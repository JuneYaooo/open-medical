// Reading frameworks, not diagnostic rules. Never infer a disease stage or prescribe.
export const ASSISTANCE_PROFILES = [
 {id:'general',name:'通用诊疗',match:null,topics:['诊断依据与需要鉴别的问题','病情变化与重要合并症','治疗目标、既往疗效与患者意愿','需要补充的检查与随访安排'],source:'https://digital.ahrq.gov/health-it-tools-and-resources/clinical-decision-support-cds',sourceName:'AHRQ · 患者相关决策支持'},
 {id:'hcc',name:'肝细胞癌',match:/肝细胞癌|\bHCC\b/i,topics:['肿瘤范围、影像与病理依据，核对分期','肝功能储备与体能状态（如 Child-Pugh、ECOG）','既往手术、局部或系统治疗及疗效','复发或转移证据、治疗目标与多学科意见'],source:'https://www.aasld.org/practice-guidelines/management-hepatocellular-carcinoma',sourceName:'AASLD · 肝细胞癌指南与更新'},
 {id:'ckd',name:'慢性肾脏病',match:/慢性肾脏?病|慢性肾功能|慢性肾衰|\bCKD\b/i,topics:['病因、慢性病程与肾功能变化','eGFR、尿白蛋白及风险分层依据','合并症与用药安全，核对肾功能相关限制','复查、转诊及患者共同决策'],source:'https://kdigo.org/guidelines/ckd-evaluation-and-management/',sourceName:'KDIGO · 慢性肾脏病指南与更新'},
];
export function suggestedProfiles(patient) {
 const diagnoses=(patient.diagnoses || []).map(d=>typeof d==='string'?d:d.name || '').join('；');
 return ASSISTANCE_PROFILES.filter(p=>p.match?.test(diagnoses));
}
export function assistanceDraft(kind, profile, question='') {
 const context=`请先读取当前关联患者最新档案及相关原文，区分历史记录与当前状态，不推断缺失分期、用药状态或评分。此次关注方向：${profile.name}；这是核对框架，不代表患者已确诊或已分期。${question.trim()?`医生本次问题：${question.trim()}。`:''}`;
 const actions={
 similar:'检索本地相似患者与网上相似病例，按疾病、阶段、治疗、用药和结局逐项对照，显示相同点、差异和来源；联网仅发送脱敏医学关键词，不发送身份资料。',
 literature:'检索相关指南文献研究，优先指南发布机构与原始研究。核对版本、日期、适用人群、证据等级及与本患者的适用限制，区分摘要与全文；联网仅发送脱敏医学关键词，不发送身份资料。',
 assessment:`请辅助诊断并评估治疗方案，围绕${profile.topics.join('；')}，给出支持证据、相反证据和未完成的核对项；先回答医生的问题，不生成无关文书。`,
 medication:'核对本患者用药安全，区分当前、历史和建议未实施用药，核对过敏、重复用药及肝肾功能相关资料；不要把出院未带药视作已停药。',
 followup:'整理本患者下一步需要核对的检查与随访问题，区分医嘱中已有安排和待医生决定的事项，不凭空指定检查或复诊间隔。',
 };
 return context+(actions[kind] || actions.assessment)+'结论保留原文出处，未知信息明确标注，生成供医生核对的回答。';
}
