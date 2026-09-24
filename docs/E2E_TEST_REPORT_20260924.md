# 端到端与全量回归测试报告 · 2026-09-24

> 后续完整动线验收发现并修复了产品问题，最新结果见 [完整动线补充报告](COMPLETE_JOURNEYS_ACCEPTANCE_20260924.md)。下文为第一轮历史记录。

## 结论

本轮针对当前源码运行完整测试套件，并补开真实模型、Docker、PTY、Office 和远程执行测试。既有 854 项测试，跨批次累计验证 850 项通过，4 项因缺少指定真实样本未运行。这里包含单元、接口、集成、浏览器及 Electron 测试，**不是 850 个浏览器端到端场景**。

发现 1 处过时的端到端测试步骤，已修正并用真实模型复测通过。已执行范围内未确认业务功能缺陷。仍有下文列出的实机、账号和样本边界，不能据此宣称所有环境、所有功能路径均已通过。

## 环境与数据

- 基线提交：`5159167800a94f79038dc8e2a18a2e3462872f9c`，项目版本 `0.9.43`。
- macOS `26.5.2`，Node `v26.8.2`，本机 Chrome、Electron、Docker `29.2.1`。
- 容器扩展使用 `open-medical-runtime:0.9-full`；PTY 用例按原脚本使用 `0.8-full`。
- 先执行生产构建，再完成主要浏览器回归。全量检查最后也执行了生产构建。
- 医疗测试使用内存或独立临时数据库及合成患者；没有使用现有患者库。真实模型仅使用项目已有配置处理合成测试资料；没有操作真实微信联系人或发送真实消息。
- 原始证据目录：[`output/playwright/e2e-20260924`](../output/playwright/e2e-20260924/)，其中日志和截图为本机产物，通常不纳入 Git。

## 执行结果

| 批次 | 结果 | 证据 |
| --- | --- | --- |
| `npm run check` | lint 通过；854 项中 829 通过、25 跳过、0 失败；构建通过 | `check.log` |
| 显式开启 Docker 和真实模型扩展 | 51 项：49 通过、1 失败、1 跳过 | `extended.log` |
| 真实 Office/PDF/ZIP 容器及 PTY | 15/15 通过 | `runtime.log` |
| 本机 Office 排版与文档助手 | 2/2 通过 | `office.log` |
| 远程协调器/worker 与平台回归 | 7/7 通过 | `remote.log` |
| Electron 真实浏览器工具 | PASS：隔离、网络限制、操作批准、截图 | `browser-tools.log` |
| 相似病例旧步骤诊断复现 | 再次复现面板等待超时；保留截图与会话证据 | `similar-diagnostic.log`、`similar-entry.txt` |
| 相似病例修正后的真实模型复测 | 1/1 通过，列表数量和详情展示均通过 | `similar-retest.log`、`similar-passed.png`、`similar-detail-passed.png` |
| 测试步骤修改后的 lint | 通过 | `lint-final.log` |

批次之间存在重复用例，不能直接相加。基础批次的 25 个跳过项已补过 21 个；最终是 850 个通过、4 个未运行。原始失败没有从日志中删除。[机器可读汇总](../output/playwright/e2e-20260924/summary.json)保留批次统计与剩余用例名称。

## 功能覆盖

| 功能域 | 本轮验证内容 | 层级与边界 |
| --- | --- | --- |
| 患者管理 | 手动建档、资料建档、名单预览与导入、同名处理、编号、搜索、分页、分组、编辑、归档恢复 | 浏览器、Electron 场景和 API |
| 临床档案 | 诊断、病史、用药状态、过敏未知状态、检验、时间线、来源、诊前摘要、档案提案与版本冲突 | 浏览器和 API |
| 材料采集 | 图片、扫描/文字 PDF、DOCX、XLSX、TXT、MD、JSON；后台建档、切换、恢复、失败与部分成功 | 浏览器合成样本及解析测试；指定真实样本另列 |
| 患者问答 | 新问题、追问、历史、草稿隔离、患者切换、刷新、模型咨询、停止和错误恢复 | 浏览器、真实模型、Electron；另做手动探索 |
| 产物与复核 | 本地整理、来源引用、复核通过、退回修订、待复核计数、Markdown 导出 | 浏览器与 Electron |
| 检查转诊与随访 | 收到结果、医生核对、告知结束、主动联系、追加更正、模板、下次提醒、防重复提交 | 浏览器完整流程及持久化测试 |
| 风险与诊疗辅助 | 风险确认/处理、用药规则、临床量表、DRG、治疗评估草稿 | UI/API；治疗评估补跑真实模型；不等同临床有效性验证 |
| 知识库与科研 | 建库、导入、索引、检索、来源和版本复核、停用过滤、引用；文献接口、病例库 | 浏览器/API；文献容错使用受控测试，在线相似病例使用真实检索 |
| 相似病例 | 真实模型检索、来源、比较字段、草稿、历史问答列表与病例详情 | 真实模型 + Chrome；修正旧测试步骤后通过 |
| 临床试验 | 方案导入、条件、双患者草稿隔离、初筛记录、缺失证据和排除条件 | 浏览器/API及真实模型 |
| 通用 Agent | 项目/工作区、文件范围、审批、文件修改、Git、恢复、历史分支、调度、权限、子任务、上下文 | API/集成；部分流程真实容器；项目入口和单次发送含 UI |
| 工具与扩展 | 插件、MCP、记忆、Code SDK、浏览器、PTY、预览、Office、远程任务 | 实际容器/MCP/浏览器及接口；OAuth 服务端契约有测试，未做真实第三方账号授权 |
| 桌面与通信 | Electron 通用场景、真实模型咨询、项目一次发送；微信桥接和企业微信状态/回执 | 桌面真实运行；微信/企业微信采用受控模拟，未实网发送 |
| 其他平台能力 | 媒体、视频任务、实时会话、桌面授权与远程租约 | 接口和受控服务测试；不代表真实供应商/硬件端到端验收 |

## 发现与处理

### 已修正：相似病例真实模型测试未选择历史问答

原步骤是“API 完成检索 → 打开患者 → 打开病例工作区 → 等待相似患者对照”。新版进入工作区时默认开始新问题，历史结果需从“以前的问答”打开。原测试因而等待 30 秒超时，但后台检索已完成并保存结果。

证据：诊断截图/文本显示“问一个新问题”“以前的问答 · 1”“1 份已保存结果”。代码 `src/main.jsx` 的患者入口显式传入 `newQuestion`，与界面行为一致。

修改：`tests/model-clinical-workflows.test.mjs` 增加展开历史并选中对应检索问题的操作，保留原来的完成状态、来源、草稿、病例数量和详情断言，没有放宽断言。真实模型复测通过，用时约 148 秒。没有修改产品运行代码。

### 非阻断观察

- Vite 构建提示部分 chunk 超过 500 kB；构建成功。本轮未做首屏性能基准，不能据此判断实际性能达标。
- Electron 浏览器工具验证退出成功，但日志存在 macOS `task_policy_set` 系统提示，本轮未观察到功能影响。
- 相似病例完整流程耗时有波动：本轮正确路径约 148 秒；应作为真实网络/模型体验的后续性能关注点，而非把测试通过等同于响应速度合格。

## 未完成的范围

4 个既有测试需要明确提供样本路径，当前未提供，未擅自搜索用户医疗文件：

1. `MEDICAL_INTAKE_PDF`：指定真实 PDF 的浏览器上传和本地 OCR。
2. `MEDICAL_INTAKE_DOCX`：指定真实 Word 样本离线解析。
3. `MEDICAL_INTAKE_IMAGE`：指定真实图片的模型与 OCR 链路。
4. `MEDICAL_BATCH_DIRECTORY`：指定 36 张图片批量去重、OCR、恢复和确认。

此外，Windows 实机、干净机器安装、签名/发布包、断网完整分发、长期压力运行、真实微信/企业微信账号、外部 OAuth 授权和供应商媒体/实时接口未做完整实网验收。既有模拟测试不能替代这些验证。

## 复跑关键命令

```sh
npm run build
npm run check
TEST_DOCKER_IMAGE=open-medical-runtime:0.9-full MODEL_E2E=on node --test --test-concurrency=2 tests/approval-policy.test.mjs tests/container-crash-recovery.test.mjs tests/code-mode.test.mjs tests/extensions.test.mjs tests/model-clinical-workflows.test.mjs tests/generic-upgrade.test.mjs tests/model-trial-eligibility.test.mjs tests/platform.test.mjs tests/desktop-one-send.test.mjs
TEST_FULL_RUNTIME_IMAGE=open-medical-runtime:0.9-full TEST_REAL_PTY=1 node --test --test-concurrency=1 tests/document-io.test.mjs tests/platform-completion.test.mjs
TEST_REMOTE_DOCKER=1 node --test tests/remaining-platform.test.mjs
npm run verify:browser-tools
MODEL_E2E=on node --test --test-name-pattern='similar-case lookup' tests/model-clinical-workflows.test.mjs
```

Office 专项额外将 `TEST_OFFICE_PYTHON` 和 `TEST_DOCUMENT_PYTHON` 指向具有所需依赖的 Python；本轮使用 Codex 的已安装依赖运行时。真实模型复跑需要项目有效配置和网络；报告不包含密钥。
