import { createServer } from "../server/agent.mjs";
export async function fixture(t, options = {}) {
  const server = createServer({ database: ":memory:", apiKey: "", ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.shutdown());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method = "GET", data, headers = {}) =>
    fetch(origin + path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-medical-token": server.token,
        ...headers,
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
  const json = async (path, method = "GET", data) => {
    const r = await request(path, method, data);
    return { status: r.status, data: await r.json() };
  };
  const session = async (title) => {
    const r = await json("/api/sessions", "POST", title ? { title } : {});
    return r.data;
  };
  const chat = async (id, message, extra = {}) => {
    const r = await request(`/api/chat/${id}`, "POST", { message, ...extra });
    const text = await r.text();
    return {
      status: r.status,
      text,
      events: text
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => JSON.parse(l.slice(6))),
    };
  };
  return { server, origin, request, json, session, chat };
}
