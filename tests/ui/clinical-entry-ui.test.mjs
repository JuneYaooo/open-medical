import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer as createViteServer } from "vite";

const patient = {
  id: "p-1", name: "测试患者", gender: "female", birthYear: 1960, revision: 3, archived: false,
  allergies: ["阿司匹林"], allergyStatus: "recorded",
  diagnoses: [{ name: "原发性高血压", code: "I10", status: "confirmed" }],
  medications: [
    { name: "氨氯地平片", dose: "5mg", frequency: "qd", status: "active" },
    { name: "二甲双胍", status: "stopped", stoppedAt: "2026-06-30", stopReason: "胃肠道不适" },
  ],
  labs: [
    { item: "收缩压", value: 148, unit: "mmHg", date: "2026-10-01" },
    { item: "血肌酐", value: 80, unit: "umol/L", date: "2025-01-01" },
    { item: "血肌酐", value: 90, unit: "umol/L", date: "2026-09-01" },
  ],
  visits: [
    { date: "2025-01-01", reason: "初诊" },
    { date: "2026-10-01", reason: "复诊", note: "主诉：头晕\n计划：2 周复诊" },
  ],
};

async function load(t) {
  const vite = await createViteServer({
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());
  return vite;
}

test("临床记录编辑：日期默认今天、新用药默认在用、列表按日期最新在前", async (t) => {
  const vite = await load(t);
  const { ClinicalPanel } = await vite.ssrLoadModule("/src/patient-clinical.jsx");
  const { localCalendarDate } = await vite.ssrLoadModule("/shared/calendar-date.mjs");
  const visits = renderToStaticMarkup(createElement(ClinicalPanel, { detail: patient, section: "visits", onChanged() {} }));
  assert.match(visits, new RegExp(`value="${localCalendarDate()}"`));
  assert.match(visits, /生命体征/);
  assert.ok(visits.indexOf("复诊") < visits.indexOf("初诊"), "最近就诊应排在前面");
  const labs = renderToStaticMarkup(createElement(ClinicalPanel, { detail: patient, section: "labs", onChanged() {} }));
  assert.ok(labs.indexOf("2026-10-01") < labs.indexOf("2025-01-01"));
  const meds = renderToStaticMarkup(createElement(ClinicalPanel, { detail: patient, section: "medications", onChanged() {} }));
  assert.match(meds, /2026-06-30 停用（胃肠道不适）/);
  assert.match(meds, /<option value="active" selected="">目前在用<\/option>/);
});

test("过敏史显示反应；检验区提供单项 / 多项切换；ICD 编码栏可填写", async (t) => {
  const vite = await load(t);
  const { ClinicalPanel } = await vite.ssrLoadModule("/src/patient-clinical.jsx");
  const detail = { ...patient, allergies: ["阿司匹林", { substance: "青霉素", reaction: "皮疹" }] };
  const meds = renderToStaticMarkup(createElement(ClinicalPanel, { detail, section: "medications", onChanged() {} }));
  assert.match(meds, /青霉素（皮疹）/);
  assert.match(meds, /aria-label="移除过敏原 青霉素"/);
  assert.match(meds, /反应（可选/);
  const labs = renderToStaticMarkup(createElement(ClinicalPanel, { detail, section: "labs", onChanged() {} }));
  assert.match(labs, /单项/);
  assert.match(labs, /多项（一次录多项）/);
  const dx = renderToStaticMarkup(createElement(ClinicalPanel, { detail, section: "diagnoses", onChanged() {} }));
  assert.match(dx, /aria-label="ICD-10 编码"/);
});
