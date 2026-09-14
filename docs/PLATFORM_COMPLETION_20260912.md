# 通用工作台能力补齐与验收（2026-09-12）

本记录接续 `WORKBENCH_IMPLEMENTATION_20260911.md`。后续已继续实现视频、实时语音、桌面控制、远程队列和 Office 排版；最新事实与验收见 [高级能力实现记录](ADVANCED_PLATFORM_IMPLEMENTATION_20260912.md)。本文件保留上一阶段记录，不表示与 Codex 全量等价。

## 已补齐

### GitHub 与本地 Git

文件与终端 → GitHub 推送与 Pull Request：使用系统 GitHub CLI 登录，读取账户/仓库/开放 PR，推送当前任务分支，获取远端跟踪分支，创建草稿 PR，阅读 PR 文件和补丁。创建前核对远端 HEAD，已有同分支 PR 时返回现有链接。主分支禁止直接推送，不提供强推。

分支合并与冲突处理：合并已存在的本地或远端跟踪分支；显示 base/ours/theirs；编辑解决方案并提交文件审批；审批写入后标记解决，最后创建合并提交。涉及受保护路径的合并拒绝执行。远端操作和合并都有单独的用户操作确认，Agent 的本地 Git 授权不会自行触发推送。

本地提交使用独立临时索引、原始文件 blob、commit-tree 和基于旧 HEAD 的 update-ref。发布时锁住真实索引，避免混入用户的并发暂存改动，也避免普通 commit 刷新工作文件时触发 clean filter。

### 多模型协作与恢复

设置 → 团队模型与协作：加密保存最多 12 个独立协议/接口/模型/密钥连接，为当前工作区选择并授权。`spawn_agent.modelProfile` 真正使用所选 provider；`list_agent_models` 返回已授权配置；模型身份纳入恢复校验。删除或修改连接后不沿用旧身份恢复上下文。

`resume_agent` 可恢复失败、中断或受依赖阻塞的子任务，保留任务 ID、检查点和剩余轮数，未知工具结果先封口处理，已记录结果不重放。已有 reader/writer/verifier 角色、依赖顺序与文件写入范围隔离继续生效。子代理还可委派最多两层读取/验证助手；嵌套助手不能获得写权限，只能管理自己的后代任务。等待时释放调度名额，模型请求共享三路并发上限。

### 交互终端

文件与终端 → 交互终端 PTY：xterm 显示 ANSI，node-pty 提供真实终端输入、Ctrl 快捷键与尺寸变化，Docker 容器提供隔离。支持重新连接仍运行的会话、结束会话、输出游标与有界历史。默认离线，联网沿用工作区终端网络授权。

不会退回宿主 shell。单会话一小时，最多 3 个运行会话。项目文本快照最多 500 文件/10MB。交互容器退出后修改不写回宿主；需要输出提案或成果时继续使用原有“命令验证”工具流。PTY 原生模块不可用时显示原因，普通隔离命令终端仍可使用。

### 桌面与后台

桌面默认连接同一个通用 daemon，不再创建另一个医疗运行时占用同一数据库。验证实例身份后复用服务；任务与加密模型配置保存在原有本地数据库。支持窗口关闭/重新打开、退出窗口后后台继续、任务完成的桌面通知，以及桌面菜单中的“登录时自动启动”。该开关未替用户自动启用。

后台保留 supervisor 的重启、健康检查、日志轮换和恢复逻辑。打包脚本已加入 daemon 入口、supervisor、node-pty 和实际需要的运行库。医疗服务仍可通过 `npm start` 独立启动。

### 媒体

右侧“媒体”面板及 `media_generate`：支持兼容 OpenAI 媒体端点的图片生成、预设音色语音合成、音视频转写。使用已保存且在工作区授权的模型连接；支持最多 10MB 音视频上传，音视频原生播放，生成成果预览/下载，取消请求、超时和并发限制。每种操作需配置对应服务支持的模型 ID。

图片端点要求返回 b64_json；不将任意返回 URL 自动作为可信下载地址。未提供实时语音通话、语音克隆或视频生成模型适配器。

协议依据：[GitHub Pull Requests API](https://docs.github.com/en/rest/pulls/pulls)、[OpenAI Audio API](https://platform.openai.com/docs/api-reference/audio)、[OpenAI Images API](https://platform.openai.com/docs/api-reference/images)、[node-pty](https://github.com/microsoft/node-pty)。

## 验收与运行

- `npm run check`：lint 与生产构建通过；194 项回归，184 通过、10 跳过、0 失败。工作台主分包仍有超过 500KB 的构建提示，PTY 已独立懒加载。
- `TEST_REAL_PTY=1 node --test tests/platform-completion.test.mjs`：11 项集成检查全部通过，包含真实 Docker PTY、本地 Git 三方冲突/合并、跨模型调度、子任务恢复、嵌套协作、推送约束和媒体协议隔离。
- `node scripts/verify-daemon-connection.mjs`：真实启动/复用/重启独立 daemon，并确认任务持久化。
- `npm run package:mac` 与 `npm run verify:desktop`：Mac arm64 包生成、真实 Electron 渲染、离线工具与数据库验收。另已单独执行 Electron 下 node-pty 的真实进程测试。
- Playwright 已检查媒体入口、PTY 入口与错误/未配置状态。
- 尝试新的真实模型修复验收，但当前没有配置模型凭据，报告明确记录 blocked，未发送模型请求。

当前页面：[http://127.0.0.1:8788](http://127.0.0.1:8788)。首次先配置主模型；需要媒体或跨模型任务，再在工作区设置中保存并授权其他模型连接。GitHub 功能需 `gh auth login`。后台停止命令为 `npm run daemon -- stop`。

## 仍需外部条件或另行实施

真实供应商账户兼容、实际 GitHub 推送/PR 发布、媒体生成效果、Windows 实机、48 小时稳定性和大型真实项目任务成功率，需要相应凭据、设备或完整测试时长；本次没有用模拟响应替代这些验收。

上述原有缺口已继续开发，支持范围与尚待账号/设备验证的部分详见 [高级能力实现记录](ADVANCED_PLATFORM_IMPLEMENTATION_20260912.md)。
