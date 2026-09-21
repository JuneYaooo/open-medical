import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceDatabase, WorkspaceService } from '../server/core/index.mjs';
import { WorkspaceFiles, hashText } from '../server/core/workspace-files.mjs';
import { SessionBridge } from '../server/session-bridge.mjs';

async function fixture(t, steps = [], { review = false, initial } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'omw-delivery-')), root = join(base, 'project');
  mkdirSync(root);
  if (initial !== undefined) writeFileSync(join(root, 'report.md'), initial);
  const db = new WorkspaceDatabase(join(base, 'state', 'agent.sqlite'));
  let index = 0;
  const provider = { local: true, model: 'scripted-test', complete: async () => {
    const step = steps[index++];
    if (typeof step === 'function') return step();
    return { message: step ? { role: 'assistant', content: '', tool_calls: [{ id: `call-${index}`, type: 'function', function: {
      name: step.name, arguments: JSON.stringify(step.args),
    } }] } : { role: 'assistant', content: '已创建 report.md，任务完成。' } };
  } };
  const service = new WorkspaceService(db.db, provider);
  t.after(async () => { await service.extensions.close(); db.close(); rmSync(base, { recursive: true, force: true }); });
  let w = service.create({ root, directoryConsent: true });
  w = service.update(w.id, { revision: w.revision, profile: 'standard', allowWrite: true,
    approvalPolicy: review ? 'review' : 'workspace-write', autoApplyConsent: !review });
  const prepare = (completion) => service.prepare(w.id, { revision: service.get(w.id).revision,
    message: '创建并核对 report.md', externalConsent: true, completion });
  const run = async (completion) => { const handle = prepare(completion); await service.execute(handle); return service.get(w.id).runs.at(-1); };
  return { service, db, root, id: w.id, prepare, run };
}
const write = (content = 'synthetic verified content', expectedHash = null) => ({ name: 'propose_file_write', args: { path: 'report.md', content, ...(expectedHash ? { expectedHash } : {}) } });

test('service verifies actual applied write, content requirements, hash and persisted bridge projection', async t => {
  const f = await fixture(t, [write()]);
  const run = await f.run({ files: [{ path: 'report.md', contains: 'verified content' }] });
  assert.equal(run.status, 'completed', run.error); assert.equal(run.outcome, 'delivered');
  assert.equal(run.delivery.evidence[0].hash, hashText(readFileSync(join(f.root, 'report.md'))));
  assert.equal(run.delivery.evidence[0].runId, run.id);
  const reloaded = new WorkspaceService(f.db.db, f.service.provider);
  assert.deepEqual(reloaded.get(f.id).runs.at(-1).delivery, run.delivery);
  assert.deepEqual(new SessionBridge(null, null, reloaded).project(reloaded.store.get(f.id)).runs.at(-1).delivery, run.delivery);
});

test('modification evidence verifies final content and rejects wrong explicit requirements', async t => {
  const initial = 'old synthetic text';
  const f = await fixture(t, [write('updated text', hashText(initial))], { initial });
  const run = await f.run({ files: [{ path: 'report.md', contains: 'absent expected phrase' }] });
  assert.equal(new WorkspaceFiles(f.root).read('report.md').text, 'updated text');
  assert.equal(run.outcome, 'answered'); assert.equal(run.delivery.delivered, false);
  assert.ok(run.delivery.gaps.some(g => g.reason === 'file_requirement_failed'));
});

test('old files, old runs and text claims cannot satisfy current-run file requirements', async t => {
  const f = await fixture(t, [write()]);
  assert.equal((await f.run()).outcome, 'delivered');
  const run = await f.run({ files: [{ path: 'report.md' }] });
  assert.equal(run.outcome, 'answered'); assert.equal(run.delivery.evidence.length, 0);
  assert.ok(run.delivery.gaps.some(g => g.reason === 'required_file_not_written'));
});

test('pending and rejected approval never count as applied delivery', async t => {
  const f = await fixture(t, [write()], { review: true });
  const run = await f.run();
  assert.equal(run.outcome, 'answered');
  const w = f.service.get(f.id), approval = w.approvals[0];
  assert.equal(approval.status, 'pending');
  f.service.decide(f.id, approval.id, { revision: w.revision, decision: 'reject' });
  const delivery = await f.service.verifyDelivery(f.id, run.id);
  assert.equal(delivery.delivered, false);
  assert.ok(delivery.gaps.some(g => g.reason === 'approval_rejected'));
});

test('service checker exception leaves structured gaps and cancellation is not completion', async t => {
  const f = await fixture(t);
  f.service.verifyDelivery = () => { throw new Error('private details'); };
  let run = await f.run();
  assert.equal(run.outcome, 'answered'); assert.equal(run.delivery.gaps[0].reason, 'delivery_check_failed');
  assert.doesNotMatch(JSON.stringify(run.delivery), /private details/);
  const handle = f.prepare();
  f.service.verifyDelivery = () => { handle.controller.abort(); return { delivered: true }; };
  await f.service.execute(handle);
  run = f.service.get(f.id).runs.at(-1);
  assert.equal(run.status, 'cancelled'); assert.notEqual(run.outcome, 'delivered');
});

test('failed execution receipt cannot verify successful file delivery', async t => {
  const f = await fixture(t, [write()]);
  const handle = f.prepare({ files: [{ path: 'report.md' }], requireExecution: true });
  // Controlled runner state, not a real container execution.
  f.service.extensions.runner.sessions.set('failed-test', { id: 'failed-test', owner: f.id,
    runId: handle.run.id, status: 'completed', exitCode: 7, output: 'synthetic failure' });
  await f.service.execute(handle);
  const run = f.service.get(f.id).runs.at(-1);
  assert.equal(run.delivery.delivered, false);
  assert.ok(run.delivery.gaps.some(g => g.reason === 'execution_not_passed' && g.exitCode === 7));
});

test('pure answer needs no tool call; protected explicit requirements rejected before run', async t => {
  const f = await fixture(t);
  const run = await f.run({ kind: 'answer' });
  assert.equal(run.status, 'completed', run.error); assert.equal(run.outcome, 'answered');
  assert.throws(() => f.prepare({ files: [{ path: '.env' }] }), { code: 'PATH_DENIED' });
  assert.throws(() => f.prepare({ files: [{ path: '../outside.md' }] }), { code: 'PATH_DENIED' });
});

test('unchanged existing file and failed tool cannot masquerade as delivery', async t => {
  const initial = 'same old text';
  const f = await fixture(t, [write(initial, hashText(initial))], { initial });
  const run = await f.run();
  assert.equal(run.delivery.delivered, false);
  assert.ok(run.delivery.gaps.some(g => g.reason === 'no_file_change'));
  const failed = await fixture(t, [write(), { name: 'unknown_execution', args: {} }]);
  const result = await failed.run();
  assert.equal(result.delivery.evidence.length, 1);
  assert.equal(result.delivery.delivered, false);
  assert.ok(result.delivery.gaps.some(g => g.reason === 'tool_failed'));
});

test('current artifacts are read back and tampering is a structured gap', async t => {
  const f = await fixture(t);
  const handle = f.prepare();
  const artifact = f.service.artifacts.save(f.id, 'result.txt', Buffer.from('synthetic artifact'), handle.run.id);
  await f.service.execute(handle);
  let run = f.service.get(f.id).runs.at(-1);
  assert.equal(run.outcome, 'delivered');
  assert.equal(run.delivery.evidence[0].hash, artifact.hash);
  writeFileSync(join(f.service.artifacts.directory, f.id, artifact.id), 'changed');
  const checked = await f.service.verifyDelivery(f.id, run.id);
  assert.equal(checked.delivered, false);
  assert.ok(checked.gaps.some(g => g.reason === 'artifact_unverified'));
});

test('trusted domain verification may restrict but cannot invent service evidence', async t => {
  const f = await fixture(t, [write()]);
  f.service.domain = { ...f.service.domain, verifyDelivery: () => ({ delivered: false,
    evidence: [], gaps: [{ reason: 'required_content_missing' }] }) };
  const run = await f.run();
  assert.equal(run.outcome, 'answered');
  assert.ok(run.delivery.gaps.some(g => g.reason === 'required_content_missing'));
});

test('restored child identity cannot attribute prior-run evidence to a new parent', async t => {
  const f = await fixture(t, [write()]);
  const prior = await f.run();
  const childId = 'restored-child';
  // A restored AgentTeam job retains its id; emulate those authoritative store
  // records without a model stub claiming delivery facts.
  f.service.store.update(f.id, w => {
    w.approvals[0].runId = childId;
    w.runs.find(r => r.id === prior.id).children = [{ id: childId, status: 'completed' }];
  });
  f.service.artifacts.save(f.id, 'prior.txt', Buffer.from('prior child output'), childId);
  f.service.extensions.runner.sessions.set('prior-execution', { id: 'prior-execution', owner: f.id,
    runId: childId, status: 'completed', exitCode: 0 });
  const handle = f.prepare({ files: [{ path: 'report.md' }], requireExecution: true });
  f.service.store.update(f.id, w => {
    w.runs.find(r => r.id === handle.run.id).children = [{ id: childId, status: 'completed' }];
  });
  await f.service.execute(handle);
  const run = f.service.get(f.id).runs.at(-1);
  assert.equal(run.delivery.delivered, false);
  assert.equal(run.delivery.evidence.length, 0);
  assert.ok(run.delivery.gaps.some(g => g.reason === 'required_file_not_written'));
  assert.ok(run.delivery.gaps.some(g => g.reason === 'execution_required'));
  assert.equal(run.evidenceBaseline, undefined, 'private boundary ids are not public API fields');
});


test('failed discovery read remains visible without invalidating independently verified delivery', async t => {
  const f = await fixture(t, [{ name: 'read_file', args: { path: 'missing.txt' } }, write()]);
  const run = await f.run({ files: [{ path: 'report.md', contains: 'verified content' }] });
  assert.equal(run.outcome, 'delivered');
  assert.equal(run.delivery.gaps.length, 0);
  assert.equal(run.toolFailures.read_file.affectsDelivery, false);
  assert.ok(run.delivery.warnings.some(w => w.tool === 'read_file' && w.reason === 'tool_failed'));
  assert.equal(run.delivery.evidence[0].hash, hashText(readFileSync(join(f.root, 'report.md'))));
  assert.deepEqual(new SessionBridge(null, null, f.service).project(f.service.store.get(f.id)).runs.at(-1).delivery, run.delivery);
});
