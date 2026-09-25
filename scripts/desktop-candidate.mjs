import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, realpath, readlink, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, join, dirname, sep, isAbsolute } from 'node:path';

export const manifestName = 'candidate-manifest.json';
export const sourceManifestName = 'candidate-source.json';
export const sourceEntries = ['src', 'dist', 'desktop', 'server', 'shared', 'skills', 'integrations', 'examples', 'scripts', 'package.json', 'package-lock.json', 'vite.config.mjs', '.env.example', 'build/icons'];
const inside = (root, path) => { const r = relative(root, path); return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r)); };
const normalize = (path) => path.split(sep).join('/');
export function prohibited(path) {
  const parts = path.split(/[\\/]/);
  return parts.some((part) => /^\.env(?:\.|$)/i.test(part) && path !== '.env.example'
    || /^(?:model\.env|\.git|\.ssh|\.aws|\.codex|\.gnupg|\.npmrc|\.netrc|\.git-credentials)$/i.test(part)
    || /\.(?:sqlite(?:3)?|db)(?:-(?:wal|shm))?$/i.test(part)
    || /^(?:__pycache__)$/i.test(part) || /\.pyc$/i.test(part)
    || /\.(?:pem|key)$/i.test(part));
}
export function argument(args, name) {
  const prefix = `--${name}=`;
  const exact = args.indexOf(`--${name}`);
  const value = args.find((item) => item.startsWith(prefix));
  if (value !== undefined) return value.slice(prefix.length);
  if (exact >= 0) {
    if (!args[exact + 1] || args[exact + 1].startsWith('--')) throw new Error(`Missing --${name} value`);
    return args[exact + 1];
  }
}
export async function reserveCandidateOutput(root, value) {
  const output = resolve(root, 'output');
  const destination = resolve(root, value);
  if (destination === output || !inside(output, destination)) throw new Error('Candidate output must be a new directory beneath repository output/');
  // Validate every existing component before creating anything: never traverse a
  // user-supplied symlink into release/, Applications, or another installation.
  let cursor = root;
  for (const part of relative(root, destination).split(sep)) {
    cursor = join(cursor, part);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Candidate output contains a symlink or non-directory');
      if (cursor === destination) throw new Error('Candidate output already exists; choose a new directory');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(destination); // Atomic reservation: never overwrite an existing candidate.
  return destination;
}
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function fingerprint(files) { return createHash('sha256').update(JSON.stringify(files)).digest('hex'); }
export async function inventory(root, { source = false, entries, exclude = [] } = {}) {
  root = await realpath(root);
  const files = [];
  const visit = async (path) => {
    const name = normalize(relative(root, path));
    if (exclude.includes(name)) return;
    if (source && (name === 'server/data' || name.startsWith('server/data/'))) return;
    const relativeApp = name.includes('/Resources/app/') ? name.split('/Resources/app/')[1] : name.includes('/resources/app/') ? name.split('/resources/app/')[1] : name;
    if (prohibited(relativeApp)) {
      if (source) return; // Do not open secrets merely to calculate source hashes.
      throw new Error(`Prohibited packaged path: ${name}`);
    }
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      const target = await readlink(path);
      if (!inside(root, await realpath(path))) throw new Error(`Symlink escapes candidate: ${name}`);
      if (isAbsolute(target)) throw new Error(`Nonportable absolute symlink: ${name}`);
      files.push({ path: name, type: 'symlink', target });
    } else if (stat.isDirectory()) {
      for (const child of (await readdir(path)).sort()) await visit(join(path, child));
    } else if (stat.isFile()) files.push({ path: name, type: 'file', bytes: stat.size, mode: stat.mode & 0o777, sha256: await sha256(path) });
    else throw new Error(`Unsupported candidate entry: ${name}`);
  };
  if (entries) {
    for (const entry of [...entries].sort()) {
      try { await lstat(join(root, entry)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      await visit(join(root, entry));
    }
  } else for (const entry of (await readdir(root)).sort()) await visit(join(root, entry));
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
export async function captureSource(root) {
  const files = await inventory(root, { source: true, entries: sourceEntries });
  return { algorithm: 'sha256', fingerprint: fingerprint(files), files };
}
export async function sealCandidate(directory, metadata) {
  const files = await inventory(directory, { exclude: [manifestName] });
  const manifest = { format: 1, createdAt: new Date().toISOString(), ...metadata, files, fingerprint: fingerprint(files) };
  await writeFile(join(directory, manifestName), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}
export async function verifyCandidate(directory, sourceRoot) {
  directory = await realpath(directory);
  const manifest = JSON.parse(await readFile(join(directory, manifestName), 'utf8'));
  if (manifest.format !== 1 || !Array.isArray(manifest.files) || !manifest.appPath || !inside(directory, resolve(directory, manifest.appPath))) throw new Error('Invalid candidate manifest');
  const files = await inventory(directory, { exclude: [manifestName] });
  if (fingerprint(files) !== manifest.fingerprint || fingerprint(manifest.files) !== manifest.fingerprint) throw new Error('Candidate integrity mismatch: missing, changed or unexpected files');
  const app = resolve(directory, manifest.appPath);
  const source = JSON.parse(await readFile(join(app, sourceManifestName), 'utf8'));
  if (!source?.files || fingerprint(source.files) !== source.fingerprint || source.fingerprint !== manifest.sourceFingerprint) throw new Error('Source manifest mismatch');
  const packaged = new Map((await inventory(app)).map((file) => [file.path, file]));
  for (const original of source.files) {
    if (!/^(?:dist|desktop|server|shared|skills|integrations|examples)\//.test(original.path)
      && !['.env.example', 'scripts/workspace-cli.mjs', 'scripts/agent-daemon.mjs', 'scripts/daemon-supervisor.mjs'].includes(original.path)) continue;
    const included = packaged.get(original.path);
    if (!included || included.type !== original.type || included.sha256 !== original.sha256 || included.target !== original.target)
      throw new Error(`Packaged source differs from manifest: ${original.path}`);
  }
  if (sourceRoot && (await captureSource(sourceRoot)).fingerprint !== source.fingerprint) throw new Error('Candidate source differs from current workspace');
  return { passed: true, candidate: directory, appPath: app, platform: manifest.platform, arch: manifest.arch,
    binary: manifest.binary, fingerprint: manifest.fingerprint, sourceFingerprint: source.fingerprint,
    sourceCompared: Boolean(sourceRoot), files: files.length, signing: manifest.signing };
}
