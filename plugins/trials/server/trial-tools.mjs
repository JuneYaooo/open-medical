import { check } from "../../../server/errors.mjs";
import { cohortSpecSchema } from "../../../server/medical/cohort-query.mjs";
import { SEARCH_STATUSES } from "./trial-registry.mjs";
import { screeningSummary } from "./trial-candidates.mjs";

// Chat tools for clinical-trial recruitment. Reading is direct; starting
// batch AI screening (sends patient records to the model), changing
// enrollment status, saving screening conditions and importing a protocol
// only file pending actions the doctor confirms.
const definition = (name, description, properties = {}, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
});
const text = { type: "string" };
const STAGE = { type: "string", enum: ["none", "shortlisted", "contacted", "consented", "enrolled", "declined", "ineligible", "withdrawn"] };
const MANUAL = { type: "array", maxItems: 40, items: { type: "string" }, description: "无法用结构化条件表达、需人工或 AI 逐人核对的入排条目（照抄或简述原文），如“预计生存期≥3个月”“签署知情同意”" };

// 候选列表给模型时只保留预筛要点，避免把整张表塞进上下文；不带姓名和编号，
// 医生在界面名单里看姓名。
const compactCandidate = (c) => ({
  patientId: c.patientId, gender: c.gender, birthYear: c.birthYear, diagnoses: c.diagnoses,
  screen: c.screen.source === "conditions"
    ? { status: c.screen.status, label: c.screen.label, met: `${c.screen.met}/${c.screen.total}`, open: c.screen.open.map((o) => `第${o.index + 1}条「${o.label}」${o.verdictLabel}：${o.evidence}`) }
    : { status: "unclear", label: "未设置筛选条件", roughHint: `粗略提示（不可靠）：${c.prefilter.status}${c.prefilter.reasons.length ? `，${c.prefilter.reasons.slice(0, 2).join("；")}` : ""}` },
  ai: c.ai, review: c.review, enrollment: c.enrollment.label, next: c.next,
});

export function trialTools(getService, pending) {
  const service = () => {
    const value = getService();
    if (!value?.candidates) throw new Error("临床试验模块未启用");
    return value;
  };
  const trials = () => service().candidates;
  const propose = (type, patientId, payload, summary) => ({
    ...pending.propose({ type, patientId, payload, summary }),
    note: "已生成待确认提案。请提醒医生在工作台右下角「待确认」面板核对后确认；确认前不会执行。",
  });
  return [
    {
      definition: definition("trial_list", "列出已保存的临床试验方案（名称、注册号、招募状态、入排条目数、是否已设置结构化筛选条件）以及各入组阶段人数。"),
      execute: () => ({ trials: trials().trials.list().map((t) => {
        const { counts } = trials().candidates(t.id);
        const screening = screeningSummary(t);
        return {
          id: t.id, title: t.title, registration: t.registration, recruitment: t.recruitment, criteria: t.criteria.length,
          screeningConditions: screening ? { conditions: screening.conditions.length, manualCriteria: screening.manualCriteria.length, source: screening.sourceLabel, updatedAt: screening.updatedAt, match: counts.screen.match, unclear: counts.screen.unclear, mismatch: counts.screen.mismatch } : null,
          stages: counts.stages, awaitingReview: counts.awaitingReview,
        };
      }) }),
    },
    {
      definition: definition("trial_protocol_criteria", "读取某试验的入选/排除标准原文（逐条，含编号）和当前已确认的结构化筛选条件。起草筛选条件前先调用。", { trialId: text }, ["trialId"]),
      execute: ({ trialId }) => {
        const trial = trials().trials.get(trialId);
        return {
          id: trial.id, title: trial.title, registration: trial.registration, version: trial.version,
          criteria: trial.criteria.map((c, i) => ({ no: i + 1, kind: c.kind, text: c.text })),
          screeningConditions: screeningSummary(trial),
        };
      },
    },
    {
      definition: definition("trial_candidates", "某试验的候选患者列表：按已确认筛选条件逐条预筛（符合/待核对/不符合及未通过的条件和依据；未设置筛选条件时全部为待核对，只附不可靠的粗略提示）、AI 初筛结果（冲突/待补）、医生核对结论、入组状态和建议下一步。回答“哪些患者可能适合这个试验”时调用。", {
        trialId: text, stage: { type: "string", description: "入组状态筛选，逗号分隔" }, prefilter: { type: "string", description: "预筛状态 match,unclear,mismatch，逗号分隔" }, limit: { type: "integer" },
      }, ["trialId"]),
      execute: ({ trialId, stage, prefilter, limit }) => {
        const value = trials().candidates(trialId, { stage, status: prefilter });
        return {
          trial: value.trial, counts: value.counts, suggested: value.suggested, suggestedBy: value.suggestedBy, batch: value.batch,
          candidates: value.candidates.slice(0, Math.min(limit || 30, 100)).map(compactCandidate),
          ...(value.trial.screening ? {} : { note: "该试验还没有结构化筛选条件，预筛结果都是待核对。可先用 trial_protocol_criteria 读取入排标准，再用 trial_screening_conditions_propose 起草筛选条件请医生确认。" }),
        };
      },
    },
    {
      definition: definition("trial_screening_conditions_propose", `为某个试验起草结构化筛选条件（与 cohort_query 相同的条件格式），生成待医生确认的提案；确认后候选患者列表按这些条件逐条预筛。
- 先用 trial_protocol_criteria 读原文。每条入排标准能结构化的（年龄、性别、诊断、用药、检验数值及时间窗、分组、标签）写成 conditions，label 写医生能看懂的原文；不要编造原文没有的阈值。
- 检验写明比较值和单位，诊断/用药给常见写法（中文、英文、缩写、通用名）；必要时先用 research_data_dictionary 看本地写法与单位。
- 无法结构化的（主观判断、知情同意、预计生存期、影像细节等）放进 manualCriteria，这些条目会显示为“需人工或 AI 逐人核对”。
返回本地患者库的试算计数（符合/待核对/不符合），不含姓名。`, {
        trialId: text,
        title: cohortSpecSchema.properties.title,
        conditions: cohortSpecSchema.properties.conditions,
        manualCriteria: MANUAL,
        summary: text,
      }, ["trialId", "title", "conditions"]),
      execute: ({ trialId, title, conditions, manualCriteria, summary }) => {
        const value = trials().normalizeProposal("trial-screening-conditions", { trialId, spec: { title, conditions }, manualCriteria });
        const preview = trials().previewSpec(value.spec);
        return {
          ...propose("trial-screening-conditions", undefined, { trialId: value.trialId, spec: value.spec, manualCriteria: value.manualCriteria, baseRevision: value.baseRevision },
            summary || `「${value.trialTitle.slice(0, 30)}」筛选条件：${value.spec.conditions.length} 条结构化${value.manualCriteria.length ? `，${value.manualCriteria.length} 条需人工核对` : ""}`),
          preview,
        };
      },
    },
    {
      definition: definition("trial_match_patient", "查看一位患者可能适合哪些试验：用各试验已确认的筛选条件做本地判断，返回每个试验的 符合/待核对/不符合、未通过或待核对的条件及依据、入组状态；没有设置筛选条件的试验单独列出；已结束、暂停或不再招募的试验默认不参与匹配（列在 closed），需要时传 includeClosed=true。不含姓名。", { patientId: text, includeClosed: { type: "boolean" } }, ["patientId"]),
      execute: ({ patientId, includeClosed }) => trials().matchPatient(patientId, { includeClosed: includeClosed === true }),
    },
    {
      definition: definition("trial_patient_screening", "读取某患者在某试验下的逐项结果：最新 AI 初筛中的冲突与待补项（含理由和出处）、医生保存的核对记录和入组状态。", { trialId: text, patientId: text }, ["trialId", "patientId"]),
      execute: ({ trialId, patientId }) => {
        const t = trials(), trial = t.trials.get(trialId);
        const criterion = (id) => trial.criteria.find((c) => c.id === id);
        const job = t.latestJobs(trial.id).get(patientId);
        const attention = (job?.checks || []).filter((c) => c.value === "unknown" || c.value === (criterion(c.id)?.kind === "include" ? "no" : "yes"));
        return {
          ai: t.aiSummary(job),
          aiAttention: attention.map((c) => ({ kind: criterion(c.id)?.kind, criterion: criterion(c.id)?.text, value: c.value, reason: c.reason, missing: c.missing, citations: (c.citations || []).map((r) => `${r.sourceName} 第${r.startLine}–${r.endLine}行`) })),
          review: t.trials.screening(trial.id, patientId),
          enrollment: t.enrollment(trial.id, patientId),
        };
      },
    },
    {
      definition: definition("trial_batch_screen_propose", "提议对某试验批量做 AI 纳排初筛。不传 patientIds 时自动选择筛选条件预筛为符合或待核对（未设置筛选条件时按粗略提示）、且还没有有效 AI 结果的患者（最多 50 位）。患者病历会交给当前模型处理，因此只生成待确认提案。", {
        trialId: text, patientIds: { type: "array", items: text }, summary: text,
      }, ["trialId"]),
      execute: ({ trialId, patientIds, summary }) => {
        const value = trials().normalizeBatch(trialId, { patientIds, externalConsent: true });
        return propose("trial-batch", undefined, { trialId, patientIds: value.patientIds }, summary || `批量 AI 初筛「${value.trialTitle.slice(0, 30)}」：${value.patientIds.length} 位患者`);
      },
    },
    {
      definition: definition("trial_enrollment_propose", "提议更新患者在某试验的入组状态：shortlisted 拟邀请、contacted 已联系、consented 已签知情同意（需 consentDate）、enrolled 已入组（需先登记知情同意且医生核对无冲突）、declined、ineligible、withdrawn。医生确认后生效。", {
        trialId: text, patientId: text, stage: STAGE, consentDate: { type: "string", description: "YYYY-MM-DD" }, note: text, summary: text,
      }, ["trialId", "patientId", "stage"]),
      execute: ({ trialId, patientId, stage, consentDate, note, summary }) => {
        const value = trials().normalizeProposal("trial-enrollment", { trialId, patientId, stage, consentDate, note });
        return propose("trial-enrollment", patientId, { trialId, patientId, stage, consentDate, note }, summary || `「${value.trialTitle.slice(0, 30)}」入组状态改为${value.label}`);
      },
    },
    {
      capability: { backend: "network" },
      definition: definition("trial_registry_search", `在 ClinicalTrials.gov 检索临床试验（只发送检索词，不含患者资料）。用英文疾病名/关键词检索；返回注册号、标题、招募状态、疾病、地点（指定国家时该国地点优先）和入选/排除标准节选。
中国临床试验注册中心（ChiCTR）没有检索接口：需要时用 web_search 并限定 domains ["chictr.org.cn"]。结果是注册信息快照，招募状态和研究中心需与研究团队核实。`, {
        condition: { type: "string", description: "疾病或适应证（英文），如 type 2 diabetes" },
        term: { type: "string", description: "其他关键词（英文），如药名、干预、生物标志物" },
        country: { type: "string", description: "优先显示该国地点，用英文国名，如 China" },
        countryOnly: { type: "boolean", description: "true 时只检索在该国有研究中心的试验" },
        status: { type: "array", items: { type: "string", enum: SEARCH_STATUSES }, description: "招募状态，默认 RECRUITING" },
        pageSize: { type: "integer", minimum: 1, maximum: 20 },
      }),
      execute: (args) => {
        const registry = service().registry;
        check(registry, "PLUGIN_UNAVAILABLE", "试验注册检索不可用", 409);
        return registry.search(args);
      },
    },
    {
      definition: definition("trial_protocol_propose", `把一个试验方案导入本地试验列表，生成待医生确认的提案。
- 来自 ClinicalTrials.gov：传 registryId（NCT 号），服务端读取完整注册记录（名称、版本、地点、招募状态、入排原文）；criteria 可省略（按原文标题自动拆分），拆不开时须按原文逐条给出 criteria。
- 来自医生提供的文字或 ChiCTR 网页：给 title、version 和逐条 criteria（kind include/exclude，text 照抄原文，不要改写阈值）。
确认后可再用 trial_screening_conditions_propose 起草筛选条件。`, {
        registryId: { type: "string", description: "NCT 加 8 位数字" },
        title: text,
        registration: { type: "string", description: "注册号，如 ChiCTR2400012345" },
        version: { type: "string", description: "方案版本与日期；不清楚时写来源和读取日期" },
        sourceUrl: text, site: text, recruitment: text,
        criteria: { type: "array", maxItems: 200, items: { type: "object", properties: { kind: { type: "string", enum: ["include", "exclude"] }, text }, required: ["kind", "text"], additionalProperties: false } },
        protocolText: { type: "string", description: "入排标准或方案原文（可选）" },
        summary: text,
      }),
      execute: async (args) => {
        const { registryId, summary, ...rest } = args;
        let input = { ...rest };
        if (registryId) {
          const record = await service().registry.lookup(registryId);
          input = {
            title: record.title, registration: record.registration, version: record.version, sourceUrl: record.sourceUrl,
            site: record.site, recruitment: record.recruitment, protocolText: record.protocolText,
            ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== "")),
          };
          if (!input.criteria) {
            check(record.inclusion && record.exclusion, "INVALID_INPUT", `${record.criteriaNotice || "注册记录的入排标准未能自动拆分"}请按原文逐条提供 criteria 后重试。原文节选：${String(record.protocolText).slice(0, 1500)}`);
            input.inclusion = record.inclusion;
            input.exclusion = record.exclusion;
          }
        }
        if (!input.version) input.version = `助手导入草稿 ${new Date().toISOString().slice(0, 10)}`;
        const value = trials().normalizeProposal("trial-protocol", input);
        const included = value.criteria.filter((c) => c.kind === "include").length;
        return {
          ...propose("trial-protocol", undefined, value, summary || `导入试验方案「${value.title.slice(0, 40)}」：入选 ${included} 条、排除 ${value.criteria.length - included} 条`),
          ...(value.duplicateOf ? { warning: `本地已有同注册号方案「${value.duplicateOf.title}」（${value.duplicateOf.version}），确认后会另存为新版本。` } : {}),
        };
      },
    },
  ];
}
