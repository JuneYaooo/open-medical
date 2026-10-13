import { check } from "../errors.mjs";
import { deidentifyExample } from "./deidentify-example.mjs";
import { localModel } from "./personal-context.mjs";
import {
  reviewDiff,
  reviewCounts,
  normalizedEditDistance,
} from "../../shared/review-diff.mjs";

// Opt-in replay of source materials. Confirmed charts are evaluator targets only;
// no chart or learning signal is written by these temporary intake sessions.
export class PersonalRegression {
  constructor({ store, bridge, jobs, pending, provider }) {
    Object.assign(this, { store, bridge, jobs, pending, provider });
    this.active = null;
    for (const row of store.db
      .prepare(
        "SELECT id,data FROM learning_events WHERE type='personal-regression'",
      )
      .all()) {
      const data = JSON.parse(row.data);
      if (data.status === "running")
        this.save(row.id, {
          ...data,
          status: "interrupted",
          message: "评测已中断，可重新发起。",
        });
    }
  }
  save(id, data) {
    this.store.db
      .prepare("UPDATE learning_events SET data=? WHERE id=?")
      .run(JSON.stringify(data), id);
    return { id, ...data };
  }
  get() {
    const row = this.store.db
      .prepare(
        "SELECT id,data FROM learning_events WHERE type='personal-regression' ORDER BY id DESC LIMIT 1",
      )
      .get();
    return {
      local: localModel(this.provider()),
      run: row ? { id: row.id, ...JSON.parse(row.data) } : null,
    };
  }
  start({ consent = false } = {}) {
    check(!this.active, "RUN_ACTIVE", "历史档案评测正在运行", 409);
    check(
      localModel(this.provider()) || consent === true,
      "CONSENT_REQUIRED",
      "去标识化资料会发送给当前云端模型，请确认同意",
    );
    const candidates = this.store.db
      .prepare(
        "SELECT patient_id,final_snapshot FROM review_sessions WHERE kind='intake' AND superseded=0 ORDER BY created_at DESC",
      )
      .all();
    const seen = new Set(),
      sources = [];
    for (const row of candidates) {
      if (seen.has(row.patient_id)) continue;
      seen.add(row.patient_id);
      const patientRow = this.store.db
        .prepare("SELECT data FROM patients WHERE id=?")
        .get(row.patient_id);
      if (!patientRow) continue;
      const patient = JSON.parse(patientRow.data);
      const materials = this.bridge
        .get(patient.sessionId)
        .files.filter((f) => f.text?.trim())
        .map((f) => ({ text: f.text }));
      if (!materials.length) continue;
      const safe = deidentifyExample(
        { materials, final: JSON.parse(row.final_snapshot) },
        [patient],
        { relativeDates: "shifted" },
      );
      sources.push(safe);
      if (sources.length === 10) break;
    }
    check(
      sources.length,
      "NO_REVIEW_HISTORY",
      "至少需要一份已确认且保留资料的建档记录",
    );
    const data = {
      status: "running",
      total: sources.length,
      completed: 0,
      model: this.provider().model,
      startedAt: new Date().toISOString(),
      results: [],
    };
    const id = Number(
      this.store.db
        .prepare(
          "INSERT INTO learning_events(type,subject,data,created_at) VALUES (?,?,?,?)",
        )
        .run("personal-regression", "", JSON.stringify(data), data.startedAt)
        .lastInsertRowid,
    );
    const handle = { cancelled: false, sessionId: null, promise: null };
    this.active = handle;
    handle.promise = this.run(id, data, sources, handle).finally(() => {
      this.active = null;
    });
    return { id, ...data };
  }
  async run(id, data, sources, handle) {
    try {
      for (const [index, source] of sources.entries()) {
        if (handle.cancelled) break;
        const session = this.bridge.createSession({
          title: `历史档案评测 ${index + 1}`,
        });
        handle.sessionId = session.id;
        try {
          this.bridge.service.store.update(session.id, (w) => {
            w.learningRegression = true;
          });
          for (const [i, file] of source.materials.entries())
            this.bridge.addMaterial(session.id, {
              name: `去标识化资料-${i + 1}.txt`,
              text: file.text,
            });
          this.jobs.start(session.id, { externalConsent: true });
          await this.jobs.active.get(session.id)?.promise;
          if (handle.cancelled) break;
          const job = this.jobs.get(session.id),
            action = this.jobs.drafts(session.id)[0];
          check(
            action && job.status !== "failed",
            "REGRESSION_FAILED",
            job.error || job.progress || "模型未生成可比较的草稿",
          );
          const diffs = reviewDiff(action.payload, source.final),
            counts = reviewCounts(action.payload, diffs);
          data.results.push({
            sample: index + 1,
            aiItems: counts.aiItems,
            edits: counts.total,
            rate: counts.rate,
            summaryDistance: normalizedEditDistance(
              action.payload.clinicalSummary?.text || "",
              source.final.clinicalSummary?.text || "",
            ),
          });
          data.completed++;
          this.save(id, data);
        } finally {
          // Only temporary replay sessions and their proposals are removed.
          this.store.db
            .prepare(
              "DELETE FROM pending_actions WHERE type='patient-create' AND json_extract(payload,'$.sourceSessionId')=?",
            )
            .run(session.id);
          this.bridge.removeSession(session.id);
          handle.sessionId = null;
        }
      }
      this.save(id, {
        ...data,
        status: handle.cancelled ? "cancelled" : "completed",
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.save(id, {
        ...data,
        status: handle.cancelled ? "cancelled" : "failed",
        message: error.message,
      });
    }
  }
  cancel() {
    if (this.active) {
      this.active.cancelled = true;
      if (this.active.sessionId) this.jobs.cancel(this.active.sessionId);
    }
    return { ok: true };
  }
  async stop() {
    this.cancel();
    await this.active?.promise;
  }
}
