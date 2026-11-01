<div align="center">

<img src="public/favicon.svg" width="76" height="76" alt="Open Medical 标识" />

# Open Medical

### 希望做和医生一起成长的桌面 Agent。

开源桌面 Agent · 患者与资料 · 知识与任务

[![License: MIT](https://img.shields.io/badge/License-MIT-28735b?style=flat-square)](LICENSE)
[![Desktop](https://img.shields.io/badge/Desktop-macOS%20%7C%20Windows-334155?style=flat-square)](docs/DESKTOP.md)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.18-28735b?style=flat-square)](package.json)

**中文** · [English](README_EN.md)

[观看演示](#产品演示) · [快速开始](#快速开始) · [使用指南](docs/DOCTOR_WORKBENCH_GUIDE.md) · [文档导航](#文档导航)

</div>

---

Open Medical 是面向医生的开源桌面 Agent，运行于 macOS / Windows。通过自然语言管理患者、资料、知识与任务，把病历整理、文献检索、文书准备和持续随访连接起来。我们希望它能逐步融入医生的知识积累与工作习惯，成为一起成长的助手。

**资料在本机积累，模型按需连接，结果由医生复核。** 支持本地 Ollama / vLLM，以及 DeepSeek、OpenAI、Anthropic、OpenRouter 和 OpenAI 兼容服务。

![患者诊前概览](docs/assets/features/patient-overview.png)

## 从这里开始

| 你想做什么 | 入口 |
| :--- | :--- |
| 安装并运行 | [快速开始](#快速开始) |
| 建档、读报告、准备文书 | [患者与诊疗资料](#patients) · [任务模板](#clinical-templates) |
| 处理今日待办、随访和消息 | [待办、随访与消息](#followup) |
| 管理知识、查文献和做研究 | [知识与研究工具](#knowledge) |
| 使用文件工具、模型与自动化 | [工作区与个性化](#workspace) |

## 产品演示

**观看产品演示 · 79 秒**

[![Open Medical 产品演示：患者档案、随访与个人知识库](docs/assets/open-medical-preview.gif)](https://github.com/JuneYaooo/open-medical-workbench/blob/main/docs/assets/open-medical-tour.mp4)

<p align="center">
  <a href="https://github.com/JuneYaooo/open-medical-workbench/blob/main/docs/assets/open-medical-tour.mp4"><strong>▶ 观看完整演示 · 79 秒 · 中文配音与字幕</strong></a>
  <br />
  <sub>点击上方预览打开视频。演示使用示例资料，部分界面随版本迭代有所调整。</sub>
</p>

## 快速开始

已有桌面包时，macOS 打开 `Open Medical.app`，Windows 从完整便携目录运行 `Open Medical.exe`。应用会自动启动本地运行时，无需打开浏览器或手动启动服务。

从源码启动需要 **Node.js ≥ 22.18** 和 npm：

```bash
git clone https://github.com/JuneYaooo/open-medical-workbench.git
cd open-medical-workbench
npm ci
npm run build
npm start
```

`npm start` 会直接打开桌面应用；`npm run desktop`、`npm run agent` 和 `npm run harness` 使用同一入口。

**首次使用：** 点击“示例体验 → 准备全部示例”浏览现成资料；或新建患者 → 添加资料 → 选择模型 → 发起整理任务。无需配置模型，也能管理患者档案、登记临床资料和随访记录；向助手提问和发起任务需要先连接模型，未连接时不会给出替代回答。

### 构建桌面包

在对应系统中构建便携桌面包：

```bash
npm run package:mac    # macOS
npm run package:win    # Windows：在 Windows 上构建
```

输出位于 `release/`。macOS 打开 `.app`，Windows 从完整便携目录运行 `Open Medical.exe`。源码启动与安装包共用桌面数据目录；关闭窗口后可继续在后台运行，退出应用会停止任务。安装、平台验证与签名限制见 [桌面版说明](docs/DESKTOP.md)。

### 连接模型

在 **设置 → 模型与运行 → 选择模型** 中查看并切换可用连接。服务地址与密钥可通过连接配置管理，也可在 **设置 → 桌面应用 → 应用维护 → 打开配置目录** 中编辑 `model.env`，填写 `AI_PROVIDER` 与对应密钥后重启应用。

| 方式 | 适用场景 |
| :--- | :--- |
| 本地 Ollama / vLLM | 使用自己部署的模型；模型与依赖就绪后可离线运行。 |
| DeepSeek / OpenAI / Anthropic / OpenRouter | 使用自己的 API 密钥连接外部服务，费用由对应服务商收取。 |
| OpenAI 兼容接口 | 连接自建或第三方兼容端点，自行填写地址和模型 ID。 |

上下文窗口与最大输出可在连接配置中调整。外部模型会接收获授权的材料原文及相关上下文；选择本地存储并不意味着云模型请求不会外发。

## 功能导览

以下界面使用虚构示例资料。展开条目查看功能说明与截图，点击图片可查看大图。

<a id="patients"></a>

### 患者与诊疗资料

<details>
<summary><strong>患者管理与建档</strong></summary>

按姓名、编号、分组和标签查找患者，维护在管与归档状态。支持手动建档、名单导入，以及上传病历、报告等材料后核对建档结果；名单导入先预览，不直接覆盖既有档案。

![患者管理与建档](docs/assets/features/patients.png)

![患者管理与建档](docs/assets/features/patient-import.png)

</details>

<details>
<summary><strong>诊前概览</strong></summary>

在同一页回顾诊断、用药、过敏、近期检验和未完成事项，再进入相应记录查看细节与来源。适合接诊前快速了解患者现状。

![诊前概览](docs/assets/features/patient-overview.png)

</details>

<details>
<summary><strong>诊断、病史与就诊记录</strong></summary>

集中维护病史摘要、诊断和就诊记录，保留日期与来源；通过核对与编辑补充缺失信息。就诊历史与原始材料始终关联同一位患者。

![诊断、病史与就诊记录](docs/assets/features/patient-clinical.png)

![诊断、病史与就诊记录](docs/assets/features/patient-visits.png)

</details>

<details>
<summary><strong>用药、过敏与治疗方案</strong></summary>

区分在用、停用和待核对用药，记录剂量、频次及过敏信息。治疗方案可保存目标、干预措施、复查日期和评估记录；风险提示只覆盖内置规则。

![用药、过敏与治疗方案](docs/assets/features/patient-medications.png)

</details>

<details>
<summary><strong>检验导入与趋势对照</strong></summary>

导入或登记检验结果，保留项目、日期、数值、单位和出处，并按时间查看趋势。同日冲突保留供核对，不把不同单位的结果混为一条趋势。

![检验导入与趋势对照](docs/assets/features/patient-labs.png)

</details>

<details>
<summary><strong>患者资料库</strong></summary>

将病历、报告和用药清单归到患者名下，在资料库中阅读原文、搜索文件并继续发起整理任务。资料与任务结果可以持续积累，减少重复上传。

![患者资料库](docs/assets/features/patient-library.png)

</details>

<details>
<summary><strong>诊前准备与临床辅助</strong></summary>

带着当前患者的档案与所选材料发起问题，准备诊前要点、诊后文书或相似病例比较。档案更新以待确认提案呈现，核对后再写入。

![诊前准备与临床辅助](docs/assets/features/patient-assistance.png)

</details>

<a id="clinical-templates"></a>

### 临床与写作任务模板

从“示例体验 → 任务模板”进入。模板会带入患者上下文与任务要求；连接模型并核对材料与授权后发送，结果仍需医生复核。

| 模板 | 用途 |
| :--- | :--- |
| **收治病例全流程** | 一次整理时间线、检验摘录、用药与过敏信息。 |
| **整理病历** | 把零散记录按就诊时间整理，保留原文出处。 |
| **摘录检验** | 提取项目、数值与单位，供对照原文核查。 |
| **核对用药资料** | 整理用药清单和缺失字段。 |
| **生成病历草稿** | 按主诉、病史、查体等结构整理，缺失项待补充。 |
| **用药辅助提醒** | 按药物类别提示过敏及交叉过敏、相互作用、同类重复用药和特殊人群用药；规则可能漏报，没有提醒不代表没有风险。 |
| **患教大白话** | 把已有方案与说明改写为患者易懂的草稿。 |
| **检验报告解读** | 依据报告打印的参考范围整理异常项与解读草稿。 |
| **出院小结草稿** | 整理住院经过、带药与已有随访医嘱。 |
| **值班交班记录** | 整理当前问题、关键事件和待交接事项。 |
| **诊疗决策流程图** | 从知识库依据生成 Mermaid 流程图与节点出处。 |
| **不良反应筛查** | 匹配用药与可疑表现，辅助准备 Naranjo 评估。 |
| **个案报告写作** | 按 CARE 框架组织病例资料与讨论要点。 |
| **准备循证检索** | 整理 PICO、检索式与证据核查步骤。 |

随访计划、问卷与结果登记见下方[待办、随访与消息](#followup)。

<a id="followup"></a>

### 待办、随访与消息

<details>
<summary><strong>今日待办与复诊安排</strong></summary>

汇总到期随访、复诊、检查转诊和患者提醒，点击事项回到相应患者。预约页面保存复诊时间、原因和处理状态。

![今日待办与复诊安排](docs/assets/features/agenda.png)

![今日待办与复诊安排](docs/assets/features/patient-appointments.png)

</details>

<details>
<summary><strong>随访计划、问卷与联系记录</strong></summary>

使用模板或自定义节点安排随访，填写问卷与核对清单。登记已联系、未联系上或拒绝等实际结果，保存联系时间、补充记录和下一次安排；产生提醒不等于已完成联系。

![随访计划、问卷与联系记录](docs/assets/features/followup-plans.png)

![随访计划、问卷与联系记录](docs/assets/features/patient-followups.png)

</details>

<details>
<summary><strong>专病管理包与快速做问卷</strong></summary>

专病管理包把一个病种的一年随访节点、随访问卷、检验监测阈值和患教素材打包在一起，目前内置高血压和 2 型糖尿病。在「设置 → 技能与规则 → 专病管理包」安装后，随访模板出现在患者随访页，患教素材导入知识库「患教素材」，可用于企业微信推送和医生分身科普；也可以在对话里说“把这位患者按高血压管起来”，确认提案后生效。新增病种只需在 `plugins/care-packs/packs/` 加一个 JSON 文件。

对助手说一句“给术后患者做个伤口和疼痛问卷”，它会生成问卷，预览患者在企业微信或微信里收到的文字和预警规则，再按你的选择保存给一位患者或存成可复用模板。患者按题号回复后，系统在本机解析、计分，触发预警时进入今日待办。配套技能：快速做随访问卷、企业微信患者触达、专病管理包入组。

</details>

<details>
<summary><strong>检查与转诊跟进</strong></summary>

按“待收结果 → 待医生核对 → 待告知登记 → 已结束”跟进，记录结果来源、核对意见和告知情况，也可调整、取消或重开事项。当前为本机登记，未接入医院检验或转诊系统。

![检查与转诊跟进](docs/assets/features/patient-tracking.png)

</details>

<details>
<summary><strong>患者消息与回复复核</strong></summary>

将患者消息、提醒和待回复草稿集中处理，关联患者后回看聊天与档案。可编辑或丢弃草稿；真实收发需要配置相应渠道与授权。

![患者消息与回复复核](docs/assets/features/messages.png)

</details>

<details>
<summary><strong>自动随访与聊天归档</strong></summary>

通过已连接的企业微信或个人微信渠道整理随访。个人微信流程支持 AI 起草、医生确认发送、回复按条目整理与确认归档；聊天随访用于把既有对话整理为跟进记录。

![自动随访与聊天归档](docs/assets/features/followup-auto.png)

![自动随访与聊天归档](docs/assets/features/followup-chat.png)

</details>

<details>
<summary><strong>私聊助手、医生分身与医生提醒</strong></summary>

在设置中分别连接私聊助手、医生分身和医生提醒。医生分身根据你的知识库对外提供科普，按你的习惯在群聊或单聊中回答患者和公众的常见问题，不做个体诊断，目前支持飞书渠道；往来会话自动记录、可做 AI 总结与风险复核；提醒可设置发送时间与内容；各渠道需要对应账号和配置。

![私聊助手、医生分身与医生提醒](docs/assets/features/settings-knowledge-bot.png)

![私聊助手、医生分身与医生提醒](docs/assets/features/settings-notifications.png)

</details>

<a id="knowledge"></a>

### 知识、病例与研究工具

<details>
<summary><strong>知识库导入与资料管理</strong></summary>

按用途建立知识库，收录指南、操作手册、模板和患教资料。阅读、导入与后台处理集中在资料页，患者材料与公共知识分别管理。

![知识库导入与资料管理](docs/assets/features/knowledge.png)

![知识库导入与资料管理](docs/assets/features/knowledge-documents.png)

</details>

<details>
<summary><strong>检索与原文溯源</strong></summary>

按问题、关键词、资料类别和来源状态检索，打开命中的原文行号核对依据，再带着问题继续问答。未配置可用嵌入服务时仍可使用关键词检索，界面会提示语义检索不可用。

![检索与原文溯源](docs/assets/features/knowledge-reader.png)

</details>

<details>
<summary><strong>来源、版本与引用权限</strong></summary>

维护作者或机构、年份、来源链接与版本，停用过期资料并保留历史引用。对外引用单独授权，修改来源信息后需要重新开启。

![来源、版本与引用权限](docs/assets/features/knowledge-source.png)

</details>

<details>
<summary><strong>知识图谱与资料结构图</strong></summary>

从资料生成实体关系、思维导图或流程图，并从节点回到原文。截图展示生成入口；需要配置整理模型，提取不到依据时不会凭空补齐关系。

![知识图谱与资料结构图](docs/assets/features/knowledge-map.png)

</details>

<details>
<summary><strong>病例库与相似病例</strong></summary>

保存病例摘要、关键检验、治疗经过、结局和经验，检索、收藏并继续编辑。可从当前患者发起相似病例比较，区分相同、不同和未知信息。

![病例库与相似病例](docs/assets/features/cases.png)

</details>

<details>
<summary><strong>文献检索</strong></summary>

通过 PubMed 或 Europe PMC 搜索文献，阅读摘要与引用，并将材料带入任务。也可先使用循证模板准备 PICO 与检索式；实际检索需要联网。

![文献检索](docs/assets/features/literature.png)

</details>

<details>
<summary><strong>临床试验入组初筛</strong></summary>

保存试验方案与入排标准，按患者档案进行规则预筛，再逐条记录符合、不符合或资料不足。AI 初筛与医生核对分开保留，并跟进入组状态；初筛不是最终入组决定。

![临床试验入组初筛](docs/assets/features/trial-screening.png)

</details>

<details>
<summary><strong>科研统计与脱敏导出</strong></summary>

上传 CSV 或选择已有任务数据，查看描述统计、进行组间比较、估算两独立组样本量，并按字段导出脱敏数据。内置虚构数据可直接体验本地计算，无需模型。

![科研统计与脱敏导出](docs/assets/features/statistics.png)

</details>

<details>
<summary><strong>临床速查</strong></summary>

量表计算、检验指标、ICD-9-CM-3 常用手术编码和不良反应匹配都可本地使用。检验参考范围以报告单为准，编码以本院库为准；不良反应匹配不构成因果判定。

![临床速查](docs/assets/features/reference-scales.png)

![临床速查](docs/assets/features/reference-labs.png)

![临床速查](docs/assets/features/reference-codes.png)

![临床速查](docs/assets/features/reference-adr.png)

</details>

<details>
<summary><strong>DRG 单例与批量示例测算</strong></summary>

根据诊断、操作与费用进行单例分组和 CSV 批量测算，调整费率或导入权重后比较费用。使用简化演示规则，不能用于实际医保结算，导入权重不会补齐分组规则。

![DRG 单例与批量示例测算](docs/assets/features/drg.png)

</details>

<a id="workspace"></a>

### 任务工作区与个性化

<details>
<summary><strong>对话、材料与任务记录</strong></summary>

从患者任务或独立任务开始，选择材料、提出问题，查看成果与执行记录，并继续修改或下载文件。所有任务可在任务记录中检索和再次打开。

![对话、材料与任务记录](docs/assets/features/tasks.png)

</details>

<details>
<summary><strong>项目文件与变更审批</strong></summary>

将本地文件夹连接为项目，阅读与整理文件，按项目设置访问权限。文件修改可查看提案与差异，支持按授权模式采纳；项目与患者档案分别管理。

![项目文件与变更审批](docs/assets/features/projects.png)

</details>

<details>
<summary><strong>浏览器、媒体与分析工具</strong></summary>

助手可以像人一样使用浏览器：打开任意网站，按页面元素编号点击、输入、选择、滚动，并把截图交给视觉模型看页面。工作面板实时显示助手浏览器画面，可直接点击；遇到登录或验证码可显示浏览器窗口亲自完成，登录状态保留在本项目内。分析终端与 Office 逐页预览需要 Docker 和预先导入的本地镜像，在项目「连接」面板填写镜像名称后开启。

![浏览器、媒体与分析工具](docs/assets/features/project-browser.png)

![浏览器、媒体与分析工具](docs/assets/features/project-extensions.png)

</details>

<details>
<summary><strong>Skills、工具服务与自动化规则</strong></summary>

使用内置医疗 Skills，管理个人技能和自动化规则。MCP 服务与离线插件目前通过本机工作区接口（`POST /api/workspaces/:id/extensions`）添加，添加后可在项目「连接」面板启停并控制其可访问范围。可通过对话提出定制要求，核对提案后应用。

![Skills、工具服务与自动化规则](docs/assets/features/settings-skills.png)

![Skills、工具服务与自动化规则](docs/assets/features/settings-connections.png)

![Skills、工具服务与自动化规则](docs/assets/features/settings-workbench.png)

</details>

<details>
<summary><strong>医生偏好与学习记忆</strong></summary>

保存确认过的工作偏好、文书写法与经验，查看、编辑、停用或删除记忆，并管理学习授权。知识与偏好的积累用于检索和上下文复用，不会自动训练模型。

![医生偏好与学习记忆](docs/assets/features/doctor-memory.png)

![医生偏好与学习记忆](docs/assets/features/settings-learning.png)

</details>

<details>
<summary><strong>计划任务</strong></summary>

按单次、固定间隔或带时区的 Cron 安排项目任务，分别授权模型使用与执行内容。服务需保持运行，计划不会自动批准文件修改。

![计划任务](docs/assets/features/scheduled-tasks.png)

</details>

<details>
<summary><strong>远程任务与 Worker</strong></summary>

连接私有队列与 Worker，选择文件并授权上传，在本地查询状态和导入结果。远程修改先形成待审批提案，并检查文件冲突；需自行配置远端服务。

![远程任务与 Worker](docs/assets/features/remote-jobs.png)

</details>

<details>
<summary><strong>模型连接与文字识别</strong></summary>

在“设置 → 模型与运行 → 选择模型”切换可用模型，单独核对材料处理授权。文字识别可配置本机 OCR 与可选视觉模型；图片、扫描件的识别质量取决于原件和所配置服务。

</details>

<details>
<summary><strong>示例体验</strong></summary>

一键准备三位虚构患者，以及病历、检验、随访、知识库、病例、试验方案和研究 CSV。按场景进入功能，不必先上传自己的资料；示例可单独删除。

![示例体验](docs/assets/features/examples.png)

</details>

<details>
<summary><strong>桌面应用与后台运行</strong></summary>

在设置中管理登录启动、到期系统提醒与应用维护。可以分别打开患者数据目录和模型配置目录；关闭或隐藏工作窗口后继续执行后台任务，再从 Dock 或托盘返回。PDF 导出通过系统保存对话框选择位置。

</details>

## 本地数据与使用边界

- **本地保存。** 患者、消息、随访和会话保存在本机 SQLite。模型连接密钥通过本地凭据保险库加密保存，**患者数据库本身未加密**。
- **按授权执行。** 模型外发遵循界面中的授权范围；计划任务与随访自动总结需单独授权。文件修改可查看提案与差异，授权方式由工作区设置决定。
- **医生复核。** AI 结果用于辅助整理和准备，临床有效性尚未验证，不能替代医生判断。内置用药与检验规则是辅助提醒，不是完整药品知识库，可能漏报。
- **单医生使用。** 多人权限、机构级审计、HIS / EMR / FHIR 对接和机构部署验收尚未实现。

<details>
<summary><strong>数据位置、备份与恢复</strong></summary>

患者数据库位于 `~/.open-medical-workbench/medical.sqlite`。通过 **设置 → 桌面应用 → 应用维护 → 打开数据目录** 查看；模型配置保存在独立的配置目录。源码环境可运行下面的命令创建数据库一致性备份：

```bash
npm run backup
```

恢复前完全退出应用，按 [备份与恢复步骤](docs/DESKTOP.md#备份与恢复) 保留现有文件并还原数据库。备份同样包含医疗资料，应按原库标准保管。删除患者会同时删除其工作区及相关记录，不会删除已经导出的文件或备份。

</details>

## 可扩展的 Agent 底座

医疗工作台建立在通用 Agent 运行时上：模型与工具循环、文件工作区、历史分支、计划任务、上下文管理和后台执行共用同一套底座。可按需接入 Skills、MCP、插件，以及浏览器、终端和办公文件工具。

通用运行时也提供无界面的 CLI 与后台 API，供扩展开发和任务执行使用：

```bash
npm run workspace --   # CLI 用法
npm run platform       # 本机后台 API，不提供工作台页面
```

开发调试使用 `npm run dev:server` 启动使用独立数据库的医疗开发服务，再用 `npm run dev:ui` 启动 Vite 界面；通用界面调试使用 `npm run dev:platform`。这些入口仅供开发，桌面应用的内部端口不向外部浏览器提供界面或会话凭据。详细命令见 [开发调试](docs/DESKTOP.md#开发调试)。

Docker 为可选依赖，用于容器化终端与部分办公工具。具体支持范围见 [运行时兼容说明](RUNTIME_COMPATIBILITY.md)。

## 文档导航

| 想了解什么 | 从这里开始 |
| :--- | :--- |
| 医生首次使用与完整流程 | [医生使用指南](docs/DOCTOR_WORKBENCH_GUIDE.md) |
| 桌面安装、构建与数据目录 | [桌面版说明](docs/DESKTOP.md) |
| 医生提醒与医生分身 | [连接指南](docs/doctor-assistant-channels.md) |
| 微信、企业微信与消息归档 | [聊天连接插件](docs/chat-connectors.md) |
| 患者、消息和随访的数据关系 | [患者管理](docs/PATIENTS.md) |
| 医生界面、交互规则与任务验收 | [开发指南](docs/DEVELOPMENT_GUIDE.md) |
| 系统架构与扩展开发 | [架构说明](docs/ARCHITECTURE.md) · [插件开发指南](docs/PLUGIN_GUIDE.md) · [通用内核](docs/GENERIC_RUNTIME.md) · [编排与调度](docs/ORCHESTRATION.md) |
| 运行时支持范围 | [运行时兼容说明](RUNTIME_COMPATIBILITY.md) |
| 私有远程任务队列与 Worker | [远程部署](deploy/remote/README.md) |

## 参与贡献

欢迎通过 [Issues](https://github.com/JuneYaooo/open-medical-workbench/issues) 反馈问题或提出建议，通过 Pull Request 改进代码和文档。反馈时请附复现步骤、系统与版本信息，并移除患者资料和密钥。

涉及医生界面或业务交互时，先阅读 [开发指南](docs/DEVELOPMENT_GUIDE.md)，按对应规则验证完整任务、数据状态和失败恢复。

代码修改可在本地运行检查：

```bash
npm run check           # ESLint 与生产构建
```

## 许可证

[MIT](LICENSE)

## 社区

[LINUX DO](https://linux.do/)
