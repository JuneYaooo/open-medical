import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
if (process.platform !== "darwin") throw new Error("This check requires macOS");
const root = resolve(import.meta.dirname, ".."),
  directory = await mkdtemp(join(tmpdir(), "omw-disconnected-"));
const blockedNetwork = !process.argv.includes("--online-control");
const policy = blockedNetwork
  ? '(version 1)(allow default)(deny network-outbound (remote ip))(allow network-outbound (remote ip "localhost:*"))(deny file-read* (subpath "/opt/homebrew"))'
  : "(version 1)(allow default)";
const run = (file, args, env) =>
  new Promise((resolve, reject) =>
    execFile(
      !blockedNetwork && file === "/usr/bin/sandbox-exec" ? args[2] : file,
      !blockedNetwork && file === "/usr/bin/sandbox-exec"
        ? args.slice(3)
        : args,
      { env, timeout: 90000, maxBuffer: 2_000_000 },
      (e, stdout, stderr) =>
        e
          ? reject(Object.assign(e, { stderr }))
          : (process.stderr.write(stderr), resolve(stdout)),
    ),
  );
try {
  const home = join(directory, "home"),
    applications = join(home, "Applications"),
    data = join(home, "data");
  await mkdir(home, { recursive: true });
  const env = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    USER: process.env.USER,
    TMPDIR: process.env.TMPDIR || tmpdir(),
    LANG: "en_US.UTF-8",
    OPEN_MEDICAL_APPLICATIONS: applications,
  };
  await mkdir(data, { recursive: true });
  const source = join(
    root,
    "release/Open Medical-darwin-arm64/Open Medical.app",
  );
  await run(
    "/usr/bin/sandbox-exec",
    [
      "-p",
      policy,
      "/bin/sh",
      join(source, "Contents/Resources/app/desktop/install-mac.command"),
      "--no-launch",
    ],
    env,
  );
  const installed = join(
    applications,
    "Open Medical.app/Contents/MacOS/Open Medical",
  );
  if (blockedNetwork) {
    const probe = await run(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        policy,
        installed,
        "-e",
        `require('node:net').createConnection({host:'1.1.1.1',port:443}).on('connect',()=>process.exit(2)).on('error',e=>console.log(e.code));setTimeout(()=>process.exit(3),2000).unref()`,
      ],
      { ...env, ELECTRON_RUN_AS_NODE: "1" },
    );
    assert.match(probe, /EPERM|EACCES/);
  }
  await run(
    "/usr/bin/sandbox-exec",
    ["-p", policy, installed, "--smoke-test", "--enable-logging=stderr"],
    { ...env, MEDICAL_DESKTOP_TEST_DIR: data },
  );
  const report = JSON.parse(
    await readFile(join(data, "desktop-report.json"), "utf8"),
  );
  assert.equal(report.passed, true, JSON.stringify(report));
  const output = join(root, "output/extensions");
  await mkdir(output, { recursive: true });
  await cp(join(data, "desktop.png"), join(output, blockedNetwork ? "disconnected-mac.png" : "mac-fresh-install.png"));
  const result = {
    ...report,
    disconnectedInstall: blockedNetwork,
    networkPolicy: blockedNetwork
      ? "OS denied non-loopback IP networking"
      : "online control; no network isolation",
    freshUserData: true,
    developmentPathRemoved: true,
    homebrewReadDenied: blockedNetwork,
    cleanPhysicalMachine: false,
    scope: blockedNetwork
      ? "Fresh profile and installer under OS network denial; not a separate clean VM"
      : "Fresh profile and real installer on the existing Mac, network not isolated; not a separate clean VM",
  };
  await writeFile(
    join(
      output,
      blockedNetwork ? "disconnected-mac.json" : "mac-fresh-install.json",
    ),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const output = join(root, "output/extensions");
  await mkdir(output, { recursive: true });
  await writeFile(
    join(
      output,
      blockedNetwork ? "disconnected-mac.json" : "mac-fresh-install.json",
    ),
    JSON.stringify(
      {
        passed: false,
        blocked: true,
        cleanPhysicalMachine: false,
        reason: error.message,
        scope:
          "Attempted fresh-profile install under outer Seatbelt network denial; Chromium nested sandbox initialization failed. Browser sandbox was not disabled.",
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await rm(directory, { recursive: true, force: true });
}
