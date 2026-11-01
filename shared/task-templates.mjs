// 任务模板的执行要求（调用哪些工具、输出结构、边界）。
// 医生在输入框里只看到简短请求；这些要求作为任务上下文随问题发送，
// 由服务端写入系统提示，不再出现在医生的提问里。
export const TASK_TEMPLATES = Object.freeze({
  "intake-full": {
    title: "整理收治资料",
    request: "请整理本次收治资料：时间线、检验摘录和用药信息。",
    guidance:
      "请对本次材料完成收治整理全流程，依次调用工具并保留原文出处：1) extract_clinical_timeline 生成时间线；2) extract_observations 摘录检验数值；3) 整理当前用药清单与过敏史，调用 medication_safety_check 做确定性核查；4) 在本次回复中说明实际缺失或冲突的信息，供用户直接补充或更正。所有产物均为参考草稿，材料缺失的信息标注「待补充」，不要推断诊断。",
  },
  "record-draft": {
    title: "生成病历草稿",
    request: "请根据我提供的就诊信息生成门诊病历草稿。",
    guidance:
      "请根据医生口述或粘贴的就诊信息，生成一份结构化门诊病历草稿（主诉、现病史、既往史、查体、辅助检查、初步诊断意向、处理计划）。所有内容标注为待医生核对；材料中没有的信息明确写「待补充」，不要编造查体阳性发现或诊断。",
  },
  "med-safety": {
    title: "用药辅助提醒",
    request: "请核对材料中的用药和过敏史，整理成用药辅助提醒清单。",
    guidance:
      "请从材料中提取当前用药清单和过敏史，调用 medication_safety_check 工具做确定性核查（过敏匹配、相互作用、重复用药），把工具结果整理成辅助提醒清单，并列出工具返回的未识别药物。结尾原样附上工具返回的 note（规则可能漏报，没有提醒不代表没有风险）。结果需药师或医生复核。",
  },
  "patient-edu": {
    title: "患教大白话",
    request: "请把材料中的诊疗方案改写成患者能看懂的患教材料。",
    guidance:
      "请把材料中的诊疗方案/用药说明改写为患者能看懂的患教材料：避免专业术语、用类比解释、仅复述来源已有的用药时间与就医提示，缺失项列为待医生补充，不自行生成剂量、时间表或诊疗计划。结尾注明「本材料为医生生成的参考，具体遵医嘱」。",
  },
  "lab-read": {
    title: "检验报告解读",
    request: "请解读这份检验报告，标出超出参考范围的项目。",
    guidance:
      "请提取检验报告中的项目、结果、单位和报告内打印的参考范围，标记超出参考范围的项目，并逐项生成通俗解读草稿。只使用报告内信息，不引入外部判断；结论标注为待医生结合临床复核。",
  },
  "discharge-summary": {
    title: "出院小结草稿",
    request: "请根据本次住院材料生成出院小结草稿。",
    guidance:
      "请根据本次住院材料生成出院小结草稿，结构为：入院日期/出院日期（缺失标待补充）、入院诊断、出院诊断、住院经过摘要（调用 extract_clinical_timeline 提取关键节点）、出院时情况、出院带药（含用法，调用用药清单整理并做 medication_safety_check 核查）、出院注意事项与随访计划（复诊时间、复查项目）。全部为待医生核对签署的草稿，缺失信息标「待补充」。",
  },
  handoff: {
    title: "值班交班记录",
    request: "请把材料整理成值班交班记录。",
    guidance:
      "请把材料整理为值班交班记录草稿：患者一览（床号/姓名/诊断，缺失标待补充）、目前问题清单（按优先级）、近 24 小时关键事件（调用 extract_clinical_timeline 与 extract_observations）、当前用药与需关注的相互作用（调用 medication_safety_check）、夜间需要重点观察的项目与预警信号、危急值与处理预案。面向接班医生，简洁条目化。",
  },
  "decision-flow": {
    title: "诊疗决策流程图",
    request: "请生成诊疗决策流程图，病种：",
    guidance:
      "请针对医生指定的病种生成诊疗决策流程图：先用 knowledge_search 检索诊断标准、分级与治疗决策条件并用 knowledge_read 核对原文，然后按 clinical-decision-flow 技能输出 mermaid 流程图与节点出处对照表。指南库未覆盖的分支标注「需补充来源」，不得凭记忆编造路径。",
  },
  "adr-screen": {
    title: "不良反应筛查",
    request: "请筛查材料中可能的药物不良反应。",
    guidance:
      "请从材料整理当前用药清单和可疑临床表现，调用 assess_adverse_reaction 做不良反应匹配筛查；对每条疑似关联，建议医生用 medical_scale_calculate（scaleId=naranjo）完成 Naranjo 因果评估。结果为提示性筛查，不构成因果判定，需结合用药时间线核实。",
  },
  "case-report": {
    title: "个案报告写作",
    request: "请基于病例材料写一份个案报告草稿。",
    guidance:
      "请基于病例材料（或病例库中引用的病例）按 CARE 框架生成个案报告草稿：标题建议、摘要（背景/病例要点/结论）、引言、病例资料（主诉/现病史/查体/辅助检查/诊疗经过，调用 extract_clinical_timeline 与 extract_observations 并保留出处）、讨论要点（提示可结合文献检索补充证据）、结论。全部为草稿，患者信息需脱敏，发表前需按目标期刊要求核对。",
  },
});

export function taskTemplateContext(id) {
  const template = TASK_TEMPLATES[id];
  return template ? { kind: "task-template", label: `模板：${template.title}`, scope: { template: id } } : null;
}
