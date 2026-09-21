# Beta 候选实现与验收（2026-09-21）

**状态：本轮修复和本地候选已经实现；扩展长任务稳定性未通过，不作为正式发布就绪证明。**

接续通用底座 A–E 验收。本轮推进真实任务覆盖与可追溯桌面候选包，并修复已经确认的两项医疗数据一致性问题。实现由 Codex 主 agent 集成，子 agent 分别处理消息摘要、提案事务及候选包工具。所有验证使用合成材料、隔离数据库和已安装容器镜像；没有访问真实患者库、复制其他应用凭据、修改全局模型配置、覆盖现有安装包或提交/推送/发布。

## 已实现

### 消息摘要仅确认实际输入

`server/agent.mjs`、`server/patients.mjs` 与 `server/followups.mjs` 统一使用服务端选定的消息快照。每次最多 50 条、12000 字符；模型执行成功后，只更新实际输入中的消息 ID，并附加患者作用域条件。执行期间新到的消息、未进入预算的消息以及失败/取消任务的消息仍保持待处理。首条消息大于预算时明确报错，避免空输入被误判为已处理。手动摘要原有排序与自动随访的排序均保留。

真实临时数据库回归覆盖 70 条消息、字符溢出、执行中新消息、模型失败及取消。取消手动摘要通过实际 HTTP 取消接口验证。

### 旧提案不得覆盖新档案

`server/medical/pending-actions.mjs` 在创建提案时从数据库获取可信 `baseRevision`。患者档案发生变化后，确认返回 `409 ACTION_CONFLICT`，保留当前档案和待处理提案，提示刷新后重新生成。模型传入的版本不能替代服务端版本。

schema 7 为 `pending_actions` 增加可空的 `base_revision`。旧提案没有历史版本，不会被伪造为“基于当前版本”；必须重新生成才能确认。备份工具同步支持 schema 7。

`server/sqlite-transaction.mjs` 保持外层 `BEGIN IMMEDIATE`，嵌套时使用 SAVEPOINT。患者变更、关联工作区记录和提案状态一起提交；中途失败整体回滚。`Store.mutate` 与 `WorkspaceStore.update` 支持加入外层事务。失败建档可能保留空的应用自有目录，但不会留下患者或工作区数据库记录、患者内容；没有额外删除未知目录。

`src/patients.jsx` 统一捕获确认/拒绝错误，禁用进行中的提案操作，并显示冲突原因。真实浏览器回归确认：医生新修改不被覆盖，旧提案保持 pending，提示可见，无未处理页面异常，仍可拒绝旧提案。

### 恢复完成后清除当前错误

扩展真实模型诊断发现，同一任务恢复成功后仍保留“服务正在关闭”的旧 error。`WorkspaceService` 成功完成时清空当前 error，历史中断事件继续保留。HTTP 关闭、数据库重开及同任务恢复回归验证了这个区别。

### 长任务上下文压缩

首轮扩展真实评测为 5/6 通过，其中第二轮长对话触及固定 240 秒任务时限。失败轨迹保存在 `output/beta-readiness-20260921/expanded-final/`，未删除或算作通过。诊断发现摘要请求将历史 JSON 任意分片，并遗漏最新用户原文却包含引用该要求的内部推理，导致来源误判及重复读取。修复使用完整记录和工具调用来源，按实际请求预算装箱，逐次保留真实最新用户消息，排除内部推理；单条超大记录明确指向原文归档。修复后在冻结版本上重新执行，两轮共 6/6 通过；原失败仍保留。

### 独立候选包和完整性核验

`package-desktop.mjs` 新增 `--out` / `--output-dir`，只允许新建仓库 `output/` 下的目录，拒绝已有目录、越界和符号链接路径。原有默认打包路径保持兼容；本次使用独立输出。

候选包含源码指纹、打包源码清单和完整文件清单。`verify-desktop-candidate.mjs` 验证源码与当前工作区一致、文件未增删改、没有数据库或凭据文件夹带，并在真实应用冒烟后再次验证完整性。清单用于本地核验，不替代发行签名或外部信任根。

Mac 本机构建保留原流程的 ad-hoc 签名，没有读取发行证书、申请公证、安装或发布。冒烟使用临时 HOME、userData 和数据库，不继承模型凭据；启动真实 Electron，验证页面、合成草稿生成和渲染进程隔离。

## 验收入口

```sh
# 三类真实模型工作流，每类两轮；逐项固定时限，无任务重试。
node scripts/verify-beta-workflows.mjs --directory output/<new-report-directory>

# 独立 Mac 候选包，不覆盖 release/。
npm run build
node scripts/package-desktop.mjs --platform=darwin --arch=arm64 --out=output/<new-candidate-directory>
node scripts/verify-desktop-candidate.mjs --candidate 'output/<new-candidate-directory>/Open Medical-darwin-arm64' --source-root . --smoke --report output/<new-report-file>.json
```

扩展工作流复用既有 `evaluate-agent.mjs` 实际任务，增加明确的单任务时间配置与两轮外层验收：长对话压缩/中断/追加要求/SQLite 重开恢复；PDF、Excel、Markdown 生成与独立回读；实际本地 HTTP MCP 的临时失败和恢复。模型使用现有项目配置，MCP 服务是合成数据夹具，文档及容器是真实执行。文件提案由验收程序模拟用户明确批准后检查，不能将其解释为未经审批的自动写入。它不是跨供应商或云端 MCP 的兼容性认证。

定向回归：60/60 通过；包含消息、提案、嵌套事务、工作区、恢复、候选包工具和真实浏览器冲突提示。此前的长对话单轮诊断单独保存，不计入最终冻结版本的两轮成绩。

## 最终本地候选

路径：`output/beta-readiness-20260921/candidate-final/Open Medical-darwin-arm64/Open Medical.app`。包含上下文和终端生命周期修复。实际 Electron 冒烟、当前源码对比及启动前后完整性检查全部通过；核验 10220 个文件/链接条目，源码指纹 `77f85c8977ec1327d6ec1eb3a3720b96a90f0ceeff8d2d26321143905f30d868`。版本仍为 0.9.8，本地 ad-hoc 签名，未安装或发布。

[最终候选核验](../output/beta-readiness-20260921/candidate-final-verification.json)、[最终打包日志](../output/beta-readiness-20260921/package-final.log)。此前 `candidate/` 和 `candidate-v2/` 及其验证记录保留为历史证据，不能替代最终候选。

### 终端输入结束与产物导出

`server/core/terminal.mjs` 在用户命令退出、收到完整的随机导出标记后关闭 Docker stdin；继续接收完整归档并等待真实进程退出，不提前判成功。命令执行期间保留交互输入；非零退出、取消、缺失或损坏归档仍失败。

真实子进程夹具先复现旧实现超时，再验证修复；独立探针验证分段标记、约 286KB 中文内容精确 hash 和截断归档失败。实际已安装 Docker 镜像完成 10 组 DOCX 创建和产物回读（20/20，最长 145ms），另有 Office/PDF/ZIP 回归 3/3。历史 Docker 停滞与输入管道的因果联系仍是基于轨迹的判断，不宣称排除了所有环境因素。

[真实文档生命周期轨迹](../output/beta-readiness-20260921/document-lifecycle-probe.json)、[独立终端核验](../output/codex-foundation-20260921/terminal-independent.json)。

### 最终短负载与任务矩阵

[修复后短负载](../output/beta-readiness-20260921/short-load-after-terminal/report.json)：110 次全部通过，耗时约 8.3 秒，4 次容器检查、1 次 Office 产物检查、4 次服务重启及 1 次强制崩溃恢复；最大 RSS 327.6 MiB。`durationTargetMet=false`，明确不计为 48 小时稳定性验收。

[20 项任务连续两轮](../output/codex-foundation-20260921/2026-09-21T09-24-19-130Z/report.json)：40/40 通过，代码冻结。任务采用脚本模型、受控网页夹具和实际产品容器；真实模型成绩另外记录。

## 终端修复前的扩展真实模型结果（历史）

[真实模型两轮报告](../output/beta-readiness-20260921/expanded-after-compaction/report.json)：6/6 通过，零重试，前后源码指纹一致。模型为项目现有配置的 `anthropic/deepseek-flash`。

| 任务 | 第一轮 | 第二轮 |
| --- | --- | --- |
| 长对话、压缩、中断及 SQLite 恢复 | 通过，72.8 秒 | 通过，175.0 秒 |
| PDF、Excel、Markdown 生成及独立回读 | 通过，19.4 秒 | 通过，13.2 秒 |
| 本地 HTTP MCP 临时失败及恢复 | 通过，10.9 秒 | 通过，9.7 秒 |

[独立轨迹核验](../output/beta-readiness-20260921/continuity-independent-after-compaction.json)确认两轮均实际完整读取 16 份源文件、同任务恢复一次、成功后 error 为空并保留原文归档。两轮摘要请求分别为 6 次、20 次，说明正确性和固定时限通过，但模型行为及压缩延迟仍有明显波动，不能由这两轮推断所有长任务都稳定快速。

## 短负载首次失败（保留证据）

`short-load/report.json` 在第 100 次任务附带的 Office 文档检查失败：文档脚本已经输出创建成功，但终端未正常结束，120 秒后取消；最终记录为 100 次任务、4 次容器检查、0 次 Office 通过，不能算作短负载通过。已修复交互 Docker stdin 的完成时机；修复后短负载 110 次通过，失败记录原样保留。

## 最终源码扩展真实模型结果

[最终两轮原始报告](../output/beta-readiness-20260921/expanded-final-terminal/report.json)：**5/6 通过，1 次长对话超时，整体失败**。零重试，源码前后指纹一致；单任务上限 240 秒、外层进程上限 260 秒。原有任务条件和模型配置保持不变。

| 任务 | 第一轮 | 第二轮 |
| --- | --- | --- |
| 长对话、压缩、中断及恢复 | 失败，240.4 秒 | 通过，164.3 秒 |
| PDF、Excel、Markdown 成果与回读 | 通过，145.5 秒 | 通过，11.8 秒 |
| 本地 HTTP MCP 失败恢复 | 通过，9.1 秒 | 通过，9.5 秒 |

[独立来源读取核验](../output/beta-readiness-20260921/continuity-independent-final.json)：两轮均实际完整读取 16 份源文件；第一轮超时，第二轮完成同任务恢复且当前 error 为空。因此原文读取通过不等于任务交付通过。

## 最终回归与汇总

[机器可读验收汇总](../output/beta-readiness-20260921/final-acceptance.json)。全量命令：

```sh
TEST_DOCKER_IMAGE=open-medical-runtime:0.8-full TEST_FULL_RUNTIME_IMAGE=open-medical-runtime:0.8-full TEST_REAL_PTY=1 node --test --test-timeout=240000 --test-concurrency=4 tests/*.test.mjs
```

[全量日志](../output/beta-readiness-20260921/regression-final.log)：534 项，532 通过、0 失败、2 跳过，耗时 144.4 秒。跳过为可选宿主 Python Office 依赖测试，真实 Docker 文档链路另有验证；不将跳过记为通过。最终 lint、构建及 `git diff --check` 通过。构建保留既有 chunk 超过 500KB 提示；此后的产品修改仅涉及服务端，最终候选已包含这些源码。

## 尚未关闭的实际问题

- 最终源码的第一轮长对话在 240 秒取消。第 5 轮的摘要已正确保留全部 16 份数据、合计 136 和最新标记，但模型继续执行 98 次成功文件读取，没有调用写入工具；25 次已完成压缩消耗约 196 秒。独立诊断未发现新的确定性分片、预算或来源关联缺陷，属于真实的任务持续推进不稳定。[诊断证据](../output/beta-readiness-20260921/residual-continuity-diagnosis.json)。
- 最终源码第一轮文档成果验收通过，但其中一次 PDF 读取已输出正文却迟迟未结束，最后呈现 cancelled/exitCode=0。端到端成果通过不能覆盖这个子工具失败。现有日志不足以确认 Docker 退出停滞的全部原因；后续应增加原始进程收尾轨迹，并验证内部无 stdin 的文档/归档命令使用非交互启动的效果。
- 因上述问题，保留“工程 Beta / 可审查本地候选”判断，不能宣称所有长任务已稳定完成。没有放宽时限、修改模型配置或通过反复重跑覆盖失败。

## 仍有边界

- Windows 实机、干净系统从零安装、发行签名/公证及安装升级回滚没有在本轮通过认证。
- 旧源码的 48 小时合成记录不能代替这一候选的新长时记录；短负载、真实模型任务与 48 小时验收分别报告。
- 上轮历史偶发容器停滞原因仍未完全确认。最终用例通过不保证所有偶发故障消失。
- 本轮修复两项具体医疗数据一致性问题，不代表患者材料所有外发路径、临床有效性或机构部署已经审计完成。
- 候选保持未安装、未发布；真实用户工作区和既有安装包没有被替换。

## 后续框架加固批次

上述结论和失败日志作为历史记录保留。后续实现、固定开源版本研究、新增归档与进程生命周期机制及当前源码验收，统一见[运行时健壮性设计与验收](framework-robustness-2026-09-21.md)。当前全量 586 项中 584 通过、2 跳过；受控 40/40、短负载 110/110；真实冻结任务仍为 5/6，因此长任务稳定性仍未达标，保持工程 Beta 判断。候选未安装或发布。
