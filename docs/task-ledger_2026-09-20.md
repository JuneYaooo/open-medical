# W0—W9 任务账本(通用底座优化)

依据:`docs/自研通用Agent底座实测与改进路线_2026-09-20.md`(W0—W9 委托范围)。本账本由实施侧维护;状态取值 pending / in_progress / self_verified / independently_verified / blocked。

## 环境基线(W0,2026-09-20 复核)

| 项 | 值 |
| --- | --- |
| 仓库 | E:\Github_fork\open-medical-workbench,HEAD `2cb3182`(0.9.7),与路线文档基线一致 |
| 平台 | Windows 10 19045 x64,Git Bash |
| Node | 系统 node v18.16.0(D:\software\node)。项目依赖 `node:sqlite`,Node 18 无法运行任何测试。已下载便携版 Node **v24.19.0** 至 `C:\Users\admin\.zcode-tools\node-v24.19.0-win-x64\`,后续所有命令用它(`export PATH="/c/Users/admin/.zcode-tools/node-v24.19.0-win-x64:$PATH"`)。路线文档所述"本机 Node 24.19.0"未在常规位置找到,判断为此前会话为临时解压,已重新 provision |
| 未提交改动 | `server/agent.mjs`(3.1 静态资源 sep 修复)、`server/core/browser-tools.mjs`(3.2 fileURLToPath 修复)、`tests/web-search.test.mjs`、新增 `tests/cross-platform-paths.test.mjs`。已用 Node 24 复跑:9/9 通过。保留,不 reset |
| Docker | CLI 存在,daemon DOWN → ProcessRunner 容器执行后端当前不可用 |
| 模型配置 | 全机检查 `.open-medical-workbench`、`.open-medical-agent`、model.env 均无 → **真实模型评测 blocked**,不得以模拟冒充 |

## 第 3 节问题核对(W0)

| 编号 | 问题 | 本次核对结果 |
| --- | --- | --- |
| 3.1 静态资源 403 | Windows 路径 sep 拼接 | 已修复(工作区代码,未提交);回归测试通过 |
| 3.2 浏览器工具拒合法 file URL | URL.pathname 解析 | 已修复(工作区代码,未提交);回归测试通过 |
| 3.3 独立通用服务无通用前端 | 医疗首页/接口不存在 | 代码层面未修复;由 W2 子代理启动实测复核后修复 |
| 3.4 assertWriteScope 跨平台 | `relative()` 产生反斜杠 vs `scope + "/"` 比较 | **确认仍在**(workspace-service.mjs:494 及 :511 writePaths 比较),W1 修复 |
| 3.5 执行环境前置 | Docker daemon DOWN | 环境事实,如实记录;W3 做就绪探测与指引 |
| 3.6 普通项目默认医疗化 | createMedicalWorkspaceDomain 全量注入 | 未修复,W6 处理(能力分层/按需启用) |

## 分包状态

| 包 | 状态 | 执行者 | 证据 |
| --- | --- | --- | --- |
| W0 基线与证据 | self_verified(基线记录、问题分类完成) | 主会话 | 本文件 + 回归测试 9/9 |
| W1 路径与生命周期 | self_verified(主会话独立复跑 17 测试 0 失败,原挂起文件自然退出) | 子代理 A | 见下「W1 交付摘要」 |
| W2 通用 App Shell | self_verified(主会话复跑 platform-shell 3/3,含真实 Edge 通用闭环+医疗不回归;lint 过) | 子代理 B | platform.mjs capabilities + 前端 medicalEnabled 门控;tests/platform-shell.test.mjs |
| W3 模型配置定位 | self_verified(verify-model 重写:配置发现+分阶段检查;真实模式如实 blocked,合成自检 5/5;lint+3/3 测试) | 主会话 | scripts/verify-model.mjs、tests/verify-model.test.mjs |
| 评测运行器适配(general-agent-v1) | self_verified(主会话独立复跑:预检 pass/哈希 ba4ed606…、验收器自测 69 样例全绿、新增测试 12/12、mock 冒烟 3/3) | 子代理 C | scripts/eval-v1/、output/eval-v1/(REPORT.md);真实模型 90 次 = blocked(无凭据) |
| W4 状态与事件统一 | self_verified(主会话复跑 run-status/delivery-evidence/session-bridge/server 32/32 + lint) | 子代理 D | server/core/run-status.mjs、server/core/delivery.mjs |
| W5 结果验证与恢复(服务端) | self_verified(同上;三场景:空口完成→answered+gaps、真实产物→delivered+哈希、纯问答不受影响) | 子代理 D | agent-runtime onDelivery seam、runtime.mjs delivery/outcome、session-bridge 派生投影 |
| W5 结果验证与恢复 | pending | — | 待补 |
| W6 上下文与工具发现 | self_verified(主会话复跑 fusion/capability-snapshot/server 27/27 + lint;真实模型 A/B 记为待评测) | 子代理 E | medical-workspace-domain systemFor 门控 + agent.mjs capabilities/capabilitySnapshot;modeFlags.medical 显式启用 |
| W7 交互闭环 | self_verified(主会话复跑 run-presentation+platform-shell 8/8,含真实 Edge 用例;lint 过) | 子代理 F | src/workbench/run-status{.js,-view.jsx}、main/workspaces 呈现层;医疗统一内核会话 steer 接通 |
| W8 扩展质量 | self_verified(extensions/mcp-http/scheduler/skills-system/agent-capabilities 套件通过;修复离线插件 Windows 安装 EPERM) | 主会话 | 见下「W8 交付摘要」 |
| W9 通用发布门槛 | 部分(工程门槛全绿:75 文件 0 失败 0 超时、全仓 lint 过、生产构建过、eval 基建终态 3/3;真实模型 90 次/双平台/留出集/外部对照 = blocked/未做) | 主会话 | 见下「W9 交付摘要」 |

## 验收锚点

### W1 交付摘要(子代理 A,主会话已独立复跑核心测试)

- 根因:`path.relative()` 平台分隔符输出 vs `scope + "/"` 字面量比较,共三处(assertWriteScope、agent-team spawn/#normalizeWriteScope、scripts/remote-worker.mjs)。
- 修复:`server/core/write-scope.mjs` 新增 `posixRelative`/`scopeCovers`(单向包含,不扩权);真实路径与符号链接检查保留;大小写语义跟随既有 `scopeKey`(win32/darwin 折叠)。
- 挂起根因:node:test after 钩子 FIFO 且抛错中止剩余钩子;Windows 下 rmSync 先于 server.shutdown() 跑 → EPERM → shutdown 不执行 → HTTP 句柄存活。修复:钩子注册顺序(shutdown 先、rmSync 后)。medical-workspace-fusion、model-switching 均在 ~3s 自然退出,未用 force-exit。
- 测试:12 个相关文件 101 tests / 88 pass / 0 fail / 13 skipped(跳过均带原因:符号链接权限、Docker、PTY);新增 tests/write-scope-paths.test.mjs(5/5)。
- 附带:remote-worker.mjs Windows 越界误拒修复(有测试)。回退:按文件 `git checkout --`。

### W2 交付摘要(子代理 B,主会话已独立复跑 3/3)

- 根因:前端不按能力字段判断模式,默认挂载医疗首页并发起 /api/patients、/api/sessions 等医疗请求(无降级)→ 通用服务全 404 → 全局错误态。
- 修复:platform.mjs bootstrap 新增 `capabilities{workspaces,modelSettings,medical}`(只加不改);前端 `medicalEnabled(config)`(capabilities 优先、patientsEnabled 回退)门控导航/首页/轮询/文案;通用模式默认进项目工作区,创建→执行→产物预览→继续闭环经真实 Edge 验证(脚本模型,如实标注);医疗模式经 Edge 验证不回归。
- 剩余:agent.mjs(医疗服务端)尚无显式 capabilities 字段(靠回退),列入 W6。

### W4/W5 交付摘要(子代理 D,主会话已独立复跑 32/32)

- 新增 `server/core/run-status.mjs`:§12 最小状态集(queued/running/waiting_approval/waiting_input/blocked/cancelled/failed/completed + interrupted 准终态)、RUN_TRANSITIONS 合法转移表、`deriveRunStatus` 单一判定源、`waitingReasonFor`;旧字段 status 取值与语义不变,新增 `derivedStatus`/`waitingReason`。
- 新增 `server/core/delivery.mjs` + agent-runtime `onDelivery` seam(可选钩子,未提供时行为不变;钩子异常→`delivery.unverified` 事件,不伪造);runtime.mjs 完成路径持久化 `delivery{delivered,evidence[],gaps[]}` + `outcome`(answered/delivered,completed 的结果分类);session-bridge 复用同一 deriveRunStatus,不建第二套判定。
- 证据:文件存在+可读+sha256 / 结构化产物回执 / 沙箱与子代理回执;空口"已完成"→answered+no_verifiable_output。
- 剩余:统一内核 workspace-service 完成路径的 delivery 接线(后续包);waiting_input 无写入方(预留契约);执行类判定按意图,边界分布待 W9 评测校准。
- 已知无关失败:tests/store.test.mjs 2 例(Windows chmod 断言与既有钩子顺序问题,不导入本次改动模块)。

### W7 交付摘要(子代理 F,主会话已独立复跑 8/8)

- 现状:通用模式链路完整但等待语义缺失(待审批仅运行中可见);医疗模式不分等待/受阻、执行中输入禁用、完成呈现两档署名。
- 实现:`src/workbench/run-status.js` 纯逻辑(优先服务端 derivedStatus,通用模式按"running+待审批数"展示层归一,不伪造服务端语义)+ `RunStatusNotice`(等待/受阻提示,审批入口,运行结束后持续可见)与 `OutcomeCard`(delivered 带哈希证据/answered 带缺口,绝不把 answered 显示成交付);医疗统一内核会话执行中输入可用、追加走 steer(与通用同入口)。
- 真实 Edge 用例:通用审批闭环(等待提示→批准→写入→预览,全程无虚假"已交付");医疗 delivered/answered 两态+执行中追加实测。
- 剩余缺口(如实):通用工作区接口(publicWorkspace)尚未下发 derivedStatus/delivery(服务端投影只接了医疗会话),前端展示层归一为过渡;医疗 workbench 无审批面板(默认自动写入,仅解释性提示);steer 对旧引擎会话不可用(服务端无通道)。

### W6 交付摘要(子代理 E,主会话已独立复跑 27/27)

- 根因:医疗领域以服务级单一 domain 叠加 GenericDomain 且无 systemFor,回退使所有项目工作区获得医疗纪律文本与 25 个医疗插件直注。
- 修复:`medicalWorkspaceEnabled(w)` 单一判定(session 恒医疗/项目按 `modeFlags.medical` 显式启用,经既有 setModeFlag 写入);systemFor 与 registerTools 共用谓词,指令与工具面不可能半开;显式入口:创建 `domain:"medical"` 别名 + 运行时 `/api/workspaces/:id/domain`(revision 409/session 拒切)。agent.mjs bootstrap 补 capabilities(与 platform.mjs 契约一致)。
- capabilitySnapshot 最小实现:authorized/ready/executable 三态+reason+remedy;真实 Docker-down 环境 terminal_* 正确标"authorized 但 not ready"并给安装指引;code_execute(应用内隔离)不受容器门控。
- 工具面事实(创建即默认权限口径):普通项目 26 工具/7,813 字符/无医疗泄漏;医疗项目 51/17,505;session 66/22,330(不变)。不作效果宣称,待真实模型 A/B。
- 修正的过时测试断言:普通项目必带医疗工具 → 移至显式医疗项目,普通项目反向断言无医疗+5 核心工具完整;原因已记录。
- 剩余:newTask/fork 不继承 medical flag(建议一行补齐,在 workspace-store/service);切换路由极小 TOCTOU 由运行中检查兜底。

### W9 交付摘要(主会话,2026-09-20 终态)

**回归扫描**(文件级,单文件 120s 上限,Node 24.19.0,输出 `output/sweep-20260920/`):
- 75 个测试文件全部正常结束(**0 超时**;基线审计:2 文件超时)。
- 扫描时点 343 过/7 失败/72 跳过;7 个失败逐一修复后终态:**349 过 / 0 失败 / 73 跳过**(基线:278 过/22 失败/66 跳过)。跳过均带原因(Docker daemon、PTY、符号链接权限×3、POSIX docker stub×1、redesign-e2e 的 Mac 前置等环境类)。
- 7 个失败的处置:harness-guidance 1(POSIX sh stub 在 Windows 不可执行,Node 安全策略禁 spawn .cmd;带因跳过,断言需 POSIX/真实 docker 覆盖);store 2(Windows chmod 位断言→POSIX 门控+文件存在断言;清理钩子顺序→先关库后删目录);wechat-bridge 3(产品 darwin 闸门×fakeRunner 无法过;加 `platform` 构造注入缝(同 extensions.runner 先例),fixture 注入 darwin,桥接逻辑在 Windows 也可测,默认行为不变);workspace-cli 1(同类钩子顺序)。
- 全仓 `npx eslint .` 0 错误(含修复子代理遗留的 eval-v1 38 个 lint 错误:未用变量/死代码/多余转义,行为不变);eval-v1 测试修复后复跑 12/12。
- 生产构建 `npx vite build --configLoader runner` 通过。

**eval-v1 终态复跑**(绑定最终工作区,code_revision=2cb3182+dirty_diff):
- 预检 pass(数据集哈希 ba4ed606…);验收器自测 69 样例全绿;mock 冒烟 3/3(C02/F01/R03,`output/eval-v1-final/`)。
- **真实模型 90 次正式评测:blocked**(本机无任何模型凭据,`node scripts/eval-v1/run.mjs --cases=all --repeat=3 --model=real` 无凭据时立即 blocked 退出,不以 mock 冒充)。解除条件:在 `%APPDATA%\Open Medical Workbench\model.env` 或仓库 `.env` 配置任一 provider 凭据后重跑(verify-model 会列出全部搜索位置)。

**未完成/受限项(如实)**:
1. 真实模型全部评测(30×3=90 次)、故障矩阵 X01—X12、T02 长变体真实压缩——需模型凭据。
2. 双平台:本轮全部证据为 Windows;macOS 启动/执行/取消恢复冒烟未做(L1 双平台放行条件未满足)。
3. 通用工作区接口(publicWorkspace)尚未下发 derivedStatus/delivery(医疗会话路径已下发;通用模式前端已按持久事实展示层归一,W7 留好消费点)——建议下一批把 workspace-service 完成路径接上 onDelivery。
4. S04 独立公式引擎重算(node_modules 无 hyperformula;已做显式降级求值器)、D01 版式渲染检查(无 Word/LibreOffice)——已记 blocked,不冒充通过。
5. Docker daemon 未运行:容器执行类能力(Python 沙箱、完整办公产物)在本机不可用;capabilitySnapshot 已如实标注"已授权但环境未就绪+安装指引"。
6. 评估方步骤未做:数据集 1.0.0 冻结、私有留出集、外部对照、独立复核(非实施者)。
7. L3 门槛(90% 成功率等)因真实评测 blocked 未验证,不得宣称达到 L3;当前可声明的是工程门槛与基建就绪。

### W8 交付摘要(主会话)

- 套件结果:extensions 7 过/0 失败/3 跳过(3 连跑稳定);mcp-http、scheduler、skills-system、agent-capabilities 通过(合计 24 项)。
- **修复路线文档 §2 定位的离线插件安装 Windows EPERM**:根因是同 hash 幂等重装时,Windows 对"rename 到已存在目录"报 EPERM 而非 EEXIST;`server/core/plugins.mjs` 的幂等分支显式纳入 `EPERM && 目标已存在`(与 POSIX EEXIST/ENOTEMPTY 同路径),语义不变(哈希命名目录不可变)。
- 测试假设修正:extensions.test.mjs 末尾的符号链接逃逸断言在无符号链接权限的 Windows 上连前置 symlinkSync 都会 EPERM;拆为独立测试并加能力探测 skip(带具体原因),POSIX/开发者模式下仍执行。原因与保留边界符合总指令。
- 真实 stdio MCP 握手为环境跳过;MCP 基准能力由 mcp-http 套件 + eval-v1 M01/M02(真实隔离 MCP 服务、服务端访问日志、幂等回执)覆盖。
- 已知无关失败:tests/store.test.mjs 2 例(Windows chmod 断言 + 既有钩子顺序,未导入本轮改动模块,另行处理)。

### 评测运行器交付摘要(子代理 C,主会话已独立复跑)

- 新增 `scripts/eval-v1/`(13 模块):precheck、validators(30 判定函数)、selftest、mock-model、run 控制器;lib(zip/xml/pdf-writer/xlsx-check/browser-check/services/fixtures)。未改动既有脚本与 cases.json/protocol.json。
- 关键落实:独立工作区+运行标记+初始/终态哈希+工具轨迹+服务回执防旧产物冒充;M01/M02 数据仅经隔离 MCP 服务暴露;C03 接口约定由控制器附加;R03 随机端口资料站;T01/T03 轮次控制;A01 审批+拒绝分支副作用=0;A02 暂停→恢复。
- 独立复核证据:预检 pass(数据集/协议哈希已记录);验收器自测 69 样例(31 正确全过+38 错误全拒,含四类指定错误样例);mock 冒烟 3/3(C02/F01/R03,明确标注 mock);真实模式无凭据时立即 blocked 退出。
- blocked(如实):真实模型 90 次正式评测;S04 独立公式引擎(node_modules 无 hyperformula,已做显式降级求值器);D01 版式渲染(无 Word/LibreOffice,已做结构级);故障矩阵 X01—X12 与 T02 长变体真实压缩(依赖真实模型)。
- 正式验收(用户要求的验证集验收)入口:`node scripts/eval-v1/run.mjs --model=real`(需先配置模型凭据);mock 模式仅验基建。

- 验证集:`evals/general-agent-v1/`(cases.json 30 项 + protocol.json + README 规则),按其 README "接入工作交给实施 Agent" 第 1—7 条执行。
- 真实模型 blocked 时:完成数据预检、夹具、验收器、验收器自测(正确+错误样例)、模拟协议冒烟;正式 90 次评测记 blocked,不伪造。

## N1—N6 修复轮(2026-09-20 复核后,基线 798cd75)

依据《ZCode下一轮修复指引_0.9.8复核后_2026-09-20.md》。逐包根因/修改/证据/剩余风险详见 `docs/N1-N6修复交付摘要_2026-09-20.md`。环境事实:Docker daemon DOWN(N1 真实容器验证 blocked);无模型凭据(真实评测 blocked);Node 24.19.0 便携版。

| 包 | 状态 | 证据锚点 |
| --- | --- | --- |
| N1 执行与验收隔离 | self_verified(宿主逃逸已封死;真实容器路径 blocked=Docker daemon DOWN,无宿主回退) | lib/execution-backend.mjs、validators runModule(nonce 防伪+篡改快照)、hashTree 边界;tests/eval-execution-backend.test.mjs 11 过/1 跳过(带因) |
| N2 检查级状态与汇总 | self_verified | lib/checks.mjs 单一聚合;validators CheckList 化;S04/D01 必需项缺引擎/渲染 → blocked;selftest 71 样例全绿(含 blocked 期望);run.mjs 正式 stage blocked → exit 2 |
| N3 通用交付契约主路径 | self_verified(服务集成 10/10 + 真实 Edge 2/2) | WorkspaceService onDelivery 接线+落库 delivery/outcome;AgentRuntime unverified/取消晚到/重试反馈;OutcomeCard 四态;publicWorkspace/SessionBridge 下发 |
| N4 医疗交付按目标核对 | self_verified | runtime.mjs 回执 ok/失败进缺口、沙箱无产物缺口、consultation→null、待复核语义;tests/medical-delivery.test.mjs 5/5 穿真实 MedicalRuntime;既有 answered→delivery_failed / unverified 为有意语义收紧 |
| N5 统一模型配置发现 | self_verified | server/core/model-config.mjs 纯函数发现(桌面→repo→环境优先级、跨提供方不拼接、损坏报错、local 合法、脱敏);verify-model/eval-v1 共用;tests/model-config.test.mjs 10/10 |
| N6 全任务轨迹与预算 | self_verified(mock 协议级;真实模型评测 blocked) | run.mjs 2.0.0-n1n6:trialId+逐轮记录+整项预算(墙钟/轮次/工具调用真实执行)+attempt 目录+变体门控+故障注册表(X02/X04/X07/X11/X12 实现;X01/X03/X05/X06/X08/X09/X10 declared-not-implemented 只出 blocked)+dirty diff 内容哈希 |

上轮遗留核对:W5"通用服务端 delivery 接线"与"评测运行器可信性"两个 pending 已由本轮 N3/N1/N2/N6 关闭;W9 未完成项中"publicWorkspace 下发 derivedStatus/delivery"已随 N3 落地。原 W0—W9 各条目的 self_verified 仅覆盖其当时范围,不自动继承为本轮证据。

真实模型 90 次正式评测、S04 独立引擎、D01 渲染通道、T02 长变体真实压缩:X01/X03/X05/X06/X08/X09/X10 故障触发器为 declared-not-implemented ——均如实 blocked,不阻塞本轮缺陷修复交付;完整 L3 认证未做,与本轮完成分开报告。
