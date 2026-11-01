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
