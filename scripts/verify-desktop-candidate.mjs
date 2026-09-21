import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { argument, verifyCandidate } from './desktop-candidate.mjs';

export async function smokeCandidate(report, { timeoutMs = 90000 } = {}) {
  if (report.platform !== process.platform || report.arch !== process.arch)
    throw new Error('Candidate platform/architecture does not match this host; smoke not run');
  const binary = resolve(report.candidate, report.binary);
  const rel = relative(report.candidate, binary);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('Invalid candidate executable path');
  const directory = await mkdtemp(join(tmpdir(), 'medical-candidate-smoke-'));
  try {
    // Deliberately small environment: no provider credentials, user settings or
    // development overrides are passed into the isolated test application.
    const env = Object.fromEntries(['PATH', 'SYSTEMROOT', 'WINDIR', 'LANG', 'DISPLAY', 'WAYLAND_DISPLAY']
      .filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
    Object.assign(env, { HOME: directory, USERPROFILE: directory, MEDICAL_DESKTOP_TEST_DIR: directory,
      XDG_CONFIG_HOME: join(directory, 'config'), XDG_DATA_HOME: join(directory, 'data'), TMPDIR: directory, TMP: directory, TEMP: directory });
    let stderr = '';
    await new Promise((done, reject) => {
      const child = spawn(binary, ['--smoke-test'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.on('data', (data) => { stderr = (stderr + data.toString()).slice(-8000); });
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        code === 0 ? done() : reject(new Error(`Candidate smoke exited ${code ?? signal}: ${stderr}`));
      });
    });
    const result = JSON.parse(await readFile(join(directory, 'desktop-report.json'), 'utf8'));
    if (!result.passed) throw new Error(result.error || 'Candidate smoke did not pass');
    return { ...result, isolated: true, realUserDataUsed: false };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const candidate = argument(args, 'candidate');
  if (!candidate) throw new Error('Usage: node scripts/verify-desktop-candidate.mjs --candidate PATH [--source-root PATH] [--smoke] [--report PATH]');
  const report = await verifyCandidate(resolve(candidate), argument(args, 'source-root'));
  if (args.includes('--smoke')) {
    report.smoke = await smokeCandidate(report);
    await verifyCandidate(resolve(candidate), argument(args, 'source-root'));
    report.integrityAfterSmoke = true;
  }
  const reportPath = argument(args, 'report');
  if (reportPath) {
    await mkdir(resolve(reportPath, '..'), { recursive: true });
    await writeFile(resolve(reportPath), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(JSON.stringify(report, null, 2));
}
