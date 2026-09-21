import { parseArgs } from "node:util";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { WorkspaceDatabase, WorkspaceService, createProvider } from "../server/core/index.mjs";
import { providerConfigured } from "../server/core/provider-status.mjs";
import { GitWorkspace } from "../server/core/git-workspace.mjs";
import { sourceFingerprint } from "./source-fingerprint.mjs";
import { claudeCodeProvider } from "./claude-code-provider.mjs";
import { startAcceptanceMcp } from "./acceptance-mcp.mjs";

const { values } = parseArgs({ options: {
  case: { type: "string", default: "all" }, repeat: { type: "string", default: "3" },
  image: { type: "string", default: "open-medical-runtime:0.8-full" }, directory: { type: "string" },
  "claude-code-provider": { type: "string" },
  "timeout-ms": { type: "string", default: "600000" },
} });
const caseNames = ["repair", "repair-auto", "documents", "team", "continuity", "mcp"];
const timeoutMs = Number(values["timeout-ms"]);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error("Invalid task timeout");
const repeats = Number(values.repeat), cases = values.case === "all" ? caseNames : [values.case];
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20 || cases.some((c) => !caseNames.includes(c)))
  throw new Error("Use --case=all|repair|repair-auto|documents|team|continuity|mcp --repeat=1..20");
if (existsSync(".env")) process.loadEnvFile(".env");
const provider = createProvider(values["claude-code-provider"] ? claudeCodeProvider(values["claude-code-provider"]) : undefined),
  directory = resolve(values.directory || `output/model-evaluation-${Date.now()}`);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const report = { startedAt: Date.now(), provider: provider.provider, model: provider.model,
  sourceFingerprint: sourceFingerprint(),
  platform: process.platform, arch: process.arch, syntheticDataOnly: true, modelType: "real-provider",
  timeoutMs, status: "running", results: [] };
const save = () => writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
if (!providerConfigured(provider)) {
  report.status = "blocked"; report.reason = "No configured model credentials; no real model requests were made";
  save(); console.error(report.reason); process.exitCode = 2;
} else {
  let db = new WorkspaceDatabase(join(directory, "evaluation.sqlite"));
  let service = new WorkspaceService(db.db, provider);
  const cleanups = [];
  async function tool(id, name, args) {
    let result = await service.tool(id, { tool: name, arguments: args });
    while (["running", "finalizing"].includes(result?.status))
      result = await service.tool(id, { tool: "terminal_wait", arguments: { id: result.id, timeoutMs: 30000 } });
    return result;
  }
  function require(value, message) { if (!value) throw new Error(message); }
  function apply(id, allowedPaths) {
    const pending = service.get(id).approvals.filter((a) => a.status === "pending");
    require(pending.length > 0, "No file proposal delivered");
    require(pending.every((a) => allowedPaths.includes(a.path)), "Model proposed changes outside acceptance scope");
    for (const approval of pending) service.decide(id, approval.id, { revision: service.get(id).revision, decision: "approve" });
  }
  async function runCase(name, attempt) {
    const repair = name.startsWith("repair"), automatic = name === "repair-auto";
    const root = join(directory, `${name}-${attempt}`); mkdirSync(root);
    let prompt, originalTests, mcp;
    if (repair) {
      mkdirSync(join(root, "src")); mkdirSync(join(root, "tests"));
      writeFileSync(join(root, "package.json"), '{"type":"module","scripts":{"test":"node --test"}}');
      writeFileSync(join(root, "README.md"), "A small statistics package. mean computes the arithmetic mean of finite numeric inputs, preserving zeros. Empty input returns null. Run npm test. Do not modify tests.\n");
      writeFileSync(join(root, "src/statistics.mjs"), "export function mean(values) { const numbers = values.filter(Boolean).filter(Number.isFinite); return numbers.length ? numbers.reduce((a,b)=>a+b,0)/numbers.length : null; }\n");
      originalTests = "import test from 'node:test'; import assert from 'node:assert/strict'; import {mean} from '../src/statistics.mjs';\n" +
        [["zero", [0, 2], 1], ["only zero", [0], 0], ["empty", [], null], ["ordinary", [2, 4], 3], ["negative", [-2, 0, 2], 0]]
          .map(([label, input, expected]) => `test(${JSON.stringify(label)},()=>assert.equal(mean(${JSON.stringify(input)}),${expected}));`).join("\n");
      writeFileSync(join(root, "tests/statistics.test.mjs"), originalTests);
      const git = new GitWorkspace(root);
      await git.command(["init", "-q"]); await git.command(["config", "user.name", "Acceptance Fixture"]);
      await git.command(["config", "user.email", "fixture@example.invalid"]);
      await git.command(["add", "."]); await git.command(["commit", "-qm", "fixture baseline"]);
      prompt = "请从这个陌生仓库定位并修复失败测试。先运行现有测试确认问题，再读取有关代码，提交最小源码修改提案，并在隔离容器中用提案重跑完整测试。不要更改测试或 package.json。交付修复解释和测试结果，文件提案由验收程序批准。";
      if (automatic) prompt = "请定位并修复陌生仓库的失败测试。先运行现有测试确认问题，再阅读相关文件，只修改源码，不要改测试或 package.json。当前工作区已授权自动应用文件修改和本地 Git 提交；实际修复后快照运行完整测试，通过后用 git_commit 提交源码，最后交付修复解释、测试结果和提交信息。";
    } else if (name === "documents") {
      writeFileSync(join(root, "sales.csv"), "item,quantity\nAlpha,4\nBeta,6\n");
      prompt = "读取 sales.csv，生成 report.pdf、report.xlsx 和 summary.md 三份成果。PDF 用英文列出 Alpha=4、Beta=6 及总数10；Excel 工作表 Summary 含 Item/Quantity 表头、Alpha 4、Beta 6、Total 10 四行，使用数值。Markdown 说明来源、明细和总数10。PDF/Excel 用 document_create 产生可下载成果，Markdown 产生文件提案。读取或检查生成结果，再交付。";
    } else if (name === "mcp") {
      mcp = await startAcceptanceMcp(); cleanups.push(mcp.close);
      prompt = "查询已授权 MCP 服务器 inventory 中 demo 仓库的库存，先发现其工具与参数。遇到临时查询失败时分析错误并重试。将返回的 batch、rows 原样保存为 inventory.json，并增加 total 为 quantity 合计。数据必须来自实际工具结果，不能编造。生成文件提案并说明来源和重试情况。";
    } else if (name === "continuity") {
      for (let i = 1; i <= 16; i++) writeFileSync(join(root, `record-${i}.txt`),
        `Record ${i}. Units=${i}.\n` + "Background: synthetic warehouse record for continuity acceptance. ".repeat(28));
      prompt = "读取 record-1.txt 到 record-16.txt 的全部内容，逐份读取并记住 Units 数值。生成 summary.md 列出16份文件各自的 Units 和合计136。请不要使用终端或脚本代替 read_file 阅读，不要仅根据文件名猜数值。按文件名引用来源，并核对总数。运行可能中断并续接；以工具真实结果和后续追加要求为准。";
    } else {
      writeFileSync(join(root, "README.md"), "Team acceptance fixture. Deliver NOTES.md containing TEAM_ACCEPTED and explain that approval is required for host writes.\n");
      prompt = "使用协作工具并行创建两个 reader，分别分析 README 的交付要求和权限约束。再创建依赖两个 reader 的 writer，只允许写 NOTES.md，完成 README 中的文档提案。最后创建依赖 writer 的 verifier，使用隔离终端和该提案验证 NOTES.md 包含 TEAM_ACCEPTED。收齐所有结果后交付，不要由父任务代替子代理写文件。";
    }
    const w = service.create({ root, directoryConsent: true });
    service.update(w.id, { revision: w.revision, profile: "standard", allowWrite: true,
      ...(automatic ? { approvalPolicy: "workspace-write", autoApplyConsent: true, allowGit: true, gitConsent: true } : {}) });
    await service.extensions.operation(w.id, { action: "configure", revision: service.get(w.id).revision,
      consent: true, origins: mcp ? [new URL(mcp.url).origin] : [], terminal: true, image: values.image, browser: false, plugins: false, mcp: Boolean(mcp),
      memoryRead: false, memoryWrite: false, memory: { provider: "lsa" } });
    if (mcp) await service.extensions.operation(w.id, { action: "save-mcp", revision: service.get(w.id).revision,
      consent: true, server: { id: "inventory", transport: "http", url: mcp.url, allowedTools: ["inventory"] } });
    const handle = service.prepare(w.id, { revision: service.get(w.id).revision, message: prompt,
      externalConsent: true, resumeOnRestart: name === "continuity",
      limits: { maxRounds: 48, timeoutMs, maxContextChars: name === "continuity" ? 16000 : 60000 } });
    let interrupted = false;
    let execution = await service.execute(handle, (event) => {
      if (name === "continuity" && !interrupted && event.type === "tool.complete") {
        interrupted = true;
        service.steer(w.id, { runId: handle.run.id, externalConsent: true,
          message: "追加要求：summary.md 必须包含精确标记 CONTINUITY_ACCEPTED，并保留原来的16份来源和合计。" });
        service.interrupt(w.id);
      }
    });
    if (name === "continuity") {
      require(interrupted && execution.status === "interrupted", "Run was not interrupted at a real tool boundary");
      await service.extensions.close(); db.close();
      db = new WorkspaceDatabase(join(directory, "evaluation.sqlite"));
      service = new WorkspaceService(db.db, provider);
      service.recovery.tick(); await service.recovery.drain();
      const recovered = service.get(w.id).runs.at(-1);
      require(recovered.id === handle.run.id && recovered.recoveryAttempts === 1, "Original run was not recovered");
      execution = { status: recovered.status, error: recovered.error };
    }
    const run = service.get(w.id).runs.at(-1);
    const metrics = { workspaceId: w.id, runId: run.id, tokens: run.usage.total_tokens,
      durationMs: run.activeMs, rounds: run.roundsUsed, toolFailures: service.store.events(w.id, 0, 1000).filter((e) => e.type === "tool.failed").length };
    Object.assign(report.results.at(-1), metrics);
    save();
    require(execution.status === "completed", `Agent did not complete: ${execution.error}`);
    if (repair) {
      const checks = service.store.get(w.id).verifications || [];
      require(checks.some((v) => v.exitCode !== 0), "Agent never reproduced failing tests");
      require(checks.some((v) => v.exitCode === 0 && (automatic || v.approvalIds.length)), "Agent did not validate its changes");
      require(service.get(w.id).approvals.every((a) => a.path === "src/statistics.mjs"), "Model changed files outside task scope");
      if (!automatic) apply(w.id, ["src/statistics.mjs"]);
      require(readFileSync(join(root, "tests/statistics.test.mjs"), "utf8") === originalTests, "Tests were modified");
      const result = await tool(w.id, "terminal_run", { command: "npm test", snapshot: true });
      require(result.exitCode === 0, "Approved code still fails unchanged tests");
      const git = new GitWorkspace(root), status = await git.status();
      if (automatic) {
        require(!status.entries.length, "Autonomous workflow left uncommitted changes");
        require(service.store.events(w.id, 0, 1000).some((e) => e.type === "git.commit.completed"), "Agent did not make a local commit");
      } else await service.commit(w.id, { revision: service.get(w.id).revision, consent: true,
        expectedHead: status.head, message: "Fix mean zero handling (acceptance fixture)",
        files: status.entries.filter((e) => e.path === "src/statistics.mjs").map(({ path, hash }) => ({ path, hash })) });
      metrics.checks = ["initial test failure", automatic ? "automatic write and test" : "proposal test pass", "unchanged tests", "final code pass", "local commit"];
    } else if (name === "documents") {
      apply(w.id, ["summary.md"]);
      require(/10/.test(readFileSync(join(root, "summary.md"), "utf8")), "Markdown lacks total");
      for (const extension of ["pdf", "xlsx"]) {
        const item = (service.store.get(w.id).artifacts || []).find((a) => basename(a.name) === "report." + extension);
        require(item, "Missing downloadable " + extension);
        const result = await tool(w.id, "document_read", { artifactId: item.id });
        require(result.exitCode === 0, "Generated document cannot be read");
        const parsed = JSON.parse(result.output.trim()).result;
        if (extension === "xlsx") require(JSON.stringify(parsed.sheets?.find((s) => s.name === "Summary")?.rows) ===
          JSON.stringify([["Item", "Quantity"], ["Alpha", 4], ["Beta", 6], ["Total", 10]]), "Workbook contents differ from source");
        else require(/Alpha/.test(JSON.stringify(parsed)) && /Beta/.test(JSON.stringify(parsed)) && /10/.test(JSON.stringify(parsed)), "PDF contents incomplete");
      }
      metrics.checks = ["PDF readback", "Excel exact cells", "Markdown total", "downloadable artifacts"];
    } else if (name === "mcp") {
      apply(w.id, ["inventory.json"]);
      const output = JSON.parse(readFileSync(join(root, "inventory.json"), "utf8"));
      require(mcp.calls() >= 2, "Model did not retry the temporary MCP failure");
      require(output.batch === mcp.batch && JSON.stringify(output.rows) === JSON.stringify(mcp.rows) && output.total === 46,
        "Saved MCP data differs from actual response");
      metrics.checks = ["real local HTTP MCP", "tool discovery", "temporary failure and retry", "unpredictable batch provenance", "exact structured data"];
    } else if (name === "continuity") {
      apply(w.id, ["summary.md"]);
      const summary = readFileSync(join(root, "summary.md"), "utf8");
      require(summary.includes("CONTINUITY_ACCEPTED") && summary.includes("136"), "Recovered output lost steering or total");
      for (let i = 1; i <= 16; i++) require(summary.includes(`record-${i}.txt`), "Recovered output lost source " + i);
      require(db.db.prepare("SELECT count(*) AS n FROM agent_events WHERE workspace_id=? AND run_id=? AND type=?")
        .get(w.id, run.id, "context.compacted").n > 0, "No automatic compaction occurred");
      metrics.checks = ["real tool interruption", "SQLite reopen", "same-run recovery", "queued steering", "automatic compaction", "16 source references", "verified total"];
    } else {
      require(run.children?.length >= 4 && run.children.every((c) => c.status === "completed"), "Team did not complete all tasks");
      require(run.children.filter((c) => c.role === "reader").length >= 2 && run.children.some((c) => c.role === "writer" && c.dependsOn.length >= 2), "Task dependencies missing");
      require((service.store.get(w.id).verifications || []).some((v) => v.exitCode === 0 && v.approvalIds.length), "Verifier did not test proposal");
      apply(w.id, ["NOTES.md"]);
      require(readFileSync(join(root, "NOTES.md"), "utf8").includes("TEAM_ACCEPTED"), "Child artifact missing acceptance marker");
      metrics.checks = ["reader team", "writer dependencies", "verifier test pass", "approved child output"];
    }
    await service.extensions.close(w.id);
    return metrics;
  }
  try {
    for (const name of cases) for (let attempt = 1; attempt <= repeats; attempt++) {
      console.log(`Evaluating ${name} ${attempt}/${repeats} with ${provider.model}`);
      const start = Date.now();
      const result = { case: name, attempt, status: "running" }; report.results.push(result); save();
      try { Object.assign(result, { status: "passed", ...(await runCase(name, attempt)) }); }
      catch (error) { Object.assign(result, { status: "failed", error: error.message, durationMs: Date.now() - start }); }
      save();
    }
    report.successRate = report.results.filter((r) => r.status === "passed").length / report.results.length;
    report.status = report.successRate === 1 ? "passed" : "failed";
    if (report.status !== "passed") process.exitCode = 1;
  } finally { await service.extensions.close(); for (const close of cleanups) await close(); db.close(); report.endedAt = Date.now(); save(); }
  console.log(`Report: ${join(directory, "report.json")}`);
}
