// Shared deterministic intent routing. These are work-routing labels for
// local tool selection, not validated clinical logic.
export const POLICY_VERSION = "medical-policy-0.3";
export const INTENTS = {
  observations: "检验数值摘录",
  record_structuring: "病历时间线",
  evidence_planning: "循证规划",
  medication_safety: "用药复核",
  consultation: "咨询问答",
  medical_product: "工作流程",
  general_medical_work: "资料整理",
};
export function medicalPolicy(input = "") {
  const text = String(input);
  const intent = /时间线|结构化病历/.test(text)
    ? "record_structuring"
    : /用药|处方|剂量|禁忌|相互作用|药物|药品/.test(text) &&
        !/产品|软件|工作台/.test(text)
      ? "medication_safety"
      : /循证|指南|文献|检索|PICO|证据等级/i.test(text)
        ? "evidence_planning"
        : /检验数值|检验结果|化验单|指标摘录/.test(text)
          ? "observations"
          : /病历|病史|病例|随访|时间线|就诊/.test(text)
            ? "record_structuring"
            : /怎么办|怎么处理|怎么改善|怎么调理|怎么回事|如何|什么原因|为什么|严重吗|正不正常|要不要|需不需要|能不能|可不可以|行不行|吗\s*[?？]?$|[?？]|咨询|问一下/.test(
                  text,
                )
              ? "consultation"
              : /产品|需求|功能|验收|工作流/.test(text)
                ? "medical_product"
                : "general_medical_work";
  return {
    version: POLICY_VERSION,
    intent,
    risk:
      intent === "medication_safety"
        ? "high"
        : intent === "consultation"
          ? "low"
          : "medium",
    requiresClinicianReview: intent !== "consultation",
    limitations: [
      "模型输出为待核查草稿",
      "发送到外部模型的内容为原文，发送前请自行确认材料范围。",
    ],
    blockedActions: [
      "prescribe",
      "change_dose",
      "publish_unreviewed",
      "send_patient_message",
    ],
  };
}
const PROPOSAL_TYPE_LABELS = {
  "patient-create": "患者建档提案",
  "patient-update": "档案变更提案",
  "followup-create": "随访计划提案",
  "case-save": "病例入库提案",
};
// 产物标题回退链：工具产物用 title；提案类产物只有 summary/payload；
// 旧数据中的技能正文快照只有 name。全空则返回空串，由调用方隐藏。
export function artifactTitle(artifact) {
  if (!artifact) return "";
  const t = (artifact.title || "").trim();
  if (t) return t;
  const name =
    artifact.payload && typeof artifact.payload.name === "string"
      ? artifact.payload.name.trim()
      : "";
  const label = PROPOSAL_TYPE_LABELS[artifact.type] || "";
  if (label && name) return `${label} · ${name}`;
  if (label) return label;
  if ((artifact.summary || "").trim()) return artifact.summary.trim();
  if ((artifact.name || "").trim()) return artifact.name.trim();
  return "";
}
export function artifactLines(artifact) {
  if (!artifact) return [];
  if (artifact.observations)
    return artifact.observations.map(
      (o) => `${o.name} ${o.value} ${o.unit}（未评价）`,
    );
  if (artifact.events)
    return artifact.events.map((e) => `${e.date || "日期未明确"} · ${e.event}`);
  if (artifact.pico)
    return [
      ...Object.entries(artifact.pico).map(
        ([k, v]) =>
          `${{ population: "人群", intervention: "干预", comparison: "对照", outcome: "结局" }[k] || k}：${v || "未提供"}`,
      ),
      `检索式：${artifact.query || "尚未生成"}`,
    ];
  if (artifact.matches)
    return artifact.matches.map(
      (m) => `${m.sourceName} L${m.line}：${m.quote}`,
    );
  if (artifact.concerns)
    return [
      artifact.summary,
      ...artifact.concerns.map((c) => `需关注：${c}`),
      ...(artifact.infoGaps || []).map((x) => `信息缺口：${x}`),
      ...(artifact.questions || []).map((q) => `建议核对：${q}`),
    ];
  return [
    ...(artifact.items || []),
    ...(artifact.missing || []).map((x) => `待补充：${x}`),
    ...(artifact.checks || []),
  ];
}
