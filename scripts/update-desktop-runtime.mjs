import { signingConfiguration, signMacApp, verifyUpdateIdentity } from './macos-signing.mjs';
// Refresh an existing Electron bundle without duplicating its large framework on a low-space disk.
import { cp, access, readFile, writeFile, mkdir, mkdtemp, rm, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

const signing = process.platform === 'darwin' ? signingConfiguration({allowAdhoc:process.argv.includes('--allow-adhoc')}) : null;
const root = resolve(import.meta.dirname, "..");
const app = join(
  root,
  `release/Open Medical-darwin-${process.arch}/Open Medical.app`,
);
const existingTarget = join(app, 'Contents/Resources/app');
await access(join(app, "Contents/MacOS/Open Medical"));
const pkg = JSON.parse(await readFile(join(existingTarget, "package.json"), "utf8"));
if (pkg.name !== "open-medical-desktop")
  throw new Error("Target is not a generated project desktop bundle");
const staging = await mkdtemp(join(dirname(app), '.runtime-update-'));
const stagedApp = join(staging, 'Open Medical.app');
const previous = join(staging,'previous.app');
let committed=false;
try {
await cp(app,stagedApp,{recursive:true});
const target = join(stagedApp,'Contents/Resources/app');
for (const entry of ["dist", "desktop", "shared", "skills", "integrations", "examples"])
  await cp(join(root, entry), join(target, entry), { recursive: true });
await cp(join(root, "server"), join(target, "server"), {
  recursive: true,
  filter: (source) => !source.startsWith(join(root, "server/data")),
});
await mkdir(join(target, "scripts"), { recursive: true });
for (const script of [
  "workspace-cli.mjs",
  "agent-daemon.mjs",
  "daemon-supervisor.mjs",
  "remote-coordinator.mjs",
  "remote-worker.mjs",
])
  await cp(join(root, "scripts", script), join(target, "scripts", script));
pkg.version = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
).version;
await writeFile(join(target, "package.json"), JSON.stringify(pkg, null, 2));
if (signing) { signMacApp(stagedApp,signing); verifyUpdateIdentity(app,stagedApp); }
await rename(app,previous);
try { await rename(stagedApp,app); committed=true; } catch(error) { await rename(previous,app); throw error; }
console.log("Updated desktop runtime: " + app);

} finally {
  // Keep the original if both the commit and rollback fail (for example, I/O failure).
  if(committed || !existsSync(previous)) await rm(staging,{recursive:true,force:true});
  else console.error('更新未提交，原安装包保留于：'+previous);
}
