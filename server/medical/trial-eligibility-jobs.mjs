import { randomUUID, createHash } from "node:crypto";
import { check } from "../errors.mjs";

// Jobs and their evidence are durable; a model draft never overwrites physician review.
export class TrialEligibilityJobs {
  constructor({ store, patients, trials, bridge, workspaces }) {
    Object.assign(this, { store, patients, trials, bridge, workspaces });
    this.active = new Map();
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS trial_ai_jobs(id TEXT PRIMARY KEY,data TEXT NOT NULL)",
    );
    for (const job of this.list())
      if (job.status === "running")
        this.write({
          ...job,
          status: "interrupted",
          error: "应用已重启，本次处理未完成；已保存进度，可重新初筛。",
        });
  }
  list(trialId, patientId) {
    return this.store.db
      .prepare("SELECT data FROM trial_ai_jobs ORDER BY rowid DESC")
      .all()
      .map((r) => JSON.parse(r.data))
      .filter(
        (j) =>
          (!trialId || j.trialId === trialId) &&
          (!patientId || j.patientId === patientId),
      );
  }
  get(id) {
    const row = this.store.db
      .prepare("SELECT data FROM trial_ai_jobs WHERE id=?")
      .get(id);
    check(row, "NOT_FOUND", "初筛任务不存在", 404);
    return JSON.parse(row.data);
  }
  write(job) {
    this.store.db
      .prepare(
        "INSERT INTO trial_ai_jobs(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(job.id, JSON.stringify(job));
    return job;
  }
  materialVersion(patient) {
    return createHash("sha256")
      .update(
        JSON.stringify(
          (this.bridge.get(patient.sessionId).files || [])
            .map((f) => [f.id, f.hash || f.text])
            .sort((a, b) => a[0].localeCompare(b[0])),
        ),
      )
      .digest("hex");
  }
  public(job) {
    const p = this.patients.get(job.patientId);
    const conflicts = job.checks.filter(
      (c) =>
        c.value ===
        (job.protocol.criteria.find((t) => t.id === c.id).kind === "include"
          ? "no"
          : "yes"),
    ).length;
    return {
      ...job,
      protocol: undefined,
      total: job.protocol.criteria.length,
      conflicts,
      missing: job.checks.filter((c) => c.value === "unknown").length,
      stale:
        p.revision !== job.patientRevision ||
        this.materialVersion(p) !== job.materialVersion,
    };
  }
  save(id, checks) {
    const job = this.get(id);
    check(
      job.status === "running",
      "TRIAL_STOPPED",
      "初筛已停止，不能继续写入",
      409,
    );
    const patient = this.patients.get(job.patientId);
    check(
      !patient.archived &&
        patient.revision === job.patientRevision &&
        this.materialVersion(patient) === job.materialVersion,
      "TRIAL_PATIENT_CHANGED",
      "患者档案已变化，请重新初筛。",
      409,
    );
    job.checks = [
      ...job.checks.filter((c) => !checks.some((n) => n.id === c.id)),
      ...checks,
    ];
    job.updatedAt = new Date().toISOString();
    return this.write(job);
  }
  start(trialId, patientId, input) {
    check(
      input?.externalConsent === true,
      "CONSENT_REQUIRED",
      "请确认使用当前配置模型分析所选患者资料",
      412,
    );
    const protocol = this.trials.get(trialId),
      patient = this.patients.get(patientId);
    check(!patient.archived, "PATIENT_ARCHIVED", "已归档患者不能初筛", 409);
    const existing = this.list(trialId, patientId).find(
      (j) => j.status === "running",
    );
    if (existing) return this.public(existing);
    const source = this.bridge.get(patient.sessionId);
    const session = this.bridge.createSession({
      title: `纳排初筛 · ${protocol.title.slice(0, 50)}`,
      patientId,
    });
    const chart = { ...patient };
    for (const key of [
      "phone",
      "name",
      "id",
      "sessionId",
      "counts",
      "createdAt",
      "updatedAt",
    ])
      delete chart[key];
    const text = JSON.stringify(chart, null, 2),
      chartFile = {
        id: randomUUID(),
        name: "患者档案快照.json",
        text,
        hash: createHash("sha256").update(text).digest("hex"),
      };
    const materials = [
      chartFile,
      ...(source.files || [])
        .filter((f) => f.text?.trim())
        .map((f) => ({
          id: f.id,
          name: f.name,
          text: f.text,
          hash: f.hash || createHash("sha256").update(f.text).digest("hex"),
        })),
    ];
    this.workspaces.store.update(session.id, (w) => {
      w.materials = materials;
    });
    const job = {
      id: randomUUID(),
      trialId,
      patientId,
      patientRevision: patient.revision,
      materialVersion: this.materialVersion(patient),
      protocol,
      sessionId: session.id,
      screeningDate: new Date().toISOString().slice(0, 10),
      status: "running",
      checks: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.write(job);
    let handle;
    try {
      handle = this.workspaces.prepare(session.id, {
        revision: this.workspaces.get(session.id).revision,
        message:
          "请按 trial-eligibility 技能完成所选患者的临床试验纳排初筛。逐批核对全部条件，保存出处和待补资料。",
        externalConsent: true,
        completion: { kind: "answer" },
        isolatedContext: true,
        collectArtifacts: true,
        skipArtifact: (o) => o.type !== "trial_eligibility",
        policy: {
          workflow: "trial-eligibility",
          intent: "consultation",
          trialJobId: job.id,
        },
        sources: materials,
        fileIds: materials.map((f) => f.id),
        sourceHashes: materials.map((f) => f.hash),
        limits: {
          maxRounds: 48,
          maxTotalToolCalls: 100,
          timeoutMs: 480000,
          maxContextChars: 100000,
        },
      });
    } catch (e) {
      this.write({ ...job, status: "failed", error: e.message });
      throw e;
    }
    job.runId = handle.run.id;
    this.write(job);
    const task = this.workspaces
      .execute(handle)
      .then((result) => {
        const current = this.get(job.id);
        if (current.status !== "running") return;
        const complete =
          result.status === "completed" &&
          current.checks.length === protocol.criteria.length;
        this.write({
          ...current,
          status: complete ? "completed" : "failed",
          error: complete
            ? ""
            : result.error || "本次初筛未完成，已保存的判断可查看；请重试。",
          updatedAt: new Date().toISOString(),
        });
      })
      .catch((e) => {
        const current = this.get(job.id);
        if (current.status === "running")
          this.write({ ...current, status: "failed", error: e.message });
      })
      .finally(() => this.active.delete(job.id));
    this.active.set(job.id, task);
    return this.public(job);
  }
  cancel(id) {
    const job = this.get(id);
    if (job.status === "running") {
      this.write({
        ...job,
        status: "cancelled",
        error: "已停止，已保存的逐项判断仍可查看。",
      });
      this.workspaces.cancel(job.sessionId);
    }
    return this.public(this.get(id));
  }
  async stop() {
    for (const id of this.active.keys()) this.cancel(id);
    await Promise.allSettled([...this.active.values()]);
  }
}
