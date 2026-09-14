import { randomUUID, createHash } from "node:crypto";
import { AppError, check, identifier, string } from "./errors.mjs";

// Patient registry: each patient links to one session that acts as the
// clinical workspace (materials, runs, artifacts, review, schedules).
export class PatientRegistry {
  constructor(store, runtime) {
    this.store = store;
    this.runtime = runtime;
  }
  all() {
    return this.store.db
      .prepare("SELECT id, data FROM patients")
      .all()
      .map((row) => JSON.parse(row.data));
  }
  row(id) {
    identifier(id);
    const row = this.store.db
      .prepare("SELECT data FROM patients WHERE id=?")
      .get(id);
    check(row, "NOT_FOUND", "患者不存在", 404);
    return JSON.parse(row.data);
  }
  counts(patientId, now = Date.now()) {
    const one = (sql, ...args) =>
      this.store.db.prepare(sql).get(...args)?.n || 0;
    return {
      unprocessedMessages: one(
        "SELECT COUNT(*) n FROM patient_messages WHERE patient_id=? AND processed=0",
        patientId,
      ),
      activeFollowups: one(
        "SELECT COUNT(*) n FROM follow_ups WHERE patient_id=? AND status IN ('active','running','paused')",
        patientId,
      ),
      dueFollowups: one(
        "SELECT COUNT(*) n FROM follow_ups WHERE patient_id=? AND status='active' AND next_due<=?",
        patientId,
        now,
      ),
      pendingReminders: one(
        "SELECT COUNT(*) n FROM reminders WHERE patient_id=? AND status='pending'",
        patientId,
      ),
    };
  }
  list({ query, group, includeArchived = false } = {}) {
    const patients = this.all()
      .filter((p) => includeArchived || !p.archived)
      .filter((p) => !group || p.groups?.includes(group))
      .filter(
        (p) =>
          !query ||
          p.name.includes(query) ||
          (p.phone || "").includes(query) ||
          (p.tags || []).some((t) => t.includes(query)),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return patients.map((p) => ({
      ...p,
      counts: this.counts(p.id),
    }));
  }
  get(id) {
    const patient = this.row(id);
    return { ...patient, counts: this.counts(id) };
  }
  create(input) {
    check(
      input && typeof input === "object" && !Array.isArray(input),
      "INVALID_INPUT",
      "患者资料无效",
    );
    const name = string(input.name, "患者姓名", 80);
    check(name.trim().length >= 1, "INVALID_INPUT", "患者姓名不能为空");
    const nowIso = new Date().toISOString();
    const patient = {
      id: randomUUID(),
      name: name.trim(),
      gender: optionalChoice(input.gender, ["male", "female", "unknown"]),
      birthYear: optionalInt(input.birthYear, 1900, new Date().getFullYear()),
      phone: input.phone === undefined ? "" : string(input.phone, "联系电话", 20),
      groups: optionalStrings(input.groups, "分组", 10, 40),
      tags: optionalStrings(input.tags, "标签", 20, 40),
      note: input.note === undefined ? "" : string(input.note, "备注", 2000),
      diagnoses: optionalDiagnoses(input.diagnoses),
      medications: optionalMedications(input.medications),
      allergies: optionalStrings(input.allergies, "过敏史", 20, 120),
      labs: optionalLabs(input.labs),
      visits: optionalVisits(input.visits),
      archived: false,
      sessionId: null,
      revision: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    check(
      !this.all().some((p) => !p.archived && p.name === patient.name),
      "CONFLICT",
      "已有同名在管患者，请改用其他标识",
      409,
    );
    const session = this.store.create({
      title: `${patient.name} · 病例`,
      patientId: patient.id,
    });
    patient.sessionId = session.id;
    this.store.db
      .prepare("INSERT INTO patients VALUES (?,?)")
      .run(patient.id, JSON.stringify(patient));
    this.store.audit(session.id, "patient.created", {
      patientId: patient.id,
    });
    return { ...patient, counts: this.counts(patient.id) };
  }
  update(id, input) {
    const patient = this.row(id);
    check(
      input && typeof input === "object" && !Array.isArray(input),
      "INVALID_INPUT",
      "更新内容无效",
    );
    check(
      input.expectedRevision === patient.revision,
      "REVISION_CONFLICT",
      "患者档案已变化，请刷新后重试",
      409,
    );
    if (input.name !== undefined) {
      const name = string(input.name, "患者姓名", 80);
      check(name.trim(), "INVALID_INPUT", "患者姓名不能为空");
      patient.name = name.trim();
    }
    if (input.gender !== undefined)
      patient.gender = optionalChoice(input.gender, [
        "male",
        "female",
        "unknown",
      ]);
    if (input.birthYear !== undefined)
      patient.birthYear = optionalInt(
        input.birthYear,
        1900,
        new Date().getFullYear(),
      );
    if (input.phone !== undefined)
      patient.phone = string(input.phone, "联系电话", 20);
    if (input.groups !== undefined)
      patient.groups = optionalStrings(input.groups, "分组", 10, 40);
    if (input.tags !== undefined)
      patient.tags = optionalStrings(input.tags, "标签", 20, 40);
    if (input.note !== undefined)
      patient.note = string(input.note, "备注", 2000);
    if (input.diagnoses !== undefined)
      patient.diagnoses = optionalDiagnoses(input.diagnoses);
    if (input.medications !== undefined)
      patient.medications = optionalMedications(input.medications);
    if (input.allergies !== undefined)
      patient.allergies = optionalStrings(input.allergies, "过敏史", 20, 120);
    if (input.labs !== undefined) patient.labs = optionalLabs(input.labs);
    if (input.visits !== undefined) patient.visits = optionalVisits(input.visits);
    if (input.archived !== undefined) {
      check(typeof input.archived === "boolean", "INVALID_INPUT", "归档状态无效");
      patient.archived = input.archived;
    }
    patient.revision++;
    patient.updatedAt = new Date().toISOString();
    this.save(patient);
    this.store.audit(patient.sessionId, "patient.updated", {
      patientId: id,
    });
    return { ...patient, counts: this.counts(id) };
  }
  save(patient) {
    this.store.db
      .prepare("UPDATE patients SET data=? WHERE id=?")
      .run(JSON.stringify(patient), patient.id);
  }
  // Research export: identity fields are removed or bucketed; clinical
  // content stays so cohort summaries remain usable.
  exportDeidentified(id) {
    const patient = this.row(id);
    const pseudoId = `P-${createHash("sha256").update(patient.id).digest("hex").slice(0, 8)}`;
    const age = patient.birthYear
      ? new Date().getFullYear() - patient.birthYear
      : null;
    return {
      pseudoId,
      gender: patient.gender || "unknown",
      ageBand:
        age !== null ? `${Math.floor(age / 10) * 10}–${Math.floor(age / 10) * 10 + 9}` : null,
      diagnoses: patient.diagnoses || [],
      medications: (patient.medications || []).map((m) => ({
        name: m.name,
        ...(m.dose ? { dose: m.dose } : {}),
        ...(m.frequency ? { frequency: m.frequency } : {}),
      })),
      allergies: patient.allergies || [],
      labs: patient.labs || [],
      visits: (patient.visits || []).map((v) => ({
        date: v.date,
        reason: v.reason,
      })),
      exportedAt: new Date().toISOString(),
      note: "已脱敏：姓名、电话与确切出生年份已移除，仅保留年龄段；导出文件请按机构科研规范管理。",
    };
  }
  remove(id) {
    const patient = this.row(id);
    const sessionId = patient.sessionId;
    check(
      !this.runtime.active.has(sessionId),
      "RUN_ACTIVE",
      "请先停止该患者的执行再删除档案",
      409,
    );
    this.store.db
      .prepare("DELETE FROM follow_ups WHERE patient_id=?")
      .run(id);
    this.store.db.prepare("DELETE FROM reminders WHERE patient_id=?").run(id);
    this.store.db
      .prepare("DELETE FROM patient_messages WHERE patient_id=?")
      .run(id);
    this.store.db.prepare("DELETE FROM patients WHERE id=?").run(id);
    try {
      this.store.get(sessionId);
      this.store.delete(sessionId);
    } catch {
      /* workspace already removed */
    }
  }
  matchPatient(hint) {
    if (!hint) return null;
    const text = String(hint).trim();
    if (!text) return null;
    const digits = text.replace(/\D/g, "");
    const patients = this.all().filter((p) => !p.archived);
    if (digits.length >= 5) {
      const byPhone = patients.find(
        (p) => (p.phone || "").replace(/\D/g, "") === digits,
      );
      if (byPhone) return byPhone;
    }
    return patients.find((p) => p.name === text) || null;
  }
  parseMessage(raw, fallbackChannel = "ingest") {
    check(
      raw && typeof raw === "object" && !Array.isArray(raw),
      "INVALID_INPUT",
      "消息格式无效",
    );
    check(
      raw.direction === "in" || raw.direction === "out",
      "INVALID_INPUT",
      "消息方向须为 in 或 out",
    );
    const text = string(raw.text, "消息内容", 5000);
    check(text.trim().length > 0, "INVALID_INPUT", "消息内容不能为空");
    let time = raw.time === undefined ? new Date().toISOString() : raw.time;
    if (typeof time === "number" && Number.isFinite(time))
      time = new Date(time).toISOString();
    check(
      typeof time === "string" &&
        Number.isFinite(Date.parse(time)) &&
        Date.parse(time) <= Date.now() + 86400000,
      "INVALID_INPUT",
      "消息时间无效",
    );
    return {
      externalId:
        raw.externalId === undefined || raw.externalId === null
          ? null
          : string(raw.externalId, "externalId", 120),
      channel:
        raw.channel === undefined
          ? fallbackChannel
          : string(raw.channel, "channel", 20),
      patientHint:
        raw.patientHint === undefined || raw.patientHint === null
          ? null
          : string(raw.patientHint, "patientHint", 80),
      direction: raw.direction,
      time: new Date(time).toISOString(),
      text,
    };
  }
  ingest(messages, { fallbackChannel = "ingest", patientId = null } = {}) {
    check(
      Array.isArray(messages) &&
        messages.length > 0 &&
        messages.length <= 200,
      "INVALID_INPUT",
      "每次最多导入 200 条消息",
    );
    if (patientId) this.row(patientId);
    const parsed = messages.map((m) => this.parseMessage(m, fallbackChannel));
    let stored = 0,
      duplicates = 0,
      unassigned = 0;
    for (const message of parsed) {
      if (
        message.externalId &&
        this.store.db
          .prepare("SELECT id FROM patient_messages WHERE external_id=?")
          .get(message.externalId)
      ) {
        duplicates++;
        continue;
      }
      const patient = patientId
        ? { id: patientId }
        : message.patientHint
          ? this.matchPatient(message.patientHint)
          : null;
      if (!patient) unassigned++;
      this.insertMessage(patient?.id || null, message);
      stored++;
    }
    return { stored, duplicates, unassigned };
  }
  insertMessage(patientId, message) {
    this.store.db
      .prepare(
        "INSERT INTO patient_messages(patient_id,channel,direction,time,external_id,processed,data) VALUES (?,?,?,?,?,0,?)",
      )
      .run(
        patientId,
        message.channel,
        message.direction,
        message.time,
        message.externalId,
        JSON.stringify({
          text: message.text,
          patientHint: message.patientHint,
        }),
      );
  }
  messages(patientId, { unprocessedOnly = false, limit = 200 } = {}) {
    this.row(patientId);
    check(
      Number.isInteger(limit) && limit > 0 && limit <= 500,
      "INVALID_INPUT",
      "消息分页参数无效",
    );
    return this.store.db
      .prepare(
        `SELECT id,patient_id,channel,direction,time,external_id,processed,data
         FROM patient_messages WHERE patient_id=? ${unprocessedOnly ? "AND processed=0" : ""}
         ORDER BY time DESC, id DESC LIMIT ?`,
      )
      .all(patientId, limit)
      .map((row) => ({
        id: row.id,
        patientId: row.patient_id,
        channel: row.channel,
        direction: row.direction,
        time: row.time,
        externalId: row.external_id,
        processed: Boolean(row.processed),
        text: JSON.parse(row.data).text,
      }));
  }
  unassigned({ limit = 200 } = {}) {
    check(
      Number.isInteger(limit) && limit > 0 && limit <= 500,
      "INVALID_INPUT",
      "消息分页参数无效",
    );
    return this.store.db
      .prepare(
        `SELECT id,patient_id,channel,direction,time,external_id,processed,data
         FROM patient_messages WHERE patient_id IS NULL ORDER BY time DESC, id DESC LIMIT ?`,
      )
      .all(limit)
      .map((row) => ({
        id: row.id,
        channel: row.channel,
        direction: row.direction,
        time: row.time,
        externalId: row.external_id,
        text: JSON.parse(row.data).text,
        patientHint: JSON.parse(row.data).patientHint,
      }));
  }
  assign(messageId, patientId) {
    const id = Number(messageId);
    check(Number.isInteger(id) && id > 0, "INVALID_INPUT", "消息编号无效");
    const patient = this.row(patientId);
    const row = this.store.db
      .prepare(
        "SELECT id, patient_id, external_id, data FROM patient_messages WHERE id=?",
      )
      .get(id);
    check(row, "NOT_FOUND", "消息不存在", 404);
    check(
      !row.patient_id,
      "CONFLICT",
      "该消息已归属患者",
      409,
    );
    if (
      row.external_id &&
      this.store.db
        .prepare(
          "SELECT id FROM patient_messages WHERE external_id=? AND patient_id=?",
        )
        .get(row.external_id, patientId)
    )
      throw new AppError("CONFLICT", "该外部消息已归档到此患者", 409);
    this.store.db
      .prepare("UPDATE patient_messages SET patient_id=? WHERE id=?")
      .run(patientId, id);
    this.store.audit(patient.sessionId, "messages.assigned", { messageId });
    return { ok: true };
  }
  markProcessed(patientId, runId) {
    this.store.db
      .prepare(
        "UPDATE patient_messages SET processed=1, data=json_set(data,'$.digestRunId',json_quote(?)) WHERE patient_id=? AND processed=0",
      )
      .run(runId, patientId);
  }
}
export function composeDigest(messages, patientName = "患者") {
  const lines = messages
    .slice()
    .sort((a, b) => a.time.localeCompare(b.time))
    .map(
      (m) =>
        `[${m.time}] ${m.direction === "out" ? "医生侧发出" : "患者发来"}（${m.channel}）：${m.text}`,
    );
  return `请把以下${patientName}的消息整理为病历记录补充。按主题归纳要点并保留发生时间；无法从消息中确认的内容明确标注"待确认"；不要给出治疗、剂量或用药建议。整理完成后调用 make_review_checklist，生成需要医生跟进确认的事项清单。\n\n${lines.join("\n")}`;
}
function optionalChoice(value, choices) {
  if (value === undefined || value === null || value === "") return null;
  check(choices.includes(value), "INVALID_INPUT", `取值须为 ${choices.join("/")}`);
  return value;
}
function optionalInt(value, min, max) {
  if (value === undefined || value === null || value === "") return null;
  check(
    Number.isInteger(value) && value >= min && value <= max,
    "INVALID_INPUT",
    `取值须为 ${min}–${max} 的整数`,
  );
  return value;
}
function optionalStrings(value, label, maxCount, maxLen) {
  if (value === undefined || value === null) return [];
  check(
    Array.isArray(value) && value.length <= maxCount,
    "INVALID_INPUT",
    `${label}最多 ${maxCount} 个`,
  );
  const items = value.map((v) => string(v, label, maxLen).trim()).filter(Boolean);
  check(new Set(items).size === items.length, "INVALID_INPUT", `${label}不能重复`);
  return items;
}
const clinicalDate = (value, label) => {
  const text = string(value, label, 10);
  check(
    /^\d{4}-\d{2}-\d{2}$/.test(text) &&
      !Number.isNaN(Date.parse(text)) &&
      new Date(text).toISOString().slice(0, 10) === text,
    "INVALID_INPUT",
    `${label}须为 YYYY-MM-DD`,
  );
  return text;
};
function structuredList(value, label, maxCount, build) {
  if (value === undefined || value === null) return [];
  check(
    Array.isArray(value) && value.length <= maxCount,
    "INVALID_INPUT",
    `${label}最多 ${maxCount} 条`,
  );
  return value.map((item) => {
    check(
      item && typeof item === "object" && !Array.isArray(item),
      "INVALID_INPUT",
      `${label}格式无效`,
    );
    return build(item);
  });
}
function optionalDiagnoses(value) {
  return structuredList(value, "诊断", 40, (item) => ({
    code: item.code ? string(item.code, "ICD-10 编码", 20) : "",
    name: string(item.name, "诊断名称", 120),
    ...(item.date ? { date: clinicalDate(item.date, "诊断日期") } : {}),
  }));
}
function optionalMedications(value) {
  return structuredList(value, "用药", 60, (item) => ({
    name: string(item.name, "药名", 120),
    ...(item.dose ? { dose: string(item.dose, "剂量", 60) } : {}),
    ...(item.frequency ? { frequency: string(item.frequency, "频次", 60) } : {}),
    ...(item.note ? { note: string(item.note, "备注", 200) } : {}),
  }));
}
function optionalLabs(value) {
  return structuredList(value, "检验", 500, (item) => {
    const value_ = item.value;
    check(
      typeof value_ === "number" && Number.isFinite(value_),
      "INVALID_INPUT",
      "检验数值必须为数字",
    );
    return {
      item: string(item.item, "检验项目", 60),
      value: value_,
      ...(item.unit ? { unit: string(item.unit, "单位", 30) } : {}),
      date: clinicalDate(item.date, "检验日期"),
    };
  });
}
function optionalVisits(value) {
  return structuredList(value, "就诊", 200, (item) => ({
    date: clinicalDate(item.date, "就诊日期"),
    reason: string(item.reason, "就诊事由", 200),
    ...(item.note ? { note: string(item.note, "备注", 500) } : {}),
  }));
}
