import { definePlugin } from "../../server/plugin-host/define.mjs";
import { DoctorNotifications } from "./server/doctor-notifications.mjs";

const REPLY = (send, status, value) => {
  send(status, value);
  return true;
};

const serviceOf = (ctx) => ctx.plugins["doctor-notifications"]?.service;

function createDoctorNotificationsApi(ctx) {
  return async function doctorNotificationsApi(req, url, io) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "api" || parts[1] !== "doctor-notifications") return false;
    const service = serviceOf(ctx);
    if (!service) return false;

    if (parts.length === 2 && req.method === "GET")
      return REPLY(io.send, 200, service.settings());
    if (parts.length === 3 && parts[2] === "feishu-binding") {
      const binding = service.bindingOrNull();
      if (!binding) return false;
      if (req.method === "POST") return REPLY(io.send, 200, await binding.begin());
      if (req.method === "DELETE")
        return REPLY(io.send, 200, binding.cancel((await io.body()).id));
      return false;
    }
    if (
      parts.length === 4 &&
      parts[2] === "feishu-binding" &&
      parts[3] === "status" &&
      req.method === "POST"
    ) {
      const binding = service.bindingOrNull();
      if (!binding) return false;
      return REPLY(io.send, 200, await binding.poll((await io.body()).id));
    }
    if (parts.length === 3 && req.method === "PUT")
      return REPLY(io.send, 200, service.save(parts[2], await io.body()));
    if (parts.length === 4 && req.method === "POST") {
      const channel = parts[2], action = parts[3], input = await io.body();
      if (action === "test") return REPLY(io.send, 200, await service.test(channel));
      if (action === "send") return REPLY(io.send, 200, await service.send(channel, input));
      if (action === "disconnect")
        return REPLY(io.send, 200, service.disconnect(channel, input.expectedRevision));
      if (channel === "wechat" && action === "qrcode")
        return REPLY(io.send, 200, await service.startQr());
      if (channel === "wechat" && action === "qrcode-status")
        return REPLY(io.send, 200, await service.pollQr(input.id));
    }
    return false;
  };
}

export default definePlugin({
  id: "doctor-notifications",
  version: "1.0.0",
  title: "医生提醒",
  enabledByDefault: true,
  provides: { service: "doctor-notifications", apiVersion: 1 },
  migrations: "./migrations",
  tablePrefix: "doctor_notification_",
  legacyApiPaths: [
    { method: "*", path: "/api/doctor-notifications" },
    { method: "*", path: "/api/doctor-notifications/*" },
  ],
  // A digest that failed to send shows in the agenda work lane, not only on
  // the settings page the doctor rarely opens.
  agendaSources: [
    {
      kind: "notification-failure",
      label: "提醒发送",
      order: 900,
      workOnly: true,
      read(ctx) {
        const items = [];
        const since = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
        for (const row of ctx.db.prepare("SELECT channel,day,data FROM doctor_notification_deliveries WHERE day>=?").all(since)) {
          const delivery = JSON.parse(row.data);
          if (!["failed", "unknown"].includes(delivery.status)) continue;
          items.push({
            id: `notification:${row.channel}:${row.day}`,
            kind: "failure",
            lane: "work",
            title: `${row.channel === "wechat" ? "微信" : "飞书"}每日提醒${delivery.status === "unknown" ? "结果未知" : "发送失败"}（${row.day}）`,
            detail: delivery.message || "检查连接后可在设置中重试",
            at: delivery.at || 0,
            fallbackName: "医生提醒",
            action: { type: "view", view: "settings", settingsTab: "notifications", label: "查看并重试" },
          });
        }
        return items;
      },
    },
  ],
  setup(ctx) {
    const host = ctx.services.notificationHost || {};
    return new DoctorNotifications(ctx.services.store, host.vault, {
      createFeishuRegistration: (input) =>
        ctx.plugins.channel?.service?.createFeishuRegistration?.(input) || null,
      patients: () => ctx.services.patients,
      // These two data sources belong to other plugins. A disabled plugin
      // leaves the corresponding part of the digest empty instead of failing.
      followups: () =>
        ctx.services.followupHost?.isActive?.("followup")
          ? ctx.services.followups
          : null,
      careTasks: () => ctx.services.careTasks?.(),
      // 今日待办（含复诊、方案复评、检验、随访等全部患者事项）是推送内容的
      // 唯一来源，推送与工作台看到的待办保持一致。
      ...(typeof host.agenda === "function" ? { agenda: host.agenda } : {}),
      ...(host.options || {}),
    });
  },
  lifecycle: {
    start(ctx) {
      serviceOf(ctx)?.start();
    },
    async stop(ctx) {
      await serviceOf(ctx)?.stop();
    },
  },
  api: (ctx, req, url, io) => createDoctorNotificationsApi(ctx)(req, url, io),
});
