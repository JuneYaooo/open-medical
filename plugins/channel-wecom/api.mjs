import { check } from "../../server/errors.mjs";

const reply = (send, status, value) => {
  send(status, value);
  return true;
};

// Legacy /api/wecom/* routes. The public callback is intentionally absent:
// the fixed shell keeps its pre-auth signature/decrypt flow and calls
// service.handleCallback().
export function createWecomApi(service) {
  const { connector, directory } = service;
  return async function wecomApi(ctx, req, url, io) {
    const send = io.send;
    const body = io.body;
    const path = url.pathname;
    const parts = path.split("/").filter(Boolean);
    if (path === "/api/wecom/status" && req.method === "GET")
      return reply(send, 200, connector.status());
    if (path === "/api/wecom/contacts" && req.method === "GET")
      return reply(
        send,
        200,
        directory.contacts({
          status: url.searchParams.get("status") || undefined,
          query: url.searchParams.get("q") || undefined,
        }),
      );
    if (path === "/api/wecom/directory" && req.method === "GET")
      return reply(send, 200, directory.status());
    if (path === "/api/wecom/directory/sync" && req.method === "POST")
      return reply(send, 200, await directory.sync());
    if (path === "/api/wecom/groups" && req.method === "GET")
      return reply(
        send,
        200,
        directory.groups({ query: url.searchParams.get("q") || undefined }),
      );
    if (
      parts[0] === "api" &&
      parts[1] === "wecom" &&
      parts[2] === "groups" &&
      parts.length === 4 &&
      req.method === "GET"
    )
      return reply(send, 200, directory.group(decodeURIComponent(parts[3])));
    if (
      parts[0] === "api" &&
      parts[1] === "wecom" &&
      parts[2] === "patients" &&
      parts.length === 4 &&
      req.method === "GET"
    )
      return reply(send, 200, directory.patient(parts[3]));
    if (path === "/api/wecom/group-tasks" && req.method === "POST")
      return reply(send, 201, directory.groupDraft(await body()));
    if (
      parts[0] === "api" &&
      parts[1] === "wecom" &&
      parts[2] === "group-tasks" &&
      parts.length === 5 &&
      req.method === "POST"
    ) {
      if (parts[4] === "submit")
        return reply(send, 200, await directory.groupSubmit(parts[3], await body()));
      if (parts[4] === "refresh")
        return reply(send, 200, await directory.groupRefresh(parts[3]));
    }
    if (path === "/api/wecom/sync" && req.method === "POST")
      return reply(send, 200, await connector.sync(await body()));
    if (path === "/api/wecom/bindings" && req.method === "GET")
      return reply(send, 200, {
        bindings: connector.bindings(url.searchParams.get("patientId")),
      });
    if (path === "/api/wecom/bindings" && req.method === "POST")
      return reply(send, 201, await directory.link(await body()));
    if (
      parts[0] === "api" &&
      parts[1] === "wecom" &&
      parts[2] === "bindings" &&
      parts.length === 4 &&
      req.method === "DELETE"
    )
    {
      const result = connector.unbind(parts[3]);
      check(result.removed, "NOT_FOUND", "该关联不存在或已解除", 404);
      return reply(send, 200, result);
    }
    if (path === "/api/wecom/tasks" && req.method === "GET")
      return reply(send, 200, {
        tasks: connector.tasks(url.searchParams.get("patientId")),
      });
    if (path === "/api/wecom/tasks" && req.method === "POST")
      return reply(send, 201, connector.draft(await body()));
    if (
      parts[0] === "api" &&
      parts[1] === "wecom" &&
      parts[2] === "tasks" &&
      parts.length === 5 &&
      req.method === "POST"
    ) {
      if (parts[4] === "submit")
        return reply(send, 200, await connector.submit(parts[3], await body()));
      if (parts[4] === "refresh")
        return reply(send, 200, await connector.refresh(parts[3]));
      if (parts[4] === "resolve")
        return reply(send, 200, connector.resolveUnknown(parts[3], await body()));
    }
    return false;
  };
}

export const WECOM_LEGACY_API_PATHS = [
  { method: "GET", path: "/api/wecom/status" },
  { method: "GET", path: "/api/wecom/contacts" },
  { method: "GET", path: "/api/wecom/directory" },
  { method: "POST", path: "/api/wecom/directory/sync" },
  { method: "GET", path: "/api/wecom/groups" },
  { method: "GET", path: "/api/wecom/groups/:chatId" },
  { method: "GET", path: "/api/wecom/patients/:patientId" },
  { method: "POST", path: "/api/wecom/group-tasks" },
  { method: "POST", path: "/api/wecom/group-tasks/:id/submit" },
  { method: "POST", path: "/api/wecom/group-tasks/:id/refresh" },
  { method: "POST", path: "/api/wecom/sync" },
  { method: "GET", path: "/api/wecom/bindings" },
  { method: "POST", path: "/api/wecom/bindings" },
  { method: "DELETE", path: "/api/wecom/bindings/:id" },
  { method: "GET", path: "/api/wecom/tasks" },
  { method: "POST", path: "/api/wecom/tasks" },
  { method: "POST", path: "/api/wecom/tasks/:id/submit" },
  { method: "POST", path: "/api/wecom/tasks/:id/refresh" },
  { method: "POST", path: "/api/wecom/tasks/:id/resolve" },
];
