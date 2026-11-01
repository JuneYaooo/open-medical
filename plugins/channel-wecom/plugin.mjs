import { definePlugin } from "../../server/plugin-host/define.mjs";
import { createWecomService } from "./service.mjs";
import { createWecomApi, WECOM_LEGACY_API_PATHS } from "./api.mjs";
import { registerWecomTools, wecomContactConfigured } from "./tools.mjs";

export default definePlugin({
  id: "channel-wecom",
  version: "1.0.0",
  title: "企业微信",
  enabledByDefault: true,
  requires: { plugins: { channel: "*" } },
  provides: { service: "channel-wecom", apiVersion: 1 },
  capabilities: ["channel.adapters"],
  legacyTables: [
    "wecom_contacts",
    "wecom_bindings",
    "wecom_tasks",
    "wecom_events",
    "wecom_groups",
    "wecom_group_tasks",
    "wecom_directory_state",
  ],
  migrations: "./migrations",
  tablePrefix: "wecom_",
  prompt: "./prompt.md",
  skills: "./skills",
  promptWhen: wecomContactConfigured,
  legacyApiPaths: WECOM_LEGACY_API_PATHS,
  // Directory sync errors and sends whose outcome is unknown need the doctor;
  // surface them in the agenda work lane.
  agendaSources: [
    {
      kind: "wecom-failure",
      label: "企业微信",
      order: 900,
      workOnly: true,
      read(ctx) {
        const service = ctx.plugins["channel-wecom"]?.service;
        const items = [];
        const state = service?.directory?.state?.();
        if (service?.connector?.client && state?.lastError) items.push({
          id: "wecom-sync", kind: "failure", lane: "work",
          title: "企业微信客户同步失败", detail: String(state.lastError).slice(0, 200),
          at: Date.parse(state.lastAttemptAt || "") || 0, fallbackName: "企业微信",
          action: { type: "view", view: "care", tab: "contacts", label: "查看" },
        });
        for (const row of ctx.db.prepare("SELECT patient_id,data FROM wecom_tasks WHERE json_extract(data,'$.status')='unknown'").all()) {
          const task = JSON.parse(row.data);
          items.push({
            id: `wecom-task:${task.id}`, kind: "failure", lane: "work", patientId: row.patient_id,
            title: "企业微信随访发送结果未知", detail: "请在企业微信核实是否已发出，再在患者沟通页登记",
            at: Date.parse(task.updatedAt || task.createdAt || "") || 0,
            action: { type: "patient", tab: "messages", label: "去核实" },
          });
        }
        return items;
      },
    },
  ],
  setup(ctx) {
    const host = ctx.services.channelWecomHost || {};
    return createWecomService({
      db: ctx.db,
      store: ctx.services.store || ctx.store,
      patients: host.patients,
      vault: host.vault,
      env: host.env,
      channel: ctx.services.channel,
      options: host.options || {},
      directoryTickMs: host.directoryTickMs,
      fetchImpl: host.fetch,
      now: host.now,
      onStart: host.onStart,
      onStop: host.onStop,
      shouldRefreshAwaiting: host.shouldRefreshAwaiting,
    });
  },
  tools(ctx, { registry }) {
    registerWecomTools(ctx, { registry });
  },
  api(ctx, req, url, io) {
    return createWecomApi(ctx.plugins["channel-wecom"].service)(
      ctx,
      req,
      url,
      io,
    );
  },
  lifecycle: {
    start(ctx) {
      return ctx.plugins["channel-wecom"].service.start();
    },
    stop(ctx) {
      return ctx.plugins["channel-wecom"].service.stop();
    },
    drain(ctx) {
      return ctx.plugins["channel-wecom"].service.drain();
    },
  },
});
