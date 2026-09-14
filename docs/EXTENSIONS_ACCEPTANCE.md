# 0.5 扩展能力交付与验收

日期：2026-09-10。当前入口为「本地工作区 → 工具、插件与记忆」。只实现单机用户的能力授权，没有增加组织角色。

## 已交付

| 请求 | 当前可运行实现 | 边界 |
| --- | --- | --- |
| MCP | 官方 SDK：stdio、Streamable HTTP、旧 SSE；工具分页发现、JSON Schema draft 7/2019/2020 参数校验、resources/templates/prompts；允许工具名单、Bearer 环境变量引用、响应预算、跨来源/重定向拦截、按已保存授权重连 | stdio 在断网容器内运行；选定文件以 `/sources` 只读快照提供；联网服务使用 HTTP(S)。未实现交互 OAuth 登录和任意第三方产品的私有协议 |
| 插件 | 本项目 `plugin.json` 清单、内容摘要预览、离线安装、升级、启停、卸载；技能、命令、MCP 入口分别授权；升级重新授权，停用关闭连接 | 包不超过 20MB/1000 文件，不运行宿主机 hooks，不执行联网依赖安装。依赖须预置在用户选择的容器镜像。未实现外部市场格式兼容 |
| 通用终端 | 运行 shell、标准输入、输出游标、取消、CLI 流式显示；选定文本进入只读快照；成功输出转成版本绑定的文件提案，批准后才写本机 | 非 PTY；容器禁止网络，最多 5 分钟；输出最多 2MB/200 项，单个提案文本 100KB，最多 20 个待审批提案。删除、二进制文件和不存在父目录的输出不会同步 |
| 浏览器 | 桌面内置独立 Chromium；CLI/预览可用 Playwright 指向已有浏览器；网页文本、元素、截图、点击和填写；逐次动作审批、页面变化拒绝执行、禁止密码/文件填写、下载、弹窗和未授权来源 | 不共享用户已有浏览器登录态；无通用任意 JS 执行工具；Windows 原生驱动尚未实机验收 |
| 跨平台沙箱 | Mac、Windows、Linux 共用 Docker Linux 容器执行后端；只读根文件系统、只读宿主挂载、非 root、无 capabilities、无提权、无网络、内存/CPU/PID/时间预算；无 Docker 时拒绝执行 | Docker 是外部前置环境。已实际测试 Linux ARM64/x64 容器，不等同于 Windows 主机测试；原医疗 Python Seatbelt 后端仍限 macOS |
| 语义记忆 | 独立工作区持久化、分块、过期时间、来源 hash、删除/重建索引；离线 LSA 或本机 Ollama/OpenAI-compatible 嵌入；余弦检索和模型命名空间；CLI 可管理 | 256 个片段上限。LSA 学习资料共现，少量资料效果有限；嵌入模型需预先安装，未打包模型权重，也未做真实嵌入模型质量验收 |

SQLite 随 Electron 运行时本地使用，不需要用户安装数据库服务。数据库未加密。目录检查、API 令牌和容器边界各有作用，不能声称抵御已经控制宿主机的程序。

## 已实际执行的测试

- `TEST_DOCKER_IMAGE=open-medical-runtime:0.5-arm64 npm run check`：**119 通过，0 失败，0 跳过**，包括 lint 和生产构建。日志：`output/extensions/final-complete-check.log`。
- ARM64 与 x64 真实容器：终端、stdin、取消、非 root、拒绝本机写入、网络连接被阻断、文件审批；stdio MCP 握手、参数/授权、资源、停用清理。x64 在当前 Mac 的 Linux 虚拟化环境下运行，不是 Windows。
- 真实本地 HTTP/SSE MCP 服务器：发现、调用、联合类型参数校验、跨工作区隔离、重定向不转发。
- 真实 Electron Chromium：只读快照、批准点击/填写、拒绝密码输入、未授权来源和重定向被阻止、截图。`output/extensions/browser-verification.json`。
- 独立 Playwright 浏览器后端：实际启动独立 Chrome，填写、点击、读取页面。`output/extensions/playwright-driver.json`。
- 实际应用 UI：创建工作区，开启扩展，检查/安装/启用插件，保存与检索记忆；控制台 0 错误。`output/extensions/workspace-extensions-final.png`。
- Mac ARM64 应用包：真实启动、渲染器 Node 隔离、数据库创建、现有医疗产物回归。`output/extensions/final-desktop-verify.log`。
- Mac 普通安装对照：真实安装器、新 HOME/应用数据目录、移除开发 PATH 后启动成功；**没有断网**。`output/extensions/mac-fresh-install.json`。
- Linux ARM64/x64：新容器 `--network=none`，只挂载打包资源；没有非回环网络接口，外部 TCP 不可达；启动服务、文件读取、离线记忆、插件安装成功。`output/extensions/offline-linux-arm64.json` 与 `offline-linux-amd64.json`。这验证安装包中的 JS 运行时资源，不是桌面操作系统安装。
- 两个桌面包均验证资源完整、运行时依赖在包内、无本机数据库/密钥文件混入；Windows 只到资源验证。

## 尚未闭环的验收

1. **干净 Windows 机器安装和运行**：当前未提供 Windows 测试机/虚拟机，没有运行 Windows 安装器或 EXE。不能以交叉打包代替。
2. **干净 Mac/Windows 的完整断网安装**：当前没有相应干净系统。Mac 尝试在外层 Seatbelt 下限制网络时，Chromium 自身沙箱无法再次初始化；已记录失败，未关闭 Chromium 沙箱来绕过。
3. **未装 Docker 的机器直接离线使用全部工具**：离线工具包提供两种架构镜像，但不提供 Docker Desktop、系统虚拟化组件或语言模型安装包。需要事先准备这些前置环境。
4. **真实模型链路**：当前没有配置 `DEEPSEEK_API_KEY`，`verify:model` 明确返回“未运行”。协议单元测试使用合成模型，本地嵌入接口也是合成向量协议测试；离线 LSA 本身实际执行。

因此，0.5 是已实现并测试的本项目扩展能力交付，不能标为“六项全部闭环”或“完全等同 Codex/Hermes”。

## 安装产物

- `release/Open Medical-darwin-arm64/Open Medical.app`
- `release/Open Medical-win32-x64/`：运行 `install-open-medical.cmd`，整个目录必须一并复制。
- `release/offline-tools/`：约 110MB，含两种架构容器镜像、SHA-256 清单、Mac/Windows 导入器和示例插件。镜像含 Node.js 22、基础 shell 工具，不含 Python、Git、编译器和模型。

Mac 安装器位于 `.app/Contents/Resources/app/desktop/install-mac.command`，使用 APFS 克隆优先、阶段目录替换和失败恢复。Windows 安装器改为阶段目录替换，需在 Windows 进行实际验证。

离线 CLI 入口为包内 `desktop/agent-cli.command` / `desktop/agent-cli.cmd`，使用内置 Electron 的 Node，无需系统 Node。CLI 默认使用单独数据库；指定桌面数据库前应退出桌面程序，独占锁会阻止并发访问。

## 配置示例

先在扩展授权中填写已导入镜像 `open-medical-runtime:0.5-arm64`（x64 为 `0.5-amd64`），开启对应能力。检查并安装 `examples/plugins/local-tools`，再启用插件。

本地 MCP 配置：

```json
{
  "id": "calculator",
  "transport": "stdio",
  "pluginId": "local-tools",
  "entryId": "tools",
  "allowedTools": ["sum_numbers"],
  "allowResources": true,
  "paths": []
}
```

要提供本地文件，可将 `paths` 设置为已存在的相对文本路径，例如 `["notes.txt"]`。`paths` 仅在连接时复制这些文本；更改源文件后需重连。MCP 服务器绑定保存时的镜像；更换默认镜像后要重新保存对应 MCP 配置。

远端配置使用 `transport: "http"` 或 `"sse"`、`url`，以及可选 `tokenEnv: "MCP_EXAMPLE_TOKEN"`。桌面 `model.env` 支持 `MCP_*_TOKEN` / `MCP_*_API_KEY`，不把凭证值保存进工作区配置。

CLI 示例：

```sh
npm run workspace -- extensions --workspace=ID --config-file=reviewed-extension-operation.json
npm run workspace -- tool --workspace=ID --tool=memory_search --arguments='{"query":"资料摘要"}'
```

配置文件内容与 `POST /api/workspaces/:id/extensions` 的 action 请求相同；CLI 自动补入当前 revision，文件中的显式 revision 仍优先。HTTP 入口继续要求本地令牌和来源校验，模型工具无法调用配置管理接口扩大权限。

协议实现依据：[MCP 官方 TypeScript SDK 客户端文档](https://ts.sdk.modelcontextprotocol.io/client)；本地向量接口依据：[Ollama Embed 文档](https://docs.ollama.com/api/embed)。
