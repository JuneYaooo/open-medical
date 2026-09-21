import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argument, reserveCandidateOutput, captureSource, sourceManifestName, inventory, sealCandidate, verifyCandidate } from '../scripts/desktop-candidate.mjs';
import { smokeCandidate } from '../scripts/verify-desktop-candidate.mjs';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'candidate-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function candidate(t) {
  const root = await fixture(t), sourceRoot = join(root, 'source'), directory = join(root, 'candidate'), app = join(directory, 'resources/app');
  await mkdir(join(sourceRoot, 'server'), { recursive: true });
  await mkdir(join(app, 'server'), { recursive: true });
  await writeFile(join(sourceRoot, 'server/agent.mjs'), 'synthetic original');
  await writeFile(join(app, 'server/agent.mjs'), 'synthetic original');
  const source = await captureSource(sourceRoot);
  await writeFile(join(app, sourceManifestName), JSON.stringify(source));
  await writeFile(join(directory, 'Open Medical'), 'synthetic executable');
  const metadata = { platform: process.platform, arch: process.arch, appPath: 'resources/app', binary: 'Open Medical', sourceFingerprint: source.fingerprint, signing: 'none' };
  return { root, sourceRoot, directory, app, metadata };
}
test('candidate output accepts both argument forms, refuses overwrite and installation paths', async (t) => {
  const root = await fixture(t);
  assert.equal(argument(['--out', 'output/test=a'], 'out'), 'output/test=a');
  assert.equal(argument(['--out=output/test=a'], 'out'), 'output/test=a');
  assert.throws(() => argument(['--out', '--smoke'], 'out'), /Missing/);
  const out = await reserveCandidateOutput(root, 'output/candidate');
  assert.equal(out, join(root, 'output/candidate'));
  await assert.rejects(reserveCandidateOutput(root, 'output/candidate'), /already exists/);
  await assert.rejects(reserveCandidateOutput(root, 'release'), /beneath/);
  await assert.rejects(reserveCandidateOutput(root, '/Applications/Example.app'), /beneath/);
  await assert.rejects(reserveCandidateOutput(root, 'output'), /beneath/);
  await mkdir(join(root, 'release'));
  await symlink(join(root, 'release'), join(root, 'output/redirect'));
  await assert.rejects(reserveCandidateOutput(root, 'output/redirect/new'), /symlink/);
});
test('sealed candidate matches current source; modified, added and missing files fail integrity', async (t) => {
  const f = await candidate(t);
  await sealCandidate(f.directory, f.metadata);
  assert.equal((await verifyCandidate(f.directory, f.sourceRoot)).passed, true);
  await writeFile(join(f.app, 'unexpected.txt'), 'extra');
  await assert.rejects(verifyCandidate(f.directory), /integrity/);
  await rm(join(f.app, 'unexpected.txt'));
  await writeFile(join(f.app, 'server/agent.mjs'), 'tampered');
  await assert.rejects(verifyCandidate(f.directory), /integrity/);
  await rm(join(f.app, 'server/agent.mjs'));
  await assert.rejects(verifyCandidate(f.directory), /integrity/);
});
test('source fingerprint detects workspace drift and staged source mismatch even with a new seal', async (t) => {
  const f = await candidate(t);
  await writeFile(join(f.app, 'server/agent.mjs'), 'stale version');
  await sealCandidate(f.directory, f.metadata);
  await assert.rejects(verifyCandidate(f.directory, f.sourceRoot), /Packaged source differs/);
  const g = await candidate(t);
  await sealCandidate(g.directory, g.metadata);
  await writeFile(join(g.sourceRoot, 'server/added.mjs'), 'new source');
  await assert.rejects(verifyCandidate(g.directory, g.sourceRoot), /current workspace/);
});
test('inventory rejects synthetic credentials, databases and escaped symlinks without reading their targets', async (t) => {
  const root = await fixture(t);
  for (const name of ['.env', 'model.env', 'patients.sqlite', 'vault.db', 'key.pem']) {
    await writeFile(join(root, name), 'SYNTHETIC');
    await assert.rejects(inventory(root), /Prohibited/);
    await rm(join(root, name));
  }
  await writeFile(join(root, '.env.example'), 'EXAMPLE=');
  assert.equal((await inventory(root)).length, 1);
  const outside = await fixture(t);
  await writeFile(join(outside, 'safe.txt'), 'synthetic outside');
  await symlink(join(outside, 'safe.txt'), join(root, 'escape'));
  await assert.rejects(inventory(root), /escapes/);
});
test('smoke uses temporary HOME and test data only, and removes them afterward (synthetic launcher)', async (t) => {
  if (process.platform === 'win32') return t.skip('synthetic POSIX launcher');
  const root = await fixture(t), binary = join(root, 'fake-launcher');
  const marker = join(root, 'observed.json');
  await writeFile(binary, `#!${process.execPath}\nconst fs=require('node:fs'); const path=require('node:path');
fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({home:process.env.HOME,test:process.env.MEDICAL_DESKTOP_TEST_DIR,apiKey:process.env.SYNTHETIC_PRIVATE_KEY}));
fs.writeFileSync(path.join(process.env.MEDICAL_DESKTOP_TEST_DIR,'desktop-report.json'),JSON.stringify({passed:true}));\n`);
  await chmod(binary, 0o755);
  const result = await smokeCandidate({ candidate: root, binary: 'fake-launcher', platform: process.platform, arch: process.arch }, { timeoutMs: 2000 });
  assert.equal(result.realUserDataUsed, false);
  const observed = JSON.parse(await readFile(marker, 'utf8'));
  assert.equal(observed.home, observed.test);
  assert.notEqual(observed.home, process.env.HOME);
  await assert.rejects(readFile(join(observed.home, 'desktop-report.json')), { code: 'ENOENT' });
});
