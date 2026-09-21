// Expanded real-model acceptance. Uses only the project's normal provider config,
// synthetic fixtures, and installed container image; never imports other app keys.
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { sourceFingerprint } from "./source-fingerprint.mjs";

const { values } = parseArgs({
  options: {
    directory: { type: "string" },
    case: { type: "string", default: "all" },
    image: { type: "string", default: "open-medical-runtime:0.8-full" },
  },
});
const allCases = ["continuity", "documents", "mcp"];
const cases = values.case === "all" ? allCases : [values.case];
if (cases.some((name) => !allCases.includes(name)))
  throw new Error("Unknown acceptance case");
const directory = resolve(
  values.directory || `output/beta-workflows-${Date.now()}`,
);
mkdirSync(directory, { recursive: false, mode: 0o700 });
const taskTimeoutMs = 240000,
  processTimeoutMs = 260000;
const report = {
  startedAt: new Date().toISOString(),
  sourceFingerprint: sourceFingerprint(),
  mode: "real project model; actual WorkspaceService, Docker, local HTTP MCP, SQLite restart",
  syntheticDataOnly: true,
  retries: 0,
  rounds: 2,
  taskTimeoutMs,
  processTimeoutMs,
  image: values.image,
  status: "running",
  records: [],
};
const save = () =>
  writeFileSync(
    join(directory, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
save();
for (let round = 1; round <= 2; round++)
  for (const name of cases) {
    const output = join(directory, `round-${round}-${name}`);
    const started = Date.now();
    const record = { round, name, status: "running", output, checks: [] };
    report.records.push(record);
    save();
    const log = openSync(
      join(directory, `round-${round}-${name}.log`),
      "wx",
      0o600,
    );
    const child = spawn(
      process.execPath,
      [
        "scripts/evaluate-agent.mjs",
        "--case",
        name,
        "--repeat",
        "1",
        "--timeout-ms",
        String(taskTimeoutMs),
        "--image",
        values.image,
        "--directory",
        output,
      ],
      { cwd: resolve(import.meta.dirname, ".."), stdio: ["ignore", log, log] },
    );
    let timedOut = false,
      killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    }, processTimeoutMs);
    const exitCode = await new Promise((resolve) => {
      child.once("error", () => resolve(-1));
      child.once("close", resolve);
    });
    clearTimeout(timer);
    clearTimeout(killTimer);
    closeSync(log);
    Object.assign(record, {
      exitCode,
      timedOut,
      elapsedMs: Date.now() - started,
    });
    try {
      const actual = JSON.parse(
        readFileSync(join(output, "report.json"), "utf8"),
      );
      record.provider = actual.provider;
      record.model = actual.model;
      record.checks = actual.results?.[0]?.checks || [];
      record.metrics = actual.results?.[0] || null;
      record.status =
        !timedOut &&
        exitCode === 0 &&
        actual.status === "passed" &&
        actual.results?.length === 1 &&
        actual.results[0].status === "passed"
          ? "passed"
          : actual.status === "blocked"
            ? "blocked"
            : "failed";
    } catch {
      record.status = "failed";
      record.reason = "Missing valid child acceptance report";
    }
    save();
    console.log(
      JSON.stringify({
        round,
        name,
        status: record.status,
        elapsedMs: record.elapsedMs,
      }),
    );
  }
report.finalSourceFingerprint = sourceFingerprint();
report.frozenSource =
  report.finalSourceFingerprint === report.sourceFingerprint;
report.counts = Object.fromEntries(
  ["passed", "failed", "blocked"].map((status) => [
    status,
    report.records.filter((r) => r.status === status).length,
  ]),
);
report.status =
  report.frozenSource && report.counts.passed === cases.length * 2
    ? "passed"
    : "failed";
report.endedAt = new Date().toISOString();
save();
if (report.status !== "passed") process.exitCode = 1;
console.log(
  JSON.stringify({
    report: join(directory, "report.json"),
    status: report.status,
    counts: report.counts,
    frozenSource: report.frozenSource,
  }),
);
