import test from "node:test";
import assert from "node:assert/strict";

test("HTTP：/api/appointments 按日期范围列出全部患者预约（复诊名单用）", async (t) => {
  const { createScriptedProvider } = await import("../helpers/scripted-provider.mjs");
  const { startTestServer } = await import("../helpers/server.mjs");
  const app = await startTestServer({ provider: createScriptedProvider([]), seedDemoPack: false });
  t.after(() => app.close());
  const created = await app.request("/api/patients", { method: "POST", body: { name: "张三" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const later = new Date(); later.setDate(later.getDate() + 150);
  assert.equal((await app.request(`/api/patients/${created.body.id}/appointments`, { method: "POST", body: { date: fmt(later) } })).status, 201);
  const end = new Date(); end.setMonth(end.getMonth() + 6);
  const range = await app.request(`/api/appointments?from=${fmt(new Date())}&to=${fmt(end)}`);
  assert.equal(range.status, 200, JSON.stringify(range.body));
  assert.deepEqual(range.body.appointments.map((a) => a.patientName), ["张三"]);
  assert.equal((await app.request("/api/appointments?from=bad&to=x")).status, 400);
});
