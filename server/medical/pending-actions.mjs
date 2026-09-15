import { randomUUID } from "node:crypto";
import { check, string } from "../errors.mjs";
import { validateClinicalInput } from "../patients.mjs";

// Agent-proposed, doctor-confirmed write-backs. The model never writes
// patient/followup/case data directly: it files a pending action with
// structured payload; only the doctor's confirm applies it through the
// same deterministic services the UI uses (proposal pattern from the
// mediwise/MDT references — LLM proposes, deterministic code applies).
const TYPES = ["patient-update", "followup-create", "case-save"];

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
      .prepare("SELECT id,type,patient_id,status,payload,summary,created_at,updated_at FROM pending_actions WHERE id=?")
      .get(id);
    check(row, "NOT_FOUND", "待确认提案不存在", 404);
    return {
      id: row.id,
      type: row.type,
      patientId: row.patient_id,
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
    let resolvedPatientId = null;
    if (type === "patient-update" || type === "followup-create") {
      check(patientId, "INVALID_INPUT", "该提案需要患者编号");
      resolvedPatientId = this.patients.row(patientId).id;
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
    if (type === "followup-create") {
      check(
        payload && typeof payload.name === "string" && payload.name.trim(),
        "INVALID_INPUT",
        "随访提案需要 name",
      );
    }
    if (type === "case-save") {
      if (patientId) resolvedPatientId = this.patients.row(patientId).id;
      else
        check(
          typeof payload.diagnosis === "string" && payload.diagnosis.trim(),
          "INVALID_INPUT",
          "非患者关联的病例提案需要 diagnosis",
        );
    }
    const time = new Date().toISOString();
    const id = randomUUID();
    this.store.db
      .prepare(
        "INSERT INTO pending_actions(id,type,patient_id,status,payload,summary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(id, type, resolvedPatientId, "pending", JSON.stringify(normalized), title, time, time);
    return {
      id,
      type,
      patientId: resolvedPatientId,
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
        `SELECT id,type,patient_id,status,payload,summary,created_at,updated_at FROM pending_actions
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT 100`,
      )
      .all(...args)
      .map((row) => ({
        id: row.id,
        type: row.type,
        patientId: row.patient_id,
        status: row.status,
        payload: JSON.parse(row.payload),
        summary: row.summary,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }
  confirm(id) {
    const action = this.row(id);
    check(
      action.status === "pending",
      "ACTION_RESOLVED",
      "该提案已处理",
      409,
    );
    let applied;
    if (action.type === "patient-update") {
      const current = this.patients.row(action.patientId);
      applied = this.patients.update(action.patientId, {
        expectedRevision: current.revision,
        ...action.payload,
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
    this.store.db
      .prepare("UPDATE pending_actions SET status='applied',updated_at=? WHERE id=?")
      .run(time, id);
    return { ok: true, action: this.row(id), applied };
  }
  reject(id) {
    const action = this.row(id);
    check(
      action.status === "pending",
      "ACTION_RESOLVED",
      "该提案已处理",
      409,
    );
    this.store.db
      .prepare("UPDATE pending_actions SET status='rejected',updated_at=? WHERE id=?")
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
export function pendingActionTools(pending) {
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
  return [
    {
      definition: definition(
        "patient_record_propose",
        "提议把整理好的临床信息写入患者档案（诊断/用药/过敏/检验/就诊）。只创建待确认提案，医生确认后才落库。",
        {
          patientId: textDef,
          diagnoses: {
            type: "array",
            items: {
              type: "object",
              properties: {
                code: textDef,
                name: textDef,
                date: textDef,
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
                dose: textDef,
                frequency: textDef,
                note: textDef,
              },
              required: ["name"],
              additionalProperties: false,
            },
          },
          allergies: { type: "array", items: textDef },
          labs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                item: textDef,
                value: { type: "number" },
                unit: textDef,
                date: textDef,
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
        const { patientId, summary, ...updates } = args;
        return pending.propose({
          type: "patient-update",
          patientId,
          payload: updates,
          summary,
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
