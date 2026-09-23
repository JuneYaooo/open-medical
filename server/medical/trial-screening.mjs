import { randomUUID } from "node:crypto";
import { check, string } from "../errors.mjs";
import { sqliteTransaction } from "../sqlite-transaction.mjs";
export class TrialScreening {
  constructor(store, patients) {
    this.store = store;
    this.patients = patients;
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS trial_protocols(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS trial_screenings(trial_id TEXT NOT NULL,patient_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(trial_id,patient_id))",
    );
  }
  list() {
    return this.store.db
      .prepare("SELECT data FROM trial_protocols")
      .all()
      .map((r) => JSON.parse(r.data))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  get(id) {
    const r = this.store.db
      .prepare("SELECT data FROM trial_protocols WHERE id=?")
      .get(id);
    check(r, "NOT_FOUND", "试验方案不存在", 404);
    return JSON.parse(r.data);
  }
  create(input) {
    return sqliteTransaction(this.store.db, () => {
      check(
        input && typeof input === "object",
        "INVALID_INPUT",
        "请填写试验方案",
      );
      const criteria = [];
      for (const [kind, field] of [
        ["include", "inclusion"],
        ["exclude", "exclusion"],
      ]) {
        const values = string(
          input[field],
          kind === "include" ? "入选标准" : "排除标准",
          20000,
        )
          .split("\n")
          .map((t) => t.trim())
          .filter(Boolean);
        check(values.length <= 100, "INVALID_INPUT", "每类标准最多100条");
        values.forEach((text) =>
          criteria.push({ id: randomUUID(), kind, text }),
        );
      }
      const sourceUrl = input.sourceUrl
        ? string(input.sourceUrl, "来源链接", 2000)
        : "";
      if (sourceUrl) {
        let valid = false;
        try {
          const url = new URL(sourceUrl);
          valid =
            ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password;
        } catch {}
        check(valid, "INVALID_INPUT", "来源链接需使用 http 或 https");
      }
      const item = {
        id: randomUUID(),
        title: string(input.title, "试验名称", 500),
        registration: input.registration
          ? string(input.registration, "注册号", 100)
          : "",
        version: string(input.version, "方案版本与日期", 200),
        sourceUrl,
        site: input.site ? string(input.site, "研究中心", 300) : "",
        recruitment: input.recruitment
          ? string(input.recruitment, "招募状态", 100)
          : "待研究中心确认",
        protocolText: input.protocolText
          ? string(input.protocolText, "方案原文", 500000)
          : "",
        criteria,
        createdAt: new Date().toISOString(),
      };
      this.store.db
        .prepare("INSERT INTO trial_protocols(id,data) VALUES(?,?)")
        .run(item.id, JSON.stringify(item));
      this.store.audit(null, "trial.protocol.created", { trialId: item.id });
      return item;
    });
  }
  screening(trialId, patientId) {
    this.get(trialId);
    this.patients.get(patientId);
    const row = this.store.db
      .prepare(
        "SELECT data FROM trial_screenings WHERE trial_id=? AND patient_id=?",
      )
      .get(trialId, patientId);
    return row
      ? JSON.parse(row.data)
      : { trialId, patientId, revision: 0, checks: [], note: "", history: [] };
  }
  save(trialId, patientId, input) {
    return sqliteTransaction(this.store.db, () => {
      check(
        input && typeof input === "object",
        "INVALID_INPUT",
        "请填写初筛记录",
      );
      const trial = this.get(trialId),
        patient = this.patients.get(patientId);
      check(
        !patient.archived,
        "PATIENT_ARCHIVED",
        "已归档患者不能新增初筛记录",
        409,
      );
      const previous = this.screening(trialId, patientId);
      check(
        input.expectedRevision === previous.revision,
        "REVISION_CONFLICT",
        "初筛已更新，请重新载入",
        409,
      );
      check(
        Array.isArray(input.checks) &&
          input.checks.length === trial.criteria.length,
        "INVALID_INPUT",
        "请逐项记录标准，资料不足可保留待核对",
      );
      const ids = new Set();
      const checks = input.checks.map((c) => {
        check(
          c && trial.criteria.some((t) => t.id === c.id) && !ids.has(c.id),
          "INVALID_INPUT",
          "标准编号无效或重复",
        );
        ids.add(c.id);
        check(
          ["yes", "no", "unknown"].includes(c.value),
          "INVALID_INPUT",
          "初筛状态无效",
        );
        return {
          id: c.id,
          value: c.value,
          evidence:
            c.value === "unknown"
              ? c.evidence
                ? string(c.evidence, "缺少资料", 3000)
                : ""
              : string(c.evidence, "判断依据及日期", 3000),
        };
      });
      const conflicts = checks.filter(
        (c) =>
          c.value ===
          (trial.criteria.find((t) => t.id === c.id).kind === "include"
            ? "no"
            : "yes"),
      ).length;
      const missing = checks.filter((c) => c.value === "unknown").length;
      const item = {
        trialId,
        patientId,
        patientRevision: patient.revision,
        revision: previous.revision + 1,
        checks,
        note: input.note ? string(input.note, "初筛备注", 3000) : "",
        summary: conflicts
          ? "存在条件冲突，需研究者核实"
          : missing
            ? "资料不足，待补充核对"
            : "逐项核对完成，待研究者确认",
        missing,
        conflicts,
        updatedAt: new Date().toISOString(),
        history: [
          ...(previous.history || []),
          ...(previous.revision
            ? [
                {
                  revision: previous.revision,
                  checks: previous.checks,
                  note: previous.note,
                  updatedAt: previous.updatedAt,
                  patientRevision: previous.patientRevision,
                },
              ]
            : []),
        ],
      };
      this.store.db
        .prepare(
          "INSERT INTO trial_screenings(trial_id,patient_id,data) VALUES(?,?,?) ON CONFLICT(trial_id,patient_id) DO UPDATE SET data=excluded.data",
        )
        .run(trialId, patientId, JSON.stringify(item));
      this.store.audit(null, "trial.screening.saved", {
        trialId,
        patientId,
        revision: item.revision,
      });
      return item;
    });
  }
}
