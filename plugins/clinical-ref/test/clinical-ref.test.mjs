import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createScriptedProvider } from "../../../tests/helpers/scripted-provider.mjs";
import { startTestServer } from "../../../tests/helpers/server.mjs";

const snapshot = JSON.parse(
  readFileSync(
    new URL("./fixtures/routes.snapshot.json", import.meta.url),
    "utf8",
  ),
);

const calls = {
  "/api/scales": { method: "GET" },
  "/api/scales/cha2ds2-vasc/calculate": {
    method: "POST",
    body: {
      answers: { chf: "是", htn: "是", age: "≥75 岁", dm: "否", stroke: "否", vascular: "否", sex: "男" },
    },
  },
  "/api/icd9?q=胆囊": { method: "GET" },
  "/api/adr-assess": {
    method: "POST",
    body: { medications: ["依那普利"], findings: "干咳" },
  },
};

test("clinical-ref：旧速查接口迁移前后响应一致", async (t) => {
  const app = await startTestServer({ provider: createScriptedProvider([]) });
  t.after(() => app.close());
  for (const [path, expected] of Object.entries(snapshot)) {
    const response = await app.request(path, calls[path]);
    assert.equal(response.status, expected.status, path);
    assert.deepEqual(response.body, expected.body, path);
  }
});

test("clinical-ref：停用后接口 404、量表/ADR 工具不注册，检验与 ICD-10 等固定能力保留", async (t) => {
  const app = await startTestServer({ provider: createScriptedProvider([]) });
  t.after(() => app.close());
  const before = app.server.sessionBridge.toolNames();
  assert.ok(before.includes("medical_scale_list"));
  assert.ok(before.includes("medical_scale_calculate"));
  assert.ok(before.includes("assess_adverse_reaction"));

  const disabled = await app.request("/api/plugins/clinical-ref", {
    method: "PUT",
    body: { enabled: false },
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.plugin.enabled, false);

  for (const path of Object.keys(snapshot)) {
    const response = await app.request(path, calls[path]);
    assert.equal(response.status, 404, path);
  }

  const after = app.server.sessionBridge.toolNames();
  assert.ok(!after.includes("medical_scale_list"));
  assert.ok(!after.includes("medical_scale_calculate"));
  assert.ok(!after.includes("assess_adverse_reaction"));

  const lab = await app.request("/api/lab-knowledge?q=肌酐");
  assert.equal(lab.status, 200, "检验速查是固定区能力");
  const icd10 = await app.request("/api/icd10?q=高血压");
  assert.equal(icd10.status, 200, "ICD-10 被固定患者页使用，必须保留");
  const safety = await app.request("/api/med-safety", {
    method: "POST",
    body: { medications: ["华法林", "阿司匹林"] },
  });
  assert.equal(safety.status, 200, "用药辅助提醒属于固定风险引擎");
});
