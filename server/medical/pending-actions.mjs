import { randomUUID } from "node:crypto";
import { check, string } from "../errors.mjs";
import { sqliteTransaction } from "../sqlite-transaction.mjs";
import { validateClinicalInput } from "../patients.mjs";

// Agent-proposed, doctor-confirmed write-backs. The model never writes
// patient/followup/case data directly: it files a pending action with
// structured payload; only the doctor's confirm applies it through the
// same deterministic services the UI uses (proposal pattern from the
// mediwise/MDT references — LLM proposes, deterministic code applies).
const TYPES = [
  "patient-create",
  "patient-update",
  "followup-create",
  "case-save",
];

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
    if (type === "patient-update") {
      const fields = validateClinicalInput(payload);
      check(
        Object.keys(fields).length >= 1,
        "INVALID_INPUT",
        "患者档案提案至少包含一项变更（诊断/用药/过敏/检验/就诊）",
      );
      normalized = fields;
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
      note: "提案已创建，需医生在患者档案（或随访/病例库）中确认后才会生效。",
    };
  }
  list({ patientId, status = "pending" } = {}) {
    check(
      ["pending", "applied", "rejected", undefined].includes(status),
      "INVALID_INPUT",
      "提案状态无效",
    );
    const where = [];
    const args = [];
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
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT 100`,
      )
      .all(...args)
      .map((row) => ({
        id: row.id,
        type: row.type,
        patientId: row.patient_id,
        baseRevision: row.base_revision,
        status: row.status,
        payload: JSON.parse(row.payload),
        summary: row.summary,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }
  confirm(id) {
    return sqliteTransaction(this.store.db, () => {
      const action = this.row(id);
      check(
        action.status === "pending",
        "ACTION_RESOLVED",
        "该提案已处理",
        409,
      );
      if (action.patientId) {
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
      if (action.type === "patient-create") {
        // The registry validates all supplied fields before creating any record.
        const patient = this.patients.create(action.payload);
        if (action.payload.sourceSessionId && this.services.copySourceMaterials)
          this.services.copySourceMaterials(action.payload.sourceSessionId, patient.sessionId, action.payload.sourceFileIds || [], action.payload.sourceInput);
        applied = this.patients.row(patient.id);
      } else if (action.type === "patient-update") {
        applied = this.patients.update(action.patientId, {
          ...action.payload,
          expectedRevision: action.baseRevision,
        });
      } else if (action.type === "followup-create") {
        applied = this.followups.create(action.patientId, action.payload);
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
    });
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
          note: textDef,
          diagnoses: {
            type: "array",
            items: {
              type: "object",
              properties: { code: textDef, name: textDef, date: textDef, source: textDef },
              required: ["name"],
              additionalProperties: false,
            },
          },
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
          updateMode: { type: "string", enum: ["append", "replace"], description: "append 保留旧记录；replace 须提供所更改字段完整列表，遗漏的字段不变" },
          diagnoses: {
            type: "array",
            items: {
              type: "object",
              properties: {
                code: textDef,
                name: textDef,
                date: textDef,
                source: textDef,
              },
              required: ["name"],
              additionalProperties: false,
            },
          },
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
        "提议为患者创建随访计划（单次或周期）。只创建待确认提案，医生确认后才生效。",
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
  ];
}
