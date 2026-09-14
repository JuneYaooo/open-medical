// Refresh an existing Electron bundle without duplicating its large framework on a low-space disk.
import { cp, access, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
const root = resolve(import.meta.dirname, "..");
const app = join(
  root,
  `release/Open Medical-darwin-${process.arch}/Open Medical.app`,
);
const target = join(app, "Contents/Resources/app");
await access(join(app, "Contents/MacOS/Open Medical"));
const pkg = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
if (pkg.name !== "open-medical-desktop")
  throw new Error("Target is not a generated project desktop bundle");
for (const entry of ["dist", "desktop", "shared", "skills", "examples"])
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
if (process.platform === "darwin")
  execFileSync("codesign", ["--force", "--sign", "-", app], {
    stdio: "inherit",
  });
console.log("Updated desktop runtime: " + app);
