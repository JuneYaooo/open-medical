> 0.4（2026-09-10）状态：Mac arm64 包本机启动已验证，Windows x64 便携包已生成并通过资源检查；Windows 实机及干净机器断网安装仍未验收。完整记录见 [REFACTOR_ACCEPTANCE.md](REFACTOR_ACCEPTANCE.md)。

# Mac 桌面试用版

桌面版将 Chromium、Node.js、本地 HTTP 运行时、UI、医疗技能和 SQLite 一起打包；启动 `.app` 不需要手动运行 npm 或启动服务。Python 沙箱仍使用本机可信 Python（缺少 Python 时其他功能仍可用，隔离计算关闭）。

## 离线安装形态

桌面包是自带 Electron、Node.js、前端、医疗运行时和本地技能的便携目录；安装机器不需要 Node.js、npm、项目源码或网络。首次启动在系统应用数据目录创建独立的 SQLite 与 `model.env`，未配置模型也能离线使用本地整理、患者档案、产物复核和随访提醒。

Windows 便携包已生成，使用 `Open Medical-win32-x64` 目录，直接复制到目标机器后运行 `Open Medical.exe`。macOS 版本使用 `.app`，可复制到「应用程序」后运行。分发时将整个目录作为一个整体压缩和传输，不能只拷贝可执行文件。

模型配置为本地 Ollama / vLLM 等服务时仍可保持离线；配置云端 Provider 后，只有明确授权的任务会访问对应服务。离线包不会自动下载模型、技能、依赖或更新。

## 构建与验证

```bash
npm install
npm run package:mac
npm run verify:desktop
npm run verify:offline
```

在 Windows 构建 Windows 包：

```bash
npm run package:win
```

`npm run package:desktop` 按当前构建机平台生成包；`TARGET_PLATFORM`/`TARGET_ARCH` 或 `--platform`/`--arch` 可供 CI 指定目标。跨平台打包需要目标 Electron runtime 已在构建机缓存或构建机可访问网络；**安装和运行阶段不需要网络**。当前交付是便携离线包，不伪装成带注册表卸载项的 MSI 安装器；如需企业 MSI，应在 Windows CI 用 WiX/MSIX 对该目录再封装。

输出：`release/Open Medical-darwin-arm64/Open Medical.app`（当前 Apple Silicon 构建）或 `release/Open Medical-win32-x64`。Intel Mac 需要在相应架构环境构建并验证。本地试用包未做 Apple Developer ID 公证，不是已完成签名分发的正式安装包；Windows 包也尚未做代码签名。

界面复用工作台；渲染进程开启 Chromium sandbox 和 context isolation，不提供 Node API，不允许 webview 或任意页面导航。所有窗口只访问自己启动的随机 loopback 端口。外部 HTTPS 链接由系统浏览器打开。参考 [Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)。

数据保存在 `~/Library/Application Support/Open Medical/medical.sqlite`，模型配置为同目录 `model.env`，首次创建权限 0600。菜单“工作台 → 编辑模型配置”打开文本编辑器，填写 AI_PROVIDER 和对应模型密钥后通过“重启以应用配置”生效。此配置与开发版项目 `.env` 分离；打包明确排除项目数据库、密钥、测试材料和截图。

关闭窗口后应用继续运行，计划任务继续执行；菜单“退出医疗工作台”或 Cmd+Q 会取消当前任务并安全关闭数据库。重新启动应用后计划按既定恢复规则处理。桌面版是独立数据空间，不会自动导入开发版已有病历资料；需要时可从原工作台导出后以资料形式导入。

`verify:desktop` 直接启动打包后的真实二进制，在临时数据目录中验证数据库、三子代理产物、OS 沙箱、页面加载和 renderer 无 Node API，并保存验收 JSON 和截图到 `output/desktop-build/verification/`。测试目录随后清理。

`verify:offline` 检查包内包含完整 UI、运行时和技能，且没有打包开发机的 `.env`、SQLite 数据库或缓存。它递归扫描实际应用资源目录，但不等同于断网安装与运行测试。
