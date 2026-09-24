# 完整动线补充验收 · 2026-09-24

> 最新收尾结果见[全量回归及安装包验收](FINAL_ACCEPTANCE_20260924.md)，已重跑全量测试并验证包含Excel修复的新包。
> 更新：用户已提供真实资料，相关样本链路补测通过，另发现并修复Excel批注兼容问题。见[真实资料验收](REAL_SAMPLES_ACCEPTANCE_20260924.md)。下文保留前一轮时点的结果及资源缺口。

本报告接续第一轮回归，重点验证从用户入口到结果保存、重启恢复的完整流程。测试使用独立数据库、临时项目和合成患者，未操作现有患者库或真实联系人。真实模型使用项目已有配置，报告及测试代码不包含密钥。

## 已完成的连续流程

| 动线 | 实际验证 | 证据（均位于 output/playwright/journeys-20260924） |
| --- | --- | --- |
| 首次模型设置 | 空配置→输入连接信息→测试连接但不保存→保存→首次真实问答→重启→配置与问答保留；数据库无明文密钥 | live1.log 首项 |
| 患者连续工作 | UI建档→上传合成材料→真实模型提出档案变更→审批前不写档→确认→检查结果收到/核对/告知完成→随访记录→SQLite备份恢复→新咨询读取既有指标与随访 | patient-trial.log |
| 临床试验连续工作 | 同一患者→导入合成方案→保存纳排条件→真实模型初筛→离开再返回→采用结果→医生保存；未知过敏保留缺失证据 | patient-trial.log |
| 项目管理 | 连接文件夹→浏览文件→置顶/取消→归档/恢复→刷新后重开 | final-local3.log |
| 项目修改与恢复 | 真实模型提案→原文件不变→隔离验证命令成功→审批写入→选择文件Git提交→生成并审批回滚→原文恢复 | project-live4.log |
| 定时任务 | UI创建一次任务→重启服务→关闭页面→等待真实时钟触发→模型完成→重新打开查看；任务只创建一次 | project-live4.log |
| 科研统计 | 上传两份CSV→描述统计→Welch/Mann-Whitney/卡方/Fisher→两类样本量→脱敏下载→切换CSV清除旧结果→重新分析→整页入口 | final-local3.log |
| 临床速查 | 遍历全部已注册量表填表计算并校验→检验WBC→手术编码→ADR筛查→Naranjo量表跳转 | final-local3.log |
| 文献实网 | Europe PMC搜索→展开摘要入口→复制引用→导入任务材料→校验文章标题→重启后任务和材料仍在 | literature2.log |
| 扩展完整生命周期 | UI授权→真实Docker终端→本地插件检查/安装/启用→MCP配置/连接→实际调用sum_numbers→记忆保存/检索/删除→断连/移除→禁用/卸载→撤权后调用被拒 | final-local3.log；MCP工具执行通过API，其余主要配置通过UI |
| 扫描资料 | 实际本地OCR扫描PDF/图片、Word解析；36张合成图片（35张不同+1重复）→去重→OCR→刷新恢复→确认建档→保留原件 | scans2.log，4/4通过 |
| 重复操作与重启 | 12个合成患者、60轮检查跟进与随访、幂等请求、3次服务重启、每轮SQLite完整性检查 | repeat-restart/report.json；短时循环，不是5小时耐久验收 |

量表结果检查使用已注册计算函数作为UI输出参照，不能作为独立临床算法正确性证明。资料批量测试使用实际OCR和合成的模型协议响应；连续患者、项目、首次设置、试验初筛使用真实模型。备份恢复通过服务/数据库接口操作，不代表存在或验收了所有备份UI入口。

## 已修复的问题

1. 科研统计“整页打开”误入临床试验：分离数据分析页面路由。
2. 切换CSV仍显示旧数据统计：清除描述统计及检验结果，计算期间禁用来源切换。
3. ADR的Naranjo入口未选中量表：跳转时传入目标量表。
4. Europe PMC部分MED记录仅提供id，没有pmid字段：将MED id正确映射为PMID。
5. 文献同时有PMID和DOI时，UI导入同时提交两个标识而被接口拒绝：优先提交PMID。

新增 `tests/complete-journeys-ui.test.mjs`（4条连续流程）、`tests/complete-live-journeys.test.mjs`（4条真实服务流程）及Europe PMC标识回归。原相似病例测试的历史问答入口修正保留。

原始失败日志均保留。另修正两处测试自身问题：小于3条数值会按现有规则作为分类数据，切换数据集测试改为3条；浏览器需先于服务关闭，避免清理阶段人为制造Failed to fetch。

## 仍未完成的外部验收

- 用户真实脱敏PDF/Word/图片及36张实际资料：尚未提供；合成扫描样本不能代替真实样本验收。
- Windows实机，以及另一台干净Mac的安装、权限、升级和卸载。
- 微信/企业微信真实测试账号和联系人下的授权、收发与回执。没有发送真实消息。
- 第三方OAuth、真实媒体/实时供应商及麦克风/摄像头/系统控制权限完整实机链路。
- GitHub测试仓库的远端推送、PR发布闭环；本轮只完成本地Git提交和回滚。
- 多小时连续使用、睡眠唤醒、跨日调度及真实大规模数据性能。

这些项目不能标记为“已测通”。此前已询问可用脱敏样本、测试账号/联系人和Windows设备，尚未收到资源信息。

## 复跑

```sh
npm run build
JOURNEY_DOCKER=1 node --test tests/complete-journeys-ui.test.mjs
JOURNEY_LIVE=1 node --test tests/complete-live-journeys.test.mjs
npm run check
```

真实服务流程依赖项目已有有效模型配置、网络、Chrome、Git；扩展与项目隔离验证依赖本机Docker及 `open-medical-runtime:0.9-full`。没有这些前提的默认测试会跳过相应场景，不应把跳过算作通过。

## 桌面候选包专项

当前源码构建为独立 `candidate/Open Medical-darwin-arm64`，未替换用户已安装应用。候选包源码匹配、10,400项完整性检查、隔离HOME下Electron启动/页面/数据库/产物/本机工具沙箱均通过，启动后包完整性仍通过（`candidate-verification.json`）。资源递归扫描确认未夹带本地数据库或配置密钥（`package-resources.json`）。这是本地ad-hoc签名，不是公证发布版。

使用现有断网安装验证脚本的诊断副本，仅改为指向本次候选包和证据目录。外层Seatbelt阻止外网的验证中，Chromium子进程报告 `sandbox initialization failed: Operation not permitted`，页面加载失败（`install-offline.log`、`install/disconnected-mac.json`）。此项记录为环境阻塞/未通过，没有关闭浏览器沙箱来绕过。

正常网络对照中，真实安装脚本安装到临时用户的Applications后启动成功，页面、数据库、产物与工具沙箱均通过（`install-online.log`、`install/mac-fresh-install.json`）。已移除开发PATH且使用全新用户数据，但仍是同一台Mac，不能代替干净实机/虚拟机验收。

## 最终回归结果

- `npm run check`：863项，834通过、29按环境条件跳过、0失败；lint与生产构建通过，用例约315秒（`full-check-final.log`）。这些包含单元、接口、集成、浏览器与桌面测试，不是863条浏览器动线。
- 新增4条本地连续流程显式启用Docker后4/4通过（`final-local3.log`）。
- 新增4条真实服务连续流程逐条通过：首次设置见 `live1.log` 首项；项目/定时任务见 `project-live4.log`；患者/试验见 `patient-trial.log`；文献见 `literature2.log`。批次之间不能直接相加。
- 默认跳过项并非未做过：其中既有Docker、Office、PTY、真实模型等专项见第一轮报告；4个资料路径用例本轮用合成扫描样本补跑通过。真实用户样本仍缺失。
- 最终生产构建后再次校验候选包与当前源码一致，完整性通过（`candidate-final-integrity.json`）。
- `git diff --check`通过。Vite仍有大于500kB的chunk体积提示，未做首屏性能基准。

结论：本机可用资源下的上述完整流程已验收并修复发现的问题；断网安装验证及列明的外部资源流程尚未测通，不能宣称所有环境下所有功能已通过。
