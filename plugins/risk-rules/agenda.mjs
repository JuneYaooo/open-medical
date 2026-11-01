// Risk alert agenda source moved from the transitional legacy-agenda plugin.
// Medication safety/allergy checks remain in the fixed medical core; this only
// surfaces persisted risk alerts and urgent care alerts.
const hasTable = (db, name) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

export const riskAgendaSources = Object.freeze([
  {
    kind: "risk",
    label: "高危风险",
    order: 10,
    read(ctx) {
      const db = ctx.db;
      const items = [];
      for (const row of db
        .prepare(
          "SELECT id,patient_id,severity,updated_at,data FROM risk_alerts WHERE status='active'",
        )
        .all()) {
        // General tips (info) stay on the patient page; the agenda lists
        // only what needs action today.
        if (row.severity === "info") continue;
        const data = JSON.parse(row.data);
        items.push({
          id: `risk:${row.id}`,
          kind: "risk",
          patientId: row.patient_id,
          title: data.title,
          detail: data.message,
          at: row.updated_at,
          weight: row.severity === "critical" ? 0 : 4,
          severity: row.severity,
          action: { type: "patient", tab: "overview", label: "核对风险" },
        });
      }
      if (
        ctx.services.followupHost?.isActive?.() !== false &&
        hasTable(db, "care_alerts")
      )
        for (const row of db
          .prepare(
            "SELECT id,patient_id,level,reason,created_at FROM care_alerts WHERE status='open'",
          )
          .all()) {
          if (row.level !== "urgent") continue;
          items.push({
            id: `care-alert:${row.id}`,
            kind: "risk",
            patientId: row.patient_id,
            title: "患者消息提示紧急情况",
            detail: row.reason,
            at: row.created_at,
            weight: 0,
            severity: "critical",
            action: { type: "view", view: "care", tab: "alerts", label: "立即查看" },
          });
        }
      return items;
    },
  },
]);
