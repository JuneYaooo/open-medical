import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { PermissionEngine } from '../server/core/permissions.mjs';

// Exercise the same tools used by chat, including material copying and stale
// proposal invalidation. Semantic interpretation is checked with live replay.
test('corrected chat registration applies once with chosen name, no note and only included materials', async t => {
  const f = await fixture(t), session = await f.session('合成建档纠正');
  const files = [], sources = [];
  for (const [name, text] of [['main.txt', '合成甲：高血压'], ['ocr.txt', '合成申：复查'], ['other.txt', '合成乙：房性期前收缩']]) {
    const result = await f.json(`/api/sessions/${session.id}/files`, 'POST', { name, text });
    assert.equal(result.status, 201);
    files.push(result.data.id);
    sources.push(result.data);
  }
  const registry = f.server.workspaces.registry(session.id, 'chat-intent-test');
  const permissions = new PermissionEngine({ profile: 'standard', grants: {} });
  const create = { execute: args => registry.execute('patient_create_propose', args, { sources }, permissions) };
  const confirm = { execute: args => registry.execute('proposal_confirm', args, { sources }, permissions) };
  const context = { sourceSessionId: session.id, sourceFileIds: files };
  const stale = await create.execute({ name: '合成甲', note: '姓名差异', summary: '原草稿' }, context);
  const corrected = await create.execute({ name: '竹子', note: '', sourceFileIds: files.slice(0, 2), diagnoses: [{ name: '高血压', status: 'confirmed', sources: ['main.txt:1'] }], summary: '按纠正建档' }, context);
  assert.equal(f.server.pendingActions.row(stale.id).status, 'superseded');
  await assert.rejects(confirm.execute({ proposalId: stale.id }), { code: 'ACTION_RESOLVED' });
  const result = await confirm.execute({ proposalId: corrected.id });
  const patient = f.server.patients.row(result.patientId);
  assert.equal(patient.name, '竹子');
  assert.equal(patient.note, '');
  assert.equal(patient.birthYear, null);
  assert.deepEqual(patient.diagnoses.map(d => d.name), ['高血压']);
  const target = (await f.json(`/api/sessions/${patient.sessionId}`)).data;
  assert.deepEqual(target.files.map(file => file.name).sort(), ['main.txt', 'ocr.txt']);
  assert.equal((await f.json('/api/patients')).data.patients.length, 1);
  await assert.rejects(confirm.execute({ proposalId: corrected.id }), { code: 'ACTION_RESOLVED' });
});

test('attachment selection rejects unavailable IDs before superseding; empty selection stays empty', async t => {
  const f = await fixture(t), session = await f.session('合成附件选择');
  const create = f.server.runtime.toolPlugins.get('patient_create_propose');
  const context = { sourceSessionId: session.id, sourceFileIds: ['available'] };
  const prior = create.execute({ name: '合成患者', summary: '仅预览' }, context);
  for (const sourceFileIds of [['foreign'], 'available', [null]]) {
    assert.throws(() => create.execute({ name: '合成患者', sourceFileIds, summary: '无效选择' }, context), { code: 'SOURCE_NOT_FOUND' });
  }
  assert.equal(f.server.pendingActions.row(prior.id).status, 'pending');
  const empty = create.execute({ name: '合成患者', sourceFileIds: [], summary: '仅保存资料内容' }, context);
  assert.deepEqual(empty.payload.sourceFileIds, []);
  const result = f.server.runtime.toolPlugins.get('proposal_confirm').execute({ proposalId: empty.id });
  assert.equal((await f.json(`/api/sessions/${result.applied.sessionId}`)).data.files.length, 0);
});
