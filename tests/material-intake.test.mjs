import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture } from './helpers.mjs';
import { PermissionEngine } from '../server/core/permissions.mjs';
import { extractOfficeText } from '../shared/office-text.mjs';
import ExcelJS from 'exceljs';
import { onlineCaseTools } from '../server/medical/online-cases.mjs';
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSAAAAABJRU5ErkJggg==';

test('image upload keeps original, rejects duplicates, copies with a new owned artifact', async (t) => {
  const f = await fixture(t), session = await f.session();
  const file = await f.json(`/api/sessions/${session.id}/files`, 'POST', { name: 'report.png', image });
  assert.equal(file.status, 201);
  assert.equal(file.data.extraction.originalRetained, true);
  assert.equal(f.server.workspaces.artifacts.read(session.id, file.data.extraction.artifactId).data.toString('base64'), image);
  assert.equal((await f.json(`/api/sessions/${session.id}/files`, 'POST', { name: 'same.png', image })).status, 409);
  const copy = await f.json(`/api/sessions/${session.id}/copy-materials`, 'POST', { fileIds: [file.data.id] });
  assert.equal(copy.status, 201);
  assert.notEqual(copy.data.files[0].extraction.artifactId, file.data.extraction.artifactId);
  assert.equal(f.server.workspaces.artifacts.read(copy.data.id, copy.data.files[0].extraction.artifactId).data.toString('base64'), image);
});

test('new-patient proposal retains labs, visits and selected source files after confirmation', async (t) => {
  const f = await fixture(t), session = await f.session();
  const file = (await f.json(`/api/sessions/${session.id}/files`, 'POST', { name: 'record.md', text: '合成患者，2026-09-20 血红蛋白 100 g/L。' })).data;
  const registry = f.server.workspaces.registry(session.id, 'intake');
  const proposal = await registry.execute('patient_create_propose', { name: '合成建档患者', summary: '整理原始材料', labs: [{ item: '血红蛋白', value: 100, unit: 'g/L', date: '2026-09-20', source: 'record.md:1' }], visits: [{ date: '2026-09-20', reason: '复查' }] }, { sources: [file, { id: "inline-input", name: "本轮输入", text: "请整理此患者的病例" }] }, new PermissionEngine({ profile: 'standard', grants: {} }));
  assert.equal(proposal.payload.sourceSessionId, session.id);
  const confirmed = await f.json(`/api/pending-actions/${proposal.id}/confirm`, 'POST', {});
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.applied.labs.length, 1);
  assert.equal(confirmed.data.applied.visits.length, 1);
  const chart = (await f.json(`/api/sessions/${confirmed.data.applied.sessionId}`)).data;
  assert.ok(chart.files.some((item) => item.text === file.text));
  assert.ok(chart.files.some((item) => item.name === "建档时的对话输入.txt"));
  assert.equal((await f.json(`/api/pending-actions/${proposal.id}/confirm`, 'POST', {})).status, 409);
});

test('scanned PDF is stored with all page artifacts, duplicates do not accumulate images', async (t) => {
  const f = await fixture(t), session = await f.session();
  const input = { name: 'scan.pdf', text: '[PDF 第 1 页]\n[无文字层]', extraction: { type: 'pdf_text', pageCount: 1, emptyPages: [1] }, pageImages: [{ page: 1, data: image }] };
  const file = await f.json(`/api/sessions/${session.id}/files`, 'POST', input);
  assert.equal(file.status, 201); assert.equal(file.data.extraction.pageImages.length, 1);
  assert.equal((await f.json(`/api/sessions/${session.id}/files`, 'POST', input)).status, 409);
  const copy = await f.json(`/api/sessions/${session.id}/copy-materials`, 'POST', { fileIds: [file.data.id] });
  assert.equal(copy.status, 201); assert.notEqual(copy.data.files[0].extraction.pageImages[0].artifactId, file.data.extraction.pageImages[0].artifactId);
});

test('xlsx extracts sheets and cell locations, preserves cached values without calculating formulas', async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('检验');
  sheet.addRow(['项目', '结果']); sheet.addRow(['血红蛋白', 100]); sheet.getCell('C2').value = { formula: '1+1', result: 2 };
  sheet.getCell('D2').value = { formula: 'HYPERLINK("https://invalid.test", "external")' };
  const result = await extractOfficeText(new Uint8Array(await book.xlsx.writeBuffer()), 'labs.xlsx');
  assert.match(result.text, /工作表：检验/); assert.match(result.text, /B2=100/); assert.match(result.text, /C2=2/); assert.match(result.text, /未计算/);
});

test('real local Word sample parses offline when supplied explicitly', { skip: !process.env.MEDICAL_INTAKE_DOCX }, async () => {
  const result = await extractOfficeText(await readFile(process.env.MEDICAL_INTAKE_DOCX), 'history.docx');
  assert.ok(result.text.length > 50); assert.ok(!result.text.includes('\0'));
});

test('local search includes live charts and excludes current patient and its snapshots', async (t) => {
  const f = await fixture(t);
  const current = (await f.json('/api/patients', 'POST', { name: '当前合成', diagnoses: [{ name: '肺炎' }] })).data;
  await f.json('/api/patients', 'POST', { name: '其他合成', diagnoses: [{ name: '肺炎' }] });
  await f.json('/api/cases', 'POST', { patientId: current.id });
  const registry = f.server.workspaces.registry(current.sessionId, 'similar');
  const result = await registry.execute('similar_case_search', { caseText: '肺炎', diagnosis: '肺炎' }, {}, new PermissionEngine({ profile: 'standard', grants: {} }));
  assert.equal(result.count, 1); assert.equal(result.matches[0].sourceType, 'local-patient-chart');
  assert.notEqual(result.matches[0].caseId, `patient:${current.id}`);
  assert.ok(!JSON.stringify(result).includes('其他合成'));
});

test('online case search deduplicates publications and reports a failed source separately', async () => {
  const tool = onlineCaseTools({ search: async ({ source }) => ({ source, count: 1, articles: [{ pmid: '123', title: 'Case report' }] }) })[0];
  assert.equal((await tool.execute({ query: 'pneumonia' })).count, 1);
  const partial = onlineCaseTools({ search: async ({ source }) => { if (source === 'pubmed') throw new Error('offline'); return { source, count: 0, articles: [] }; } })[0];
  const result = await partial.execute({ query: 'pneumonia' });
  assert.equal(result.searches[0].status, 'failed'); assert.equal(result.searches[1].status, 'ok');
  await assert.rejects(tool.execute({ query: 'patient 13812345678 pneumonia' }), /脱敏/);
});

test('real local image goes through an authorized model turn and local OCR tool', { skip: !process.env.MEDICAL_INTAKE_IMAGE }, async (t) => {
  const { DeepSeekProvider } = await import('../server/provider.mjs');
  const provider = new DeepSeekProvider({ apiKey: 'synthetic-only', model: 'ocr-protocol-test' });
  let artifactId, output;
  provider.complete = async (messages) => {
    const previous = messages.findLast((m) => m.role === 'tool');
    if (previous) { output = JSON.parse(previous.content); return { message: { role: 'assistant', content: 'OCR 验收完成' } }; }
    return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'ocr-test', type: 'function', function: { name: 'inspect_image', arguments: JSON.stringify({ artifactId, question: '只读取原文，不作诊断' }) } }] } };
  };
  const f = await fixture(t, { provider }), session = await f.session();
  const file = (await f.json(`/api/sessions/${session.id}/files`, 'POST', { name: 'discharge.jpeg', image: (await readFile(process.env.MEDICAL_INTAKE_IMAGE)).toString('base64') })).data;
  artifactId = file.extraction.artifactId;
  const run = await f.chat(session.id, '读取这张出院记录图片', { mode: 'model', externalConsent: true, fileIds: [file.id] });
  assert.equal(run.status, 200);
  assert.equal(output.method, 'local-ocr'); assert.ok(output.analysis.length > 100);
  assert.ok(run.events.some((e) => e.type === 'message.complete'));
});
