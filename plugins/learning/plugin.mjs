import { definePlugin } from "../../server/plugin-host/define.mjs";
import { LearningService } from "./server/service.mjs";

const REPLY = (send, status, value) => { send(status, value); return true; };
const serviceOf = (ctx) => ctx.plugins.learning?.service;

const custom = {
  kind: "custom",
  label: "我的规则",
  order: 70,
  read(ctx, { now } = {}) {
    const service = serviceOf(ctx);
    const auto = service?.automation;
    if (!auto) return [];
    const DAY = 86400000;
    const time = (value) => typeof value === "number" ? value : Date.parse(value) || 0;
    const current = typeof now === "number" ? now : Date.parse(now) || Date.now();
    const items = [];
    for (const item of auto.openItems()) {
      const entry = { id: `rule:${item.id}`, itemId: item.id, patientId: item.patientId, title: item.title, detail: `${item.detail ? `${item.detail} · ` : ""}来自规则「${item.rule}」`,
        at: item.createdAt, weight: 5, resolvable: true, fallbackName: "我的规则",
        action: item.sessionId ? { type: "task", sessionId: item.sessionId, label: "打开汇总" } : item.replyId ? { type: "view", view: "care", tab: "drafts", label: "核对发送" } : { type: "patient", tab: "overview", label: "查看患者" } };
      if (item.lane === "work" || !item.patientId) items.push({ ...entry, kind: "review", lane: "work" });
      else items.push({ ...entry, kind: "custom" });
    }
    for (const s of auto.suggestions()) items.push({ id: `evolve:${s.id}`, kind: "evolve", lane: "work", title: s.title, detail: s.evidence, at: s.createdAt, fallbackName: "工作台进化",
      action: { type: "view", view: "settings", settingsTab: "workbench", label: "查看建议" } });
    for (const c of auto.changes().filter((c) => c.status === "applied" && current - time(c.createdAt) < 7 * DAY)) items.push({ id: `evolved:${c.id}`, kind: "evolve", lane: "work", title: `已自动调整：${c.title}`,
      detail: c.detail, at: c.createdAt, fallbackName: "工作台进化", action: { type: "view", view: "settings", settingsTab: "workbench", label: "查看或撤销" } });
    return items;
  },
};

function createLearningApi(ctx) {
  return async function learningApi(req, url, io) {
    const parts = url.pathname.split("/").filter(Boolean);
    const service = serviceOf(ctx);
    if (!service) return false;
    if (parts[0] !== "api") return false;
    const path = url.pathname;
    if (path === "/api/extensions/prefs" && req.method === "GET") return REPLY(io.send, 200, service.automation.workbenchPrefs());
    if (path === "/api/review-stats" && req.method === "GET") return REPLY(io.send, 200, service.stats(url.searchParams.get("range") || "90d"));
    if (path === "/api/review-details" && req.method === "GET") return REPLY(io.send, 200, service.details(url.searchParams.get("section"), url.searchParams.get("field")));
    if (path === "/api/learning/regression") {
      if (req.method === "GET") return REPLY(io.send, 200, service.regression.get());
      if (req.method === "POST") return REPLY(io.send, 202, service.regression.start(await io.body()));
      if (req.method === "DELETE") return REPLY(io.send, 200, service.regression.cancel());
    }
    if (path === "/api/learning/events" && req.method === "POST") return REPLY(io.send, 200, service.events(await io.body()));
    if (parts[1] === "learning" && parts[2] === "similar" && parts.length === 4 && req.method === "GET") return REPLY(io.send, 200, service.similar(parts[3]));
    if (path === "/api/learning/changes" && req.method === "GET") return REPLY(io.send, 200, service.changes());
    if (path === "/api/learning/month" && req.method === "GET") return REPLY(io.send, 200, service.month());
    if (path === "/api/learning/settings") {
      if (req.method === "GET") return REPLY(io.send, 200, service.prefs());
      if (req.method === "PUT") return REPLY(io.send, 200, service.savePrefs(await io.body()));
    }
    if (path === "/api/learning/export" && req.method === "GET") return REPLY(io.send, 200, service.exportStats());
    if (path === "/api/learning/habits" && req.method === "GET") return REPLY(io.send, 200, service.habits());
    if (path === "/api/learning/feedback" && req.method === "POST") return REPLY(io.send, 200, service.feedback(await io.body()));
    if (path === "/api/learning/clear" && req.method === "POST") return REPLY(io.send, 200, service.clear(await io.body()));
    if (parts[1] === "learning" && parts[2] === "habits" && parts.length === 4 && req.method === "GET") return REPLY(io.send, 200, service.habit(parts[3]));
    if (parts[1] === "learning" && parts[2] === "habits" && parts.length === 5 && parts[4] === "decision" && req.method === "POST") return REPLY(io.send, 200, service.decide(parts[3], await io.body()));
    return false;
  };
}

export default definePlugin({
  id: "learning",
  version: "1.0.0",
  title: "学习与规则",
  enabledByDefault: true,
  provides: { service: "learning", apiVersion: 1 },
  migrations: "./migrations",
  tablePrefix: ["review_", "habit_", "learning_", "workbench_", "automation_", "evolution_"],
  legacyApiPaths: [
    { method: "*", path: "/api/learning" },
    { method: "*", path: "/api/learning/*" },
    { method: "GET", path: "/api/review-stats" },
    { method: "GET", path: "/api/extensions/prefs" },
    { method: "GET", path: "/api/review-details" },
  ],
  agendaSources: [custom],
  setup(ctx) {
    const host = ctx.services.learningHost || {};
    return new LearningService({
      store: ctx.services.store,
      doctor: ctx.services.doctor,
      pending: ctx.services.pending,
      bridge: host.bridge,
      jobs: host.jobs,
      provider: host.provider,
      cases: () => ctx.services.cases,
      guidelines: ctx.services.guidelines,
      extensions: ctx.services.extensions,
      workspaces: ctx.services.workspaces,
      patients: ctx.services.patients,
      schedule: ctx.services.schedule,
      care: () => ctx.services.careTasks?.()?.care || null,
      now: host.now || Date.now,
    });
  },
  // Review sessions hold full before/after chart snapshots; they go with the
  // patient. Runs inside the patient-delete transaction.
  hooks: {
    "patient.deleted": (payload, ctx) => {
      const db = ctx.db;
      db.prepare("DELETE FROM review_sessions WHERE patient_id=?").run(payload.patientId);
      db.prepare("DELETE FROM automation_items WHERE patient_id=?").run(payload.patientId);
    },
  },
  lifecycle: {
    start(ctx) { serviceOf(ctx)?.start(); },
    stop(ctx) { return serviceOf(ctx)?.stop(); },
  },
  api: (ctx, req, url, io) => createLearningApi(ctx)(req, url, io),
});
