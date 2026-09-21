# 通用 Agent 底座实现与验收记录（2026-09-21）

本轮以 `798cd75` 为基线，保留工作区已有修改，由 Codex 主 agent 集成、子 agent 分别实现与复核。在 macOS / Node 26.8.2 上使用合成材料和隔离临时数据库验证。没有恢复 ZCode、自动跟进或修改全局模型配置；未 commit、push、部署。

## 实现与根因

| 范围 | 根因与最终行为 | 主要文件 |
| --- | --- | --- |
| A 交付证据 | 默认工作区此前未接入交付检查。现在 completed 只表示运行结束；只有本次实际应用的修改、当前内容/hash、产物或成功执行回执满足条件才产生 delivered。旧记录、无变化写入、待定/拒绝审批、失败命令均不能冒充交付。 | `server/core/workspace-delivery.mjs`、`workspace-service.mjs`、`agent-runtime.mjs`、`delivery.mjs`、`domain-adapter.mjs`、`server/session-bridge.mjs`、`src/workbench/run-status-view.jsx` |
| B 能力一致性 | 权限此前被误当成后端依赖，code_execute 漏检镜像，已有终端读取又被过度禁止。现用共享能力元数据和实际依赖区分 authorized / ready / executable；镜像、后端和配置检查有缓存及失效，未知能力拒绝默认就绪，模型发现与 UI 使用同一判定。 | `server/core/capability.mjs`、`tool-registry.mjs`、`workspace-service.mjs`、`server/agent.mjs` |
| C 仓库搜索 | 固定文件数/深度上限造成漏查。现提供受控 rg 参数、目录/glob/regex/上下文/模式/分页，支持取消、超时和预算；无 rg 时明确标注受限降级。搜索受保护路径前先拒绝，并在私有快照运行 rg，防止原目录在子进程启动时被替换为符号链接。 | `server/core/workspace-files.mjs`、`workspace-service.mjs` |
| D 网页可信读取 | 搜索失败与低相关此前混淆，重定向检查不完整，正文不可续读。现区分质量与失败原因，声明过滤支持情况；每跳重新授权，opaque 跳转拒绝；正文具有 hash、offset、nextOffset 和变化标记。 | `server/core/web-tools.mjs`、`web-extract.mjs` |
| E 上下文预算 | 压缩只按字符数判断，未覆盖工具定义、输出预留和模型窗口。现在请求与压缩共享预算，使用明确标注的保守估算、当轮输入 usage 校准和有限失败恢复；持久化计划、授权、审批及已发生副作用从 store 注入，摘要不能覆盖这些事实。 | `server/core/context-budget.mjs`、`context-manager.mjs`、`agent-runtime.mjs`、`providers.mjs`、`model-profiles.mjs`、`model-settings.mjs` |

A 的交付对象持久化后，经工作区 API 与 SessionBridge 投影保持一致。领域校验只能收紧已有证据，不能生成替代事实。恢复子任务时记录原有证据基线，避免保留的子任务 ID 复用旧证据。独立核验的产物不会因探索时某次只读文件查询失败而失效；该失败仍保留在 `toolFailures` 和 `delivery.warnings`，界面显示警告。未知工具、产生副作用的失败及非零/取消执行回执仍阻止交付。

真实模型回归另外发现，普通医疗咨询可意外调用文书工具生成用药审核产物。现在新旧医疗入口按已确定的咨询意图约束文书工具发现和执行，保留检索能力；确定性测试同时验证两个入口实际没有产生文书。

真实模型六任务验收还复现了 Code SDK 的 stdout 协议缺陷：普通 `console.log` 被当成 JSON 控制帧解析，使真实成功退出变成取消。`server/core/code-mode.mjs` 为每次调用的控制帧增加标记，并以流式解析分离普通输出；保留有界日志，继续执行工具权限、调用预算、退出码和取消校验。新增真实容器回归覆盖 console、直接 stdout/文件描述符写入、UTF-8 分块、无换行、大日志以及失败/取消。标记用于协议分流，不是隔离容器内代码的安全边界。另修复了协议收尾时宿主输入管道未关闭的问题：收到有效最终帧后发送 EOF，仍等待实际退出；独立的等待 EOF 执行端探针复现了旧实现超时，非零退出仍判失败。此探针不证明先前真实容器停滞与该缺口同因。

全量测试还修复了验收工具的环境假设：PDF 生成不再硬编码 Windows SimHei，而是检查本机字体与实际中文字符覆盖；缺配置测试使用隔离 HOME/cwd；浏览器模型测试把超时传入正确的 Playwright 参数位置。断言保留，未增加自动重试掩盖失败。

## API 兼容与使用

`WorkspaceService.prepare`（以及会话桥）可接受以下可选完成条件；省略时兼容旧请求，使用本次运行事实检查，不根据关键词猜测全部内容要求：

```json
{
  "completion": {
    "kind": "execution",
    "files": [{ "path": "report.md", "contains": "expected text" }],
    "requireExecution": true
  }
}
```

`kind` 为 `auto`、`answer` 或 `execution`；文件还可指定完整小写 SHA-256 `hash`。`contains` 是子串条件，不能替代完整语义评估。`answer` 无需产物；`auto` 的 delivered 只证明本次可核对事实，界面说明未指定的内容要求仍需复核。

`search_files` 继续接受 `{ "query": "literal" }`，也支持 `path`（目录）、`glob`、`regex`（与 query 二选一）、`ignoreCase`、`context`、`outputMode`（content/files/count）、`offset`、`limit` 和 `timeoutMs`。结果是否完整以返回的截断/预算状态为准，分页只保证目录内容不变时稳定。

模型配置可指定 `contextWindow`；不同模型可用 `contextWindows` 映射。没有明确窗口时保留 131072 的旧兼容上限，并标记 `legacy_default_unverified`，不是已核实的模型规格。估算同时计入工具 schema、输出预留与多模态保守预留，不宣称精确 token 数。

## 验收方法

- `scripts/verify-agent-foundation.mjs`：计划中 20 场景，固定 20 秒/任务，两轮，无任务重试；脚本模型驱动实际 WorkspaceService、文件、容器及本地 HTTP。拒绝、取消和失败场景按正确边界行为计通过。
- `scripts/verify-foundation-live.mjs`：01/02/03/06/07/20 六个正向任务，真实项目模型和容器各跑两轮，固定 240 秒/任务，最多两个并发，不新增任务重试。使用现有项目模型加载路径，不复制其他应用凭据；报告只保存脱敏元数据和合成材料证据。
- 全量回归使用既有安装镜像 `open-medical-runtime:0.8-full`，真实 PTY、浏览器、容器与模型测试按各测试定义执行；未拉取镜像或启动/停止 Docker daemon。
- 已失败尝试保留在输出目录，不覆盖为成功；修复后对新的固定源码版本重新运行。

```sh
TEST_DOCKER_IMAGE=open-medical-runtime:0.8-full TEST_FULL_RUNTIME_IMAGE=open-medical-runtime:0.8-full TEST_REAL_PTY=1 node --test --test-timeout=240000 --test-concurrency=4 tests/*.test.mjs
npm run lint
npm run build
node scripts/verify-agent-foundation.mjs
node scripts/verify-foundation-live.mjs
node output/codex-foundation-20260921/external-web-smoke.mjs
```

## 边界与限制

实际公共网页冒烟已经执行：免密搜索 `Node.js JavaScript runtime` 返回 so360、quality=ok、4 个结果；实际读取 `https://nodejs.org/en` 成功并得到正文 hash。这里只验证当前请求和协议可用，不据此保证结果全部相关或其他搜索引擎持续可用。逐跳越权、失败源、取消与长文分页用受控 HTTP/响应夹具独立验证。

本轮不证明 Windows 实机、医疗临床有效性、动态网页或 PDF 全文抓取、长期真实模型长上下文表现。搜索快照有条目、文本与输出预算，遇上限会报告未完成，不谎称全量扫描；仍沿用已有 WorkspaceFiles 的跨平台路径边界，不宣称新增操作系统级 openat 沙箱。多模态 token 预算明确不确定。

一次真实模型综合任务在 SDK 执行约 120 秒后被取消。失败未计通过；20 次独立容器生命周期探针（普通返回与嵌套读取各 10 次）全部正常，另一次带原始协议时间线的单任务诊断也正常。诊断运行单列，不替换失败验收轮次；这些结果尚不能证实该次停滞的具体原因。

两个既有宿主 Python Office 扩展测试需要显式 `TEST_OFFICE_PYTHON` / `TEST_DOCUMENT_PYTHON`，未配置时跳过，不计通过；实际完整 Docker 文档套件另行执行。构建存在既有大 chunk 提示，没有把提示当成构建失败。

并行运行全量、真实模型与 20 场景时，一次 PPTX 读取输出正确 JSON 后仍触发了既有 120 秒执行期限，记录为 cancelled。保持断言/期限不变，单独复跑文档套件 3/3 通过（完整容器用例 2.177 秒）。现有日志不足以证明具体争用原因；失败日志保留，最终容器密集验收顺序执行。

详细逐轮结果、代码/配置指纹、耗时和产物哈希保存在 `output/codex-foundation-20260921/`；最终冻结版本结果列于下方。

## 最终冻结版本记录

真实模型六项任务连续两轮 **12/12 通过**，0 失败、0 阻塞、0 重试；运行前后源码指纹一致：`a58d42a3dafb018b73f9294997025e114663186c339ca46512e4512414611791`。该指纹覆盖 server/shared 与真实模型验收脚本，与 20 场景报告的更广源码指纹计算范围不同。

| 真实任务 | 第一轮 | 第二轮 |
| --- | --- | --- |
| 01 | passed (1769ms) | passed (1475ms) |
| 02 | passed (5052ms) | passed (4280ms) |
| 03 | passed (6718ms) | passed (4133ms) |
| 06 | passed (3313ms) | passed (3402ms) |
| 07 | passed (5999ms) | passed (5105ms) |
| 20 | passed (8840ms) | passed (7740ms) |

[真实模型汇总与逐项证据](../output/codex-foundation-20260921/live-general/summary.json)。历史尝试单独保存在 `live-general-attempt-1` 至 `live-general-attempt-5`，诊断用单任务运行不计入上述两轮。

20 项任务按固定夹具连续两轮 **40/40 通过**，0 失败、0 阻塞；最长 666ms（每项固定 20 秒上限），代码指纹未变化。这里的模型是受控脚本，实际执行的是产品工具；不把这 40 次计入真实模型成功次数。

- [20 项任务矩阵](../output/codex-foundation-20260921/2026-09-21T07-44-44-032Z/matrix.md)
- [逐轮输入、预期、实际与产物证据](../output/codex-foundation-20260921/2026-09-21T07-44-44-032Z/report.json)
- 代码指纹：`5a81e481ccbb85cbe8caddc73b8fb9b617b03530369a4887dea57010ca2544d6`
- 配置指纹：`4fe216b02de87a9d9e89439f095d4f2bfc4ab5e26d90b50afba199a80bb6ff49`

独立协议探针 8/8 通过，另验证最终帧后发送 EOF、保持真实退出判定；[协议证据](../output/codex-foundation-20260921/independent-code-protocol.json)、[EOF 证据](../output/codex-foundation-20260921/independent-code-eof.json)。这些协议分块探针使用合成传输，实际容器另由 `tests/code-mode.test.mjs` 验证。

全量回归 **506 项：504 通过，0 失败，0 取消，2 项可选宿主 Python 测试跳过**，退出码 0，耗时 144.04 秒。实际容器文档、Code SDK、PTY、浏览器及已配置的模型用例均按套件完成；此前超时的完整 Office/PDF/ZIP 用例本轮 2.745 秒通过。Lint、build 和 `git diff --check` 均通过。

- [全量回归日志](../output/codex-foundation-20260921/regression-final-sequential.log)
- [Lint 日志](../output/codex-foundation-20260921/lint-final.log) / [构建日志](../output/codex-foundation-20260921/build-final.log)
- [实际公共网页冒烟](../output/codex-foundation-20260921/external-web-smoke.json)
- [机器可读的最终汇总](../output/codex-foundation-20260921/final-acceptance.json)

本轮 A–E 的实现与最终固定版本的验收门槛已通过。结论限定于上述环境、任务和两轮结果；历史容器偶发停滞的因果仍未确认，不宣称所有非确定性问题消失或达到泛化的“90% 成功率”。工作区修改供审阅，未提交、推送或部署。
