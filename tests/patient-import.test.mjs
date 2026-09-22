import test from "node:test";
import assert from "node:assert/strict";
import { parsePatientImport } from "../shared/patient-import.mjs";
import { fixture } from "./helpers.mjs";

test("patient import parses quoted CSV, Excel paste and rejects malformed or oversized tables", () => {
  const rows = parsePatientImport('\uFEFF姓名,患者编号,性别,出生年份,电话,分组,标签\r\n合成甲,001,女,1980,13800000000,"慢病,复查","合成"\r\n');
  assert.deepEqual(rows[0].input.groups, ["慢病", "复查"]);
  assert.equal(rows[0].input.patientNumber, "001");
  assert.equal(rows[0].input.gender, "female");
  assert.deepEqual(rows[0].errors, []);
  assert.equal(parsePatientImport('姓名\t出生年份\n合成乙\t1970')[0].input.birthYear, 1970);
  assert.match(parsePatientImport("姓名,出生年份\n合成丙,1970abc")[0].errors[0], /出生年份/);
  assert.throws(() => parsePatientImport('姓名,电话\n"未闭合,123'), /引号/);
  assert.throws(() => parsePatientImport("姓名,constructor\n合成,值"), /未知列/);
  assert.throws(() => parsePatientImport("姓名,姓名\n合成,合成"), /重复列/);
  assert.throws(() => parsePatientImport("姓名\n" + "合成\n".repeat(201)), /200/);
  assert.match(parsePatientImport("姓名,性别\n合成,constructor")[0].errors[0], /性别/);
});

test("batch import previews without writes, requires same-name decisions and replays one saved batch", async (t) => {
  const f = await fixture(t), base = "/api/patients/import";
  await f.json("/api/patients", "POST", { name: "合成已有", patientNumber: "EXIST-1" });
  const text = "姓名,患者编号,出生年份\n合成已有,EXIST-1,1960\n合成新建,NEW-1,1970\n合成已有,NEW-2,1980\n合成坏行,NEW-3,20260\n";
  const preview = (await f.json(`${base}/preview`, "POST", { text })).data;
  assert.deepEqual(preview.counts, { ready: 1, same_name: 1, existing: 1, invalid: 1 });
  assert.equal((await f.json("/api/patients")).data.patients.length, 1);
  const input = { text, fingerprint: preview.fingerprint, selectedRows: [3, 4], distinctRows: [], requestId: "batch-test" };
  assert.equal((await f.json(`${base}/commit`, "POST", input)).status, 409);
  input.distinctRows = [4];
  const first = await f.json(`${base}/commit`, "POST", input);
  assert.equal(first.status, 201); assert.equal(first.data.count, 2);
  const retry = await f.json(`${base}/commit`, "POST", input);
  assert.equal(retry.data.replayed, true);
  assert.deepEqual(retry.data.patients, first.data.patients);
  assert.equal((await f.json("/api/patients")).data.patients.length, 3);
  assert.equal((await f.json(`${base}/commit`, "POST", { ...input, selectedRows: [3], distinctRows: [] })).status, 409);
  assert.equal((await f.json(`${base}/commit`, "POST", { ...input, requestId: "new-batch", text: text + "新行,NEW-4,1980" })).status, 400);
});

test("batch import rechecks identity changes and rolls back all rows if final audit fails", async (t) => {
  const f = await fixture(t), base = "/api/patients/import";
  const text = "姓名,患者编号\n合成一,B-1\n合成二,B-2";
  const preview = (await f.json(`${base}/preview`, "POST", { text })).data;
  const input = { text, fingerprint: preview.fingerprint, selectedRows: [2, 3], requestId: "atomic-import" };
  const audit = f.server.store.audit;
  f.server.store.audit = function (sessionId, action, detail) { if (action === "patient.imported") throw new Error("synthetic audit failure"); return audit.call(this, sessionId, action, detail); };
  assert.equal((await f.json(`${base}/commit`, "POST", input)).status, 500);
  f.server.store.audit = audit;
  assert.equal((await f.json("/api/patients")).data.patients.length, 0);
  assert.equal((await f.json("/api/sessions")).data.sessions.length, 0);
  await f.json("/api/patients", "POST", { name: "其他人", patientNumber: "B-2" });
  assert.equal((await f.json(`${base}/commit`, "POST", input)).status, 409);
  assert.equal((await f.json("/api/patients")).data.patients.length, 1);
});
