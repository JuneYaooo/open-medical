import { check, identifier } from "../../../server/errors.mjs";
import { careApi } from "./care.mjs";
import { chatFollowupsApi } from "../core/chat-followups-api.mjs";
import { chatAutoFollowApi } from "../core/chat-autofollow-api.mjs";
import { chatAibotApi } from "../core/aibot.mjs";
import { MESSAGING_DISCONNECTED, messagingConnected } from "../connection.mjs";

const REPLY = (send, status, value) => {
  send(status, value);
  return true;
};

// Connection management stays available without a connected channel: the
// doctor must be able to connect one from the settings panel.
export function isFollowupConnectionRoute(path, method) {
  if (method === "GET" && path === "/api/chat-followups/settings") return true;
  if (method === "POST" && path === "/api/chat-followups/plugins") return true;
  if (method === "DELETE" && /^\/api\/chat-followups\/plugins\/[^/]+$/.test(path))
    return true;
  return (
    method === "POST" &&
    /^\/api\/chat-followups\/connections\/[^/]+(?:\/(?:connect|test|cancel|rescan))?$/.test(
      path,
    )
  );
}

// Importing a chat file the doctor exported is local work: it reads only the
// selected file and needs no live channel. Preview, match and commit stay
// open, together with the local records the import produces (the patient's
// chat list, its review drafts and unlinking). Reading, syncing or sending
// through a channel stays gated.
export function isFollowupImportRoute(path, method) {
  if (method === "POST" && /^\/api\/chat-followups\/imports(?:\/(?:preview|match))?$/.test(path))
    return true;
  if (method === "GET" && /^\/api\/chat-followups\/patients\/[^/]+$/.test(path)) return true;
  if (method === "GET" && /^\/api\/chat-followups\/drafts\/[^/]+\/sources$/.test(path)) return true;
  if (method === "POST" && /^\/api\/chat-followups\/drafts\/[^/]+\/(?:save|summarize|archive)$/.test(path))
    return true;
  return method === "DELETE" && /^\/api\/chat-followups\/bindings\/[^/]+$/.test(path);
}

// Routes that reach patients or patient chat history. They need a connected
// WeChat/WeCom channel; follow-up plans, reminders, contact records and
// manually recorded questionnaire answers do not. Questionnaire send is gated
// per channel in its handler: the manual channel only records that the doctor
// copied the text, so it works without a connection.
export function isFollowupMessagingRoute(path, method) {
  if (isFollowupConnectionRoute(path, method)) return false;
  if (isFollowupImportRoute(path, method)) return false;
  return /^\/api\/(?:care|chat-followups|chat-autofollow|chat-aibot)\//.test(path);
}

// All followup-private legacy routes. Paths, status codes and response bodies
// are unchanged; /api/reminders (the shared reminder bus) remains fixed.
export function createFollowupApi(ctx) {
  const service = () => ctx.plugins.followup.service;
  const active = () => ctx.services.followupHost?.isActive?.() !== false;
  async function handle(req, url, io) {
    const send = io.send;
    const body = io.body;
    const path = url.pathname;
    const parts = path.split("/").filter(Boolean);
    const svc = service();
    const followups = svc.followups;
    const surveys = svc.surveys;
    const risks = ctx.services.risks || null;

    if (!active() && !isFollowupConnectionRoute(path, req.method)) {
      return REPLY(send, 409, {
        error: "随访插件未启用",
        code: "FOLLOWUP_INACTIVE",
      });
    }
    if (isFollowupMessagingRoute(path, req.method) && !messagingConnected(ctx))
      return REPLY(send, 409, { ...MESSAGING_DISCONNECTED });

    if (path === "/api/followup-plans" && req.method === "GET")
      return REPLY(send, 200, { plans: followups.listPlans() });
    if (path === "/api/followup-plans" && req.method === "POST")
      return REPLY(send, 201, followups.createPlan(await body()));
    if (
      parts[0] === "api" &&
      parts[1] === "followup-plans" &&
      parts.length === 3 &&
      req.method === "DELETE"
    )
      return REPLY(send, 200, followups.removePlan(parts[2]));
    if (
      parts[0] === "api" &&
      parts[1] === "followups" &&
      parts[2] === "overview" &&
      req.method === "GET"
    )
      return REPLY(
        send,
        200,
        followups.overviewPage({
          limit: url.searchParams.has("limit")
            ? Number(url.searchParams.get("limit"))
            : undefined,
          offset: url.searchParams.has("offset")
            ? Number(url.searchParams.get("offset"))
            : undefined,
        }),
      );

    if (parts[0] === "api" && parts[1] === "reminders") {
      if (
        parts.length === 4 &&
        parts[3] === "addendum" &&
        req.method === "POST"
      )
        return REPLY(
          send,
          200,
          followups.addContactAddendum(identifier(parts[2]), await body()),
        );
      if (
        parts.length === 4 &&
        parts[3] === "complete" &&
        req.method === "POST"
      ) {
        const reminder = followups.completeReminder(
          identifier(parts[2]),
          await body(),
        );
        risks?.evaluatePatient(reminder.patientId);
        return REPLY(send, 200, reminder);
      }
      if (parts.length === 4 && parts[3] === "snooze" && req.method === "POST")
        return REPLY(send, 200, followups.snoozeReminder(identifier(parts[2]), await body()));
      if (parts.length === 4 && parts[3] === "ack" && req.method === "POST")
        return REPLY(send, 200, followups.ackReminder(identifier(parts[2])));
    }

    if (parts[0] === "api" && parts[1] === "patients" && parts[2]) {
      const pid = identifier(parts[2]);
      if (
        parts[3] === "followup-records" &&
        parts.length === 4 &&
        req.method === "POST"
      ) {
        const record = followups.recordContact(pid, await body());
        risks?.evaluatePatient(pid);
        return REPLY(send, 201, record);
      }
      if (parts[3] === "followup-surveys") {
        if (parts.length === 4 && req.method === "GET")
          return REPLY(send, 200, {
            surveys: surveys.list(pid, {
              reminderId: url.searchParams.get("reminderId"),
              surveyId: url.searchParams.get("surveyId"),
            }),
          });
        if (parts.length === 6 && req.method === "POST") {
          const surveyId = identifier(parts[4]);
          if (parts[5] === "send") {
            const input = await body();
            if ((input?.channel || "manual") !== "manual" && !messagingConnected(ctx))
              return REPLY(send, 409, { ...MESSAGING_DISCONNECTED });
            return REPLY(send, 200, await surveys.send(pid, surveyId, input));
          }
          if (parts[5] === "collect") {
            const row = surveys.collect(pid, surveyId, await body());
            risks?.evaluatePatient(pid);
            return REPLY(send, 200, row);
          }
          if (parts[5] === "cancel")
            return REPLY(send, 200, surveys.cancel(pid, surveyId, await body()));
          if (parts[5] === "ai-parse")
            return REPLY(send, 200, await surveys.aiParse(pid, surveyId));
        }
      }
      if (parts[3] === "followups") {
        if (parts.length === 4 && req.method === "GET")
          return REPLY(send, 200, { jobs: followups.list(pid) });
        if (parts.length === 4 && req.method === "POST")
          return REPLY(send, 201, followups.create(pid, await body()));
        if (parts.length === 5 && parts[4] === "apply" && req.method === "POST")
          return REPLY(
            send,
            201,
            followups.applyTemplate(pid, await body()),
          );
        if (parts.length === 5) {
          const job = followups.row(parts[4]);
          check(
            job.patientId === pid,
            "NOT_FOUND",
            "随访计划不属于当前患者",
            404,
          );
          if (req.method === "PATCH")
            return REPLY(send, 200, followups.update(job.id, await body()));
          if (req.method === "DELETE") {
            followups.remove(job.id, (await body()).revision);
            return REPLY(send, 200, { ok: true });
          }
        }
      }
    }

    if (path.startsWith("/api/care/"))
      return careApi(svc.care, req, url, {
        body,
        send,
        pending: ctx.services.pending,
      });

    if (path.startsWith("/api/chat-followups/"))
      return chatFollowupsApi(svc.chatFollowups, req, url, { body, send });
    if (path.startsWith("/api/chat-autofollow/"))
      return chatAutoFollowApi(svc.chatAutoFollow, req, url, { body, send });
    if (path.startsWith("/api/chat-aibot/"))
      return chatAibotApi(svc.aibot, req, url, { body, send });
    return false;
  }
  return async function followupApi(req, url, io) {
    try {
      return await handle(req, url, io);
    } finally {
      // Connect/disconnect/test/save can change activation even when the
      // handler returns an error after writing the new config.
      if (isFollowupConnectionRoute(url.pathname, req.method)) {
        try {
          await ctx.services.followupHost?.syncActivation?.();
        } catch (error) {
          console.error("随访渠道状态更新失败:", error);
        }
      }
    }
  };
}

export const FOLLOWUP_LEGACY_API_PATHS = [
  { method: "*", path: "/api/followup-plans" },
  { method: "DELETE", path: "/api/followup-plans/:id" },
  { method: "GET", path: "/api/followups/overview" },
  { method: "POST", path: "/api/reminders/:id/addendum" },
  { method: "POST", path: "/api/reminders/:id/complete" },
  { method: "POST", path: "/api/reminders/:id/ack" },
  { method: "POST", path: "/api/reminders/:id/snooze" },
  { method: "POST", path: "/api/patients/:id/followup-records" },
  { method: "GET", path: "/api/patients/:id/followup-surveys" },
  { method: "POST", path: "/api/patients/:id/followup-surveys/:surveyId/*" },
  { method: "*", path: "/api/patients/:id/followups" },
  { method: "*", path: "/api/patients/:id/followups/*" },
  { method: "*", path: "/api/care/*" },
  { method: "*", path: "/api/chat-followups/*" },
  { method: "*", path: "/api/chat-autofollow/*" },
  { method: "*", path: "/api/chat-aibot/*" },
];
