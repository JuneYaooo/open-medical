import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
const draft = (name) => ({
  name,
  gender: "male",
  clinicalSummary: { text: `${name}于2026-01-01就诊`, source: "合成资料第1行" },
  diagnoses: [{ name: "HTN", status: "suspected", source: "合成资料" }],
  labs: [{ item: "血糖", value: 5, date: "2026-01-01", unit: "mmol/L" }],
});
test("review autosave, revision conflict, atomic confirm and deidentified audit", async (t) => {
  const f = await fixture(t),
    p = f.server.pending.propose({
      type: "patient-create",
      summary: "合成核对",
      payload: draft("私密测试甲"),
    });
  const final = {
    ...p.payload,
    diagnoses: [
      {
        ...p.payload.diagnoses[0],
        name: "高血压",
        status: "confirmed",
        source: "伪造来源",
      },
    ],
  };
  const saved = await f.json(
    `/api/pending-actions/${p.id}/review-draft`,
    "PATCH",
    { payload: final, expectedRevision: 0 },
  );
  assert.equal(saved.status, 200);
  assert.equal(saved.data.payload.diagnoses[0].name, "HTN");
  assert.equal(saved.data.reviewDraft.payload.diagnoses[0].source, "合成资料");
  assert.equal(
    (
      await f.json(`/api/pending-actions/${p.id}/review-draft`, "PATCH", {
        payload: final,
        expectedRevision: 0,
      })
    ).status,
    409,
  );
  assert.equal(
    f.server.pending.row(p.id).reviewDraft.payload.diagnoses[0].name,
    "高血压",
  );
  const result = await f.json(`/api/pending-actions/${p.id}/confirm`, "POST", {
    payload: final,
    reviewMs: 120000,
    expectedRevision: 1,
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.applied.diagnoses[0].name, "高血压");
  const sessions = f.server.store.db
      .prepare("SELECT * FROM review_sessions")
      .all(),
    diffs = f.server.store.db.prepare("SELECT * FROM review_diffs").all();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].modified, 1);
  assert.equal(diffs.length, 2);
  assert.doesNotMatch(JSON.stringify(sessions), /私密测试甲/);
  assert.equal(diffs.find((d) => d.field === "status").learnable, 0);
  assert.equal(
    (
      await f.json(`/api/pending-actions/${p.id}/confirm`, "POST", {
        payload: final,
      })
    ).status,
    409,
  );
});
test("zero edits backwards compatible; invalid payload rolls back; other action cannot smuggle payload", async (t) => {
  const f = await fixture(t),
    p = f.server.pending.propose({
      type: "patient-create",
      summary: "测试",
      payload: draft("合成乙"),
    });
  assert.equal(
    (
      await f.json(`/api/pending-actions/${p.id}/confirm`, "POST", {
        payload: {
          ...p.payload,
          labs: [{ item: "血糖", value: "x", date: "2026-01-01" }],
        },
      })
    ).status,
    400,
  );
  assert.equal(f.server.patients.all().length, 0);
  assert.equal(
    f.server.store.db.prepare("SELECT COUNT(*) n FROM review_sessions").get().n,
    0,
  );
  const result = f.server.pending.confirm(p.id);
  assert.equal(
    f.server.store.db.prepare("SELECT modified FROM review_sessions").get()
      .modified,
    0,
  );
  const update = f.server.pending.propose({
    type: "patient-update",
    patientId: result.applied.id,
    summary: "更新",
    payload: { phone: "123" },
  });
  assert.equal(
    f.server.pending.confirm(update.id, { payload: { name: "不能注入" } })
      .applied.name,
    "合成乙",
  );
});
test("superseded review retains signals but does not contribute to trend; clear removes histories", async (t) => {
  const f = await fixture(t),
    p = f.server.pending.propose({
      type: "patient-create",
      summary: "测试",
      payload: draft("合成丙"),
    });
  f.server.pending.saveReview(p.id, {
    payload: {
      ...p.payload,
      diagnoses: [{ name: "高血压", status: "suspected" }],
    },
  });
  assert.match(f.server.pending.reviewCorrection(p.id, "preserve"), /高血压/);
  assert.equal(f.server.pending.reviewCorrection(p.id, "discard"), "");
  f.server.pending.supersede(p.id, "replacement");
  assert.equal(
    f.server.store.db.prepare("SELECT superseded FROM review_diffs").get()
      .superseded,
    1,
  );
  assert.equal(f.server.pending.reviewLog.stats().count, 0);
  assert.equal((await f.json("/api/learning/clear", "POST", {})).status, 400);
  assert.equal(
    (await f.json("/api/learning/clear", "POST", { confirmed: true })).status,
    200,
  );
  assert.equal(
    f.server.store.db.prepare("SELECT COUNT(*) n FROM review_diffs").get().n,
    0,
  );
});
test("stats show threshold and median at five confirmed charts", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) {
    const p = f.server.pending.propose({
      type: "patient-create",
      summary: "统计",
      payload: draft(`统计${i}`),
    });
    f.server.pending.confirm(p.id, { reviewMs: (i + 1) * 1000 });
  }
  const stats = f.server.pending.reviewLog.stats();
  assert.equal(stats.remaining, 0);
  assert.equal(stats.medianReviewMs, 3000);
  assert.equal(stats.recentAverage, 0);
});

test("pilot exports only numeric aggregates and preserves assignment without revealing patient text", async (t) => {
  const f = await fixture(t);
  const action = f.server.pending.propose({
    type: "patient-create",
    summary: "统计",
    payload: {
      ...draft("禁止导出的姓名"),
      learningContext: { enabled: true, holdout: true },
    },
  });
  f.server.pending.confirm(action.id, { reviewMs: 12000 });
  const result = (await f.json("/api/learning/export")).data;
  assert.equal(result.series[0].group, "holdout");
  assert.equal(result.series[0].fastZero, 1);
  assert.ok(result.habitsSummary);
  assert.ok(Array.isArray(result.events));
  assert.doesNotMatch(
    JSON.stringify(result),
    /禁止导出|HTN|2026-01-01|patient_id|ai_snapshot/,
  );
});
