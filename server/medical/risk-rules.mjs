import { randomUUID } from "node:crypto";
import { AppError } from "../errors.mjs";

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
    items: ["血钾", "钾", "血清钾"],
    op: "lt",
    threshold: 2.8,
    title: "严重低钾血症",
    message: "血钾 {value}{unit} 低于 2.8 mmol/L，请结合心电图与临床评估。",
  },
  {
    key: "lab_potassium_high",
    severity: "critical",
    items: ["血钾", "钾", "血清钾"],
    op: "gt",
    threshold: 6,
    title: "严重高钾血症",
    message: "血钾 {value}{unit} 高于 6.0 mmol/L，请紧急评估。",
  },
  {
    key: "lab_glucose_low",
    severity: "critical",
    items: ["血糖", "葡萄糖"],
    op: "lt",
    threshold: 3,
    title: "低血糖",
    message: "血糖 {value}{unit} 低于 3.0 mmol/L，请核实有无低血糖症状。",
  },
  {
    key: "lab_inr_high",
    severity: "critical",
    items: ["inr", "国际标准化比值", "凝血酶原国际"],
    op: "gt",
    threshold: 4,
    title: "INR 超上限",
    message: "INR {value} 高于 4.0，出血风险升高。",
  },
  {
    key: "lab_hba1c_high",
    severity: "info",
    items: ["糖化血红蛋白", "hba1c"],
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
    message: "肌酐 {value}{unit}（前值 {previous}{unit}，{date}），升幅超过 50%，警惕急性肾损伤。",
  },
];

// Each pair matches when some medication name contains the first fragment
// and another (different) medication contains the second one.
const INTERACTION_PAIRS = [
  {
    key: "int_aspirin_warfarin",
    a: "阿司匹林",
    b: "华法林",
    severity: "warning",
    title: "抗栓药物联用",
    message: "阿司匹林与华法林联用会增加出血风险，请核对适应证与监测计划。",
  },
  {
    key: "int_digoxin_furosemide",
    a: "地高辛",
    b: "呋塞米",
    severity: "warning",
    title: "洋地黄与排钾利尿剂联用",
    message: "呋塞米可致低钾而增加洋地黄中毒风险，建议监测血钾与地高辛浓度。",
  },
  {
    key: "int_simvastatin_clarithromycin",
    a: "辛伐他汀",
    b: "克拉霉素",
    severity: "warning",
    title: "他汀与大环内酯类联用",
    message: "克拉霉素显著升高他汀血药浓度，横纹肌溶解风险增加。",
  },
];

const FOLLOWUP_OVERDUE_DAYS = 7 * 86400000;

const formatValue = (value) =>
  Number.isFinite(value) ? String(Number(value.toFixed(3))) : String(value);

export class RiskEngine {
  constructor(store, followups = null) {
    this.store = store;
    this.followups = followups;
  }
  patientRow(patientId) {
    const row = this.store.db
      .prepare("SELECT data FROM patients WHERE id=?")
      .get(patientId);
    return row ? JSON.parse(row.data) : null;
  }
  // Evaluate every rule against one patient; returns created/updated alerts.
  // Existing active alerts with the same key are refreshed with new evidence;
  // acknowledged/resolved ones get re-activated only when still triggering.
  evaluatePatient(patientId) {
    const patient = this.patientRow(patientId);
    if (!patient) return [];
    const now = Date.now();
    const fired = [];
    for (const alert of this.laboratoryAlerts(patient)) fired.push(alert);
    for (const alert of this.medicationAlerts(patient)) fired.push(alert);
    for (const alert of this.followupAlerts(patient, now)) fired.push(alert);
    for (const alert of fired) this.upsert(patient, alert, now);
    // Rules that no longer trigger are auto-resolved so fixed data never
    // leaves stale active alerts behind.
    const firedKeys = new Set(fired.map((alert) => alert.ruleKey));
    for (const row of this.store.db
      .prepare(
        "SELECT id,rule_key FROM risk_alerts WHERE patient_id=? AND status='active'",
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
    const labs = patient.labs || [];
    for (const rule of LAB_RULES) {
      if (rule.trend === "creatinine") {
        const series = labs
          .filter((lab) =>
            ["肌酐", "cr", "血肌酐"].some((needle) =>
              lab.item.toLowerCase().includes(needle),
            ),
          )
          .sort((a, b) => String(a.date).localeCompare(String(b.date)));
        const previous = series.at(-2);
        const latest = series.at(-1);
        if (!previous || !latest) continue;
        if (latest.value > previous.value * 1.5)
          alerts.push({
            ruleKey: rule.key,
            severity: rule.severity,
            title: rule.title,
            message: rule.message
              .replace("{value}", formatValue(latest.value))
              .replace("{previous}", formatValue(previous.value))
              .replace("{date}", previous.date),
            evidence: [latest, previous],
          });
        continue;
      }
      const needles = rule.items.map((needle) => needle.toLowerCase());
      const matches = labs.filter((lab) =>
        needles.some((needle) => lab.item.toLowerCase().includes(needle)),
      );
      if (!matches.length) continue;
      // Evaluate the most recent matching value only, to avoid stale alerts.
      const latest = matches
        .slice()
        .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
      const triggered =
        rule.op === "lt" ? latest.value < rule.threshold : latest.value > rule.threshold;
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
  medicationAlerts(patient) {
    const alerts = [];
    const meds = (patient.medications || []).map((m) => m.name);
    const allergies = patient.allergies || [];
    for (const allergy of allergies) {
      const needle = allergy.toLowerCase();
      const hit = meds.find((name) => name.toLowerCase().includes(needle));
      if (hit)
        alerts.push({
          ruleKey: `med_allergy_${allergy}`,
          severity: "critical",
          title: "用药与过敏史匹配",
          message: `用药「${hit}」与过敏史「${allergy}」匹配，请立即核对。`,
          evidence: [{ medication: hit, allergy }],
        });
    }
    for (const pair of INTERACTION_PAIRS) {
      const hasA = meds.find((name) => name.toLowerCase().includes(pair.a.toLowerCase()));
      const hasB = meds.find((name) => name.toLowerCase().includes(pair.b.toLowerCase()));
      if (hasA && hasB)
        alerts.push({
          ruleKey: pair.key,
          severity: pair.severity,
          title: pair.title,
          message: pair.message,
          evidence: [{ medication: hasA }, { medication: hasB }],
        });
    }
    // Duplicate therapy: identical base names appearing more than once.
    const seen = new Map();
    for (const name of meds) {
      const key = name.toLowerCase();
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    for (const [name, count] of seen)
      if (count > 1)
        alerts.push({
          ruleKey: `med_duplicate_${name}`,
          severity: "warning",
          title: "重复用药",
          message: `「${name}」出现 ${count} 次，请核对是否重复开具。`,
          evidence: [{ medication: name, count }],
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
        evidence: [{ followUpId: job.id, name: job.name, nextDue: job.nextDue }],
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
        .run(randomUUID(), patient.id, alert.ruleKey, alert.severity, "active", payload, now);
      return "created";
    }
    if (existing.status === "active") {
      this.store.db
        .prepare("UPDATE risk_alerts SET data=?,updated_at=? WHERE id=?")
        .run(payload, now, existing.id);
      return "refreshed";
    }
    // Still triggering: re-activate acknowledged/resolved alerts.
    this.store.db
      .prepare("UPDATE risk_alerts SET status='active',data=?,updated_at=? WHERE id=?")
      .run(payload, now, existing.id);
    return "reopened";
  }
  list({ patientId, status = "active" } = {}) {
    checkStatus(status);
    const where = ["risk_alerts.status=?"];
    const args = [status];
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
          (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) ||
          b.updatedAt - a.updatedAt,
      );
  }
  setStatus(id, status) {
    checkStatus(status);
    const row = this.store.db
      .prepare("SELECT id FROM risk_alerts WHERE id=?")
      .get(id);
    if (!row)
      throw new AppError("NOT_FOUND", "风险提醒不存在", 404);
    this.store.db
      .prepare("UPDATE risk_alerts SET status=?,updated_at=? WHERE id=?")
      .run(status, Date.now(), id);
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
