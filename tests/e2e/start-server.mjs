// Start the production-shaped web server for Playwright.
//
// The wrapper exists for one reason: the E2E data directory must be wiped before
// the server opens SQLite. Playwright's webServer command has no separate
// "prepare" step, so the wrapper clears the directory and then launches the
// documented command as a child process, forwarding shutdown signals:
//
//   node --import ./tests/e2e/fake-time.mjs server/agent.mjs --dev-web
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { delimiter, dirname, join } from "node:path";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const dataDir = join(root, "test-results", "e2e-data");
const tempDir = join(dataDir, "tmp");

// The E2E build must include the fixture UI glob. Vite replaces the env check
// at build time, so a normal `npm run build` still excludes fixtures.
const build = process.env.npm_execpath
  ? spawnSync(process.execPath, [process.env.npm_execpath, "run", "build"], {
      cwd: root,
      env: { ...process.env, VITE_E2E_FIXTURES: "1" },
      stdio: "inherit",
    })
  : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
      cwd: root,
      env: { ...process.env, VITE_E2E_FIXTURES: "1" },
      stdio: "inherit",
    });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status || 1);

rmSync(dataDir, { recursive: true, force: true });
mkdirSync(tempDir, { recursive: true });

const env = {
  ...process.env,
  PORT: "18787",
  TZ: "Asia/Shanghai",
  MEDICAL_DATABASE: join(dataDir, "medical.sqlite"),
  TMPDIR: tempDir,
  MEDICAL_TEST_TMP: tempDir,
  MEDICAL_PRIVACY_SERVICE_URL: "off",
  // Only the hello fixture is enabled by default; the bad fixtures stay
  // excluded. Opt-in connected runs add the fake channel adapter so followup
  // activates without a real WeChat/WeCom account.
  MEDICAL_PLUGIN_DIRS: [
    join(root, "tests/fixtures/plugins/hello"),
    ...(process.env.MEDICAL_E2E_CONNECTED === "1"
      ? [join(root, "tests/fixtures/plugins/channel-fake")]
      : []),
  ].join(delimiter),
};

const child = spawn(
  process.execPath,
  [
    "--import",
    join(root, "tests/e2e/fake-time.mjs"),
    join(root, "server/agent.mjs"),
    "--dev-web",
  ],
  { cwd: root, env, stdio: "inherit" },
);

let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
  setTimeout(() => child.kill("SIGKILL"), 15000);
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
process.once("exit", () => {
  if (child.exitCode === null) child.kill("SIGKILL");
});

child.once("error", (error) => {
  console.error(`[e2e] failed to start server: ${error.stack || error}`);
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (signal) console.error(`[e2e] server stopped by ${signal}`);
  process.exit(stopping ? 0 : code ?? (signal ? 1 : 0));
});
