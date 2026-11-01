import { definePlugin } from "../../server/plugin-host/define.mjs";
import { identifier } from "../../server/errors.mjs";
import { RiskEngine } from "./server/risk-rules.mjs";
import { riskAgendaSources } from "./agenda.mjs";

const REPLY = (send, status, value) => {
  send(status, value);
  return true;
};

const serviceOf = (ctx) => ctx.plugins["risk-rules"]?.service;

function createRiskApi(ctx) {
  return async function riskApi(req, url, io) {
    const parts = url.pathname.split("/").filter(Boolean);
    const service = serviceOf(ctx);
    if (parts[0] !== "api") return false;

    if (parts.length === 2 && parts[1] === "risk-alerts" && req.method === "GET")
      return REPLY(io.send, 200, {
        alerts: service.list({
          patientId: url.searchParams.get("patientId") || undefined,
          status: url.searchParams.get("status") || undefined,
        }),
        counts: service.counts(),
      });
    if (
      parts.length === 3 &&
      parts[1] === "risk-alerts" &&
      parts[2] === "evaluate" &&
      req.method === "POST"
    )
      return REPLY(io.send, 200, service.evaluateAll());
    if (
      parts.length === 4 &&
      parts[1] === "risk-alerts" &&
      ["ack", "resolve", "reopen"].includes(parts[3]) &&
      req.method === "POST"
    ) {
      const status =
        parts[3] === "ack"
          ? "acknowledged"
          : parts[3] === "resolve"
            ? "resolved"
            : "active";
      return REPLY(io.send, 200, service.setStatus(parts[2], status));
    }

    if (parts[1] !== "patients" || parts[3] !== "lab-monitors") return false;
    const pid = identifier(parts[2]);
    if (parts.length === 4 && req.method === "GET")
      return REPLY(io.send, 200, { monitors: service.listMonitors(pid) });
    if (parts.length === 4 && req.method === "POST") {
      const monitor = service.createMonitor(pid, await io.body());
      service.evaluatePatient(pid);
      return REPLY(io.send, 201, monitor);
    }
    if (parts.length === 5 && req.method === "PATCH") {
      const monitor = service.updateMonitor(
        pid,
        identifier(parts[4]),
        await io.body(),
      );
      service.evaluatePatient(pid);
      return REPLY(io.send, 200, monitor);
    }
    if (parts.length === 5 && req.method === "DELETE") {
      service.removeMonitor(
        pid,
        identifier(parts[4]),
        (await io.body()).revision,
      );
      service.evaluatePatient(pid);
      return REPLY(io.send, 200, { ok: true });
    }
    return false;
  };
}

export default definePlugin({
  id: "risk-rules",
  version: "1.0.0",
  title: "风险规则与提醒",
  enabledByDefault: true,
  provides: { service: "risk-rules", apiVersion: 1 },
  migrations: "./migrations",
  tablePrefix: ["risk_", "lab_"],
  legacyApiPaths: [
    { method: "*", path: "/api/risk-alerts" },
    { method: "*", path: "/api/risk-alerts/*" },
    { method: "*", path: "/api/patients/:id/lab-monitors" },
    { method: "*", path: "/api/patients/:id/lab-monitors/*" },
  ],
  agendaSources: riskAgendaSources,
  patientBrief(ctx, patientId) {
    return ctx.plugins["risk-rules"]?.service?.patientBrief(patientId) || {};
  },
  hooks: {
    "patient.deleted": (payload, ctx) =>
      ctx.plugins["risk-rules"]?.service?.removePatient(payload.patientId),
  },
  setup(ctx) {
    return new RiskEngine(ctx.store, ctx.services.followups);
  },
  api: (ctx, req, url, io) => createRiskApi(ctx)(req, url, io),
  // Date-based rules (lab recheck due, follow-up overdue) change with the
  // calendar, not with chart edits. Re-run all patients shortly after start
  // and once each new local day.
  lifecycle: {
    start(ctx) {
      const service = serviceOf(ctx);
      if (!service) return;
      const day = () => new Date().toDateString();
      let last = null;
      const run = () => {
        if (last === day()) return;
        last = day();
        try { service.evaluateAll(); }
        catch (error) { last = null; console.warn("[risk-rules] 每日重算失败", error?.message); }
      };
      service.dailyTimers = [setTimeout(run, 5000), setInterval(run, 60 * 60 * 1000)];
      for (const timer of service.dailyTimers) timer.unref?.();
    },
    stop(ctx) {
      const service = serviceOf(ctx);
      for (const timer of service?.dailyTimers || []) { clearTimeout(timer); clearInterval(timer); }
      if (service) service.dailyTimers = [];
    },
  },
});
