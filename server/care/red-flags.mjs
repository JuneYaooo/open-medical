// Deterministic safety rules for the care pipeline. These run before and
// after any model call; the model can add caution but never veto them.

const RED_FLAGS = Object.freeze([
  { id: "chest-pain", label: "胸痛/胸闷", pattern: /胸痛|胸口(痛|疼)|心绞痛|胸闷.{0,6}(厉害|严重|加重|喘不上|出汗)/ },
  { id: "dyspnea", label: "呼吸困难", pattern: /呼吸困难|喘不上气|喘不过气|憋气|窒息|透不过气/ },
  { id: "consciousness", label: "意识改变/抽搐", pattern: /昏迷|晕倒|昏倒|意识不清|叫不醒|神志不清|抽搐|惊厥/ },
  { id: "bleeding", label: "大出血", pattern: /大出血|吐血|呕血|咯血|黑便|柏油样便|血止不住|出血不止|大量便血/ },
  { id: "stroke", label: "卒中征象", pattern: /口角歪斜|嘴歪|半边.{0,3}(麻|没力|无力|不能动)|说话不清|口齿不清|突然看不见|突然失明/ },
  { id: "self-harm", label: "自伤/自杀风险", pattern: /自杀|不想活|轻生|结束(自己的)?生命|割腕|自残|跳楼|活着没意思/ },
  { id: "anaphylaxis", label: "严重过敏", pattern: /过敏性休克|喉咙.{0,4}(肿|发紧|堵)|嘴唇.{0,3}肿.{0,6}(喘|憋)|全身.{0,4}(风团|起疹).{0,8}(喘|憋|头晕)/ },
  { id: "high-fever", label: "高热", pattern: /(高烧|高热|发烧|发热|体温).{0,6}(39|40|41|42)(\.\d)?\s*(度|℃|°)?/ },
  { id: "severe-pain", label: "剧烈疼痛", pattern: /剧痛|剧烈(疼|痛)|(疼|痛)得受不了|(疼|痛)得(直)?打滚/ },
  { id: "pregnancy", label: "妊娠急症", pattern: /(怀孕|孕期|妊娠).{0,10}(出血|腹痛|见红)|羊水破/ },
  { id: "overdose", label: "误服/过量服药", pattern: /吃多了药|药吃多了|误服|过量服(用|药)|一次吃了.{0,4}(瓶|盒)/ },
]);

export const SAFETY_REPLY =
  "您描述的情况可能需要尽快处理。请立即拨打 120 或前往最近医院急诊就医，不要等待线上回复；我们已通知医生关注。";

export const AI_DISCLAIMER = "（AI 助手回复，仅供参考；症状加重或有疑问请及时就医或联系医生）";

// `extra` are plain keywords added by the doctor in settings.
export function detectRedFlags(text, extra = []) {
  const value = String(text || "");
  const hits = RED_FLAGS.filter((flag) => flag.pattern.test(value)).map(({ id, label }) => ({ id, label }));
  for (const word of extra) {
    if (typeof word === "string" && word.trim() && value.includes(word.trim()))
      hits.push({ id: `custom:${word.trim()}`, label: `自定义关注词：${word.trim()}` });
  }
  return hits;
}

const OUTBOUND_RULES = Object.freeze([
  { reason: "包含剂量或用量", pattern: /\d+(\.\d+)?\s*(mg|毫克|μg|ug|微克|g\b|克|片|粒|袋|支|ml|毫升|单位|iu)/i },
  { reason: "包含用药调整建议", pattern: /(可以|建议|请|需要|应该|先)(自行)?(加量|减量|停药|换药|加药|停用|增加剂量|减少剂量|加倍)/ },
  { reason: "包含诊断结论", pattern: /确诊|诊断为|可以排除|(你|您)(这|的情况)?(就|应该|可能|肯定)?是.{0,6}(癌|炎|综合征|病)/ },
  { reason: "包含处方", pattern: /处方|给您?开(药|点)|开个药/ },
]);

// Screens a reply before any automatic send. A failed screen never blocks
// a doctor-reviewed send; it only prevents unattended delivery.
export function screenOutbound(text) {
  const value = String(text || "");
  const reasons = OUTBOUND_RULES.filter((rule) => rule.pattern.test(value)).map((rule) => rule.reason);
  if (!value.trim()) reasons.push("回复为空");
  if (value.length > 1000) reasons.push("回复过长");
  return { ok: reasons.length === 0, reasons };
}
