# 0.6 通用 Agent 平台验收

日期：2026-09-10。验收对象为本次工作目录源码和重新生成的 0.6.0 桌面包。改造前源码快照保存在 `output/platform-upgrade/source-before.tgz`；没有删除或迁移现有医疗数据库。

## 已验证

- `TEST_DOCKER_IMAGE=open-medical-runtime:0.5-arm64 npm run check`：ESLint、全部测试、Vite 双入口生产构建。**134 项通过、0 失败、0 跳过**。测试结果见 `output/platform-upgrade/final-check.log`。
- 合成模型驱动真实 Docker：失败测试 → 精确编辑提案 → 覆盖隔离快照 → 测试成功 → 用户批准后才修改宿主文件。
- 真实 Docker：输入/环境/网络默认隔离、交互输入、取消、二进制输入和成果持久化；真实 stdio MCP 握手、调用、资源和插件清理。
- 真实 Git 临时仓库：受保护文件过滤、禁止目录 pathspec 扩展、过滤器和 hooks 禁用、隔离工作树、选择文件提交、HEAD/hash/暂存区冲突检查。未向远程推送，也未给当前非 Git 项目目录初始化仓库。
- 通用独立服务：仅通用数据表、认证和来源检查、后台任务在短 HTTP 请求结束后继续。显式检查点续接、模型/领域变更隔离、并行只读子任务及医疗权限回归通过。
- 浏览器人工流程（合成模型、临时工作区）：进入工作区、查看预算与计划、发起后台任务、查看结果、刷新后仍可读取历史。修复了同级 React key 重复导致面板重复渲染的问题。
- Mac arm64 桌面包：渲染隔离、窗口加载、本地 SQLite、三份合成医疗产物及 Seatbelt 计算冒烟测试。
- Electron 浏览器工具：真实浏览器、来源阻断、隔离、审批和截图验证。
- Mac / Windows 0.6.0 打包与资源检查：递归检查应用资源，不含项目 `.env`、患者数据库或工作区数据。资源检查不等于断网安装验证。

## 没有验证的事项

- 真实云端或本地模型任务：当前未配置可用模型凭据，`npm run verify:model` 明确报告未运行。合成模型测试只证明执行链和错误语义，不证明真实模型的规划质量或任务成功率。
- Windows 实机安装、启动及 Git/Docker 行为；本轮只生成 Windows x64 包并检查资源。
- 连续 10 小时负载、干净机器完整断网安装、系统休眠唤醒、跨机器升级和正式签名公证。
- 所有 Office/PDF/OCR 解析库、任意二进制文件类型和视觉模型协议；容器生成/解析能力依赖镜像中的软件。
- 远程插件市场、递归或可写子代理、Git 自动合并/推送、完整 DAG、分布式多用户及临床有效性。

## 交付入口

- 独立通用平台：`npm run platform`，http://127.0.0.1:8788。
- 医疗集成平台：`npm start`，http://127.0.0.1:8787；默认进入通用 Agent。
- Mac：`release/Open Medical-darwin-arm64/Open Medical.app`。
- Windows：`release/Open Medical-win32-x64/`。
- 设计与使用说明：[GENERIC_PLATFORM_06.md](GENERIC_PLATFORM_06.md)。

这是通用能力优先的可运行版本，不构成与 Codex/Pi/DeepSeek Harness 完全等价或能完成任意任务的承诺。

机器可读验收结果与源码/双平台包 hash 一致性检查见 `output/platform-upgrade/acceptance.json`。
