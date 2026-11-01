import test from "node:test";
import assert from "node:assert/strict";
import {
  checkOutboundTool,
  guardOutboundTools,
  outboundQueryIssue,
  patientIdentityTerms,
} from "../../server/medical/outbound-query.mjs";

const patient = { name: "示例·张沪生", phone: "13812345678", patientNumber: "MRN-2024-001" };
const ids = patientIdentityTerms(patient);

test("外发检索词：允许中英文脱敏医学关键词", () => {
  for (const query of ["原发性高血压 病例报告", "肝细胞癌 术后复发 TACE 个案", "hypertension case report", "2型糖尿病 HbA1c 7.5% 2024 指南", "IL-6 1000 pg/mL"])
    assert.equal(outboundQueryIssue(query, ids), null, query);
});

test("外发检索词：拒绝患者身份、电话、证件号、长编号和精确日期", () => {
  const cases = [
    ["张沪生 高血压", /姓名/],
    ["示例·张沪生", /姓名/],
    ["MRN-2024-001 高血压", /病历号/],
    ["高血压 138 1234 5678", /姓名|电话/],
    ["高血压 13900001111", /电话/],
    ["110101199003071234 病例", /证件号/],
    ["住院号 8812345", /7 位以上/],
    ["高血压 2024-03-05 入院", /精确日期/],
    ["2023年5月12日 胸痛", /精确日期/],
    ["3月12日 发热", /精确日期/],
  ];
  for (const [query, pattern] of cases) assert.match(outboundQueryIssue(query, ids) || "", pattern, query);
});

test("外发工具：literature_search 逐条检查 queries，web_fetch 网址只查患者身份", () => {
  assert.throws(() => checkOutboundTool("literature_search", { queries: ["hypertension", "Zhang 13812345678"] }, ids), { code: "OUTBOUND_PRIVACY" });
  assert.doesNotThrow(() => checkOutboundTool("web_fetch", { url: "https://www.yiigle.com/LinkIn.do?linkin_type=DOI&DOI=10.3760/cma.j.cn112137-20240305-00512" }, ids));
  assert.throws(() => checkOutboundTool("web_fetch", { url: `https://so.example/?q=${encodeURIComponent("张沪生")}` }, ids), { code: "OUTBOUND_PRIVACY" });
  assert.doesNotThrow(() => checkOutboundTool("read_source", { query: "张沪生" }, ids));
});

test("guardOutboundTools 在执行前拦截，不触达原工具", async () => {
  let called = 0;
  const tools = new Map([["web_search", { execute: async () => { called++; return { results: [] }; } }]]);
  const registry = { tools, get: (name) => tools.get(name) };
  guardOutboundTools(registry, ids);
  guardOutboundTools(registry, ids);
  await assert.rejects(() => tools.get("web_search").execute({ query: "张沪生 病例" }), /脱敏医学关键词/);
  await tools.get("web_search").execute({ query: "高血压 病例报告" });
  assert.equal(called, 1);
});
