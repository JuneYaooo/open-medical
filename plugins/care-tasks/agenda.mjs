// Care-task source moved from the transitional legacy-agenda plugin. Lab
// results awaiting review belong to the fixed patient chart and stay in the
// shell agenda; this source only reports the doctor's tracking records.
const moment = (now) => (typeof now === "number" ? now : Date.parse(now) || Date.now());
const DAY = 86400000;
const time = (value) => (typeof value === "number" ? value : Date.parse(value) || 0);
// Same overdue wording and weight as follow-up reminders.
const overdueDays = (at, now) => Math.floor((now - time(at)) / DAY);

export const careTasksAgendaSources = Object.freeze([
  {
    kind: "tracking",
    label: "检查检验",
    order: 40,
    read(ctx, { now } = {}) {
      const current = moment(now);
      const items = [];
      for (const row of ctx.db
        .prepare(
          "SELECT id,patient_id,status,due_at,data FROM care_tasks WHERE status IN ('awaiting_review','awaiting_communication') OR (status='waiting_result' AND due_at<=?)",
        )
        .all(current)) {
        const task = JSON.parse(row.data);
        const label = {
          waiting_result: "结果尚未收到，跟进时间已到",
          awaiting_review: "结果已收到，等待医生核对",
          awaiting_communication: "医生已核对，需告知患者",
        }[row.status];
        const late = row.status === "waiting_result" ? overdueDays(row.due_at, current) : 0;
        items.push({
          id: `tracking:${row.id}`,
          kind: "tracking",
          patientId: row.patient_id,
          title: task.title,
          detail: late >= 1 ? `已逾期 ${late} 天，${label}` : label,
          at: row.due_at,
          weight: late >= 1 ? 1 : row.status === "awaiting_review" ? 3 : 5,
          action: { type: "patient", tab: "tracking", label: "继续跟进" },
        });
      }
      return items;
    },
  },
]);
