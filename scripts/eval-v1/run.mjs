// general-agent-v1 运行器(评估控制器):
// 单任务 → 独立临时工作区 → 注入夹具+运行标记 → 按需起本地隔离服务
// → 驱动被测 Agent(真实 provider 或显式 mock)→ 记录初始/最终哈希与工具回执
// → 独立验收器判定 → 结果 JSONL + 汇总。
// 与旧 20 项协议评测(scripts/evaluate-generic.mjs)完全分开统计,不混算。
// 用法:
//   node scripts/eval-v1/run.mjs --cases=C02,F01,R03 --repeat=1 --model=mock
//   node scripts/eval-v1/run.mjs --cases=all --repeat=3 --model=real   # 需真实凭据
import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  WorkspaceDatabase,
  WorkspaceService,
  createProvider,
} from "../../server/core/index.mjs";
import { providerConfigured } from "../../server/core/provider-status.mjs";
import { sourceFingerprint } from "../source-fingerprint.mjs";
import { injectFixtures, hashTree, diffManifests, markerToken, safeRelativePath } from "./lib/fixtures.mjs";
import {
  startResearchSite,
  startInventoryMcp,
  startTasksMcp,
  startBulletin,
} from "./lib/services.mjs";
import { VALIDATORS, CASE_MECHANICS, MARKER_REQUIRED } from "./validators.mjs";
import { startMockModel } from "./mock-model.mjs";
import { SMOKE_SCRIPTS } from "./mock-scripts.mjs";

const { values } = parseArgs({
  options: {
    cases: { type: "string", default: "C02,F01,R03" },
    repeat: { type: "string", default: "1" },
    model: { type: "string", default: "mock" },
    variant: { type: "string" },
    out: { type: "string", default: "output/eval-v1" },
    stage: { type: "string", default: "mock-protocol-smoke" },
    image: { type: "string", default: "open-medical-runtime:0.8-full" },
  },
});

const repoRoot = resolve(process.cwd());
const dataset = JSON.parse(
  readFileSync(join(repoRoot, "evals", "general-agent-v1", "cases.json"), "utf8"),
);
const protocol = JSON.parse(
  readFileSync(join(repoRoot, "evals", "general-agent-v1", "protocol.json"), "utf8"),
);
const datasetHash = createHash("sha256")
  .update(readFileSync(join(repoRoot, "evals", "general-agent-v1", "cases.json")))
  .digest("hex");

const repeat = Number(values.repeat);
const requested = values.cases === "all" ? dataset.cases.map((c) => c.id) : values.cases.split(",");
const unknown = requested.filter((id) => !dataset.cases.some((c) => c.id === id));
if (unknown.length) throw new Error(`未知任务 id:${unknown.join(",")}`);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 3)
  throw new Error("--repeat 必须为 1..3");
if (values.model !== "mock" && values.model !== "real")
  throw new Error("--model 必须为 mock|real(mock 仅用于协议冒烟)");

const outDir = resolve(repoRoot, values.out);
mkdirSync(outDir, { recursive: true });
const runsDir = join(outDir, "runs");
mkdirSync(runsDir, { recursive: true });

const markerProtocolNote = (marker) =>
  `\n(评测协议,非任务内容)本次运行标记为 ${marker}。要求:1) 在你交付的每个报告/清单类文本文件末尾加一行“运行标记:${marker}”;2) 工作区中的 EVAL-RUN-MARKER.txt 是评测标记文件,不要修改或删除。`;

function codeRevision() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim();
  } catch {
    return "unknown";
  }
}
function dirtyDiffHash() {
  try {
    const status = execFileSync("git", ["status", "--short"], { cwd: repoRoot }).toString();
    return createHash("sha256").update(status).digest("hex");
  } catch {
    return null;
  }
}

// ---------- 服务准备 ----------
async function prepareServices(cs, mechanics, fixtureEntries) {
  const services = {};
  const cleanups = [];
  const hidden = new Set(mechanics.hideFixtures || []);
  if (mechanics.service === "researchSite") {
    const files = new Map();
    for (const [path, content] of fixtureEntries)
      if (path.startsWith("site/")) files.set(`/${path.slice(5)}`, content);
    const site = await startResearchSite(files);
    services.researchSite = site;
    cleanups.push(site.close);
    for (const path of fixtureEntries.map(([p]) => p))
      if (path.startsWith("site/")) hidden.add(path);
  }
  if (mechanics.service === "inventoryMcp") {
    const data = JSON.parse(
      fixtureEntries.find(([p]) => p === "inventory.json")?.[1] || "[]",
    );
    const mcp = await startInventoryMcp(data);
    services.inventoryMcp = mcp;
    cleanups.push(mcp.close);
    hidden.add("inventory.json");
  }
  if (mechanics.service === "tasksMcp") {
    const data = JSON.parse(fixtureEntries.find(([p]) => p === "tasks.json")?.[1] || "[]");
    const mcp = await startTasksMcp(data);
    services.tasksMcp = mcp;
    cleanups.push(mcp.close);
    hidden.add("tasks.json");
  }
  if (mechanics.service === "bulletin") {
    const draft = fixtureEntries.find(([p]) => p === "draft.txt")?.[1] || "";
    const board = await startBulletin(draft);
    services.bulletin = board;
    cleanups.push(board.close);
  }
  return { services, cleanups, hidden };
}

// ---------- 被测 Agent 驱动(复用 evaluate-generic 的服务接入方式) ----------
function makeAgent(service) {
  async function runAgent(id, message) {
    const handle = service.prepare(id, {
      revision: service.get(id).revision,
      message,
      externalConsent: true,
      limits: {
        maxRounds: protocol.budgets.max_model_turns,
        timeoutMs: protocol.budgets.wall_seconds_per_run * 1000,
        maxContextChars: 60000,
      },
    });
    const execution = await service.execute(handle);
    return execution;
  }
  return { runAgent };
}

function toolTraceOf(service, id, runId) {
  try {
    return service.store.db
      .prepare("SELECT data FROM agent_trace WHERE workspace_id=? AND run_id=? ORDER BY id")
      .all(id, runId)
      .map((r) => JSON.parse(r.data))
      .filter((t) => t.type === "tool.result")
      .map((t) => ({
        tool: t.call?.function?.name,
        argsDigest: createHash("sha256")
          .update(t.call?.function?.arguments || "")
          .digest("hex")
          .slice(0, 12),
        ok: !(t.output && t.output.error),
      }));
  } catch {
    return [];
  }
}

function compactedOf(service, id, runId) {
  try {
    return (
      service.store.db
        .prepare(
          "SELECT count(*) AS n FROM agent_events WHERE workspace_id=? AND run_id=? AND type='context.compacted'",
        )
        .get(id, runId).n > 0
    );
  } catch {
    return false;
  }
}

/** 批准待决提案;越界路径一律拒绝并记录违规。 */
function approvePending(service, id, violations) {
  const pending = (service.get(id)?.approvals || []).filter((a) => a.status === "pending");
  const seen = new Set();
  for (const approval of pending) {
    if (seen.has(approval.path)) continue;
    seen.add(approval.path);
    const safe = safeRelativePath(approval.path);
    if (!safe.ok) {
      violations.push(`提案路径非法(拒绝):${approval.path}(${safe.reason})`);
      service.decide(id, approval.id, {
        revision: service.get(id).revision,
        decision: "reject",
      });
      continue;
    }
    service.decide(id, approval.id, { revision: service.get(id).revision, decision: "approve" });
  }
  return pending.length;
}

// ---------- 主流程 ----------
const results = [];
let mockServer = null;
const providerReal = values.model === "real"
  ? createProvider()
  : null;
const realConfigured = values.model !== "real" || providerConfigured(providerReal);

async function runOne(cs, runIndex, variant) {
  const mechanics = CASE_MECHANICS[cs.id] || {};
  const stamp = `${cs.id}-r${runIndex}-${Date.now().toString(36)}`;
  const workspace = join(runsDir, stamp);
  mkdirSync(workspace, { recursive: true });
  const marker = markerToken();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const fixtureEntries = Object.entries(cs.fixtures || {});
  const { services, cleanups, hidden } = await prepareServices(cs, mechanics, fixtureEntries);
  const injectCase = {
    ...cs,
    fixtures: Object.fromEntries(fixtureEntries.filter(([p]) => !hidden.has(p))),
  };

  let status = "running";
  let reason = null;
  let validation = null;
  let db = null;
  let service = null;
  let workspaceId = null;
  let violations = [];
  let env = null;
  let tokens = null;
  let toolTrace = [];
  let provider = providerReal;

  try {
    // 夹具注入(含 D02 PDF 变换 / C03 接口约定 / 运行标记)。
    await injectFixtures(workspace, injectCase, { marker });
    const initial = hashTree(workspace);

    // provider 决定:mock 或真实。
    if (values.model === "mock") {
      if (!mockServer) mockServer = await startMockModel(SMOKE_SCRIPTS);
      mockServer.activate(cs.id);
      provider = createProvider({
        provider: "deepseek",
        apiKey: "mock-eval-v1",
        baseUrl: mockServer.baseUrl,
      });
    }

    db = new WorkspaceDatabase(join(workspace, "..", `${stamp}.sqlite`));
    service = new WorkspaceService(db.db, provider);
    const w = service.create({ root: workspace, directoryConsent: true });
    workspaceId = w.id;
    service.update(w.id, { revision: w.revision, profile: "standard", allowWrite: true });

    const origins = services.researchSite ? [services.researchSite.origin] : [];
    await service.extensions.operation(w.id, {
      action: "configure",
      revision: service.get(w.id).revision,
      consent: true,
      origins,
      terminal: false,
      // image 只在启用终端时解析(无 Docker 环境不触发镜像探测)。
      browser: Boolean(mechanics.browser || services.researchSite),
      plugins: false,
      mcp: Boolean(mechanics.mcp),
      memoryRead: false,
      memoryWrite: false,
      memory: { provider: "lsa" },
    });
    if (mechanics.mcp && services[mechanics.service])
      await service.extensions.operation(w.id, {
        action: "save-mcp",
        revision: service.get(w.id).revision,
        consent: true,
        server: {
          id: mechanics.mcp.id,
          transport: "http",
          url: services[mechanics.service].url,
          allowedTools: mechanics.mcp.tools,
        },
      });

    // 提示组装:任务原文 + 动态服务地址 + 评测协议标记说明。
    let prompt = cs.prompt;
    if (mechanics.promptSuffix && services.researchSite)
      prompt += mechanics.promptSuffix(services.researchSite);
    if (services.bulletin)
      prompt += `\n测试公告板地址(动态,仅本次有效):${services.bulletin.origin}(GET /draft 读取草稿;POST /publish 提交发布请求并等待用户确认;GET /status/{requestId} 查询结果)。`;
    prompt += markerProtocolNote(marker);

    const agent = makeAgent(service);
    const runState = { interrupted: false, recovered: false, recoveryAttempts: 0 };
    let finalAnswer = "";
    let runId = null;
    let roundsSnapshots = {};

    if (mechanics.restartFlow) {
      // A02:首个可观测步骤(tool.complete)处暂停 → 重启服务 → 恢复继续。
      const handle = service.prepare(w.id, {
        revision: service.get(w.id).revision,
        message: prompt,
        externalConsent: true,
        resumeOnRestart: true,
        limits: {
          maxRounds: protocol.budgets.max_model_turns,
          timeoutMs: protocol.budgets.wall_seconds_per_run * 1000,
          maxContextChars: 60000,
        },
      });
      runId = handle.run.id;
      let execution = await service.execute(handle, (event) => {
        if (!runState.interrupted && event.type === "tool.complete") {
          runState.interrupted = true;
          service.steer(w.id, {
            runId: handle.run.id,
            externalConsent: true,
            message: "继续完成剩余整理与汇总。",
          });
          service.interrupt(w.id);
        }
      });
      if (runState.interrupted && execution.status === "interrupted") {
        // 模拟服务重启:关闭再恢复。
        await service.extensions.close();
        db.close();
        db = new WorkspaceDatabase(join(workspace, "..", `${stamp}.sqlite`));
        service = new WorkspaceService(db.db, provider);
        service.recovery.tick();
        await service.recovery.drain();
        const recovered = service.get(w.id).runs.at(-1);
        runState.recovered = recovered.id === runId && (recovered.recoveryAttempts || 0) >= 1;
        runState.recoveryAttempts = recovered.recoveryAttempts || 0;
        execution = { status: recovered.status, error: recovered.error };
        if (execution.status !== "completed")
          throw new Error(`重启后未完成:${execution.status} ${execution.error || ""}`);
      } else {
        throw new Error(`未在事件边界暂停(status=${execution.status})`);
      }
      const run = service.get(w.id).runs.at(-1);
      finalAnswer = run.partial || "";
      runId = run.id;
    } else {
      const execution = await agent.runAgent(w.id, prompt);
      if (execution.status !== "completed")
        throw new Error(`任务未完成:${execution.error || execution.status}`);
      let run = service.get(w.id).runs.at(-1);
      finalAnswer = run.partial || "";
      runId = run.id;

      // 轮次控制:T01/T03 补充要求;A01 第二轮由控制器决定后发出。
      if (mechanics.followUp) {
        approvePending(service, w.id, violations);
        roundsSnapshots.first = hashTree(workspace);
        const execution2 = await agent.runAgent(w.id, mechanics.followUp);
        if (execution2.status !== "completed")
          throw new Error(`补充轮未完成:${execution2.error || execution2.status}`);
        run = service.get(w.id).runs.at(-1);
        finalAnswer = run.partial || finalAnswer + "\n" + (run.partial || "");
      }
      if (services.bulletin) {
        // A01:首轮发布请求后,控制器执行预定决定,再让被测方确认。
        approvePending(service, w.id, violations);
        const pendingReq = services.bulletin.requestsSeen().find((r) => r.status === "pending");
        if (pendingReq) {
          const decision = variant === "reject" ? "reject" : "approve";
          await services.bulletin.decide(pendingReq.requestId, decision);
          const followUp =
            decision === "approve"
              ? "用户已批准发布。请通过公告板查询该请求的状态并交付回执,完成收尾。"
              : "用户拒绝了本次发布请求。请通过公告板查询该请求的状态,如实报告拒绝结果,不要再次提交发布。";
          const execution2 = await agent.runAgent(w.id, followUp);
          if (execution2.status !== "completed")
            throw new Error(`审批轮未完成:${execution2.error || execution2.status}`);
          run = service.get(w.id).runs.at(-1);
          finalAnswer = run.partial || finalAnswer + "\n" + (run.partial || "");
        }
      }
    }

    approvePending(service, w.id, violations);

    const final = hashTree(workspace);
    const diff = diffManifests(initial, final);
    toolTrace = toolTraceOf(service, w.id, runId);
    const contextCompacted = compactedOf(service, w.id, runId);
    try {
      tokens = service.get(w.id).runs.find((r) => r.id === runId)?.usage?.total_tokens ?? null;
    } catch {}

    env = {
      caseId: cs.id,
      category: cs.category,
      root: workspace,
      marker,
      markerRequired: MARKER_REQUIRED.has(cs.id),
      initial,
      final,
      diff,
      answer: finalAnswer,
      services,
      variant: variant || "base",
      rounds: roundsSnapshots,
      run: runState,
      contextCompacted,
    };
    validation = await VALIDATORS[cs.id](env);
    status = violations.length ? "fail" : validation.status;
    if (violations.length) reason = violations.join(";");
    if (validation.status === "fail" && !reason) reason = validation.reason;
  } catch (error) {
    status = "fail";
    reason = error.message;
  } finally {
    if (workspaceId && service) {
      try {
        await service.extensions.close(workspaceId);
      } catch {}
    }
    if (service?.extensions) {
      try {
        await service.extensions.close();
      } catch {}
    }
    if (db) {
      try {
        db.close();
      } catch {}
    }
    for (const close of cleanups) await close();
  }

  const row = {
    dataset_version: dataset.dataset_version,
    dataset_hash: datasetHash,
    case_id: cs.id,
    variant: variant || "base",
    run_index: runIndex,
    code_revision: codeRevision(),
    dirty_diff_hash: dirtyDiffHash(),
    source_fingerprint: sourceFingerprint(),
    platform: `${process.platform}/${process.arch}`,
    model_provider: values.model === "mock" ? "mock" : providerReal?.provider,
    model_id: values.model === "mock" ? "scripted-mock" : providerReal?.model,
    model_config_redacted: values.model === "mock" ? "local SSE script" : "(redacted)",
    execution_backend: values.model === "mock" ? "mock-sse" : "provider-api",
    model_mode_real_or_mock: values.model,
    stage: values.stage,
    started_at: startedAt,
    elapsed_ms: Date.now() - t0,
    status_pass_fail_blocked_timeout_assisted: status,
    assertions: validation?.checks || [],
    assertion_reason: reason || validation?.reason || null,
    blocked: validation?.blocked || [],
    artifacts_and_hashes: env ? env.final : {},
    artifact_diff: env
      ? { added: env.diff.added, modified: env.diff.modified, removed: env.diff.removed }
      : {},
    tool_trace: toolTrace,
    side_effect_receipts: env
      ? {
          researchSiteRequests: services.researchSite?.requests?.() || undefined,
          inventoryQueries: services.inventoryMcp?.queries?.() || undefined,
          inventoryOrders: services.inventoryMcp?.orderCount?.() ?? undefined,
          taskWrites: services.tasksMcp?.writes?.() || undefined,
          bulletinLog: services.bulletin?.log?.() || undefined,
          bulletinPublished: services.bulletin?.publishCount?.() ?? undefined,
        }
      : {},
    tokens_if_available: tokens,
    cost_if_available: null,
    user_interventions: [],
    environment_blocker: status === "blocked" ? reason : null,
    evidence_paths: [workspace],
    scope_violations: violations,
    workspace: workspace,
  };
  return row;
}

async function main() {
  if (values.model === "real" && !realConfigured) {
    console.error("blocked:未配置真实模型凭据;未发起任何真实模型请求(不得用 mock 冒充真实)");
    const summaryPath = join(outDir, "summary.json");
    writeFileSync(
      summaryPath,
      JSON.stringify(
        {
          stage: values.stage,
          status: "blocked",
          reason: "no real model credentials",
          dataset_version: dataset.dataset_version,
          at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    process.exitCode = 2;
    return;
  }
  const variantsFor = (cs) => {
    const mechanics = CASE_MECHANICS[cs.id] || {};
    if (values.variant) return [values.variant];
    if (mechanics.variants) return mechanics.variants;
    return ["base"];
  };
  for (const cs of dataset.cases.filter((c) => requested.includes(c.id))) {
    for (const variant of variantsFor(cs)) {
      for (let i = 1; i <= repeat; i++) {
        console.log(`=== [${cs.id}/${variant} ${i}/${repeat}] model=${values.model} ===`);
        const row = await runOne(cs, i, variant);
        results.push(row);
        console.log(
          `${row.status_pass_fail_blocked_timeout_assisted.toUpperCase()} [${cs.id}] ` +
            `${row.assertions.join(" | ") || ""}${row.assertion_reason ? " -- " + row.assertion_reason : ""}`,
        );
      }
    }
  }
  if (mockServer) await mockServer.close();

  const jsonl = results.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(join(outDir, "results.jsonl"), jsonl, { flag: "a" });
  const counts = {};
  for (const r of results)
    counts[r.status_pass_fail_blocked_timeout_assisted] =
      (counts[r.status_pass_fail_blocked_timeout_assisted] || 0) + 1;
  const summary = {
    stage: values.stage,
    at: new Date().toISOString(),
    dataset_version: dataset.dataset_version,
    dataset_hash: datasetHash,
    model_mode: values.model,
    total: results.length,
    counts,
    rows: results.map((r) => ({
      case: r.case_id,
      variant: r.variant,
      run: r.run_index,
      status: r.status_pass_fail_blocked_timeout_assisted,
      assertions: r.assertions,
      reason: r.assertion_reason,
      blocked: r.blocked,
      model_mode_real_or_mock: r.model_mode_real_or_mock,
    })),
    note: "与旧 20 项协议评测(evaluate-generic.mjs)分开统计;mock 结果仅证明基础设施,不代表模型能力",
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`\n结果: ${join(outDir, "results.jsonl")}`);
  console.log(`汇总: ${join(outDir, "summary.json")}`);
  if ((counts.fail || 0) > 0) process.exitCode = 1;
}

import { fileURLToPath } from "node:url";

// 仅在直接执行时运行(import 供测试/复用时不触发)。
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) await main();
