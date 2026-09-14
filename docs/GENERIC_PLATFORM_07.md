# 0.8 通用 Agent 能力补齐与验收

更新：2026-09-11。本文是 0.8 实现快照；0.3–0.7 文档保留为历史记录。

项目继续采用自研 AgentRuntime：模型决定下一步 → Schema 和授权检查 → 隔离工具执行 → 工具结果进入上下文 → 检查完成条件。通用运行时独立于医疗领域。此次直接补充运行时、工具、服务和界面，并非增加一组提示词。

**不能据此宣称与 Codex、DeepSeek Harness 或 WorkBuddy 完全等价。** 这些产品并不共享一套完全一致的实现；本项目没有复制其完整运行时、协议或生态。是否好用还取决于模型、任务成功率、恢复可靠性和实际使用验收，不能用工具数量或未经评测的百分比代替。

## 当前能力

| 基础能力 | 0.8 实现与入口 | 完整程度与限制 |
| --- | --- | --- |
| 模型与工具循环 | DeepSeek、Chat Completions、Anthropic、Responses；流式输出、Schema、权限、重试、取消与预算 | 协议回归通过；已通过 Claude Code 保存的 DeepSeek v4 Pro 配置直连真实模型验收，具体任务与结果见下文；不代表其他模型也通过 |
| 长会话 | 超过上下文预算约 80% 自动压缩旧历史，保留最近完整工具批次；原文落库，可用 `read_context_archive` 分页回查 | 通用工作区已实现；摘要会损失细节，必须按需回查；医疗适配器默认不启用 |
| 上下文续接 | 保存完整模型检查点、同权限/模型历史复用、失败续接与历史分支 | 主运行支持；子 Agent 不能跨进程独立恢复；分支不复制私有完整模型上下文 |
| 用户中途调整 | 运行期间输入追加要求，在工具批次边界消费；请求 ID 去重；待处理要求持久化 | 工作台“追加要求”；当前模型请求不会被强行改写 |
| 工具程序编排 | `code_execute` 在 Docker Node 内运行 JS，`await tools.*` 和 `Promise.all` 调用注册工具 | 已用真实 Docker 验证；每次最多 32 调用、8 并发，禁止递归；工具权限与审批仍生效 |
| 多 Agent 协作 | `spawn_agent`、`list_agents`、`send_agent_message`、`cancel_agent`、`wait_agents` | 每运行最多 24 个任务、3 并发；reader/writer/verifier；依赖失败阻断；writer 指定文件清单及并行占用冲突检查 |
| 子 Agent 完整度 | 独立上下文、父任务消息、依赖结果、取消联动、终端验证、写入提案、父运行检查点恢复 | 单层同模型团队；没有递归团队、跨机器分发；工具为限定白名单 |
| 编码基础 | 目录/搜索/读取、精确替换、文件提案与修订、删除恢复、AGENTS.md、Git diff/worktree/commit、快照验证 | 默认逐项复核；通用域允许单独授权自动写入和本地提交；没有远程托管 Git 平台账号与 PR 全流程连接器 |
| 网页 | 新增 `web_fetch`，记录 URL、时间、hash、截断；`web_search` 使用配置的 SearXNG JSON 端点 | 抓取边界已测；搜索端点需另行配置；HTML 抽取不执行网页脚本，交互走浏览器工具 |
| 浏览器与电脑操作 | 原有 Electron 隔离浏览器导航、读取、截图、审批后点击/填写 | 浏览器级能力；没有通用操作系统桌面/任意原生 App 控制 |
| 图片理解 | Responses 适配器下 `inspect_image` 发送当前工作区 PNG/JPEG/WebP，检测文件类型、限制 4MB、记录 hash 与用量 | 仅已授权运行内可用；合成协议测试通过；真实视觉模型未验收；其他适配器暂不开放此工具 |
| 办公文件 | `document_read` 读取 PDF/DOCX/XLSX/PPTX、图片和 JSON/CSV；`document_create` 生成四种办公格式；ZIP 安全检查/解包/打包 | 完整办公 Docker 镜像已实际读写回测；简单内容生成，不含专业排版、图表/透视表或全部保真编辑；Excel 公式保存但不重算 |
| 语义记忆 | 原有 SQLite 持久化、LSA/本地嵌入、索引与召回、单独读写授权 | 本地工作区记忆；不是跨设备同步或完整自动记忆治理 |
| Skills 与插件 | 本地技能；插件检查/安装/启停/卸载；新增 HTTPS tar/tgz 下载 + SHA-256 校验 + 解包后审阅 | 只接受本项目 `plugin.json` 格式；不是第三方 marketplace、任意上游插件兼容或自动更新 |
| 插件 Hooks | `run_start/tool_start/tool_end/run_end`；每个 hook 单独授权；隔离只读容器、无网络、失败可阻断后续执行 | 主运行、子 Agent、手动工具、Code SDK 工具执行接入；完成后 hook 不回滚已执行操作；不是任意 UI 注入 |
| MCP 与账号 | 原有 stdio/HTTP/SSE、工具/资源授权；新增 MCP OAuth、PKCE、state、客户端注册/刷新、清除本地授权 | 本地模拟 OAuth 实测通过；实际供应商兼容需连接验收；要求预先配置全部授权来源；清除本地令牌不等于服务商端撤销授权 |
| 凭据 | OAuth token/client 信息 AES-256-GCM 加密落库，密钥文件权限 0600，按 owner/server 隔离 | 仅 OAuth 凭据保险库；整个工作区数据库/审计轨迹不加密，不能推广为企业密钥或患者数据保护完备 |
| 定时与后台 | 单次/固定间隔 + 五字段 Cron/IANA 时区、错过执行跳过；独立 daemon start/status/stop | daemon 存活时关闭页面/启动终端仍执行；不含系统开机自启/关机执行；页面启动的任务依然依赖其服务器进程 |
| 观察与通知 | 原始模型请求/响应/工具结果轨迹、只读协议重放、游标分页、运行 tokens/时长、完成/失败消息及未读状态；Electron 非前台系统通知 | 本地单用户轨迹；重放只验证并展示已记录步骤，不重新执行工具；没有成本估价、集中式监控或防篡改审计；实际系统通知展示取决于系统权限 |
| 领域能力 | 医疗工作台继续作为独立入口和领域适配层 | 原有医疗边界与测试保留；通用扩展不自动扩大医疗数据外发范围 |

## 使用

```sh
npm run build
npm run platform
# 打开 http://127.0.0.1:8788
```

工作台左侧的“设置与模型”打开全局模型连接面板。面板支持 DeepSeek、OpenAI/Responses、Anthropic、兼容 OpenAI 的服务和本地回环模型，可保存、测试连接并在重启后恢复；API Key 使用本机加密凭据库保存，页面不会回显密钥。运行中的任务不允许切换模型。运行记录页会列出 Agent 生成的成果并通过受认证的成果接口下载。

工作区的“工具、插件与记忆”配置终端镜像、允许的网络来源、搜索端点、MCP 账号和插件 hook。高级能力仍需明确授权，文件修改继续通过提案复核。首次连接目录即可使用基础文件工具；无需把医疗资料作为通用功能测试输入。

产品发布以独立通用工作流为门槛，医疗仅提供提示词、数据模型、临床工具、权限限制、产物格式和审核规则。发布门槛及未完成项见 [通用发布门槛](GENERIC_RELEASE_GATES.md)。

### 模型与图片分析

在 `.env` 中设置 `AI_PROVIDER=openai-responses`、`OPENAI_API_KEY`、`OPENAI_BASE_URL` 和账号可用的 `OPENAI_MODEL`。可选 `AI_REASONING_EFFORT`，实际支持取决于选定模型。使用 `store:false`，重放加密 reasoning 项及 function call/output，流没有完整终态时按失败处理。

`inspect_image` 只在支持该路径的适配器下暴露，且需要处于已授权的运行中。普通文字模型不会因挂载这个工具自动获得视觉能力。

### Code SDK 与团队

启用隔离终端、选择含 Node 的本地镜像后，模型可以调用：

```js
const [a, b] = await Promise.all([
  tools.read_file({ path: 'README.md' }),
  tools.list_directory({ path: '.' }),
]);
return { readme: a.text, entries: b };
```

模型可为 writer 指定 `writePaths: ["notes.md"]`，再为 verifier/reader 指定 `dependsOn: [writerId]`。文件变更只产生待复核提案。终端验证可检查待批准内容；根任务必须等待运行中的团队/终端结束才允许报告完成。

### 完整办公环境

```sh
npm run build:runtime
# 成功后，在终端镜像设置中选择 open-medical-runtime:0.8-full
```

镜像在 `desktop/full-runtime/Dockerfile` 定义，包含 Python、办公库、LibreOffice、Poppler、中英文 Tesseract、字体与 Node。构建需要联网下载依赖；运行时遵守工作区隔离设置。`document_create` 使用 `contentJson`：文档为 title/paragraphs；工作簿为 sheets:[{name,rows}]；演示为 slides:[{title,paragraphs}]。当前内容请求上限 5000 字符，终端命令另有字节/长度预算；大型复杂文档应分步处理。

生成成果不会自动落入宿主工作区。使用 `document_read({artifactId: "成果ID"})` 直接回读；`terminal_run` / `terminal_start` 的 `artifactIds` 可把同一工作区的成果作为下一个隔离任务的输入。输入按原名暂存，拒绝覆盖同名快照或提案；仍校验成果归属、内容哈希、路径及输入大小。

### MCP OAuth

在现有 HTTP/SSE MCP JSON 配置添加：

```json
{
  "oauth": {
    "origins": ["https://auth.example.com", "https://mcp.example.com"],
    "clientId": "服务商已注册客户端 ID（支持动态注册时可省略）"
  }
}
```

实际地址和 clientId 由服务商提供。支持动态 loopback 端口；固定客户端需要时设置 `redirectPort`，并让服务商注册的 callback 与 `http://127.0.0.1:端口/callback` 一致。界面“连接账号”打开授权地址。回调有 5 分钟时限、绑定 owner/server/config，并校验 Host/state。访问未批准的认证来源会被拒绝，按服务商实际元数据补充 origins 后重试。

### 关闭桌面后仍执行

```sh
npm run daemon -- start --port=8788
npm run daemon -- status
npm run daemon -- stop
```

通过后台服务页面创建任务与计划。数据库默认位于 `~/.open-medical-workbench/platform.sqlite`；可用 `--directory` 启动隔离实例。不要同时让两个服务使用同一数据库。daemon 是独立服务进程，不是把已经在另一个桌面服务里运行的任务无缝迁移过去。重启后恢复的是持久记录/计划和可续接检查点，正在运行的进程本身不会存活。

0.8 起，桌面应用的通用工作区也使用这个 `platform.sqlite`，所以桌面端和 `npm run platform` / daemon 先后打开时会看到同一批工作区、审批、历史和轨迹。首次启动会把旧桌面 `medical.sqlite` 复制到共享位置。两个进程不能同时打开同一数据库；切换入口前先关闭另一端。模型配置仍按入口分别保存，不同步 API Key。

## 验收记录

当前回归包括自动压缩/回查、工具批次完整性、追加要求去重与恢复、写入代理作用域/依赖/取消、MCP OAuth 模拟服务与密文隔离、Responses reasoning/工具重放与不完整流拒绝、Cron 时区/DST、网页边界、远程插件校验与越界拒绝、真实 Docker Code SDK/Hook、daemon 启停、办公助手四格式实际读写。

0.8 本地验收结果：`npm run lint` 通过；使用 `TEST_DOCKER_IMAGE=open-medical-runtime:0.8-full TEST_FULL_RUNTIME_IMAGE=open-medical-runtime:0.8-full npm test` 得到 175 项通过、1 项跳过、0 项失败。完整办公镜像摘要为 `sha256:36b435fc2415b6a2face3e050260274259c30639c658b525866c101f2aacbf1c`。`npm run verify:soak -- --iterations=110 --interval-ms=0 --image=open-medical-runtime:0.8-full` 通过 110 次任务、4 次服务重启、1 次强制进程恢复、24 次上下文压缩、4 次容器检查和 1 次办公检查；该短验收的 `durationTargetMet` 为 `false`，不能冒充 48 小时结果。浏览器工作台用 Playwright 完成了目录连接、历史归档翻页、恢复授权入口和任务提交操作检查。

真实模型验收使用 `npm run verify:agent -- --repeat=3`。默认读取 `.env`；也可以明确选择本机 Claude Code 配置：`npm run verify:agent -- --claude-code-provider=default --repeat=3`，其中 `default` 是 CC Switch 保存的 Claude 提供商 ID，`active` 表示当前 Claude settings.json。凭据仅在进程内使用，不改写 Claude 配置、不写入项目或验收报告。模型由本项目运行时直接调用，Claude Code 不代替本项目执行任务。

2026-09-11 的实际结果、失败与修复记录见 [真实模型验收](REAL_MODEL_ACCEPTANCE_20260911.md)，该记录优先于早期“凭据缺失”的历史状态。

验收覆盖逐项审批修复、自动修复与 Git 提交、PDF/Excel/Markdown 成果、依赖团队、上下文压缩与服务重建恢复、真实本地 HTTP MCP 的发现/失败重试/数据落盘。MCP 数据是合成数据，OAuth 供应商兼容仍需实连；恢复注入的是服务中断及数据库重开，强杀进程由独立回归与 soak 覆盖。不能把这些检查描述为对任意陌生仓库或外部系统的普遍成功保证。

最终测试计数、完整办公容器验收以及浏览器验收结果记录在本文末尾。测试使用合成资料和合成模型，不访问真实患者数据库；合成协议正确不等于真实模型任务成功率。

## 仍需完成的通用能力差距

- 真实模型、真实 MCP 供应商与搜索服务的跨工具任务评测，包括长任务成功率、token 成本、恢复后重复操作率；仓库已提供 `npm run verify:agent` 和 `npm run verify:soak` 验收脚本。
- 递归/跨模型团队、跨设备执行和云端调度。
- 通用桌面控制、语音/音视频理解、完整图像生成入口；当前图片分析只覆盖指定模型适配器。
- 插件 marketplace/第三方清单兼容/自动更新、可插拔 UI；Creator 仍是已有文件创作模式，不是上游 Creator 完整插件环境。
- 完整保真办公编辑、复杂图表及布局验收；Windows 实机、干净系统离线安装与新版安装包验证。
- 多用户权限、集中运维、全库加密、防篡改审计和带工具重执行的可复现轨迹重放。

这些缺口仍属于项目待办，不能因医疗定位而省略，也不能把本次“已实现的基础层”描述为与参照产品完全一致。
