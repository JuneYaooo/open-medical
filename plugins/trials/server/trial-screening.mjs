import { randomUUID } from "node:crypto";
import { check, string } from "../../../server/errors.mjs";
import { sqliteTransaction } from "../../../server/sqlite-transaction.mjs";
import { normalizeCohortSpec } from "../../../server/medical/cohort-query.mjs";
export class TrialScreening {
  constructor(store, patients) {
    this.store = store;
    this.patients = patients;
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
  // 方案字段校验：界面新建和助手导入提案（trial-protocol）走同一套规则。
  // criteria 可直接给 [{kind,text}]，也可给 inclusion/exclusion 多行文本。
  normalizeProtocol(input) {
    check(
      input && typeof input === "object",
      "INVALID_INPUT",
      "请填写试验方案",
    );
    const lines = Array.isArray(input.criteria)
      ? {
          include: input.criteria.filter((c) => c?.kind === "include").map((c) => c.text),
          exclude: input.criteria.filter((c) => c?.kind === "exclude").map((c) => c.text),
        }
      : null;
    if (lines) {
      check(
        input.criteria.every((c) => c && ["include", "exclude"].includes(c.kind) && typeof c.text === "string"),
        "INVALID_INPUT",
        "每条标准需要 kind（include/exclude）和 text",
      );
    }
    const criteria = [];
    for (const [kind, field] of [
      ["include", "inclusion"],
      ["exclude", "exclusion"],
    ]) {
      const label = kind === "include" ? "入选标准" : "排除标准";
      const values = (lines
        ? (check(lines[kind].length, "INVALID_INPUT", `请填写${label}`), lines[kind].map((t) => string(t, label, 2000)))
        : string(input[field], label, 20000).split("\n"))
        .map((t) => t.trim())
        .filter(Boolean);
      check(values.length <= 100, "INVALID_INPUT", "每类标准最多100条");
      values.forEach((text) => criteria.push({ kind, text }));
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
    return {
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
    };
  }
  create(input) {
    return sqliteTransaction(this.store.db, () => {
      const value = this.normalizeProtocol(input);
      const item = {
        id: randomUUID(),
        ...value,
        criteria: value.criteria.map((c) => ({ id: randomUUID(), ...c })),
        createdAt: new Date().toISOString(),
      };
      this.store.db
        .prepare("INSERT INTO trial_protocols(id,data) VALUES(?,?)")
        .run(item.id, JSON.stringify(item));
      this.store.audit(null, "trial.protocol.created", { trialId: item.id });
      return item;
    });
  }
  // 方案的结构化筛选条件（cohort-query 条件）：助手起草经医生确认，或医生在
  // 界面直接保存/删改。spec 为 null 表示清除。旧方案没有这些字段，读取时
  // 视为未设置。manualCriteria 是无法结构化、需人工或 AI 逐人核对的条目。
  normalizeScreeningSpec(input = {}) {
    check(input && typeof input === "object", "INVALID_INPUT", "请提供筛选条件");
    if (input.spec === null) return { spec: null, manualCriteria: [] };
    const spec = normalizeCohortSpec({ ...input.spec, includeArchived: false });
    const manual = input.manualCriteria ?? [];
    check(Array.isArray(manual) && manual.length <= 40, "INVALID_INPUT", "需人工核对的条目最多 40 条");
    const manualCriteria = [...new Set(manual.map((t) => string(t, "需人工核对的条目", 500).trim()))];
    return { spec, manualCriteria };
  }
  setScreeningSpec(trialId, input = {}, source = "doctor") {
    return sqliteTransaction(this.store.db, () => {
      const trial = this.get(trialId);
      check(["doctor", "model_draft"].includes(source), "INVALID_INPUT", "筛选条件来源无效");
      const current = trial.screeningSpecRevision || 0;
      if (input.expectedRevision !== undefined)
        check(input.expectedRevision === current, "REVISION_CONFLICT", "筛选条件已被修改，请刷新后重试", 409);
      const { spec, manualCriteria } = this.normalizeScreeningSpec(input);
      const item = { ...trial };
      for (const key of ["screeningSpec", "screeningManualCriteria", "screeningSpecSource", "screeningSpecUpdatedAt"]) delete item[key];
      item.screeningSpecRevision = current + 1;
      if (spec)
        Object.assign(item, {
          screeningSpec: spec,
          screeningManualCriteria: manualCriteria,
          screeningSpecSource: source,
          screeningSpecUpdatedAt: new Date().toISOString(),
        });
      this.store.db
        .prepare("UPDATE trial_protocols SET data=? WHERE id=?")
        .run(JSON.stringify(item), trial.id);
      this.store.audit(null, spec ? "trial.screening_spec.saved" : "trial.screening_spec.cleared", {
        trialId: trial.id, source, conditions: spec?.conditions.length || 0, revision: item.screeningSpecRevision,
      });
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
