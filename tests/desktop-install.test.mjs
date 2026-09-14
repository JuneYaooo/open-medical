import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

test("Mac installer stages replacements, rejects incomplete packages, and survives being run from installed app", (t) => {
  if (process.platform !== "darwin") return t.skip("macOS shell installer");
  const dir = mkdtempSync(join(tmpdir(), "medical-installer-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "source", "Open Medical.app"),
    applications = join(dir, "Applications");
  const script = join(
    source,
    "Contents/Resources/app/desktop/install-mac.command",
  );
  mkdirSync(join(source, "Contents/Resources/app/desktop"), {
    recursive: true,
  });
  mkdirSync(join(source, "Contents/Resources/app/dist"), { recursive: true });
  mkdirSync(join(source, "Contents/MacOS"), { recursive: true });
  cpSync(resolve("desktop/install-mac.command"), script);
  const exec = (file) =>
    spawnSync("/bin/sh", [file, "--no-launch"], {
      env: { ...process.env, OPEN_MEDICAL_APPLICATIONS: applications },
      encoding: "utf8",
    });
  assert.notEqual(exec(script).status, 0);
  const installed = join(applications, "Open Medical.app");
  assert.equal(existsSync(installed), false);
  writeFileSync(
    join(source, "Contents/MacOS/Open Medical"),
    "synthetic executable",
  );
  writeFileSync(
    join(source, "Contents/Resources/app/dist/index.html"),
    "version1",
  );
  assert.equal(exec(script).status, 0);
  writeFileSync(
    join(source, "Contents/Resources/app/dist/index.html"),
    "version2",
  );
  assert.equal(exec(script).status, 0);
  const installedScript = join(
    installed,
    "Contents/Resources/app/desktop/install-mac.command",
  );
  assert.equal(exec(installedScript).status, 0);
  assert.equal(
    readFileSync(
      join(installed, "Contents/Resources/app/dist/index.html"),
      "utf8",
    ),
    "version2",
  );
});

test("offline resource verification scans nested app resources and distinguishes structure from offline execution", async (t) => {
  const { verifyOfflinePackage } =
    await import("../scripts/verify-offline-package.mjs");
  const dir = mkdtempSync(join(tmpdir(), "offline-resource-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = join(dir, "resources/app");
  for (const path of [
    "dist/index.html",
    "desktop/main.cjs",
    "server/agent.mjs",
    "server/core/agent-runtime.mjs",
    "node_modules/ws/index.js",
  ]) {
    const full = join(app, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, "synthetic");
  }
  writeFileSync(join(dir, "Open Medical.exe"), "synthetic");
  writeFileSync(join(app, "package.json"), '{"version":"test"}');
  const result = await verifyOfflinePackage(dir, "win32");
  assert.equal(result.passed, true);
  assert.equal(result.disconnectedInstallationTested, false);
  mkdirSync(join(app, "server/data"));
  writeFileSync(join(app, "server/data/private.sqlite"), "SYNTHETIC");
  await assert.rejects(
    () => verifyOfflinePackage(dir, "win32"),
    /local state or secrets/,
  );
});
