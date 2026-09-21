import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import tar from 'tar-stream';
import { hashText } from '../server/core/workspace-files.mjs';
import { WorkspaceDatabase, WorkspaceService } from '../server/core/index.mjs';
async function fixture(t, { exitCode = 0, afterMarkerDelay = 0 } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'terminal-half-close-')), root = join(base, 'project');
  mkdirSync(root);
  const db = new WorkspaceDatabase(join(base, 'state.sqlite'));
  const service = new WorkspaceService(db.db, { model: 'synthetic-unused' });
  const workspace = service.create({ root, directoryConsent: true });
  service.update(workspace.id, { revision: workspace.revision, profile: 'standard', allowWrite: true });
  service.store.update(workspace.id, (w) => { w.extensions = { ...w.extensions, image: 'sha256:' + 'a'.repeat(64) }; });
  const pack = tar.pack();
  const chunks = [];
  pack.on('data', (chunk) => chunks.push(chunk));
  const packed = new Promise((done) => pack.on('end', done));
  pack.entry({ name: 'receipt.txt' }, 'synthetic exported content'); pack.finalize(); await packed;
  const archive = Buffer.concat(chunks).toString('base64');
  const runner = service.extensions.runner;
  runner.docker = process.execPath;
  // Controlled Docker-attach lifecycle fixture, not an OS isolation test.
  // The command first needs interactive input, then emits a split final marker;
  // export/exit are deliberately gated on the client's stdin half-close.
  runner.args = (config) => ({ name: 'synthetic-attach', args: ['-e', `
    let received=false;process.stdin.setEncoding('utf8');
    process.stdin.on('data',value=>{if(received)return;received=true;
      process.stdout.write('accepted:'+value.trim()+'\\n'+${JSON.stringify(config.command.at(-1).slice(0, 9))});
      setTimeout(()=>process.stdout.write(${JSON.stringify(config.command.at(-1).slice(9))}),10);
    });
    process.stdin.on('end',()=>setTimeout(()=>{
      if(!received)process.exit(9);
      process.stdout.write(${JSON.stringify(archive.slice(0, 25))});
      setTimeout(()=>process.stdout.write(${JSON.stringify(archive.slice(25))},()=>process.exit(${exitCode})),20);
    },${afterMarkerDelay}));
  `] });
  t.after(async () => { await service.extensions.close(); db.close(); rmSync(base, { recursive: true, force: true }); });
  const start = (signal) => service.extensions.terminal.start(workspace.id, { command: 'synthetic-interactive', timeoutMs: 1000 }, { signal });
  return { service, runner, workspace, start };
}
test('terminal closes input only after split output marker and drains complete export before successful receipt', async (t) => {
  const f = await fixture(t);
  const started = await f.start();
  const session = f.runner.get(f.workspace.id, started.id);
  assert.equal(session.child.stdin.writableEnded, false);
  f.runner.write(f.workspace.id, started.id, 'continue\n');
  const result = await session.done;
  assert.equal(result.status, 'completed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, 'accepted:continue\n');
  assert.equal(session.child.stdin.writableEnded, true);
  assert.equal(result.result.applied.length + result.result.proposals.length, 1);
  const proposal = f.service.store.get(f.workspace.id).approvals.find((p) => p.path === 'receipt.txt');
  assert.equal(proposal.content, 'synthetic exported content');
  assert.equal(hashText(proposal.content), hashText('synthetic exported content'));
  assert.equal(f.service.store.get(f.workspace.id).verifications.at(-1).status, 'completed');
});
test('output marker never turns a failed process exit into successful artifacts', async (t) => {
  const f = await fixture(t, { exitCode: 7 });
  const started = await f.start();
  f.runner.write(f.workspace.id, started.id, 'continue\n');
  const result = await f.runner.get(f.workspace.id, started.id).done;
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 7);
  assert.deepEqual(result.result.proposals, []);
  assert.equal(f.service.store.get(f.workspace.id).verifications.at(-1).status, 'failed');
});
test('cancelling after output marker prevents artifact acceptance while export is still draining', async (t) => {
  const f = await fixture(t, { afterMarkerDelay: 500 });
  const controller = new AbortController();
  const started = await f.start(controller.signal);
  const session = f.runner.get(f.workspace.id, started.id);
  session.child.stdin.once('finish', () => controller.abort());
  f.runner.write(f.workspace.id, started.id, 'continue\n');
  const result = await session.done;
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.result.proposals, []);
  assert.equal(f.service.store.get(f.workspace.id).verifications.at(-1).status, 'cancelled');
});
