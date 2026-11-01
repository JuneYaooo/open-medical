// Synthetic fixtures shared by the onboarding guide and real module forms.
export const DEMO_CSV = `subject,group,age,sbp,adherent
D01,A,51,138,yes
D02,A,62,142,yes
D03,A,57,135,no
D04,A,65,146,yes
D05,A,49,132,yes
D06,A,60,140,no
D07,B,53,148,yes
D08,B,64,152,no
D09,B,55,144,yes
D10,B,67,156,no
D11,B,48,139,yes
D12,B,61,150,yes`;
export const DEMO_DRG = { principalDx: "J18.9", secondaryDx: "E11.9", procedures: "", totalCost: "6800" };
export const DEMO_DRG_CSV = "id,principal_dx,secondary_dx,procedures,total_cost\nD01,J18.9,E11.9,,6800\nD02,K35.9,,47.01,9200";
export const DEMO_KNOWLEDGE = [
  { title: "示例·门诊资料核对流程", kind: "操作手册", text: "# 门诊资料核对流程（虚构演示）\n本资料仅用于体验检索、引用和流程图，不是临床指南。\n## 资料核对\n接诊前核对患者标识、就诊日期和材料来源。\n病历、检验报告、用药记录按日期归档。缺少日期或单位时，标记待补充，不推断。\n## 检验与用药\n检验结果只与原报告打印的参考范围对照。\n用药清单记录名称、剂量、频次和来源，过敏史单独保留。\n记录冲突时保留双方出处，交给医生核对。\n## 复核与随访\n先生成草稿，再由医生确认。医生确认后登记复诊时间和随访清单。\n随访回复进入档案，未回复显示待跟进。" },
  { title: "示例·复诊资料准备清单", kind: "患教", text: "# 复诊资料准备清单（虚构演示素材）\n复诊前请整理上次就诊记录、检验报告和正在使用的药品清单。\n如果有居家测量记录，请保留日期、数值和单位。\n可以提前写下这次最想问医生的问题。\n这份清单仅演示资料准备，不包含治疗建议。" },
];
export const DEMO_SCENARIOS = [
  { id: "chart", group: "临床与患者", title: "看懂患者档案", detail: "打开张沪生的诊断、用药、检验趋势、就诊记录与原始材料。", patient: 0, tab: "overview", question: "请概括这位示例患者的病历，列出需要补充核对的信息，并保留材料出处。", next: "依次打开检验、用药、资料库；也可在任务里继续追问。" },
  { id: "intake", group: "临床与患者", title: "病历整理与检验解读", detail: "已有病历、检验参考范围和用药清单，可以直接开始整理。", patient: 0, flow: "intake-full", tab: "library", next: "试试整理病历、摘录检验、用药辅助提醒和病历草稿。" },
  { id: "labs-trend", group: "临床与患者", title: "检验趋势解读", detail: "李婉珍的 HbA1c 有三次记录，可对照原报告参考范围看趋势。", patient: 1, tab: "labs", question: "请解读这位示例患者的 HbA1c 与空腹血糖趋势：对照材料中的报告参考范围说明变化方向，列出缺失的采样时间和单位信息；只依据材料，不给出治疗建议。", next: "在检验页查看趋势和原始报告；也可以继续追问复查前需要补齐哪些信息。" },
  { id: "discharge", group: "临床与患者", title: "出院小结与交班", detail: "王建国的入院、手术、复查与出院记录已经备齐。", patient: 2, flow: "discharge-summary", tab: "library", next: "生成小结后追问：请改写为交班记录，并指出材料缺失的信息。" },
  { id: "gaps", group: "临床与患者", title: "出院资料缺口核对", detail: "王建国的出院记录刻意留有缺口（如未记录出院带药），练习让助手指出缺失。", patient: 2, question: "请核对该患者的出院与复查材料，列出缺失或未记录的信息，生成一份待补充清单并注明每项的出处；不要推断缺失内容。", next: "把待补充项交给医生核对后，可登记到治疗方案或复诊计划。" },
  { id: "education", group: "临床与患者", title: "患者教育", detail: "用虚构的复诊准备清单，练习把资料写成患者能看懂的文字。", patient: 1, flow: "patient-edu", tab: "library", next: "生成草稿后可以继续要求缩短、调整语气或制作清单。" },
  { id: "followup", plugin: "followup", group: "临床与患者", title: "随访、问卷与复诊", detail: "李婉珍已有到期随访和问卷；张沪生已有今日复诊。", patient: 1, tab: "followups", question: "请查看这位示例患者的随访安排与检验趋势，说明接下来可以登记哪些随访信息。不要发送消息。", next: "查看计划与问卷、登记随访结果；今日待办可以进入复诊处理。" },
  { id: "tracking", plugin: "care-tasks", group: "临床与患者", title: "治疗方案与检查跟进", detail: "王建国已有虚构恢复记录、治疗目标和待回收的血常规报告。", patient: 2, tab: "tracking", next: "在检查与转诊中登记收到结果、医生核对和告知情况；病历中的治疗方案可以继续编辑。" },
  { id: "agenda", group: "临床与患者", title: "今日待办", detail: "查看由示例复诊、逾期随访和患者提醒汇总的工作清单。", view: "agenda", next: "点击一项待办进入患者，处理后返回查看状态。" },
  { id: "messages", plugin: "followup", group: "临床与患者", title: "患者消息与回复复核", detail: "已有虚构消息、人工草稿和待处理提醒；示例消息不会发给真实患者。", view: "care", next: "打开待回复草稿，编辑或丢弃；示例使用人工渠道。真实收发需要连接外部账号。" },
  { id: "knowledge", group: "资料与研究", title: "知识库检索与出处", detail: "演示资料库已包含流程手册和患教清单，可阅读、检索和查看引用。", view: "knowledge", question: "请在「示例体验资料库」检索复诊资料准备要求，引用原文并说明出处；只使用演示资料。", next: "搜索“复诊”，打开原文，尝试来源管理与知识整理。演示手册不是临床指南。" },
  { id: "flowchart", group: "资料与研究", title: "从资料生成流程图", detail: "使用演示手册中的资料核对流程，体验知识检索和图文输出。", question: "请检索「示例·门诊资料核对流程」，仅根据该演示手册生成 Mermaid 资料核对流程图，并列出各节点出处。不要生成临床诊疗建议。", next: "生成后追问：缺少检验单位时，应走哪条分支？" },
  { id: "cases", group: "资料与研究", title: "病例库与相似病例", detail: "三份虚构病例快照可检索、收藏、编辑经验并用于相似病例比较。", view: "cases", patient: 0, question: "请根据这位示例患者检索本地病例库，比较相似与不同之处，缺失信息标未知。", next: "搜索“高血压”，展开病例；也可从患者页进入相似病例对照。" },
  { id: "trials", plugin: "trials", group: "资料与研究", title: "临床试验筛选", detail: "虚构的随访观察方案已包含入排标准，可选择示例患者逐条核对。", view: "research", next: "打开示例方案，选择李婉珍，核对每条标准并记录待补充项。AI 评估需要模型。" },
  { id: "statistics", plugin: "research-stats", group: "资料与研究", title: "科研统计与脱敏", detail: "12 行虚构双组 CSV，可做描述统计、组间比较、样本量与脱敏导出。", view: "data-analysis", next: "点击“使用示例数据”，查看概况，再以 sbp 为结局、group 为分组比较。" },
  { id: "cohort", group: "资料与研究", title: "患者库研究可行性", detail: "用研究数据字典查看 3 位虚构患者能脱敏成哪些分析表，先判断能不能研究，再谈分析。", question: "请查看研究数据字典，说明当前示例患者库脱敏后有哪些数据表和字段、样本量能支持哪些类型的回顾性分析、还需要补充哪些信息；数据为虚构示例，不用于真实结论。", next: "换成真实患者库后走同样流程：先看字典评估可行性，再在脱敏沙箱里写 Python 分析。" },
  { id: "literature", plugin: "literature", group: "资料与研究", title: "文献检索", detail: "使用预设检索词，体验检索、摘要、引用与导入任务。", view: "literature", question: "请为高血压患者居家血压监测与常规随访的比较建立 PICO 和英文检索式，先展示检索计划。", next: "点击“填入示例检索词”再检索。实际文献结果需要联网，规划任务需要模型。" },
  { id: "reference", plugin: "clinical-ref", group: "资料与研究", title: "量表、检验与编码速查", detail: "每个速查页都能填入示例，计算或检索结果无需模型。", view: "clinical-ref", next: "依次尝试量表计算、检验速查、手术编码和不良反应筛查。" },
  { id: "drg", plugin: "drg", group: "资料与研究", title: "DRG 单例与批量测算", detail: "预设诊断、费用和批量 CSV，体验分组与费用对照。", view: "drg", next: "点击“填入示例病例”，运行单例分组和批量分析；使用内置演示方案。" },
  { id: "customize", group: "工作台能力", title: "定制模板与自动化", detail: "通过对话提出模板要求，查看提案并决定是否应用。", question: "请为我新增一个名为「示例·复诊资料清单」的任务模板，要求核对日期、原文出处、检验单位与待补充项。先展示提案，供我确认。", next: "模型生成提案后核对内容，在「设置 → 技能与规则」中管理。需已连接模型。" },
  { id: "workspace", group: "工作台能力", title: "文件、成果与任务记录", detail: "打开带示例 CSV 和说明书的任务，体验材料阅读、问答、文件生成和历史。", task: true, question: "请读取示例研究数据.csv，检查缺失值和字段，生成一份数据字典 Markdown 文件与数据质量报告。数据为虚构练习，不能据此形成临床结论。", next: "在示例任务中查看材料、成果与执行记录，继续追问或下载产物。" },
  { id: "docgen", group: "工作台能力", title: "生成患者教育幻灯", detail: "把演示患教清单做成 PPTX。生成文档需要本机文档生成环境或 Docker 运行时。", question: "请根据「示例·复诊资料准备清单」生成一份约 4 页的患者教育 PPTX，保存为成果；内容只使用清单原文，不添加治疗建议。", next: "未安装环境时助手会提示在「设置 → 模型与运行」安装；生成后在成果区下载文件。" },
];

// Demo cards that operate the followup/care surface. Follow-up plans and
// reminders only need the followup plugin; patient messages also need a
// connected WeChat/WeCom channel.
export function isFollowupDemoScenario(scenario) {
  return Boolean(
    scenario &&
      (scenario.flow === "followup" ||
        scenario.tab === "followups" ||
        isMessagingDemoScenario(scenario)),
  );
}

export function isMessagingDemoScenario(scenario) {
  return Boolean(scenario && (scenario.view === "care" || scenario.id === "messages"));
}

// `pluginActive(id)` reports whether the plugin that owns a card's view or tab
// is active; a card for a disabled plugin would only open "功能未启用".
export function demoScenarioVisible(scenario, followupActive, messaging = followupActive, pluginActive = () => true) {
  if (scenario?.plugin && scenario.plugin !== "followup" && !pluginActive(scenario.plugin)) return false;
  if (isMessagingDemoScenario(scenario)) return Boolean(followupActive && messaging);
  return Boolean(followupActive) || !isFollowupDemoScenario(scenario);
}

// Title and next-step text for a card; without a patient channel the follow-up
// card no longer mentions questionnaires.
export function demoScenarioCopy(scenario, followupActive, messaging = followupActive) {
  if (!scenario) return {};
  const copy = { detail: demoScenarioDetail(scenario, followupActive, messaging) };
  if (scenario.id === "followup" && !messaging) {
    copy.title = "随访与复诊";
    copy.next = "查看随访计划、登记随访结果；今日待办可以进入复诊处理。";
  }
  return copy;
}

export function demoScenarioDetail(scenario, followupActive, messaging = followupActive) {
  if (!scenario) return "";
  // Today's agenda still exists without followup, but it only contains visit
  // and shared reminders then.
  if (scenario.id === "agenda" && !followupActive)
    return "查看由示例复诊和提醒汇总的工作清单。";
  if (scenario.id === "agenda" && !messaging)
    return "查看由示例复诊和逾期随访提醒汇总的工作清单。";
  // Without a patient channel the demo plan is a doctor reminder, no questionnaire.
  if (scenario.id === "followup" && !messaging)
    return "李婉珍已有到期的随访提醒；张沪生已有今日复诊。";
  return scenario.detail || "";
}
