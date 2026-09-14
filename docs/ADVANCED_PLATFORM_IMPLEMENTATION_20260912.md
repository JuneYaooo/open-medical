# 高级能力实现与持续验收

本记录接续 `PLATFORM_COMPLETION_20260912.md`，区分代码完成、真实本机验收和外部账号验收。实现位置均在当前项目内。

## 使用入口

- 当前工作台：<http://127.0.0.1:8788>。
- 媒体：图片、语音合成、转写、实时语音、摄像头或屏幕画面、视频任务。先在团队模型中保存并授权对应连接。
- 浏览器：系统桌面控制，检查权限后选择已打开的 macOS 应用。
- 工作区设置：远程执行与云端 Worker；插件管理支持第三方技能导入，MCP 区提供 JSON 转换。
- Office 成果：点击成果，再点“生成 PDF 与逐页预览”。需要启用终端并选择 `open-medical-runtime:0.8-full`。

## 本轮实现

### 视频任务

`server/core/advanced-media.mjs` 使用 SQLite 保存提交状态、供应商任务 ID、进度和成果引用。提交结果不确定时保留 unknown 状态，不自动重提；查询和下载绑定原连接身份。下载只访问配置好的供应商路径，拒绝重定向，校验 MP4 标记，最高 100MB。已经保存的成果不重复下载。

适配的是 OpenAI 风格 `videos` 创建／查询／content 接口，不表示所有供应商都接受该协议。供应商模型的可用性应独立核对；当前官方文档还提示 Sora API 计划于 2026-09-24 关闭，因此不应把这个模型当作长期固定依赖。[视频接口参考](https://developers.openai.com/api/reference/typescript/resources/videos/methods/create)

### 实时语音与画面

浏览器 WebRTC 承载语音，长期 API 密钥只用于服务端 SDP 交换，不返回前端。支持屏幕选择与摄像头，画面每五秒发送一帧；这属于持续图像理解输入，不是供应商输出的视频直播。可单独授权查询当前工作区的文件、目录和搜索，禁止通过此通道运行终端或写文件。

页面离开、切换连接、撤销团队授权、连接失败和三十分钟到时都会清理本地媒体轨道与连接。服务端保留限时会话、校验权限版本，并在供应商提供 call ID 时请求挂断。Electron 只对当前工作台开放用户确认的媒体权限，画面由用户选择。[Realtime calls 参考](https://developers.openai.com/api/reference/typescript/resources/realtime/subresources/calls/methods/create)、[Electron 画面选择](https://www.electronjs.org/docs/latest/api/session)

### macOS 桌面控制

原生 Swift helper 使用 Accessibility 与 Core Graphics。支持运行应用列表、聚焦、窗口文本、单窗口截图、点击、移动、Unicode 输入、快捷键与滚动。授权限定应用和十五分钟有效期；坐标需位于授权窗口，实际输入前核对前台应用。Agent 的变更操作形成单次、两分钟有效的审批提案；确认后删除提案，无法重复执行。状态查询不请求新的系统权限。

`npm run build:native-control` 已在当前 Mac 编译通过。系统当前报告辅助功能和屏幕录制均未授权，因此实际点击和截图未执行，不能标作系统交互验收通过。Windows/Linux 原生适配器尚不包含在此实现内。[Apple CGEvent](https://developer.apple.com/documentation/coregraphics/cgevent)

### 远程任务执行

`remote-coordinator.mjs` 提供持久队列，`remote-worker.mjs` 运行真实 Agent 执行循环。协调器和 Worker 使用不同令牌；模型配置保留在 Worker 主机。支持原始请求去重、多 Worker 原子领取、心跳、租约失效、取消、明确重试和终止任务删除。失联任务不会自动重放。Worker 先保存结果再确认完成，保留七天诊断目录。

本地连接配置加密保存，上传用户明确列出的文本文件。导入先验证原始文件哈希和本地写权限，所有修改进入本地审批，不自动覆盖。当前支持单租户私有部署；不同用户需独立部署。文件删除不自动回传，二进制成果保存在返回报告的 base64 字段中。部署方式、systemd 单元和容量限制见 `deploy/remote/README.md`。

### Office 排版与预览

新增 `document_layout.py`，保留原有简单内容格式，同时支持：

- DOCX：字体、页边距、页眉页脚、页码、标题、列表、富文本、重复表头、图片和分页。
- XLSX：格式、列宽、冻结窗格、合并区域、表格、图片、柱状／折线／饼图、打印布局；公式保持公式。
- PPTX：16:9 页面、文本／表格／图片／图表位置、讲稿和页码。
- PDF：中文、标题、表格、图片、分页、页眉页脚。
- `document_render`：通过容器内 LibreOffice 转 PDF，再用 Poppler 输出前二十页 PNG，成果区可以预览。

这是一套结构化排版接口，不是完整 Office 桌面编辑器，也未声称支持任意既有复杂模板的无损编辑。真实四格式生成、渲染及输出页面已检查。

### 插件入口兼容

可识别 `.codex-plugin/plugin.json`、`.claude-plugin/plugin.json`，导入技能和隔离 stdio MCP。命令 Markdown 转成指令技能；原始与转换后的文件均纳入内容摘要，安装后再次检查摘要。未映射的 hooks、agents、apps、LSP 入口在检查结果中列明，不静默启用。此兼容范围不等同于运行整个 Codex/Claude 插件生态。

MCP JSON 向导接受常见 `mcpServers`／`servers` 字典，转换 HTTP/SSE 连接，初始工具授权为空。含明文 headers 或环境密钥的配置拒绝导入，避免把凭据写进普通插件文件。

## 已完成的验证

- 最后完整 `npm run check`：203 项，191 通过，12 项按环境跳过，0 失败；lint 和构建通过。
- 新增协议、权限、任务恢复与远程端到端集成：7 项通过。测试模型为合成响应，协调器、Worker、SQLite、文件修改和本地审批为实际执行。
- `TEST_REAL_PTY=1`：12 项通过，含实际 Docker 交互终端与本机预览端口。
- Office 结构回读验证通过；实际 Docker 的 DOCX／XLSX／PPTX／PDF 生成与渲染通过，输出在 `output/document-layout`。
- 桌面发行包已增量更新并通过真实 Electron 验证；后台 daemon 启动／复用／重启持久化验证通过。
- Playwright 检查媒体、桌面权限、远程队列界面；未配置账号时不发模型请求。
- 新版短稳定性检查完成 110 轮，包含 4 次容器验证、1 次 Office 验证。此结果不等同于 48 小时通过。

## 仍在继续的验收

旧 48 小时测试进程已消失，报告停留在约 14.9 小时的 running，不能算通过。`scripts/soak-status.mjs` 现在同时检查 PID 存活和源码指纹，新的长期验证使用单独目录。持续运行结果以实际报告为准，不按启动时长或计划时长冒充通过。

目前没有配置真实模型凭据；真实媒体供应商、云主机部署、GitHub 发布和跨平台实机验证尚未执行。真实账号接入后继续验证。源码和本机可执行能力已经补齐到上面明确列出的范围，账号、设备和长期运行结果不会用模拟测试替代。

长期验证已启动于 `output/soak-remaining-48h`，每五分钟执行一轮；本任务已建立每三十分钟的持续跟进，健康且无变化时不重复通知。检查命令：`node scripts/soak-status.mjs output/soak-remaining-48h`。实际完成之前保持未验收状态。
