import { patientPhone } from "../shared/patient-phone.mjs";
import { messageProvenance, messageSpeakerLabel, messageTimeLabel } from "../shared/message-provenance.mjs";
import { dashboardLabLayout } from "../shared/patient-dashboard.mjs";
import { patientListBrief } from "../shared/patient-list-brief.mjs";
import { localCalendarDate } from "../shared/calendar-date.mjs";
import { sqliteTransaction } from "./sqlite-transaction.mjs";
import { randomUUID, createHash } from "node:crypto";
import { AppError, check, identifier, string } from "./errors.mjs";
import { DIAGNOSIS_STATUS, mergeDiagnoses } from "../shared/diagnoses.mjs";

// Patient registry: each patient links to one session that acts as the
// clinical workspace (materials, runs, artifacts, review, schedules).
export class PatientRegistry {
  constructor(store, runtime, { createSession, removeSession, onIdentityChanged, onCreated, learning = null, hooks = null, summaries = null } = {}) {
    this.store = store;
    this.runtime = runtime;
    // The fixed region owns the patients table but not plugin data. These two
    // seams are lazy: patient deletion emits a transactional hook, and list /
    // detail counts merge active plugin contributions without naming tables.
    this.hooks = hooks;
    this.summaryProvider = summaries;
    // 统一内核：患者病例会话由 SessionBridge 创建（kind:"session" 工作区）。
    this.createSession = createSession;
    this.removeSession = removeSession;
    this.onIdentityChanged = onIdentityChanged;
    this.onCreated = onCreated;
    this.learning = learning;
    this.store.db.exec("CREATE TABLE IF NOT EXISTS patient_mutation_requests(patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(patient_id, request_id))");
  }
  all() {
    return this.store.db
      .prepare("SELECT id, data FROM patients")
      .all()
      .map((row) => JSON.parse(row.data));
  }
  summaries({ brief = false } = {}) {
    // Clinical histories can grow indefinitely. List and picker requests only
    // need identity fields, so SQLite projects those without transferring charts.
    return this.store.db.prepare(`SELECT json_object(
      'id',id,'name',json_extract(data,'$.name'),
      'patientNumber',json_extract(data,'$.patientNumber'),
      'gender',json_extract(data,'$.gender'),'birthYear',json_extract(data,'$.birthYear'),
      'phone',json_extract(data,'$.phone'),'sessionId',json_extract(data,'$.sessionId'),
      'revision',json_extract(data,'$.revision'),'updatedAt',json_extract(data,'$.updatedAt'),
      'createdAt',json_extract(data,'$.createdAt'),'archived',json_extract(data,'$.archived'),
      'groups',json_extract(data,'$.groups'),'tags',json_extract(data,'$.tags'),
      'diagnoses',json_extract(data,'$.diagnoses'),'visits',json_extract(data,'$.visits')${brief ? `,
      'allergies',json_extract(data,'$.allergies'),'allergyStatus',json_extract(data,'$.allergyStatus'),
      'medications',json_extract(data,'$.medications'),'labs',json_extract(data,'$.labs'),
      'treatmentPlan',json_extract(data,'$.treatmentPlan')` : ""}) AS data FROM patients`)
      .all().map((row) => JSON.parse(row.data));
  }
  row(id) {
    identifier(id);
    const row = this.store.db
      .prepare("SELECT data FROM patients WHERE id=?")
      .get(id);
    check(row, "NOT_FOUND", "患者不存在", 404);
    return JSON.parse(row.data);
  }
  pluginSummary(patientIds, now) {
    if (typeof this.summaryProvider !== "function") return {};
    try {
      return this.summaryProvider(patientIds, { now }) || {};
    } catch (error) {
      // A summary contribution must never break the fixed patient list.
      console.error("患者计数贡献失败:", error);
      return {};
    }
  }
  counts(patientId, now = Date.now()) {
    const one = (sql, ...args) =>
      this.store.db.prepare(sql).get(...args)?.n || 0;
    const contributed = this.pluginSummary([patientId], now)[patientId] || {};
    return {
      unprocessedMessages: one(
        "SELECT COUNT(*) n FROM patient_messages WHERE patient_id=? AND processed=0",
        patientId,
      ),
      activeFollowups: Number.isFinite(contributed.activeFollowups)
        ? contributed.activeFollowups
        : 0,
      dueFollowups: Number.isFinite(contributed.dueFollowups)
        ? contributed.dueFollowups
        : 0,
      pendingReminders: one(
        "SELECT COUNT(*) n FROM reminders WHERE patient_id=? AND status='pending'",
        patientId,
      ),
    };
  }
  allCounts(now = Date.now()) {
    const counts = new Map();
    const entry = (id) => {
      if (!counts.has(id)) counts.set(id, { unprocessedMessages: 0, activeFollowups: 0, dueFollowups: 0, pendingReminders: 0 });
      return counts.get(id);
    };
    for (const row of this.store.db.prepare("SELECT patient_id,COUNT(*) n FROM patient_messages WHERE processed=0 AND patient_id IS NOT NULL GROUP BY patient_id").all()) entry(row.patient_id).unprocessedMessages = row.n;
    for (const row of this.store.db.prepare("SELECT patient_id,COUNT(*) n FROM reminders WHERE status='pending' GROUP BY patient_id").all()) entry(row.patient_id).pendingReminders = row.n;
    const patientIds = this.store.db.prepare("SELECT id FROM patients").all().map((row) => row.id);
    const contributed = this.pluginSummary(patientIds, now);
    for (const [patientId, fields] of Object.entries(contributed)) {
      const row = entry(patientId);
      if (Number.isFinite(fields.activeFollowups))
        row.activeFollowups = fields.activeFollowups;
      if (Number.isFinite(fields.dueFollowups))
        row.dueFollowups = fields.dueFollowups;
    }
    return counts;
  }
  // `brief` adds compact clinical facts (allergy, active meds, abnormal labs,
  // next visit) for list rows; without it the response shape is unchanged.
  list({ query, group, includeArchived = false, summary = false, brief = false } = {}) {
    const counts = this.allCounts();
    const diagnosisText = (p) =>
      typeof p.diagnoses === "string"
        ? p.diagnoses
        : (p.diagnoses || [])
            .map((d) => (typeof d === "string" ? d : d?.name || ""))
            .filter(Boolean)
            .join(" ");
    const q = String(query || "").trim().toLowerCase();
    const patients = (summary ? this.summaries({ brief }) : this.all())
      .filter((p) => includeArchived || !p.archived)
      .filter((p) => !group || p.groups?.includes(group))
      // 内部 ID 只在输入足够长时参与匹配，否则单个字母会命中所有患者。
      .filter((p) => !q || [p.name, p.patientNumber, q.length >= 8 ? p.id : "", p.phone, ...(p.tags || []), diagnosisText(p)]
        .some((value) => String(value || "").toLowerCase().includes(q)))
      .sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt) || a.id.localeCompare(b.id));
    const appointments = brief ? this.upcomingAppointments() : null;
    return patients.map((p) => {
      const row = {
        ...p,
        counts: counts.get(p.id) || { unprocessedMessages: 0, activeFollowups: 0, dueFollowups: 0, pendingReminders: 0 },
        lastVisitAt: (p.visits || []).map((v) => v?.date).filter(Boolean).sort().at(-1) || "",
        diagnosisSummary: diagnosisText(p).split(" ").filter(Boolean).slice(0, 3).join(" · "),
      };
      if (!brief) return row;
      row.brief = patientListBrief(p, appointments.get(p.id));
      // The summary projection only needs the brief; charts stay on the detail route.
      if (summary) for (const key of ["labs", "medications", "treatmentPlan", "allergies", "allergyStatus"]) delete row[key];
      return row;
    });
  }
  upcomingAppointments() {
    // Optional table owned by the schedule service; absent in minimal setups.
    try {
      const today = localCalendarDate();
      const map = new Map();
      for (const row of this.store.db.prepare("SELECT patient_id, date FROM appointments WHERE status='scheduled' AND substr(date,1,10)>=? ORDER BY date").all(today)) {
        if (!map.has(row.patient_id)) map.set(row.patient_id, row.date);
      }
      return map;
    } catch {
      return new Map();
    }
  }
  get(id) {
    const patient = this.row(id);
    return { ...patient, counts: this.counts(id) };
  }
  create(input) {
    return sqliteTransaction(this.store.db, () => {
      check(
        input && typeof input === "object" && !Array.isArray(input),
        "INVALID_INPUT",
        "患者资料无效",
      );
      const nowIso = new Date().toISOString();
      const patient = { ...normalizePatientCreate(input), id: randomUUID(), archived: false, sessionId: null, revision: 0, createdAt: nowIso, updatedAt: nowIso };
      if (input.requestId) {
        patient.creationRequestId = identifier(input.requestId);
        const stable = { ...patient };
        for (const key of ["id", "sessionId", "createdAt", "updatedAt"]) delete stable[key];
        patient.creationFingerprint = createHash("sha256").update(JSON.stringify(stable)).digest("hex");
        const existing = this.store.db.prepare("SELECT data FROM patients WHERE json_extract(data,'$.creationRequestId')=?").get(patient.creationRequestId);
        if (existing) {
          const created = JSON.parse(existing.data);
          check(created.creationFingerprint === patient.creationFingerprint, "CONFLICT", "此建档请求已经保存过其他内容，请先查看已创建的患者", 409);
          return this.get(created.id);
        }
      }
      check(
        input.confirmDistinctPatient === true || !this.all().some((p) => p.name === patient.name),
        "CONFLICT",
        "存在同名患者，请核对后选择已有档案，或确认是另一位患者",
        409,
      );
      this.checkPatientNumber(patient.patientNumber);
      const session = this.createSession({
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
      // 建档事务内把初始检验记为已阅基线（SAVEPOINT 可嵌套）。
      this.onCreated?.(patient);
      return { ...patient, counts: this.counts(patient.id) };
    });
  }
  checkPatientNumber(value, excludingId) {
    check(!value || !this.all().some((patient) => patient.id !== excludingId && patient.patientNumber === value),
      "CONFLICT", "患者编号已被使用，请核对已有档案", 409);
  }
  update(id, input) {
    return sqliteTransaction(this.store.db, () => {
      const patient = this.row(id);
      const previousName = patient.name;
      const reviewBefore = structuredClone(patient);
      check(
        input && typeof input === "object" && !Array.isArray(input),
        "INVALID_INPUT",
        "更新内容无效",
      );
      const requestId = input.requestId === undefined ? null : identifier(input.requestId);
      const fingerprint = createHash("sha256").update(JSON.stringify(input, (key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value)).digest("hex");
      if (requestId) {
        const previous = this.store.db.prepare("SELECT fingerprint FROM patient_mutation_requests WHERE patient_id=? AND request_id=?").get(id, requestId);
        if (previous) {
          check(previous.fingerprint === fingerprint, "REQUEST_CONFLICT", "同一次保存的内容已变化，请核对已保存结果后重新提交", 409);
          return { ...patient, counts: this.counts(id) };
        }
      }
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
      if (input.patientNumber !== undefined) {
        patient.patientNumber = input.patientNumber === "" ? "" : string(input.patientNumber, "患者编号", 40);
        this.checkPatientNumber(patient.patientNumber, id);
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
        patient.phone = validatedPhone(input.phone);
      if (input.groups !== undefined)
        patient.groups = optionalStrings(input.groups, "分组", 10, 40);
      if (input.tags !== undefined)
        patient.tags = optionalStrings(input.tags, "标签", 20, 40);
      if (input.note !== undefined)
        patient.note = input.note === "" ? "" : string(input.note, "备注", 2000);
      if (input.clinicalSummary !== undefined)
        patient.clinicalSummary = optionalClinicalSummary(input.clinicalSummary);
      if (input.diagnoses !== undefined)
        patient.diagnoses = optionalDiagnoses(input.diagnoses);
      if (input.treatmentPlan !== undefined)
        patient.treatmentPlan = optionalTreatmentPlan(input.treatmentPlan);
      if (input.medications !== undefined)
        patient.medications = optionalMedications(input.medications);
      if (input.allergies !== undefined)
        patient.allergies = optionalAllergies(input.allergies);
      patient.allergyStatus = allergyState(patient, input);
      if (input.labs !== undefined) {
        patient.labs = optionalLabs(input.labs);
        if (patient.labDisplay) {
          const valid = new Set(dashboardLabLayout(patient.labs).groups.map(g => g.key));
          let changed = false;
          for (const field of ["order", "compare", "collapsed", "hidden"]) {
            const previous = patient.labDisplay[field];
            if (!previous) continue;
            patient.labDisplay[field] = previous.filter(key => valid.has(key));
            changed ||= previous.length !== patient.labDisplay[field].length;
          }
          if (changed) patient.labDisplay.revision++;
        }
      }
      if (input.visits !== undefined)
        patient.visits = optionalVisits(input.visits);
      if (input.archived !== undefined) {
        check(
          typeof input.archived === "boolean",
          "INVALID_INPUT",
          "归档状态无效",
        );
        patient.archived = input.archived;
      }
      patient.revision++;
      patient.updatedAt = new Date().toISOString();
      this.save(patient);
      this.learning?.()?.reviewLog?.record({ kind: "chart_edit", patientId: id, ai: reviewBefore, final: patient });
      if (previousName !== patient.name) this.onIdentityChanged?.(patient, previousName);
      this.store.audit(patient.sessionId, "patient.updated", {
        patientId: id,
      });
      if (requestId) this.store.db.prepare("INSERT INTO patient_mutation_requests VALUES (?,?,?)").run(id, requestId, fingerprint);
      return { ...patient, counts: this.counts(id) };
    });
  }
  labDisplay(id) {
    const patient = this.row(id);
    const preferences = patient.labDisplay || { revision: 0 };
    return { patientId: id, preferences, groups: dashboardLabLayout(patient.labs, preferences).groups.map(g => ({ key: g.key, item: g.item, unit: g.unit, records: g.records.length })) };
  }
  updateLabDisplay(id, input) {
    return sqliteTransaction(this.store.db, () => {
      const patient = this.row(id);
      check(input && typeof input === "object" && !Array.isArray(input), "INVALID_INPUT", "展示偏好无效");
      const current = patient.labDisplay || { revision: 0 };
      check(input.expectedRevision === current.revision, "REVISION_CONFLICT", "展示偏好已变化，请刷新后重试", 409);
      check(Object.keys(input).every(k => ["expectedRevision", "reset", "order", "compare", "collapsed", "hidden"].includes(k)), "INVALID_INPUT", "未知展示偏好");
      check(input.reset === undefined || typeof input.reset === "boolean", "INVALID_INPUT", "重置选项无效");
      const next = input.reset ? {} : { ...current };
      const keys = new Set(dashboardLabLayout(patient.labs).groups.map(g => g.key));
      for (const field of ["order", "compare", "collapsed", "hidden"]) {
        if (input[field] === undefined) continue;
        check(!input.reset && Array.isArray(input[field]) && input[field].length <= 1000 && input[field].every(k => typeof k === "string" && keys.has(k)) && new Set(input[field]).size === input[field].length, "INVALID_INPUT", "请使用当前患者的有效检验指标，不能重复");
        next[field] = input[field];
      }
      next.revision = current.revision + 1;
      patient.labDisplay = next;
      this.save(patient);
      this.store.audit(patient.sessionId, "patient.lab_display.updated", { patientId: id, preferences: next });
      return this.labDisplay(id);
    });
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
    const result = {
      pseudoId,
      gender: patient.gender || "unknown",
      ageBand:
        age !== null
          ? `${Math.floor(age / 10) * 10}–${Math.floor(age / 10) * 10 + 9}`
          : null,
      diagnoses: (patient.diagnoses || []).map(({ name, code, date, status }) => ({ name, code, date, ...(status ? { status } : {}) })),
      medications: (patient.medications || []).map((m) => ({
        name: m.name,
        ...(m.dose ? { dose: m.dose } : {}),
        ...(m.frequency ? { frequency: m.frequency } : {}),
        status: m.status || "unknown",
      })),
      allergies: patient.allergies || [],
      allergyStatus: patient.allergyStatus || ((patient.allergies || []).length ? "recorded" : "unknown"),
      labs: (patient.labs || []).map(({ item, value, unit, date }) => ({ item, value, unit, date })),
      visits: (patient.visits || []).map((v) => ({
        date: v.date,
        reason: v.reason,
      })),
      exportedAt: new Date().toISOString(),
      note: "基础脱敏：已移除直接身份字段与来源文本，出生年份改为年龄段。临床自由文本可能仍含间接识别信息，导出前需复核。",
    };
    const identities = [patient.id, patient.name, patient.phone, patient.patientNumber].filter(Boolean).sort((a, b) => b.length - a.length);
    const redact = (value) => {
      if (typeof value === "string") return identities.reduce((text, identity) => text.split(identity).join("[身份信息已移除]"), value);
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
      return value;
    };
    return redact(result);
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
    // Plugin-owned rows are removed through the synchronous hook bus in the
    // same transaction as the fixed tables. A plugin failure rolls back every
    // participant instead of leaving a half-deleted chart.
    sqliteTransaction(this.store.db, () => {
      this.hooks?.("patient.deleted", { patientId: id, patient });
      this.store.db.prepare("DELETE FROM reminders WHERE patient_id=?").run(id);
      this.store.db
        .prepare("DELETE FROM patient_messages WHERE patient_id=?")
        .run(id);
      this.store.db.prepare("DELETE FROM patients WHERE id=?").run(id);
    });
    this.removeSession?.(sessionId);
  }
  matchPatient(hint) {
    if (!hint) return null;
    const text = String(hint).trim();
    if (!text) return null;
    const patients = this.all().filter((p) => !p.archived);
    const byId = patients.find((p) => p.id === text);
    if (byId) return byId;
    // Any overlap (name/number/shared phone) is ambiguous. Never select the
    // first patient merely because it was inserted first.
    const digits = /^[+\d\s()-]+$/.test(text) ? text.replace(/\D/g, "") : "";
    const candidates = patients.filter((patient) =>
      patient.name === text || patient.patientNumber === text ||
      (digits.length >= 5 && (patient.phone || "").replace(/\D/g, "") === digits));
    return candidates.length === 1 ? candidates[0] : null;
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
    const timeUnknown = raw.timeUnknown === true;
    let time = raw.time === undefined ? new Date().toISOString() : raw.time;
    if (typeof time === "number" && Number.isFinite(time))
      time = new Date(time).toISOString();
    check(
      timeUnknown || (typeof time === "string" &&
        Number.isFinite(Date.parse(time)) &&
        Date.parse(time) <= Date.now() + 86400000),
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
      time: timeUnknown ? "" : new Date(time).toISOString(),
      timeUnknown,
      rawTime: raw.rawTime ? string(raw.rawTime, "原始时间", 200) : "",
      speaker: optionalChoice(raw.speaker, ["doctor", "patient", "family", "unknown"]),
      rawSpeaker: raw.rawSpeaker ? string(raw.rawSpeaker, "原始发言人", 200) : "",
      collectedAt: new Date().toISOString(),
      text,
    };
  }
  ingest(messages, { fallbackChannel = "ingest", patientId = null } = {}) {
    check(
      Array.isArray(messages) && messages.length > 0 && messages.length <= 200,
      "INVALID_INPUT",
      "每次最多导入 200 条消息",
    );
    if (patientId) this.row(patientId);
    const parsed = messages.map((m) => this.parseMessage(m, fallbackChannel));
    let stored = 0,
      duplicates = 0,
      unassigned = 0;
    return sqliteTransaction(this.store.db, () => {
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
      if (fallbackChannel === "manual" && patient && this.store.db.prepare(
        "SELECT id FROM patient_messages WHERE patient_id=? AND channel=? AND direction=? AND time=? AND json_extract(data,'$.text')=? AND COALESCE(json_extract(data,'$.speaker'),'')=? AND COALESCE(json_extract(data,'$.rawTime'),'')=? AND COALESCE(json_extract(data,'$.rawSpeaker'),'')=?"
      ).get(patient.id, message.channel, message.direction, message.time, message.text, message.speaker || "", message.rawTime, message.rawSpeaker)) { duplicates++; continue; }
      if (!patient) unassigned++;
      this.insertMessage(patient?.id || null, message);
      stored++;
    }
    return { stored, duplicates, unassigned };
    });
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
          speaker: message.speaker, rawSpeaker: message.rawSpeaker,
          timeUnknown: message.timeUnknown, rawTime: message.rawTime, collectedAt: message.collectedAt,
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
        ...JSON.parse(row.data),
        ...messageProvenance(JSON.parse(row.data), row.direction),
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
    check(!row.patient_id, "CONFLICT", "该消息已归属患者", 409);
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
  markProcessed(patientId, runId, messageIds) {
    return markDigestProcessed(this.store, patientId, runId, messageIds);
  }
}
// IDs are captured by the server before model execution, never supplied by it.
export function markDigestProcessed(store, patientId, runId, messageIds) {
  check(
    Array.isArray(messageIds) &&
      messageIds.every((id) => Number.isSafeInteger(id) && id > 0),
    "INVALID_INPUT",
    "摘要消息快照无效",
  );
  if (!messageIds.length) return;
  store.db
    .prepare(
      `UPDATE patient_messages SET processed=1, data=json_set(data,'$.digestRunId',json_quote(?)) WHERE patient_id=? AND processed=0 AND id IN (${messageIds.map(() => "?").join(",")})`,
    )
    .run(runId, patientId, ...messageIds);
}
export function selectDigestMessages(pending) {
  const messages = [];
  let budget = 12000;
  for (const message of pending.slice(0, 50)) {
    const size = message.text.length + JSON.stringify(messageProvenance(message, message.direction)).length + 80;
    if (size > budget) break;
    budget -= size;
    messages.push(message);
  }
  check(
    !pending.length || messages.length > 0,
    "DIGEST_INPUT_TOO_LARGE",
    "首条待处理消息超过摘要输入预算，请先拆分消息",
    422,
  );
  return messages;
}
export function composeDigest(messages, patientName = "患者") {
  const lines = messages
    .slice()
    .sort((a, b) => a.time.localeCompare(b.time))
    .map(
      (m) =>
        `[${messageTimeLabel(m)}] ${messageSpeakerLabel(m)}${m.rawSpeaker ? `（原始发言人：${m.rawSpeaker}）` : ""}（${m.channel}）：${m.text}`,
    );
  return `请把以下${patientName}的消息整理为病历记录补充。按主题归纳要点并保留发生时间；无法从消息中确认的内容明确标注"待确认"；不要给出治疗、剂量或用药建议。整理完成后在本次回复中概括新增内容与实际缺失或冲突，用户可直接回复补充或更正。\n\n${lines.join("\n")}`;
}
function optionalChoice(value, choices) {
  if (value === undefined || value === null || value === "") return null;
  check(
    choices.includes(value),
    "INVALID_INPUT",
    `取值须为 ${choices.join("/")}`,
  );
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
  const items = value
    .map((v) => string(v, label, maxLen).trim())
    .filter(Boolean);
  check(
    new Set(items).size === items.length,
    "INVALID_INPUT",
    `${label}不能重复`,
  );
  return items;
}
// 过敏史：旧数据为纯字符串；填写了反应时存为 { substance, reaction }。
// 没有反应的对象收敛回字符串，保持与既有读取方兼容。
function optionalAllergies(value) {
  if (value === undefined || value === null) return [];
  check(Array.isArray(value) && value.length <= 20, "INVALID_INPUT", "过敏史最多 20 个");
  const items = value.map((v) => {
    if (typeof v === "string") return string(v, "过敏史", 120).trim();
    check(v && typeof v === "object" && !Array.isArray(v), "INVALID_INPUT", "过敏史格式无效");
    const substance = string(v.substance, "过敏原", 120).trim();
    const reaction = v.reaction === undefined || v.reaction === null || v.reaction === "" ? "" : string(v.reaction, "过敏反应", 120).trim();
    return reaction ? { substance, reaction } : substance;
  });
  const names = items.map((item) => (typeof item === "string" ? item : item.substance));
  check(new Set(names).size === names.length, "INVALID_INPUT", "过敏史不能重复");
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
  return value.map((item, index) => {
    check(
      item && typeof item === "object" && !Array.isArray(item),
      "INVALID_INPUT",
      `${label}格式无效`,
    );
    try {
      return build(item);
    } catch (error) {
      // Prefix the entry index, otherwise an over-long note deep inside the
      // list reads as just "备注 too long" and the agent retries blind.
      if (error instanceof AppError && error.code === "INVALID_INPUT")
        error.message = `${label}[${index + 1}] ${error.message}`;
      throw error;
    }
  });
}
// Normalized clinical-field validation shared with the agent proposal flow.
export function validateClinicalInput(input = {}) {
  return {
    ...(input.clinicalSummary !== undefined ? { clinicalSummary: optionalClinicalSummary(input.clinicalSummary) } : {}),
    ...(input.diagnoses !== undefined
      ? { diagnoses: optionalDiagnoses(input.diagnoses) }
      : {}),
    ...(input.medications !== undefined
      ? { medications: optionalMedications(input.medications) }
      : {}),
    ...(input.allergies !== undefined
      ? { allergies: optionalAllergies(input.allergies) }
      : {}),
    ...(input.allergyStatus !== undefined
      ? { allergyStatus: optionalChoice(input.allergyStatus, ["unknown", "none_known", "recorded"]) || "unknown" }
      : {}),
    ...(input.labs !== undefined ? { labs: optionalLabs(input.labs) } : {}),
    ...(input.visits !== undefined
      ? { visits: optionalVisits(input.visits) }
      : {}),
  };
}
function validatedPhone(value) {
  const result = patientPhone(value);
  check(!result.error, "INVALID_INPUT", result.error);
  return result.value;
}
// Identity fields (name 等) for the agent proposal flow — same rules as the
// profile-page edit path in update(), so a name the doctor states in chat can
// land on the record instead of being dumped into a note.
export function validateIdentityInput(input = {}) {
  const fields = {};
  if (input.name !== undefined) {
    const name = string(input.name, "患者姓名", 80);
    check(name.trim(), "INVALID_INPUT", "患者姓名不能为空");
    fields.name = name.trim();
  }
  if (input.patientNumber !== undefined)
    fields.patientNumber =
      input.patientNumber === "" ? "" : string(input.patientNumber, "患者编号", 40);
  if (input.gender !== undefined)
    fields.gender = optionalChoice(input.gender, ["male", "female", "unknown"]);
  if (input.birthYear !== undefined)
    fields.birthYear = optionalInt(input.birthYear, 1900, new Date().getFullYear());
  if (input.phone !== undefined)
    fields.phone = validatedPhone(input.phone);
  return fields;
}
function allergyState(patient, input) {
  const status = input.allergyStatus;
  check(status === undefined || ["unknown", "none_known", "recorded"].includes(status), "INVALID_INPUT", "过敏史记录状态无效");
  if ((patient.allergies || []).length) {
    check(status === undefined || status === "recorded", "INVALID_INPUT", "已有过敏原记录，不能标记为无已知过敏或未记录");
    return "recorded";
  }
  check(status !== "recorded", "INVALID_INPUT", "请先填写已知过敏原");
  return status || (input.allergies !== undefined ? "unknown" : patient.allergyStatus || "unknown");
}
const diagnosisSourceList = (value) => {
  const items = (Array.isArray(value) ? value : [])
    .map((item) => string(item, "诊断来源", 200).trim())
    .filter(Boolean);
  check(items.length <= 8, "INVALID_INPUT", "诊断来源最多 8 条");
  return [...new Set(items)];
};
function optionalDiagnoses(value) {
  const list = structuredList(value, "诊断", 40, (item) => ({
    code: item.code ? string(item.code, "ICD-10 编码", 20) : "",
    name: string(item.name, "诊断名称", 120),
    ...(item.date ? { date: clinicalDate(item.date, "诊断日期") } : {}),
    ...(item.status ? { status: optionalChoice(item.status, DIAGNOSIS_STATUS) } : {}),
    ...(item.note ? { note: string(item.note, "诊断备注", 300) } : {}),
    ...(item.source ? { source: string(item.source, "来源", 200) } : {}),
    ...(item.sources !== undefined ? { sources: diagnosisSourceList(item.sources) } : {}),
  }));
  // Same problem repeated across documents collapses into one entry that
  // keeps every source; doctor-entered duplicates merge the same way.
  return mergeDiagnoses(list);
}
function optionalTreatmentPlan(value) {
  check(value && typeof value === "object" && !Array.isArray(value), "INVALID_INPUT", "治疗方案格式无效");
  const result = {};
  const textFields = { title: 120, goal: 2000, interventions: 4000, prognosis: 2000, source: 200 };
  const dateFields = ["startDate", "reviewDate", "assessmentDate"];
  check(Object.keys(value).every(key => key in textFields || dateFields.includes(key) || key === "status"), "INVALID_INPUT", "未知治疗方案字段");
  for (const [key, limit] of Object.entries(textFields)) result[key] = value[key] === undefined || value[key] === "" ? "" : string(value[key], "治疗方案内容", limit).trim();
  check(result.title, "INVALID_INPUT", "请填写治疗方案名称");
  result.status = optionalChoice(value.status, ["active", "paused", "completed"]) || "active";
  for (const key of dateFields) result[key] = value[key] === undefined || value[key] === "" ? "" : clinicalDate(value[key], "方案日期");
  check(!result.startDate || !result.reviewDate || result.reviewDate >= result.startDate, "INVALID_INPUT", "复评日期不能早于开始日期");
  check(!result.prognosis || result.assessmentDate, "INVALID_INPUT", "填写预后评估时请同时记录评估日期");
  return result;
}
function optionalMedications(value) {
  return structuredList(value, "用药", 60, (item) => ({
    name: string(item.name, "药名", 120),
    ...(item.status !== undefined ? { status: optionalChoice(item.status, ["active", "stopped", "unknown"]) || "unknown" } : {}),
    ...(item.dose ? { dose: string(item.dose, "剂量", 60) } : {}),
    ...(item.frequency
      ? { frequency: string(item.frequency, "频次", 60) }
      : {}),
    ...(item.startDate ? { startDate: clinicalDate(item.startDate, "开始用药日期") } : {}),
    ...(item.stoppedAt ? { stoppedAt: clinicalDate(item.stoppedAt, "停药日期") } : {}),
    ...(item.stopReason ? { stopReason: string(item.stopReason, "停药原因", 200) } : {}),
    ...(item.note ? { note: string(item.note, "备注", 500) } : {}),
    ...(item.source ? { source: string(item.source, "来源", 200) } : {}),
    ...(item.sources !== undefined ? { sources: diagnosisSourceList(item.sources) } : {}),
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
      ...(item.referenceRange ? { referenceRange: string(item.referenceRange, "报告参考范围", 200) } : {}),
      ...(item.note ? { note: string(item.note, "备注", 500) } : {}),
      ...(item.source ? { source: string(item.source, "来源", 200) } : {}),
      ...(item.sources !== undefined ? { sources: diagnosisSourceList(item.sources) } : {}),
    };
  });
}
function optionalVisits(value) {
  return structuredList(value, "就诊", 200, (item) => ({
    date: clinicalDate(item.date, "就诊日期"),
    reason: string(item.reason, "就诊事由", 200),
    ...(item.source ? { source: string(item.source, "来源", 200) } : {}),
    ...(item.sources !== undefined ? { sources: diagnosisSourceList(item.sources) } : {}),
    ...(item.note ? { note: string(item.note, "备注", 4000) } : {}),
  }));
}

function timestamp(value) { return typeof value === "number" ? value : Date.parse(value) || 0; }

function optionalClinicalSummary(value) {
  check(value && typeof value === "object" && !Array.isArray(value), "INVALID_INPUT", "病史摘要须包含正文与来源");
  return {text:string(value.text,"病史摘要正文",4000), source:string(value.source,"病史摘要来源",2000)};
}

export function normalizePatientCreate(input) {
  check(input && typeof input === "object" && !Array.isArray(input), "INVALID_INPUT", "患者资料无效");
  const name = string(input.name, "患者姓名", 80);
  check(name.trim(), "INVALID_INPUT", "患者姓名不能为空");
  const patient = {
        name: name.trim(),
        patientNumber: input.patientNumber ? string(input.patientNumber, "患者编号", 40) : "",
        gender: optionalChoice(input.gender, ["male", "female", "unknown"]),
        birthYear: optionalInt(input.birthYear, 1900, new Date().getFullYear()),
        phone: validatedPhone(input.phone),
        groups: optionalStrings(input.groups, "分组", 10, 40),
        tags: optionalStrings(input.tags, "标签", 20, 40),
        note: input.note === undefined || input.note === "" ? "" : string(input.note, "备注", 2000),
        ...(input.clinicalSummary !== undefined ? { clinicalSummary: optionalClinicalSummary(input.clinicalSummary) } : {}),
        diagnoses: optionalDiagnoses(input.diagnoses),
        ...(input.treatmentPlan !== undefined ? { treatmentPlan: optionalTreatmentPlan(input.treatmentPlan) } : {}),
        medications: optionalMedications(input.medications),
        allergies: optionalAllergies(input.allergies),
        labs: optionalLabs(input.labs),
        visits: optionalVisits(input.visits),
  };
  patient.allergyStatus = allergyState(patient, input);
  return patient;
}
