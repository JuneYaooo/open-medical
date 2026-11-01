// Trial enrollment agenda source moved from the transitional legacy-agenda
// plugin. The host still owns merging, sorting, pagination and counts.
const TRIAL_STEP = {
  shortlisted: "联系患者，说明研究",
  contacted: "登记知情同意",
  consented: "确认入组",
};
const hasTable = (db, name) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

export const trialAgendaSources = Object.freeze([
  {
    kind: "trial",
    label: "试验入组",
    order: 60,
    read(ctx) {
      const db = ctx.db;
      const items = [];
      if (hasTable(db, "trial_enrollments")) {
        const titles = new Map(
          db
            .prepare("SELECT id,data FROM trial_protocols")
            .all()
            .map((row) => [row.id, JSON.parse(row.data).title]),
        );
        for (const row of db
          .prepare("SELECT trial_id,patient_id,data FROM trial_enrollments")
          .all()) {
          const enrollment = JSON.parse(row.data);
          if (!TRIAL_STEP[enrollment.stage] || !titles.has(row.trial_id))
            continue;
          items.push({
            id: `trial:${row.trial_id}:${row.patient_id}`,
            kind: "trial",
            patientId: row.patient_id,
            title: TRIAL_STEP[enrollment.stage],
            detail: `临床试验「${titles.get(row.trial_id).slice(0, 40)}」`,
            at: enrollment.updatedAt,
            weight: 6,
            action: {
              type: "view",
              view: "research",
              trialId: row.trial_id,
              label: "打开试验",
            },
          });
        }
      }
      // Background screening that stopped (failure or restart) needs the
      // doctor to restart it; show it in the work lane, newest batch per trial.
      if (hasTable(db, "trial_batches") && hasTable(db, "trial_protocols")) {
        const latest = new Map();
        for (const row of db.prepare("SELECT trial_id,data FROM trial_batches").all()) {
          const batch = JSON.parse(row.data);
          const previous = latest.get(row.trial_id);
          if (!previous || String(batch.createdAt) > String(previous.createdAt)) latest.set(row.trial_id, batch);
        }
        const titles = new Map(db.prepare("SELECT id,data FROM trial_protocols").all().map((row) => [row.id, JSON.parse(row.data).title]));
        for (const [trialId, batch] of latest) {
          if (!["failed", "interrupted"].includes(batch.status) || !titles.has(trialId)) continue;
          items.push({
            id: `trial-batch:${batch.id}`,
            kind: "failure",
            lane: "work",
            title: `「${titles.get(trialId).slice(0, 30)}」批量初筛${batch.status === "interrupted" ? "已中断" : "未完成"}`,
            detail: batch.detail || "再次开始会跳过已完成的患者",
            at: Date.parse(batch.createdAt) || 0,
            fallbackName: "临床试验",
            action: { type: "view", view: "research", trialId, label: "继续初筛" },
          });
        }
      }
      return items;
    },
  },
]);
