// Explicit opt-in. Synthetic patient only; no real patient database is opened.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fixture } from "./helpers.mjs";
if (existsSync(".env")) process.loadEnvFile(".env");
const model = {
  providerName: process.env.AI_PROVIDER || "anthropic",
  apiKey: process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY || "",
  baseUrl: process.env.ANTHROPIC_BASE_URL || process.env.DEEPSEEK_BASE_URL,
  model: process.env.ANTHROPIC_MODEL || process.env.DEEPSEEK_MODEL,
};
test(
  "real model screens synthetic patient with dated evidence, exclusion trigger and missing recent laboratory data",
  { skip: process.env.MODEL_E2E !== "on" || !model.apiKey, timeout: 180000 },
  async (t) => {
    const f = await fixture(t, model),
      p = (
        await f.json("/api/patients", "POST", {
          name: "合成纳排模型验收",
          gender: "male",
          birthYear: 1981,
        })
      ).data;
    await f.json(`/api/sessions/${p.sessionId}/files`, "POST", {
      name: "人工合成病历.txt",
      text: "仅供软件验收，不是真实患者。\n2026-09-24门诊：患者45岁，男性，病理诊断为肝细胞癌。\n2026-09-24患者明确确认：仍在参加另一项干预性临床试验。\n最近一次肝功能报告日期2025-08-01。之后无检验报告，未记载当前肝功能。",
    });
    const trial = (
        await f.json("/api/trials", "POST", {
          title: "合成纳排模型验收方案",
          version: "2026-09-24",
          inclusion: "年龄至少18岁\n筛选前7天内肝功能检查正常",
          exclusion: "正在参加另一项干预性临床试验",
        })
      ).data,
      path = `/api/trials/${trial.id}/screenings/${p.id}/ai`,
      started = Date.now();
    const start = await f.json(path, "POST", { externalConsent: true });
    assert.equal(start.status, 202, JSON.stringify(start.data));
    let job;
    for (let n = 0; n < 160; n++) {
      job = (await f.json(path)).data.jobs[0];
      if (job.status !== "running") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    t.diagnostic(
      JSON.stringify({
        durationMs: Date.now() - started,
        status: job.status,
        checked: job.checks.length,
        conflicts: job.conflicts,
        missing: job.missing,
        error: job.error,
      }),
    );
    assert.equal(job.status, "completed", job.error);
    const check = (i) => job.checks.find((c) => c.id === trial.criteria[i].id);
    assert.equal(check(0).value, "yes");
    assert.equal(check(1).value, "unknown");
    assert.equal(check(2).value, "yes");
    assert.ok(check(0).citations.length);
    assert.ok(check(1).missing);
    assert.ok(check(2).citations.length);
  },
);
