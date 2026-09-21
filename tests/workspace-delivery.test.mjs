import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceDatabase, WorkspaceService } from '../server/core/index.mjs';
import { WorkspaceFiles, hashText } from '../server/core/workspace-files.mjs';
import { SessionBridge } from '../server/session-bridge.mjs';

async function fixture(t, steps = [], { review = false, initial, message = '创建并核对 report.md', answer = '已创建 report.md，任务完成。' } = {}) {
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
    } }] } : { role: 'assistant', content: answer } };
  } };
  const service = new WorkspaceService(db.db, provider);
  t.after(async () => { await service.extensions.close(); db.close(); rmSync(base, { recursive: true, force: true }); });
  let w = service.create({ root, directoryConsent: true });
  w = service.update(w.id, { revision: w.revision, profile: 'standard', allowWrite: true,
    approvalPolicy: review ? 'review' : 'workspace-write', autoApplyConsent: !review });
  const prepare = (completion) => service.prepare(w.id, { revision: service.get(w.id).revision,
    message, externalConsent: true, completion });
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
  assert.equal(run.outcome, 'delivery_failed'); assert.equal(run.delivery.delivered, false);
  assert.ok(run.delivery.gaps.some(g => g.reason === 'file_requirement_failed'));
});

test('old files, old runs and text claims cannot satisfy current-run file requirements', async t => {
  const f = await fixture(t, [write()]);
  assert.equal((await f.run()).outcome, 'delivered');
  const run = await f.run({ files: [{ path: 'report.md' }] });
  assert.equal(run.outcome, 'delivery_failed'); assert.equal(run.delivery.evidence.length, 0);
  assert.ok(run.delivery.gaps.some(g => g.reason === 'required_file_not_written'));
});

test('pending and rejected approval never count as applied delivery', async t => {
  const f = await fixture(t, [write()], { review: true });
  const run = await f.run();
  assert.equal(run.outcome, 'delivery_failed');
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
  assert.equal(run.outcome, 'unverified'); assert.equal(run.delivery.gaps[0].reason, 'delivery_check_failed');
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
  const f = await fixture(t, [], { message: '生成合成测试产物', answer: '产物已生成。' });
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
  assert.equal(run.outcome, 'delivery_failed');
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

test('verified proposal submission stops as waiting approval, survives reload, and never applies itself', async t => {
  let f;
  f = await fixture(t, [write(), () => {
    const w = f.service.store.get(f.id), proposal = w.approvals[0], run = w.runs.at(-1);
    // Synthetic service-owned execution receipt; actual container tests exercise
    // the producer separately. Never use model text as this fixture's evidence.
    f.service.store.update(f.id, w => { w.verifications = [{ id: 'verified', runId: run.id,
      status: 'completed', exitCode: 0, outputComplete: true, environment: 'isolated-container',
      approvalIds: [proposal.id], inputs: [{ path: proposal.path, hash: hashText(proposal.content) }] }]; });
    return { message: { role: 'assistant', tool_calls: [{ id: 'submit', type: 'function', function: {
      name: 'submit_for_approval', arguments: JSON.stringify({ approvalIds: [proposal.id], verificationIds: ['verified'] }),
    } }] } };
  }, () => { throw new Error('Model must stop after verified submission'); }], { review: true });
  const run = await f.run({ files: [{ path: 'report.md', contains: 'verified content' }], requireExecution: true });
  assert.equal(run.status, 'waiting_approval', run.error); assert.equal(run.outcome, 'awaiting_approval');
  assert.equal(run.delivery, null); assert.equal(run.runtimeState, undefined); // private projection
  assert.equal(f.service.store.get(f.id).runs.at(-1).runtimeState.phase, 'waiting_approval');
  assert.throws(() => readFileSync(join(f.root, 'report.md')), { code: 'ENOENT' });
  const reloaded = new WorkspaceService(f.db.db, f.service.provider);
  t.after(() => reloaded.extensions.close());
  assert.equal(reloaded.get(f.id).runs.at(-1).status, 'waiting_approval');
  const w = reloaded.get(f.id);
  reloaded.decide(f.id, w.approvals[0].id, { revision: w.revision, decision: 'approve' });
  assert.equal(reloaded.get(f.id).runs.at(-1).status, 'waiting_input');
  assert.equal(readFileSync(join(f.root, 'report.md'), 'utf8'), 'synthetic verified content');
});

for (const invalid of ['missing', 'wrong-run', 'failed', 'finalizing', 'incomplete', 'wrong-hash', 'unrelated', 'wrong-requirement'])
  test(`submission refuses ${invalid} verification and keeps proposal pending`, async t => {
    let f;
    f = await fixture(t, [write(), () => {
      const w = f.service.store.get(f.id), p = w.approvals[0], run = w.runs.at(-1);
      f.service.store.update(f.id, current => { current.verifications = invalid === 'missing' ? [] : [{
        id: 'v', runId: invalid === 'wrong-run' ? 'old' : run.id,
        status: ['failed','finalizing'].includes(invalid) ? invalid : 'completed', exitCode: invalid === 'failed' ? 1 : 0,
        outputComplete: invalid !== 'incomplete', environment: 'isolated-container',
        approvalIds: invalid === 'unrelated' ? [] : [p.id],
        inputs: [{ path: p.path, hash: invalid === 'wrong-hash' ? '0'.repeat(64) : hashText(p.content) }],
      }]; });
      return { message: { role: 'assistant', tool_calls: [{ id: 'submit', type: 'function', function: {
        name: 'submit_for_approval', arguments: JSON.stringify({ approvalIds: [p.id], verificationIds: ['v'] }),
      } }] } };
    }], { review: true });
    const run = await f.run(invalid === 'wrong-requirement' ? { files: [{ path: 'report.md', contains: 'required absent' }] } : undefined);
    assert.notEqual(run.status, 'waiting_approval');
    assert.notEqual(run.outcome, 'delivered');
    assert.equal(f.service.get(f.id).approvals[0].status, 'pending');
    assert.throws(() => readFileSync(join(f.root, 'report.md')), { code: 'ENOENT' });
  });

test('natural final answer with exact proposal verification uses the same waiting boundary', async t => {
  let f;
  f = await fixture(t, [write(), () => {
    const w = f.service.store.get(f.id), p = w.approvals[0], run = w.runs.at(-1);
    f.service.store.update(f.id, current => { current.verifications = [{ id: 'v', runId: run.id,
      status: 'completed', exitCode: 0, outputComplete: true, environment: 'isolated-container',
      approvalIds: [p.id], inputs: [{ path: p.path, hash: hashText(p.content) }] }]; });
    return { message: { role: 'assistant', content: 'The proposal has been tested; please review.' } };
  }], { review: true });
  const run = await f.run();
  assert.equal(run.status, 'waiting_approval', run.error);
  assert.equal(run.outcome, 'awaiting_approval');
  assert.equal(f.service.store.get(f.id).runs.at(-1).runtimeState.phase, 'waiting_approval');
  assert.equal(run.delivery, null);
  assert.throws(() => readFileSync(join(f.root, 'report.md')), { code: 'ENOENT' });
});

test('validated batch schedules a restricted finish decision before any repeated reads', async t => {
  let f, round = 0;
  f = await fixture(t, [], { review: true });
  f.service.provider.complete = async (_messages, tools) => {
    round++;
    if (round === 1) return { message: { role: 'assistant', tool_calls: [{ id: 'write', function: {
      name: 'propose_file_write', arguments: JSON.stringify({ path: 'report.md', content: 'verified' }),
    } }] } };
    if (round === 2) {
      const w = f.service.store.get(f.id), p = w.approvals[0], run = w.runs.at(-1);
      f.service.store.update(f.id, current => { current.verifications = [{ id: 'v', runId: run.id,
        status: 'completed', exitCode: 0, outputComplete: true, environment: 'isolated-container',
        approvalIds: [p.id], inputs: [{ path: p.path, hash: hashText(p.content) }] }]; });
      return { message: { role: 'assistant', tool_calls: [{ id: 'list', function: { name: 'list_artifacts', arguments: '{}' } }] } };
    }
    assert.deepEqual(tools.map(t => t.function.name).sort(), ['continue_task', 'submit_for_approval']);
    return { message: { role: 'assistant', content: 'Ready for review.' } };
  };
  const run = await f.run();
  assert.equal(run.status, 'waiting_approval', run.error); assert.equal(round, 3);
  assert.equal(f.service.get(f.id).approvals[0].status, 'pending');
});

test('explicit remaining work restores execution and cannot repeatedly reopen the same finish phase', async t => {
  let f, round = 0;
  f = await fixture(t, [], { review: true });
  f.service.provider.complete = async (_messages, tools) => {
    round++;
    if (round === 1) return { message: { role: 'assistant', tool_calls: [{ id: 'write', function: {
      name: 'propose_file_write', arguments: JSON.stringify({ path: 'report.md', content: 'verified' }),
    } }] } };
    if (round === 2) {
      const w = f.service.store.get(f.id), p = w.approvals[0], run = w.runs.at(-1);
      f.service.store.update(f.id, current => { current.verifications = [{ id: 'v', runId: run.id,
        status: 'completed', exitCode: 0, outputComplete: true, environment: 'isolated-container',
        approvalIds: [p.id], inputs: [{ path: p.path, hash: hashText(p.content) }] }]; });
      return { message: { role: 'assistant', tool_calls: [{ id: 'list', function: { name: 'list_artifacts', arguments: '{}' } }] } };
    }
    if (round === 3) return { message: { role: 'assistant', tool_calls: [{ id: 'continue', function: {
      name: 'continue_task', arguments: JSON.stringify({ remainingSteps: ['Inspect remaining requirements'] }),
    } }] } };
    assert.ok(tools.some(t => t.function.name === 'read_file'));
    if (round === 4) return { message: { role: 'assistant', tool_calls: [{ id: 'list-again', function: { name: 'list_artifacts', arguments: '{}' } }] } };
    return { message: { role: 'assistant', content: 'No further changes needed.' } };
  };
  const run = await f.run();
  assert.equal(round, 5); assert.equal(run.status, 'waiting_approval', run.error);
});

test('run_end hook observes waiting approval rather than a false completed status', async t => {
  let f;
  f = await fixture(t, [write(), () => {
    const w = f.service.store.get(f.id), p = w.approvals[0], run = w.runs.at(-1);
    f.service.store.update(f.id, current => { current.verifications = [{ id: 'v', runId: run.id,
      status: 'completed', exitCode: 0, outputComplete: true, environment: 'isolated-container',
      approvalIds: [p.id], inputs: [{ path: p.path, hash: hashText(p.content) }] }]; });
    return { message: { role: 'assistant', content: 'Please review.' } };
  }], { review: true });
  const ends = [], original = f.service.extensions.runHooks.bind(f.service.extensions);
  f.service.extensions.runHooks = (...args) => { if (args[1] === 'run_end') ends.push(args[2].status); return original(...args); };
  assert.equal((await f.run()).status, 'waiting_approval');
  assert.deepEqual(ends, ['waiting_approval']);
});
