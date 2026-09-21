// One diagnostic of the original continuity task. No approvals, retries, or
// changes to the historical six-task acceptance assertions/results.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { WorkspaceDatabase, WorkspaceService, createProvider } from "../server/core/index.mjs";
import { sourceFingerprint } from "./source-fingerprint.mjs";

if (existsSync(".env")) process.loadEnvFile(".env");
const directory = resolve(process.argv[2] || `output/beta-boundary-live-${Date.now()}`);
if (existsSync(directory)) throw new Error("Diagnostic destination must be new");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const root = join(directory, "continuity"); mkdirSync(root);
const original = readFileSync(new URL("./evaluate-agent.mjs", import.meta.url), "utf8");
const branch = original.slice(original.indexOf('} else if (name === "continuity") {'), original.indexOf('} else {\n      writeFileSync(join(root, "README.md")'));
const prompt = JSON.parse(branch.match(/prompt = ("[^\n]+?");/)[1]);
const steering = JSON.parse(original.match(/message: ("追加要求：[^\n]+?")/)[1]);
for (let i = 1; i <= 16; i++) writeFileSync(join(root, `record-${i}.txt`),
  `Record ${i}. Units=${i}.\n` + "Background: synthetic warehouse record for continuity acceptance. ".repeat(28));
const provider = createProvider();
const report = { startedAt: new Date().toISOString(), sourceFingerprint: sourceFingerprint(),
  taskTimeoutMs: 240000, retries: 0, syntheticDataOnly: true, approvalsApplied: 0,
  originalPromptUnchanged: true, originalSixTaskAcceptanceReplaced: false, status: "running" };
const save = () => writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2));
save();
let db, service;
try {
  db = new WorkspaceDatabase(join(directory, "evaluation.sqlite")); service = new WorkspaceService(db.db, provider);
  let w = service.create({ root, directoryConsent: true });
  w = service.update(w.id, { revision: w.revision, profile: "standard", allowWrite: true });
  await service.extensions.operation(w.id, { action: "configure", revision: w.revision, consent: true,
    terminal: true, image: "open-medical-runtime:0.8-full", origins: [], browser: false, plugins: false, mcp: false,
    memoryRead: false, memoryWrite: false, memory: { provider: "lsa" } });
  const handle = service.prepare(w.id, { revision: service.get(w.id).revision, message: prompt, externalConsent: true,
    resumeOnRestart: true, limits: { maxRounds: 48, timeoutMs: 240000, maxContextChars: 16000 } });
  let interrupted = false;
  await service.execute(handle, (event) => {
    if (!interrupted && event.type === "tool.complete") {
      interrupted = true;
      service.steer(w.id, { runId: handle.run.id, externalConsent: true, message: steering });
      service.interrupt(w.id);
    }
  });
  await service.extensions.close(); db.close();
  db = new WorkspaceDatabase(join(directory, "evaluation.sqlite")); service = new WorkspaceService(db.db, provider);
  service.recovery.tick(); await service.recovery.drain();
  const current = service.store.get(w.id), run = current.runs.at(-1);
  const traces = db.db.prepare("SELECT data FROM agent_trace ORDER BY id").all().map((r) => JSON.parse(r.data));
  const reads = traces.filter((r) => r.type === "tool.result" && r.call?.function?.name === "read_file" && typeof r.output?.text === "string");
  const summaries = traces.filter((r) => r.type === "model.response" && r.phase === "compaction");
  const proposals = current.approvals.filter((a) => a.runId === run.id && a.status === "pending");
  const proposal = proposals.find((a) => a.path === "summary.md"), text = proposal?.content || "";
  const sources = Array.from({ length: 16 }, (_, n) => `record-${n + 1}.txt`);
  const checks = {
    recoveredOriginalRun: interrupted && run.id === handle.run.id && run.recoveryAttempts === 1,
    allSourceBodiesRead: sources.every((path) => reads.some((r) => JSON.parse(r.call.function.arguments).path === path && r.output.text === readFileSync(join(root, path), "utf8"))),
    steeringAndTotal: text.includes("CONTINUITY_ACCEPTED") && text.includes("136"),
    allSourceReferences: sources.every((path) => text.includes(path)),
    automaticCompaction: summaries.length > 0,
    noHostWrite: !existsSync(join(root, "summary.md")) && current.approvals.every((a) => a.status !== "applied"),
    verifiedWaitingBoundary: run.status === "waiting_approval" && run.runtimeState?.phase === "waiting_approval" && Boolean(run.approvalReadiness),
  };
  Object.assign(report, { status: Object.values(checks).every(Boolean) ? "passed" : "failed", checks,
    runId: run.id, workspaceId: w.id, runStatus: run.status, error: run.error, activeMs: run.activeMs,
    rounds: run.roundsUsed, sourceReads: reads.length, compactionCalls: summaries.length,
    compactionMs: summaries.reduce((n, r) => n + r.durationMs, 0),
    batchLimitErrors: traces.filter((r) => r.type === "tool.result" && r.output?.code === "TOOL_BATCH_LIMIT").length,
    pendingProposalIds: proposals.map((p) => p.id) });
} catch (error) { report.status = "failed"; report.error = error.code || error.message; }
finally {
  await service?.extensions.close(); db?.close();
  report.frozenSource = report.sourceFingerprint === sourceFingerprint();
  report.endedAt = new Date().toISOString(); save();
}
console.log(JSON.stringify(report));
if (report.status !== "passed") process.exitCode = 1;
