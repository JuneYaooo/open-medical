import { randomUUID } from "node:crypto";
import { AppError, check, identifier, string } from "../errors.mjs";
import { evaluateMedicationSafety } from "./med-safety.mjs";

// Deterministic, data-driven risk rules evaluated against the structured
// clinical fields of a patient record. Alerts are advisory only: they never
// block actions, and each one carries the triggering evidence. The built-in
// medication-interaction set is intentionally small and clearly labelled
// non-exhaustive; the lab thresholds are common, conservative trigger points.
export const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

const LAB_RULES = [
  {
    key: "lab_potassium_low",
    severity: "critical",
    items: ["血钾", "钾", "血清钾", "k", "k+"],
    units: ["mmol/l"],
    op: "lt",
    threshold: 2.8,
    title: "严重低钾血症",
    message: "血钾 {value}{unit} 低于 2.8 mmol/L，请结合心电图与临床评估。",
  },
  {
    key: "lab_potassium_high",
    severity: "critical",
    items: ["血钾", "钾", "血清钾", "k", "k+"],
    units: ["mmol/l"],
    op: "gt",
    threshold: 6,
    title: "严重高钾血症",
    message: "血钾 {value}{unit} 高于 6.0 mmol/L，请紧急评估。",
  },
  {
    key: "lab_glucose_low",
    severity: "critical",
    items: ["血糖", "葡萄糖", "空腹血糖"],
    units: ["mmol/l"],
    op: "lt",
    threshold: 3,
    title: "低血糖",
    message: "血糖 {value}{unit} 低于 3.0 mmol/L，请核实有无低血糖症状。",
  },
  {
    key: "lab_inr_high",
    severity: "critical",
    items: ["inr", "国际标准化比值", "凝血酶原国际标准化比值"],
    units: ["", "1", "比值"],
    op: "gt",
    threshold: 4,
    title: "INR 超上限",
    message: "INR {value} 高于 4.0，出血风险升高。",
  },
  {
    key: "lab_hba1c_high",
    severity: "info",
    items: ["糖化血红蛋白", "hba1c"],
    units: ["%"],
    op: "gt",
    threshold: 9,
    title: "糖化血红蛋白明显偏高",
    message: "糖化血红蛋白 {value}{unit} 高于 9%，提示近期血糖控制不佳。",
  },
  {
    key: "lab_creatinine_rise",
    severity: "warning",
    trend: "creatinine",
    title: "肌酐较前次明显升高",
    message:
      "肌酐 {value}{unit}（前值 {previous}{unit}，{date}），升幅超过 50%，请核对采样时间、单位及临床背景。",
  },
];

const FOLLOWUP_OVERDUE_DAYS = 7 * 86400000;

const normalizeUnit = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/\s/g, "")
    .replaceAll("μ", "u")
    .replaceAll("µ", "u");
const normalizeItem = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const formatValue = (value) =>
  Number.isFinite(value) ? String(Number(value.toFixed(3))) : String(value);

export class RiskEngine {
  constructor(store, followups = null) {
    this.store = store;
    this.followups = followups;
    // Per-patient lab monitors set by the doctor on top of the built-in
    // LAB_RULES; same advisory semantics, thresholds chosen per patient.
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS lab_monitors (id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, data TEXT NOT NULL)",
    );
  }
  patientRow(patientId) {
    const row = this.store.db
      .prepare("SELECT data FROM patients WHERE id=?")
      .get(patientId);
    return row ? JSON.parse(row.data) : null;
  }
  // Evaluate every rule against one patient; returns created/updated alerts.
  // Existing active alerts with the same key are refreshed with new evidence;
  // acknowledged/resolved ones reopen only for changed triggering evidence.
  evaluatePatient(patientId) {
    const patient = this.patientRow(patientId);
    if (!patient || patient.archived) return [];
    const now = Date.now();
    const fired = [];
    for (const alert of this.laboratoryAlerts(patient)) fired.push(alert);
    for (const alert of this.monitorAlerts(patient, now)) fired.push(alert);
    for (const alert of this.medicationAlerts(patient)) fired.push(alert);
    for (const alert of this.followupAlerts(patient, now)) fired.push(alert);
    for (const alert of fired) this.upsert(patient, alert, now);
    // Rules that no longer trigger are auto-resolved so fixed data never
    // leaves stale active alerts behind.
    const firedKeys = new Set(fired.map((alert) => alert.ruleKey));
    for (const row of this.store.db
      .prepare(
        "SELECT id,rule_key FROM risk_alerts WHERE patient_id=? AND status IN ('active','acknowledged')",
      )
      .all(patient.id))
      if (!firedKeys.has(row.rule_key)) {
        this.store.db
          .prepare(
            "UPDATE risk_alerts SET status='resolved',data=json_set(data,'$.autoResolved',json_quote(?)),updated_at=? WHERE id=?",
          )
          .run(new Date(now).toISOString(), now, row.id);
      }
    return fired;
  }
  evaluateAll() {
    const patients = this.store.db
      .prepare("SELECT id FROM patients")
      .all()
      .map((row) => row.id);
    let count = 0;
    for (const id of patients) count += this.evaluatePatient(id).length;
    return { patients: patients.length, triggered: count };
  }
  laboratoryAlerts(patient) {
    const alerts = [];
    const labs = (patient.labs || []).filter(
      (lab) =>
        Number.isFinite(lab.value) && Number.isFinite(Date.parse(lab.date)),
    );
    for (const rule of LAB_RULES) {
      if (rule.trend === "creatinine") {
        const series = labs
          .filter((lab) =>
            ["肌酐", "cr", "血肌酐", "血清肌酐"].includes(
              normalizeItem(lab.item),
            ),
          )
          .sort((a, b) => String(a.date).localeCompare(String(b.date)));
        const previous = series.at(-2);
        const latest = series.at(-1);
        if (
          !previous ||
          !latest ||
          previous.value <= 0 ||
          previous.date === latest.date ||
          !["umol/l", "mg/dl"].includes(normalizeUnit(latest.unit)) ||
          normalizeUnit(previous.unit) !== normalizeUnit(latest.unit)
        )
          continue;
        if (latest.value > previous.value * 1.5)
          alerts.push({
            ruleKey: rule.key,
            severity: rule.severity,
            title: rule.title,
            message: rule.message
              .replace("{value}", formatValue(latest.value))
              .replaceAll("{unit}", latest.unit || "")
              .replace("{previous}", formatValue(previous.value))
              .replace("{date}", previous.date),
            evidence: [latest, previous],
          });
        continue;
      }
      const needles = rule.items.map((needle) => needle.toLowerCase());
      const matches = labs.filter((lab) =>
        needles.includes(normalizeItem(lab.item)),
      );
      if (!matches.length) continue;
      // Evaluate the most recent matching value only, to avoid stale alerts.
      const latest = matches
        .slice()
        .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
      if (!rule.units.includes(normalizeUnit(latest.unit))) continue;
      const triggered =
        rule.op === "lt"
          ? latest.value < rule.threshold
          : latest.value > rule.threshold;
      if (!triggered) continue;
      alerts.push({
        ruleKey: rule.key,
        severity: rule.severity,
        title: rule.title,
        message: rule.message
          .replace("{value}", formatValue(latest.value))
          .replace("{unit}", latest.unit || ""),
        evidence: [latest],
      });
    }
    return alerts;
  }
  // Doctor-set per-patient monitors. Item matching is a bidirectional
  // substring match on the normalized analyte name (「钾」 matches 「血钾」);
  // the alert message always carries the actual matched record so the doctor
  // can see exactly what fired.
  monitorAlerts(patient, now) {
    const monitors = this.listMonitors(patient.id).filter(
      (monitor) => monitor.status === "active",
    );
    if (!monitors.length) return [];
    const alerts = [];
    const labs = (patient.labs || []).filter(
      (lab) =>
        Number.isFinite(lab.value) && Number.isFinite(Date.parse(lab.date)),
    );
    for (const monitor of monitors) {
      const needle = normalizeItem(monitor.item);
      if (!needle) continue;
      const matches = labs.filter((lab) => {
        const item = normalizeItem(lab.item);
        return item.includes(needle) || needle.includes(item);
      });
      if (!matches.length) continue;
      const latest = matches
        .slice()
        .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
      const valueOut =
        monitor.op === "lt"
          ? latest.value < monitor.threshold
          : latest.value > monitor.threshold;
      const recheckDue =
        Number.isInteger(monitor.recheckDays) &&
        now - Date.parse(latest.date) > monitor.recheckDays * 86400000;
      if (!valueOut && !recheckDue) continue;
      // Monitor revision rides in the evidence so editing a monitor re-opens
      // acknowledged alerts instead of leaving stale dispositions behind.
      const evidence = [
        latest,
        { condition: valueOut ? "value" : "recheck", monitorRevision: monitor.revision },
      ];
      alerts.push(
        valueOut
          ? {
              ruleKey: `lab_monitor_${monitor.id}`,
              severity: monitor.severity,
              title: `监测：${latest.item}越界`,
              message: `「${latest.item}」最新值 ${formatValue(latest.value)}${latest.unit || ""}（${latest.date}）${monitor.op === "lt" ? "低于" : "高于"}监测阈值 ${formatValue(monitor.threshold)}${monitor.unitHint || latest.unit || ""}。`,
              evidence,
            }
          : {
              ruleKey: `lab_monitor_${monitor.id}`,
              severity: "warning",
              title: `监测：${latest.item}复查到期`,
              message: `「${latest.item}」最近一次记录为 ${latest.date}，已超过 ${monitor.recheckDays} 天未复查。`,
              evidence,
            },
      );
    }
    return alerts;
  }
  listMonitors(patientId) {
    identifier(patientId);
    return this.store.db
      .prepare("SELECT data FROM lab_monitors WHERE patient_id=? ORDER BY rowid")
      .all(patientId)
      .map((row) => JSON.parse(row.data));
  }
  createMonitor(patientId, input = {}) {
    identifier(patientId);
    const patient = this.patientRow(patientId);
    check(patient, "NOT_FOUND", "患者不存在", 404);
    check(!patient.archived, "PATIENT_ARCHIVED", "已归档患者不能新建监测", 409);
    const row = {
      id: randomUUID(),
      patientId,
      item: string(input.item, "监测项目", 60),
      op: input.op === "lt" ? "lt" : "gt",
      threshold: input.threshold,
      recheckDays: null,
      severity: "warning",
      note: input.note ? string(input.note, "备注", 200) : "",
      unitHint: input.unit ? string(input.unit, "单位", 30) : "",
      status: "active",
      createdAt: Date.now(),
      revision: 0,
    };
    check(
      input.op === "gt" || input.op === "lt",
      "INVALID_INPUT",
      "监测方向须为高于（gt）或低于（lt）",
    );
    check(
      Number.isFinite(row.threshold),
      "INVALID_INPUT",
      "监测阈值须为数值",
    );
    if (input.recheckDays !== undefined && input.recheckDays !== null && input.recheckDays !== "") {
      check(
        Number.isInteger(input.recheckDays) &&
          input.recheckDays >= 1 &&
          input.recheckDays <= 3650,
        "INVALID_INPUT",
        "复查间隔须为 1–3650 天",
      );
      row.recheckDays = input.recheckDays;
    }
    if (input.severity !== undefined) {
      check(
        ["warning", "critical"].includes(input.severity),
        "INVALID_INPUT",
        "严重度仅支持提醒或重要",
      );
      row.severity = input.severity;
    }
    this.store.db
      .prepare("INSERT INTO lab_monitors VALUES (?,?,?)")
      .run(row.id, patientId, JSON.stringify(row));
    this.store.audit(patient.sessionId, "lab_monitor.created", {
      monitorId: row.id,
      item: row.item,
      op: row.op,
      threshold: row.threshold,
    });
    return row;
  }
  updateMonitor(patientId, monitorId, input = {}) {
    identifier(monitorId);
    const row = this.store.db
      .prepare("SELECT data FROM lab_monitors WHERE id=? AND patient_id=?")
      .get(monitorId, patientId);
    check(row, "NOT_FOUND", "监测不存在", 404);
    const monitor = JSON.parse(row.data);
    check(
      monitor.revision === input.revision,
      "REVISION_CONFLICT",
      "监测已变化，请刷新",
      409,
    );
    if (input.item !== undefined) monitor.item = string(input.item, "监测项目", 60);
    if (input.op !== undefined) {
      check(
        input.op === "gt" || input.op === "lt",
        "INVALID_INPUT",
        "监测方向须为高于（gt）或低于（lt）",
      );
      monitor.op = input.op;
    }
    if (input.threshold !== undefined) {
      check(
        Number.isFinite(input.threshold),
        "INVALID_INPUT",
        "监测阈值须为数值",
      );
      monitor.threshold = input.threshold;
    }
    if (input.recheckDays !== undefined) {
      if (input.recheckDays === null || input.recheckDays === "") {
        monitor.recheckDays = null;
      } else {
        check(
          Number.isInteger(input.recheckDays) &&
            input.recheckDays >= 1 &&
            input.recheckDays <= 3650,
          "INVALID_INPUT",
          "复查间隔须为 1–3650 天",
        );
        monitor.recheckDays = input.recheckDays;
      }
    }
    if (input.severity !== undefined) {
      check(
        ["warning", "critical"].includes(input.severity),
        "INVALID_INPUT",
        "严重度仅支持提醒或重要",
      );
      monitor.severity = input.severity;
    }
    if (input.note !== undefined) monitor.note = string(input.note, "备注", 200);
    if (input.status !== undefined) {
      check(
        ["active", "paused"].includes(input.status),
        "INVALID_INPUT",
        "监测状态仅支持开启或暂停",
      );
      monitor.status = input.status;
    }
    monitor.revision++;
    this.store.db
      .prepare("UPDATE lab_monitors SET data=? WHERE id=?")
      .run(JSON.stringify(monitor), monitorId);
    this.store.audit(null, "lab_monitor.updated", {
      monitorId,
      revision: monitor.revision,
      status: monitor.status,
    });
    return monitor;
  }
  removeMonitor(patientId, monitorId, revision) {
    identifier(monitorId);
    const row = this.store.db
      .prepare("SELECT data FROM lab_monitors WHERE id=? AND patient_id=?")
      .get(monitorId, patientId);
    check(row, "NOT_FOUND", "监测不存在", 404);
    const monitor = JSON.parse(row.data);
    check(
      monitor.revision === revision,
      "REVISION_CONFLICT",
      "监测已变化，请刷新",
      409,
    );
    this.store.db.prepare("DELETE FROM lab_monitors WHERE id=?").run(monitorId);
    this.store.audit(null, "lab_monitor.deleted", { monitorId });
    return { ok: true };
  }
  medicationAlerts(patient) {
    const alerts = [];
    const result = evaluateMedicationSafety({
      medications: (patient.medications || []).filter((medication) => medication.status !== "stopped"),
      allergies: patient.allergies || [],
    });
    for (const match of result.allergyMatches)
      alerts.push({
        ruleKey: `med_allergy_${match.allergy}`,
        severity: "critical",
        title: "用药与过敏史匹配",
        message: match.message,
        evidence: [{ medication: match.medication, allergy: match.allergy }],
      });
    for (const interaction of result.interactions)
      alerts.push({
        ruleKey: interaction.ruleKey,
        severity: interaction.severity,
        title: interaction.title,
        message: interaction.message,
        evidence: interaction.medications.map((medication) => ({ medication })),
      });
    for (const duplicate of result.duplicates)
      alerts.push({
        ruleKey: `med_duplicate_${duplicate.medication}`,
        severity: "warning",
        title: "重复用药",
        message: duplicate.message,
        evidence: [
          { medication: duplicate.medication, count: duplicate.count },
        ],
      });
    return alerts;
  }
  followupAlerts(patient, now) {
    if (!this.followups) return [];
    const alerts = [];
    for (const job of this.followups.list(patient.id)) {
      if (job.status !== "active") continue;
      if (now - job.nextDue < FOLLOWUP_OVERDUE_DAYS) continue;
      alerts.push({
        ruleKey: `followup_overdue_${job.id}`,
        severity: "warning",
        title: "随访逾期超过一周",
        message: `随访「${job.name}」已逾期 ${Math.floor((now - job.nextDue) / 86400000)} 天。`,
        evidence: [
          { followUpId: job.id, name: job.name, nextDue: job.nextDue },
        ],
      });
    }
    for (const row of this.store.db
      .prepare(
        "SELECT id,due_at,data FROM reminders WHERE patient_id=? AND status='pending' AND due_at<=?",
      )
      .all(patient.id, now - FOLLOWUP_OVERDUE_DAYS)) {
      const reminder = JSON.parse(row.data);
      alerts.push({
        ruleKey: `followup_pending_${row.id}`,
        severity: "warning",
        title: "随访提醒超过一周未处理",
        message: `「${reminder.title}」仍待登记，请核实联系情况。`,
        evidence: [
          { reminderId: row.id, name: reminder.title, nextDue: row.due_at },
        ],
      });
    }
    return alerts;
  }
  upsert(patient, alert, now) {
    const existing = this.store.db
      .prepare(
        "SELECT id,status,data FROM risk_alerts WHERE patient_id=? AND rule_key=?",
      )
      .get(patient.id, alert.ruleKey);
    const payload = JSON.stringify({
      patientId: patient.id,
      patientName: patient.name,
      sessionId: patient.sessionId,
      ...alert,
    });
    if (!existing) {
      this.store.db
        .prepare(
          "INSERT INTO risk_alerts(id,patient_id,rule_key,severity,status,data,updated_at) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          patient.id,
          alert.ruleKey,
          alert.severity,
          "active",
          payload,
          now,
        );
      return "created";
    }
    if (existing.status === "active") {
      this.store.db
        .prepare("UPDATE risk_alerts SET data=?,updated_at=? WHERE id=?")
        .run(payload, now, existing.id);
      return "refreshed";
    }
    const previous = JSON.parse(existing.data);
    // Profile edits and rescans must not undo a doctor's disposition. A new
    // measurement or a recurrence after auto-resolution requires fresh review.
    if (
      !previous.autoResolved &&
      JSON.stringify(previous.evidence) === JSON.stringify(alert.evidence)
    )
      return "unchanged";
    // Changed evidence or recurrence: request a new review.
    this.store.db
      .prepare(
        "UPDATE risk_alerts SET status='active',data=?,updated_at=? WHERE id=?",
      )
      .run(payload, now, existing.id);
    return "reopened";
  }
  // 默认返回全部状态：已确认/已处理的风险需要闭环可见（交互规范 R10）。
  list({ patientId, status } = {}) {
    if (status !== undefined) checkStatus(status);
    const where = ["1=1"];
    const args = [];
    if (status) {
      where.push("risk_alerts.status=?");
      args.push(status);
    }
    if (patientId) {
      where.push("patient_id=?");
      args.push(patientId);
    }
    return this.store.db
      .prepare(
        `SELECT id,patient_id,rule_key,severity,status,data,updated_at FROM risk_alerts
         WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT 200`,
      )
      .all(...args)
      .map((row) => ({
        id: row.id,
        patientId: row.patient_id,
        ruleKey: row.rule_key,
        severity: row.severity,
        status: row.status,
        updatedAt: row.updated_at,
        ...JSON.parse(row.data),
      }))
      .sort(
        (a, b) =>
          (SEVERITY_ORDER[a.severity] ?? 9) -
            (SEVERITY_ORDER[b.severity] ?? 9) || b.updatedAt - a.updatedAt,
      );
  }
  setStatus(id, status) {
    checkStatus(status);
    const row = this.store.db
      .prepare("SELECT id,data FROM risk_alerts WHERE id=?")
      .get(id);
    if (!row) throw new AppError("NOT_FOUND", "风险提醒不存在", 404);
    this.store.db
      .prepare("UPDATE risk_alerts SET status=?,updated_at=? WHERE id=?")
      .run(status, Date.now(), id);
    const alert = JSON.parse(row.data);
    this.store.audit(alert.sessionId, "risk.disposition", {
      alertId: id,
      status,
    });
    return { ok: true };
  }
  counts() {
    const one = (sql, ...args) =>
      this.store.db.prepare(sql).get(...args)?.n || 0;
    return {
      active: one("SELECT COUNT(*) n FROM risk_alerts WHERE status='active'"),
      critical: one(
        "SELECT COUNT(*) n FROM risk_alerts WHERE status='active' AND severity='critical'",
      ),
    };
  }
}

function checkStatus(status) {
  if (!["active", "acknowledged", "resolved"].includes(status))
    throw new AppError("INVALID_INPUT", "风险提醒状态无效", 400);
}
