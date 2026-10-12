import { randomUUID } from "node:crypto";
import { check, string } from "../errors.mjs";
import { sqliteTransaction } from "../sqlite-transaction.mjs";
import { validateClinicalInput } from "../patients.mjs";
import { DIAGNOSIS_STATUS, mergeDiagnoses } from "../../shared/diagnoses.mjs";
import { normalizeGroupProposal, scanGroupSuggestions } from "./patient-grouping.mjs";

// Agent-proposed, doctor-confirmed write-backs. The model never writes
// patient/followup/case data directly: it files a pending action with
// structured payload; only the doctor's confirm applies it through the
// same deterministic services the UI uses (proposal pattern from the
// mediwise/MDT references — LLM proposes, deterministic code applies).
const TYPES = [
  "patient-create",
  "patient-update",
  "patient-grouping",
  "followup-create",
  "case-save",
  "care-message",
  "care-campaign",
  "care-settings",
  "care-bind",
  "care-group-message",
  "care-education-broadcast",
  "patient-group-suggest",
  "trial-batch",
  "trial-enrollment",
  "ext-change",
  "ext-install",
];
const isCare = (type) => type.startsWith("care-");
const isTrial = (type) => type.startsWith("trial-");
const isExt = (type) => type.startsWith("ext-");

export class PendingActions {
  // services are accessor functions (e.g. () => patients) so the registry
  // can be constructed before the runtime-dependent registries exist.
  constructor(store, services) {
    this.store = store;
    this.services = services;
  }
  get patients() {
    return this.services.patients();
  }
  get followups() {
    return this.services.followups();
  }
  get cases() {
    return this.services.cases();
  }
  get care() {
    return this.services.care?.() || null;
  }
  get trials() {
    return this.services.trials?.() || null;
  }
  get extensions() {
    return this.services.extensions?.() || null;
  }
  row(id) {
    check(typeof id === "string" && id, "INVALID_INPUT", "提案编号无效");
    const row = this.store.db
      .prepare(
        "SELECT id,type,patient_id,base_revision,status,payload,summary,created_at,updated_at FROM pending_actions WHERE id=?",
      )
      .get(id);
    check(row, "NOT_FOUND", "待确认提案不存在", 404);
    return {
      id: row.id,
      type: row.type,
      patientId: row.patient_id,
      baseRevision: row.base_revision,
      status: row.status,
      payload: JSON.parse(row.payload),
      summary: row.summary,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  propose({ type, patientId, payload = {}, summary } = {}) {
    check(
      TYPES.includes(type),
      "INVALID_INPUT",
      `提案类型须为：${TYPES.join("/")}`,
    );
    const title = string(summary, "提案摘要", 300);
    check(
      payload && typeof payload === "object" && !Array.isArray(payload),
      "INVALID_INPUT",
      "提案内容必须是对象",
    );
    let resolvedPatientId = null;
    let baseRevision = null;
    if (type === "patient-update" || type === "followup-create") {
      check(patientId, "INVALID_INPUT", "该提案需要患者编号");
      const patient = this.patients.row(patientId);
      resolvedPatientId = patient.id;
      baseRevision = patient.revision;
    }
    let normalized = payload;
    if (isCare(type)) {
      check(this.care, "CARE_UNAVAILABLE", "患者管理模块未启用", 503);
      normalized = this.care.normalizeProposal(type, { ...payload, ...(patientId ? { patientId } : {}) });
      // Care proposals reference the patient for display only; they never
      // overwrite the clinical record, so no revision check applies.
      if (normalized.patientId) resolvedPatientId = this.patients.row(normalized.patientId).id;
    }
    if (isExt(type)) {
      check(this.extensions, "EXTENSIONS_UNAVAILABLE", "扩展中心未启用", 503);
      normalized = this.extensions.normalizeProposal(type, payload);
    }
    if (isTrial(type)) {
      check(this.trials, "TRIAL_UNAVAILABLE", "临床试验模块未启用", 503);
      normalized = this.trials.normalizeProposal(type, { ...payload, ...(patientId ? { patientId } : {}) });
      if (normalized.patientId) resolvedPatientId = normalized.patientId;
    }
    if (type === "patient-update") {
      const fields = validateClinicalInput(payload);
      check(
        Object.keys(fields).length >= 1,
        "INVALID_INPUT",
        "患者档案提案至少包含一项变更（诊断/用药/过敏/检验/就诊）",
      );
      normalized = fields;
    }
    if (type === "patient-group-suggest") {
      normalized = normalizeGroupProposal(this.patients, payload);
    }
    if (type === "patient-create") {
      normalized = {
        ...payload,
        name: string(payload.name, "患者姓名", 80),
        ...validateClinicalInput(payload),
      };
    }
    if (type === "followup-create") {
      check(
        payload && typeof payload.name === "string" && payload.name.trim(),
        "INVALID_INPUT",
        "随访提案需要 name",
      );
    }
    if (type === "patient-grouping") {
      // 多患者分组提案：逐人快照姓名与当前分组，供托盘展示和确认时核对；
      // 患者级冲突（归档/分组已满）在 confirm 时逐人跳过，不整体失败。
      const groupName = string(payload.groupName, "分组名称", 40);
      check(
        Array.isArray(payload.patients) && payload.patients.length >= 1 && payload.patients.length <= 100,
        "INVALID_INPUT",
        "分组提案须包含 1–100 位患者",
      );
      const seen = new Set();
      const entries = [];
      for (const entry of payload.patients) {
        check(entry && typeof entry === "object" && !Array.isArray(entry), "INVALID_INPUT", "分组患者条目无效");
        const patient = this.patients.row(entry.patientId);
        check(!patient.archived, "PATIENT_ARCHIVED", `患者 ${patient.name} 已归档，请先恢复档案再分组`, 409);
        if (seen.has(patient.id)) continue;
        seen.add(patient.id);
        entries.push({
          patientId: patient.id,
          name: patient.name,
          reason: string(entry.reason, "分组依据", 200),
          groups: patient.groups || [],
        });
      }
      normalized = {
        groupName,
        patients: entries,
        ...(payload.note ? { note: string(payload.note, "备注", 300) } : {}),
        ...(payload.sourceSessionId ? { sourceSessionId: string(payload.sourceSessionId, "来源会话", 200) } : {}),
      };
    }
    if (type === "case-save") {
      if (patientId) {
        const patient = this.patients.row(patientId);
        resolvedPatientId = patient.id;
        baseRevision = patient.revision;
      } else
        check(
          typeof payload.diagnosis === "string" && payload.diagnosis.trim(),
          "INVALID_INPUT",
          "非患者关联的病例提案需要 diagnosis",
        );
    }
    if (resolvedPatientId) check(!this.patients.row(resolvedPatientId).archived, "PATIENT_ARCHIVED", "患者已归档，请先恢复档案再创建提案。", 409);
    const time = new Date().toISOString();
    const id = randomUUID();
    // 同一资料任务的重复建档分析：新提案取代旧提案，托盘只留一张卡。
    // 医生对同一批材料重跑建档时（换模型、修正口述），旧提案的核对工作
    // 直接作废，两张几乎一样的卡只会让人犹豫该确认哪张。
    if (type === "patient-create" && normalized.sourceSessionId) {
      for (const stale of this.list({ type: "patient-create", sourceSessionId: normalized.sourceSessionId, status: "pending", limit: 50 }))
        this.supersede(stale.id, id);
    }
    this.store.db
      .prepare(
        "INSERT INTO pending_actions(id,type,patient_id,base_revision,status,payload,summary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        type,
        resolvedPatientId,
        baseRevision,
        "pending",
        JSON.stringify(normalized),
        title,
        time,
        time,
      );
    return {
      id,
      type,
      patientId: resolvedPatientId,
      baseRevision,
      status: "pending",
      payload: normalized,
      summary: title,
      createdAt: time,
      updatedAt: time,
      note: isCare(type) || type === "patient-grouping" ? "提案已创建，需医生在工作台「待确认」面板核对后确认才会执行。" : "提案已创建，需医生在患者档案（或随访/病例库）中确认后才会生效。",
    };
  }
  // ext-install 载荷内嵌整包技能文件（几十 MB）；列表每 20 秒被托盘轮询，
  // 只回元数据，完整文件内容仅在 row(id)（确认时）读取。
  slimPayload(type, payload) {
    if (type !== "ext-install" || !payload?.install) return payload;
    return { ...payload, install: { ...payload.install, skills: (payload.install.skills || []).map(({ files, body, ...meta }) => ({ ...meta, fileCount: Array.isArray(files) ? files.length : files })) } };
  }
  list({ patientId, status = "pending", type, sourceSessionId, limit = 100, offset = 0 } = {}) {
    check(
      ["pending", "applied", "rejected", "superseded", undefined].includes(status),
      "INVALID_INPUT",
      "提案状态无效",
    );
    const where = [];
    const args = [];
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 && Number.isSafeInteger(offset) && offset >= 0, "INVALID_INPUT", "提案分页参数无效");
    if (type !== undefined) { check(TYPES.includes(type), "INVALID_INPUT", "提案类型无效"); where.push("type=?"); args.push(type); }
    if (sourceSessionId !== undefined) {
      where.push("json_extract(payload,'$.sourceSessionId')=?");
      args.push(string(sourceSessionId, "来源会话", 200));
    }
    if (status) {
      where.push("status=?");
      args.push(status);
    }
    if (patientId) {
      where.push("patient_id=?");
      args.push(patientId);
    }
    return this.store.db
      .prepare(
        `SELECT id,type,patient_id,base_revision,status,payload,summary,created_at,updated_at FROM pending_actions
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset)
      .map((row) => ({
        id: row.id,
        type: row.type,
        patientId: row.patient_id,
        baseRevision: row.base_revision,
        status: row.status,
        payload: this.slimPayload(row.type, JSON.parse(row.payload)),
        summary: row.summary,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }
  confirm(id) {
    let writtenSkill;
    try { return sqliteTransaction(this.store.db, () => {
      const action = this.row(id);
      check(
        action.status === "pending",
        "ACTION_RESOLVED",
        "该提案已处理",
        409,
      );
      // Care and trial proposals never overwrite the chart, so no revision check applies.
      if (action.patientId && (isCare(action.type) || isTrial(action.type))) {
        check(!this.patients.row(action.patientId).archived, "PATIENT_ARCHIVED", "患者已归档，请先恢复档案并重新核对提案。", 409);
      } else if (action.patientId) {
        check(!this.patients.row(action.patientId).archived, "PATIENT_ARCHIVED", "患者已归档，请先恢复档案并重新核对提案。", 409);
        check(
          Number.isSafeInteger(action.baseRevision) && action.baseRevision >= 0,
          "ACTION_CONFLICT",
          "该提案缺少生成时的患者档案版本，无法安全采纳；请保留当前档案并重新生成提案。",
          409,
        );
        check(
          this.patients.row(action.patientId).revision === action.baseRevision,
          "ACTION_CONFLICT",
          "患者档案在提案生成后已变化，旧提案不能覆盖当前记录；请刷新档案并重新生成提案。",
          409,
        );
      }
      let applied;
      if (isCare(action.type)) {
        check(this.care, "CARE_UNAVAILABLE", "患者管理模块未启用", 503);
        applied = this.care.applyProposal(action);
      } else if (isExt(action.type)) {
        check(this.extensions, "EXTENSIONS_UNAVAILABLE", "扩展中心未启用", 503);
        applied = this.extensions.applyProposal(action);
        if (applied?.kind === "skill") writtenSkill = applied.id ?? applied.ids;
      } else if (isTrial(action.type)) {
        check(this.trials, "TRIAL_UNAVAILABLE", "临床试验模块未启用", 503);
        applied = this.trials.applyProposal(action);
      } else if (action.type === "patient-create") {
        if (action.payload.sourceSessionId) check(!this.list({ type: "patient-create", sourceSessionId: action.payload.sourceSessionId, status: "applied", limit: 1 }).length,
          "ALREADY_CREATED", "该资料任务已完成建档，请到已有患者档案查看。", 409);
        // The registry validates all supplied fields before creating any record.
        const patient = this.patients.create(action.payload);
        if (action.payload.sourceSessionId && this.services.copySourceMaterials)
          this.services.copySourceMaterials(action.payload.sourceSessionId, patient.sessionId, action.payload.sourceFileIds || [], action.payload.sourceInput);
        // 整理完的档案若标注了读不清的原文，把对应材料质量降为待核对，
        // 让原始资料横幅与重新识别入口接住统计评分漏掉的乱码页。
        if (this.services.flagSuspectMaterials)
          this.services.flagSuspectMaterials(patient.sessionId, action.payload);
        applied = this.patients.row(patient.id);
      } else if (action.type === "patient-update") {
        applied = this.patients.update(action.patientId, {
          ...action.payload,
          expectedRevision: action.baseRevision,
        });
        if (this.services.flagSuspectMaterials)
          this.services.flagSuspectMaterials(this.patients.row(action.patientId).sessionId, action.payload);
      } else if (action.type === "followup-create") {
        applied = this.followups.create(action.patientId, action.payload);
      } else if (action.type === "patient-group-suggest") {
        // Per-patient optimistic apply: a profile edited after the proposal
        // is skipped with its reason, never overwritten.
        const appliedRows = [];
        const skipped = [];
        for (const assignment of action.payload.assignments) {
          try {
            const patient = this.patients.row(assignment.patientId);
            const groups = [...new Set([...(patient.groups || []), ...assignment.addTags])];
            check(groups.length <= 10, "GROUP_LIMIT", "分组超过 10 个，请先整理该患者的现有分组");
            const updated = this.patients.update(assignment.patientId, {
              groups,
              expectedRevision: assignment.baseRevision,
            });
            appliedRows.push({ patientId: assignment.patientId, name: assignment.name, groups: updated.groups });
          } catch (error) {
            skipped.push({ patientId: assignment.patientId, name: assignment.name, reason: error.message });
          }
        }
        applied = { assignments: appliedRows, skipped };
      } else if (action.type === "patient-grouping") {
        // 分组提案在生成后患者档案可能已变化：逐人按当前档案合并分组，
        // 已在组内视为幂等成功；归档或分组数已满 10 的跳过并在结果中说明，
        // 不让个别患者的漂移推翻整份提案。
        let added = 0;
        let already = 0;
        const skipped = [];
        for (const entry of action.payload.patients) {
          const patient = this.patients.row(entry.patientId);
          if (patient.archived) { skipped.push({ patientId: entry.patientId, name: entry.name, reason: "已归档" }); continue; }
          if ((patient.groups || []).includes(action.payload.groupName)) { already++; continue; }
          if ((patient.groups || []).length >= 10) { skipped.push({ patientId: entry.patientId, name: entry.name, reason: "已有 10 个分组" }); continue; }
          this.patients.update(entry.patientId, {
            groups: [...(patient.groups || []), action.payload.groupName],
            expectedRevision: patient.revision,
          });
          added++;
        }
        applied = { added, already, skipped };
      } else {
        if (action.patientId) {
          const patient = this.patients.row(action.patientId);
          applied = this.cases.fromPatient(patient, {
            summary: action.payload.summary,
            outcome: action.payload.outcome,
          });
        } else {
          applied = this.cases.addCase(action.payload);
        }
      }
      const time = new Date().toISOString();
      const updated = this.store.db
        .prepare(
          "UPDATE pending_actions SET status='applied',updated_at=? WHERE id=? AND status='pending'",
        )
        .run(time, id);
      check(
        updated.changes === 1,
        "ACTION_CONFLICT",
        "提案确认状态未写入，请刷新后重试；本次变更已回滚。",
        409,
      );
      return { ok: true, action: this.row(id), applied };
    }); } catch (error) {
      // Installs return a list of ids; restore every skill file the rolled
      // back transaction had materialized.
      if (writtenSkill) for (const id of [].concat(writtenSkill)) this.extensions.restoreSkill(id);
      throw error;
    }
  }
  reject(id) {
    const action = this.row(id);
    check(action.status === "pending", "ACTION_RESOLVED", "该提案已处理", 409);
    this.store.db
      .prepare(
        "UPDATE pending_actions SET status='rejected',updated_at=? WHERE id=?",
      )
      .run(new Date().toISOString(), id);
    return { ok: true, action: this.row(id) };
  }
  // 被更新的提案取代（同一资料任务重新分析）。不算医生拒绝：审计里保留
  // supersededBy 指向取代它的提案，列表/计数把它当已处理。
  supersede(id, byId) {
    const stale = this.row(id);
    if (stale.status !== "pending") return;
    const payload = JSON.stringify({ ...stale.payload, supersededBy: byId });
    this.store.db
      .prepare(
        "UPDATE pending_actions SET status='superseded',payload=?,updated_at=? WHERE id=?",
      )
      .run(payload, new Date().toISOString(), id);
  }
  counts({ patientId } = {}) {
    const one = (sql, ...args) =>
      this.store.db.prepare(sql).get(...args)?.n || 0;
    return {
      pending: patientId
        ? one(
            "SELECT COUNT(*) n FROM pending_actions WHERE status='pending' AND patient_id=?",
            patientId,
          )
        : one("SELECT COUNT(*) n FROM pending_actions WHERE status='pending'"),
    };
  }
}

// Agent-facing proposal tools. None of them mutate records — every tool
// only files a pending action for the doctor to confirm.
export function pendingActionTools(pending, doctor = null) {
  const definition = (name, description, properties, required = []) => ({
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    },
  });
const textDef = { type: "string" };
const diagnosisStatusDef = {
  type: "string",
  enum: DIAGNOSIS_STATUS,
  description: "confirmed=病理或资料明确的诊断/临床问题；suspected=考虑、疑似、待排、影像印象；finding=影像或检验的偶然发现与背景改变（囊肿、钙化、退行性变等）；needs_review=资料矛盾、OCR无法辨认或等待病理，须医生核对",
};
const diagnosisNoteDef = { type: "string", description: "诊断依据、限定语境与 OCR 疑点等说明；不写入诊断名称本身" };
const diagnosisItemsDef = {
  type: "object",
  properties: {
    code: textDef,
    name: { type: "string", description: "规范诊断名称，一条一个临床问题；不把依据、限定词或 OCR 疑点写进名称" },
    date: textDef,
    status: diagnosisStatusDef,
    note: diagnosisNoteDef,
    source: textDef,
    sources: { type: "array", items: textDef, description: "同一诊断的多份来源（文件名+页码或行号）" },
  },
  required: ["name"],
  additionalProperties: false,
};
  const memoryTool = doctor
    ? [
        {
          definition: definition(
            "doctor_memory_propose",
            "当医生在对话中明确表达偏好或习惯（随访方式、文书格式、常用检查组合、表达习惯等）时，把它存为一条待确认记忆。只创建待确认条目，医生在记忆面板确认后才会注入后续任务；不要推测或替医生总结没有说过的偏好。",
            { content: textDef, topic: textDef },
            ["content"],
          ),
          execute: (args) => {
            const memory = doctor.addMemory({
              kind: "explicit",
              status: "pending",
              content: args.content,
              topic: args.topic || "",
              source: { via: "chat" },
            });
            return {
              memoryId: memory.id,
              status: memory.status,
              note: "已存为待确认记忆；医生在「医生记忆」面板确认后自动注入后续任务。",
            };
          },
        },
      ]
    : [];
  return [
    ...memoryTool,
    {
      definition: definition(
        "patient_create_propose",
        "从上传材料中识别出新患者时，提议创建患者档案（姓名等基本信息 + 可选的临床字段）。只创建待确认提案，医生确认后才真正建档；材料中找不到姓名时先向医生询问。",
        {
          name: textDef,
          gender: { type: "string", enum: ["male", "female"] },
          birthYear: { type: "integer" },
          phone: textDef,
          groups: { type: "array", items: textDef },
          tags: { type: "array", items: textDef },
          note: {type:"string",description:"资料备注与待核对信息：身份比对、OCR冲突、缺失项目。不是病史摘要。"},
          clinicalSummary: clinicalSummaryDef,
          diagnoses: { type: "array", items: diagnosisItemsDef, description: "一条一个临床问题；同名诊断合并为一条并用 sources 列全来源" },
          medications: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: textDef,
                status: { type: "string", enum: ["active", "stopped", "unknown"], description: "仅依来源判断正在使用或停用，未明确则 unknown" },
                source: textDef,
                dose: textDef,
                frequency: textDef,
                note: textDef,
              },
              required: ["name"],
              additionalProperties: false,
            },
          },
          allergies: { type: "array", items: textDef },
          allergyStatus: { type: "string", enum: ["unknown", "none_known", "recorded"], description: "仅来源明确核对无已知过敏时用 none_known；未提及不等于无过敏" },
          labs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                item: textDef,
                value: { type: "number" },
                unit: textDef,
                date: textDef,
                source: textDef,
              },
              required: ["item", "value", "date"],
              additionalProperties: false,
            },
          },
          visits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                date: textDef,
                reason: textDef,
                note: textDef,
              },
              required: ["date", "reason"],
              additionalProperties: false,
            },
          },
          summary: textDef,
        },
        ["name", "summary"],
      ),
      execute: (args, context = {}) => {
        const { summary, ...payload } = args;
        if (context.sourceSessionId) {
          payload.sourceSessionId = context.sourceSessionId;
          payload.sourceFileIds = context.sourceFileIds || (context.sources || []).map((source) => source.id);
          if (context.sourceInput) payload.sourceInput = context.sourceInput;
        }
        return pending.propose({
          type: "patient-create",
          payload,
          summary,
        });
      },
    },
    {
      definition: definition(
        "patient_record_propose",
        "提议更新患者临床档案。默认 append 追加新记录并保留既往数据；更改已有用药状态等须先读取档案，使用 replace 提交该字段完整列表。只创建待确认提案，医生对照复核后才落库。",
        {
          patientId: textDef,
          clinicalSummary: clinicalSummaryDef,
          updateMode: { type: "string", enum: ["append", "replace"], description: "append 保留旧记录；replace 须提供所更改字段完整列表，遗漏的字段不变" },
          diagnoses: { type: "array", items: diagnosisItemsDef, description: "一条一个临床问题；append 时同名诊断自动与原档案合并来源" },
          medications: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: textDef,
                status: { type: "string", enum: ["active", "stopped", "unknown"], description: "仅依来源判断正在使用或停用，未明确则 unknown" },
                source: textDef,
                dose: textDef,
                frequency: textDef,
                note: textDef,
              },
              required: ["name"],
              additionalProperties: false,
            },
          },
          allergies: { type: "array", items: textDef },
          allergyStatus: { type: "string", enum: ["unknown", "none_known", "recorded"], description: "仅来源明确核对无已知过敏时用 none_known；未提及不等于无过敏" },
          labs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                item: textDef,
                value: { type: "number" },
                unit: textDef,
                date: textDef,
                source: textDef,
              },
              required: ["item", "value", "date"],
              additionalProperties: false,
            },
          },
          visits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                date: textDef,
                reason: textDef,
                note: textDef,
              },
              required: ["date", "reason"],
              additionalProperties: false,
            },
          },
          summary: textDef,
        },
        ["patientId", "summary"],
      ),
      execute: (args) => {
        const { patientId, summary, updateMode = "append", ...input } = args;
        check(["append", "replace"].includes(updateMode), "INVALID_INPUT", "档案更新模式无效");
        const current = pending.patients.row(patientId);
        const updates = validateClinicalInput(input);
        if (updateMode === "append") for (const key of ["diagnoses", "medications", "allergies", "labs", "visits"]) {
          if (!Array.isArray(updates[key])) continue;
          const previous = validateClinicalInput({ [key]: current[key] || [] })[key];
          if (key === "medications") check(updates[key].every((value) => !previous.some((old) => old.name === value.name && JSON.stringify(old) !== JSON.stringify(value))),
            "MEDICATION_CONFLICT", "已有同名用药且信息不同。先核对原档案；如需修改状态或剂量，用 replace 提交完整用药列表供医生复核", 409);
          // Same problem documented again appends its source to the existing
          // entry instead of creating a duplicate row.
          if (key === "diagnoses") { updates[key] = mergeDiagnoses(previous, updates[key]); continue; }
          const values = new Map([...previous, ...updates[key]].map((value) => [JSON.stringify(value), value]));
          updates[key] = [...values.values()];
        }
        if ((updates.allergies || current.allergies || []).length && updates.allergyStatus !== undefined)
          check(updates.allergyStatus === "recorded", "INVALID_INPUT", "存在已记录过敏原，不能改为无已知过敏");
        return pending.propose({
          type: "patient-update",
          patientId,
          payload: updates,
          summary: `${updateMode === "append" ? "追加资料" : "替换所选字段"} · ${summary}`.slice(0, 300),
        });
      },
    },
    {
      definition: definition(
        "followup_create_propose",
        "提议为患者创建本机随访提醒（单次或周期），到期提醒医生本人联系患者，不会给患者发消息。若要定时给患者发问题并自动收集回复，用 care_campaign_propose。只创建待确认提案，医生确认后才生效。",
        {
          patientId: textDef,
          name: textDef,
          once: { type: "boolean" },
          intervalDays: { type: "integer" },
          firstDueAt: textDef,
          checklist: { type: "array", items: textDef },
          summary: textDef,
        },
        ["patientId", "name", "firstDueAt", "summary"],
      ),
      execute: (args) => {
        const { patientId, summary, ...payload } = args;
        return pending.propose({
          type: "followup-create",
          patientId,
          payload,
          summary,
        });
      },
    },
    {
      definition: definition(
        "case_save_propose",
        "提议把当前病例收入本地病例库（可关联患者快照）。只创建待确认提案，医生确认后才入库。",
        {
          patientId: textDef,
          diagnosis: textDef,
          summary: textDef,
          outcome: textDef,
        },
        ["summary"],
      ),
      execute: (args) => {
        const { patientId, ...payload } = args;
        return pending.propose({
          type: "case-save",
          patientId,
          payload,
          summary: args.summary,
        });
      },
    },
    {
      definition: definition(
        "patient_query",
        "查询在管患者名单与档案概要。医生问「我有几个患者」「某患者的基本情况」「哪些人属于某分组」时必须先调用本工具，不要凭当前会话内容断言没有患者。支持按姓名/编号/电话/标签模糊筛选，可含已归档。",
        {
          query: { type: "string", description: "姓名、患者编号、电话或标签的模糊关键字；留空列出全部" },
          group: textDef,
          includeArchived: { type: "boolean" },
        },
        [],
      ),
      execute: (args) => {
        const rows = pending.patients.list({
          query: args.query || "",
          group: args.group || "",
          includeArchived: args.includeArchived === true,
        });
        return {
          total: rows.length,
          patients: rows.slice(0, 50).map((p) => ({
            id: p.id,
            name: p.name,
            gender: p.gender || "unknown",
            birthYear: p.birthYear || null,
            groups: p.groups || [],
            tags: p.tags || [],
            archived: !!p.archived,
            diagnosisCount: (p.diagnoses || []).length,
            mainDiagnoses: (p.diagnoses || []).slice(0, 3).map((d) => (typeof d === "string" ? d : d.name)),
            activeFollowups: p.counts?.activeFollowups ?? 0,
            updatedAt: p.updatedAt,
          })),
          note: rows.length > 50 ? `共 ${rows.length} 位，仅返回最近更新的 50 位；可用 query/group 缩小范围。` : "",
        };
      },
    },
    {
      definition: definition(
        "patient_group_propose",
        "按诊断规律为在管患者生成疾病分组建议（内置 ICD-10/诊断名规则，也可指定分组名与名单）。只创建待确认提案，医生在「待确认」面板核对后才写入档案。医生说「帮患者分组」「把某类患者归到一组」时使用；先 patient_query 拿到名单再提交。",
        {
          groupName: textDef,
          patientIds: { type: "array", items: textDef, description: "要归组的患者 id（来自 patient_query）；留空则由规则引擎按诊断自动扫描全部在管患者" },
          reason: textDef,
        },
        [],
      ),
      execute: (args) => {
        const groupName = args.groupName ? string(args.groupName, "分组名称", 40) : "";
        let patientIds = Array.isArray(args.patientIds) ? args.patientIds.filter(Boolean) : [];
        if (!patientIds.length) {
          // 规则引擎按诊断扫描：返回按患者的 addTags，按目标分组名过滤。
          const scanned = scanGroupSuggestions(pending.patients)
            .map((s) => ({ patientId: s.patientId, addTags: s.addTags || [] }))
            .filter((s) => !groupName || s.addTags.includes(groupName));
          if (!scanned.length) return { status: "no_suggestion", note: "规则引擎没有给出匹配的诊断分组建议；请提供 patientIds 或换个分组名。" };
          return pending.propose({
            type: "patient-group-suggest",
            payload: { assignments: scanned },
            summary: `分组建议：为 ${scanned.length} 位患者追加疾病分组（依据诊断 ICD-10/名称）`,
          });
        }
        check(groupName, "INVALID_INPUT", "指定名单时需要提供分组名称");
        return pending.propose({
          type: "patient-group-suggest",
          payload: {
            assignments: patientIds.map((id) => ({ patientId: id, addTags: [groupName] })),
          },
          summary: `分组建议：把 ${patientIds.length} 位患者加入「${groupName}」`,
        });
      },
    },
  ];
}

const clinicalSummaryDef = {type:"object",description:"供医生阅读的病史摘要：按时间概括主要疾病、关键治疗、复查变化与最新资料。保留疑似限定词；身份编号/OCR错误/归属不明联系方式只写备注，不进入本字段。",properties:{text:{type:"string",description:"清晰分段的病史正文，不是标签或资料核对清单"},source:{type:"string",description:"所依据的文件名、页码或行号，必须能回查"}},required:["text","source"],additionalProperties:false};
