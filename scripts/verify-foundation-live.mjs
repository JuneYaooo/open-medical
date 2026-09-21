// Six positive tasks, real configured provider + actual WorkspaceService and Docker.
// Fixed 240 s per task, two rounds, at most two workers, no task retries.
// Credentials are loaded only by the project's normal .env/createProvider path.
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { WorkspaceDatabase, WorkspaceService } from "../server/core/index.mjs";
import { createProvider } from "../server/core/providers.mjs";
import { PermissionEngine } from "../server/core/permissions.mjs";
import { SessionBridge } from "../server/session-bridge.mjs";

const project = fileURLToPath(new URL("..", import.meta.url));
const self = fileURLToPath(import.meta.url);
const diagnosticMode = process.argv.includes("--diagnostic");
const output = join(
  project,
  "output/codex-foundation-20260921",
  diagnosticMode ? "live-general-diagnostic-task20" : "live-general",
);
const image = "open-medical-runtime:0.8-full";
const timeoutMs = 240000;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const safeProvider = (provider) => ({
  provider: provider.provider,
  model: provider.model,
  origin: new URL(provider.baseUrl).origin,
  contextWindow: provider.contextWindow ?? null,
  maxTokens: provider.maxTokens,
  thinking: provider.thinking ?? null,
});
function configuredProvider() {
  const envFile = join(project, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  // Match the current project's model-e2e provider selection, without reading
  // other apps' configuration or writing any credential to the fixture.
  return createProvider({
    provider: process.env.AI_PROVIDER || "anthropic",
    apiKey: process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY || "",
    baseUrl: process.env.ANTHROPIC_BASE_URL || process.env.DEEPSEEK_BASE_URL,
    model: process.env.ANTHROPIC_MODEL || process.env.DEEPSEEK_MODEL,
  });
}
function sourceHash() {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:mjs|js|cjs|json)$/.test(entry.name)) files.push(path);
    }
  };
  walk(join(project, "server"));
  walk(join(project, "shared"));
  files.push(self);
  return hash(
    files
      .sort()
      .map((p) => `${p.slice(project.length)}:${hash(readFileSync(p))}`)
      .join("\n"),
  );
}
const initialEdit = "mode=legacy\nlimit=10\nkeep=unchanged\n";
const edited = "mode=legacy\nlimit=25\nkeep=unchanged\n";
const created = "Foundation live acceptance\ncount=42\n";
const broken =
  "export function total(values) { return values.reduce((sum, n) => sum - n, 0); }\n";
const verifyProgram = `node --input-type=module -e 'import {total} from "./sum.mjs"; if(total([19,23])!==42 || total([-3,8,0])!==5 || total([])!==0) process.exit(9); console.log("PROGRAM_VERIFIED")'`;
const taskSpecs = [
  {
    id: "01",
    name: "Ordinary answer",
    completion: { kind: "answer" },
    message:
      "这是纯问答。请只回答整数：19+23 等于多少？不要创建文件或调用工具。",
    expected: { answer: "42", files: 0 },
  },
  {
    id: "02",
    name: "Create exact file",
    completion: { files: [{ path: "report.txt", hash: hash(created) }] },
    message: `请创建 report.txt，其完整内容必须等于此 JSON 字符串解码后的内容：${JSON.stringify(created)}。保留末尾换行。使用 propose_file_write 实际写入，再 read_file 核对。`,
    expected: { path: "report.txt", hash: hash(created) },
  },
  {
    id: "03",
    name: "Precise edit",
    completion: { files: [{ path: "settings.txt", hash: hash(edited) }] },
    message:
      "读取 settings.txt，将 limit=10 精确改成 limit=25。保留其余行和末尾换行。实际应用修改并 read_file 核对；不要改 sentinel.txt。",
    expected: { path: "settings.txt", hash: hash(edited) },
  },
  {
    id: "06",
    name: "Code agent calculation",
    completion: { requireExecution: true },
    message:
      "必须调用 code_execute，在真实隔离 Node 环境用 JavaScript 循环计算整数 1 到 20 的和与平方和，并 return {sum, sumSquares}。不能只口算回答、不能硬编码结果。不需要创建文件。",
    expected: { sum: 210, sumSquares: 2870, tool: "code_execute" },
  },
  {
    id: "07",
    name: "Repair and verify program",
    completion: { files: [{ path: "sum.mjs" }], requireExecution: true },
    message: `sum.mjs 的 total(values) 应对任意数字数组求和，但存在已由独立夹具复现的错误。读取文件并修复，不要修改 sentinel.txt。修复后必须使用 terminal_run，snapshot:true，timeoutMs:30000，执行这一条行为验证命令：${verifyProgram}。确保退出码 0，然后结束；不要重新运行已确认失败的旧实现。`,
    expected: { programCases: 3, terminalExit: 0 },
  },
  {
    id: "20",
    name: "Search compute write reload",
    completion: {
      files: [{ path: "result.txt", hash: hash("total=34\n") }],
      requireExecution: true,
    },
    message:
      "请先调用 search_files 在本仓库搜索 BATCH_OMEGA，定位真实数据文件，再读取其 values 数组。必须用 code_execute 实际计算数组总和，然后创建 result.txt，内容格式严格为 total=<计算所得整数> 加一个换行。用 read_file 核对最终文件。不许修改数据文件或 sentinel.txt；不要仅用模型口算。",
    expected: {
      path: "result.txt",
      hash: hash("total=34\n"),
      reload: true,
      tools: ["search_files", "code_execute"],
    },
  },
];
const common =
  "\n这是已授权的合成工程验收，允许读取本临时工作区并将合成文本发给当前模型。已开启 workspace-write 自动应用提案，允许使用已安装的隔离容器；无需额外询问。只处理当前要求，不要联网、委派或修改其他文件。写入请使用文件提案工具；必须实际完成，不能只声称完成。";
function taskResultPath(round, id) {
  return join(output, `round-${round}-task-${id}.json`);
}
async function runTask(spec, round, frozen) {
  const startedAt = new Date().toISOString(),
    started = Date.now();
  const base = mkdtempSync(join(tmpdir(), "omw-live-foundation-"));
  const root = join(base, "project");
  mkdirSync(root);
  const result = {
    task: spec.id,
    round,
    name: spec.name,
    startedAt,
    timeoutMs,
    sourceHash: frozen,
    input: spec.message + common,
    expected: spec.expected,
    mode: "real-model + actual WorkspaceService + installed Docker image",
    checks: [],
  };
  const check = (name, condition) => {
    result.checks.push({ name, passed: Boolean(condition) });
  };
  let service, db, handle;
  let sanitize = (value, limit = 2000) =>
    typeof value === "string" ? value.slice(0, limit) : null;
  const controller = new AbortController();
  const watchdog = setTimeout(() => {
    result.timedOut = true;
    controller.abort();
    handle?.controller.abort();
  }, timeoutMs - 1000);
  try {
    if (sourceHash() !== frozen)
      throw Object.assign(new Error(), { code: "SOURCE_CHANGED" });
    const provider = configuredProvider();
    sanitize = (value, limit = 2000) => {
      if (typeof value !== "string") return null;
      return (
        provider.apiKey
          ? value.split(provider.apiKey).join("[REDACTED]")
          : value
      )
        .replace(/(?:Bearer|api[_-]?key)\s*[:= ]\s*[^\s,;]+/gi, "[REDACTED]")
        .slice(0, limit);
    };
    result.configuration = safeProvider(provider);
    if (!provider.apiKey && !provider.local)
      throw Object.assign(new Error(), { code: "MODEL_NOT_CONFIGURED" });
    db = new WorkspaceDatabase(join(base, "state/agent.sqlite"));
    service = new WorkspaceService(db.db, provider);
    if (diagnosticMode) {
      result.diagnosticOnly = true;
      result.sdkLifecycle = [];
      const runner = service.extensions.runner,
        start = runner.start.bind(runner);
      const record = (event, data = {}) => {
        if (result.sdkLifecycle.length < 100)
          result.sdkLifecycle.push({
            elapsedMs: Date.now() - started,
            event,
            ...data,
          });
      };
      runner.start = (owner, config, options = {}) => {
        if (!config.command?.includes("/program/bridge.mjs"))
          return start(owner, config, options);
        const receipt = start(owner, config, {
          ...options,
          stdoutTransform(chunk) {
            record("stdout-data", { text: sanitize(chunk.toString()) });
            return options.stdoutTransform
              ? options.stdoutTransform(chunk)
              : chunk;
          },
        });
        const session = runner.get(owner, receipt.id),
          child = session.child;
        record("started");
        child.stdout.on("end", () => record("stdout-end"));
        child.stderr.on("data", (chunk) =>
          record("stderr-data", { text: sanitize(chunk.toString()) }),
        );
        child.stdin.on("finish", () => record("stdin-finish"));
        child.stdin.on("error", (error) =>
          record("stdin-error", { code: error.code }),
        );
        child.on("exit", (code, signal) =>
          record("child-exit", { code, signal }),
        );
        child.on("close", (code, signal) =>
          record("child-close", { code, signal }),
        );
        options.signal?.addEventListener(
          "abort",
          () => record("signal-abort"),
          { once: true },
        );
        return receipt;
      };
    }
    let w = service.create({ root, directoryConsent: true });
    w = service.update(w.id, {
      revision: w.revision,
      profile: "standard",
      allowWrite: true,
      approvalPolicy: "workspace-write",
      autoApplyConsent: true,
    });
    await service.extensions.configure(w.id, {
      revision: w.revision,
      consent: true,
      image,
      terminal: true,
      terminalNetwork: false,
      browser: false,
      plugins: false,
      mcp: false,
      memoryRead: false,
      memoryWrite: false,
      origins: [],
    });
    result.image = {
      reference: image,
      digest: service.store.get(w.id).extensions.image,
    };
    const put = (path, text) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    if (["03", "07", "20"].includes(spec.id))
      put("sentinel.txt", "unchanged fixture\n");
    if (spec.id === "03") put("settings.txt", initialEdit);
    if (spec.id === "07") put("sum.mjs", broken);
    if (spec.id === "20") {
      for (let i = 0; i < 140; i++)
        put(
          `data/item-${String(i).padStart(3, "0")}.txt`,
          `OTHER_BATCH_${i}\n`,
        );
      put(
        "data/deep/a/b/c/d/e/values.txt",
        "BATCH_OMEGA values: [3,7,11,13]\n",
      );
    }
    const fixtureFiles = new Map();
    const collect = (directory, prefix = "") => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const rel = prefix + entry.name;
        if (entry.isDirectory())
          collect(join(directory, entry.name), rel + "/");
        else
          fixtureFiles.set(
            rel,
            hash(readFileSync(join(directory, entry.name))),
          );
      }
    };
    collect(root);
    const invokeTerminal = async (runId) => {
      const perms = new PermissionEngine(service.store.get(w.id).permissions);
      let receipt = await service
        .registry(w.id, runId)
        .execute(
          "terminal_run",
          { command: verifyProgram, snapshot: true, timeoutMs: 30000 },
          { signal: controller.signal },
          perms,
        );
      while (receipt.status === "running")
        receipt = await service.extensions.runner.wait(
          w.id,
          receipt.id,
          30000,
          controller.signal,
        );
      return receipt;
    };
    if (spec.id === "07") {
      const baseline = await invokeTerminal("independent-before");
      result.preRepair = {
        status: baseline.status,
        exitCode: baseline.exitCode,
      };
      check(
        "independent failing baseline",
        baseline.status === "failed" && baseline.exitCode === 9,
      );
    }
    handle = service.prepare(w.id, {
      revision: service.get(w.id).revision,
      message: spec.message + common,
      externalConsent: true,
      completion: spec.completion,
      limits: {
        maxRounds: 12,
        timeoutMs: timeoutMs - 15000,
      },
    });
    await service.execute(handle);
    const saved = service.store.get(w.id),
      run = saved.runs.at(-1);
    const events = service.store
      .events(w.id, 0, 1000)
      .filter((event) => event.run_id === run.id);
    const toolNames = events
      .filter((event) => event.type === "tool.start")
      .map((event) => event.payload.tool);
    result.observed = {
      status: run.status,
      runError: sanitize(
        typeof run.error === "string" ? run.error : run.error?.message,
      ),
      runErrorCode: typeof run.error === "object" ? run.error?.code : null,
      outcome: run.outcome,
      tools: toolNames,
      // Only code generated for these fixed synthetic acceptance inputs; never
      // dump provider requests, authorization headers, or other applications.
      syntheticCode: (run.contextMessages || [])
        .flatMap((m) => m.tool_calls || [])
        .filter((call) => call.function.name === "code_execute")
        .map((call) => {
          try {
            return sanitize(JSON.parse(call.function.arguments).code, 30000);
          } catch {
            return null;
          }
        }),
      toolErrors: (run.contextMessages || [])
        .filter((m) => m.role === "tool")
        .flatMap((m) => {
          try {
            const r = JSON.parse(m.content);
            return r?.error
              ? [{ code: r.code || null, message: sanitize(r.error) }]
              : [];
          } catch {
            return [];
          }
        }),
      failedTools: events
        .filter((event) => event.type === "tool.failed")
        .map((event) => event.payload.tool),
      unresolvedFailures: Object.entries(run.toolFailures || {}).map(
        ([tool, failure]) => ({
          tool,
          affectsDelivery: failure.affectsDelivery !== false,
        }),
      ),
      warnings: (run.delivery?.warnings || []).map(({ reason, tool }) => ({
        reason,
        tool,
      })),
      gaps: (run.delivery?.gaps || []).map((g) => g.reason),
      evidence: (run.delivery?.evidence || []).map(
        ({ kind, path, hash, source }) => ({ kind, path, hash, source }),
      ),
      receipts: [...service.extensions.runner.sessions.values()]
        .filter((session) => session.owner === w.id && session.runId === run.id)
        .map(({ status, exitCode, error, startedAt }) => ({
          status,
          exitCode,
          error: sanitize(error),
          elapsedMs: Date.now() - startedAt,
        })),
      approvals: saved.approvals
        .filter((a) => a.runId === run.id)
        .map(({ path, status }) => ({ path, status })),
    };
    check("run completed", run.status === "completed");
    check(
      "expected outcome",
      run.outcome === (spec.id === "01" ? "answered" : "delivered"),
    );
    if (spec.id === "01") {
      const answer = saved.messages
        .filter((m) => m.runId === run.id && m.role === "assistant")
        .map((m) => m.content)
        .join("")
        .trim();
      check("exact answer", answer === "42");
      check("no tool calls", toolNames.length === 0);
      check(
        "no file delivery",
        !run.delivery?.delivered && readdirSync(root).length === 0,
      );
    }
    const expectedPath =
      spec.expected.path || (spec.id === "07" ? "sum.mjs" : null);
    if (expectedPath) {
      const present = existsSync(join(root, expectedPath));
      const observedHash = present
        ? hash(readFileSync(join(root, expectedPath)))
        : null;
      result.observed.file = { path: expectedPath, hash: observedHash };
      check(
        "file current evidence",
        (run.delivery?.evidence || []).some(
          (e) =>
            e.kind === "file" &&
            e.path === expectedPath &&
            e.hash === observedHash &&
            e.runId === run.id,
        ),
      );
      if (spec.expected.hash)
        check("exact file bytes", observedHash === spec.expected.hash);
    }
    for (const [path, originalHash] of fixtureFiles)
      if (path !== expectedPath)
        check(
          `fixture unchanged:${path}`,
          existsSync(join(root, path)) &&
            hash(readFileSync(join(root, path))) === originalHash,
        );
    if (spec.id === "06") {
      const calls = new Map();
      for (const message of run.contextMessages || [])
        for (const call of message.tool_calls || [])
          calls.set(call.id, call.function.name);
      const outputs = (run.contextMessages || [])
        .filter(
          (m) =>
            m.role === "tool" && calls.get(m.tool_call_id) === "code_execute",
        )
        .map((m) => {
          try {
            return JSON.parse(m.content);
          } catch {
            return null;
          }
        });
      check("code tool called", toolNames.includes("code_execute"));
      check(
        "actual code result",
        outputs.some(
          (r) =>
            r?.exitCode === 0 &&
            r.environment === "isolated-node" &&
            r.value?.sum === 210 &&
            r.value?.sumSquares === 2870,
        ),
      );
      result.observed.calculation = outputs.map((r) => ({
        sum: typeof r?.value?.sum === "number" ? r.value.sum : null,
        sumSquares:
          typeof r?.value?.sumSquares === "number" ? r.value.sumSquares : null,
        exitCode: r?.exitCode,
      }));
    }
    if (spec.id === "07") {
      check("model terminal verification", toolNames.includes("terminal_run"));
      const verified = await invokeTerminal("independent-after");
      result.observed.independentVerification = {
        status: verified.status,
        exitCode: verified.exitCode,
      };
      check(
        "independent repaired behavior",
        verified.status === "completed" && verified.exitCode === 0,
      );
    }
    if (spec.id === "20") {
      check(
        "search and computation used",
        ["search_files", "code_execute"].every((name) =>
          toolNames.includes(name),
        ),
      );
      const id = w.id,
        runId = run.id,
        deliveryHash = run.delivery ? hash(JSON.stringify(run.delivery)) : null;
      await service.extensions.close();
      db.close();
      db = new WorkspaceDatabase(join(base, "state/agent.sqlite"));
      service = new WorkspaceService(db.db, provider);
      const reloaded = service.get(id).runs.find((r) => r.id === runId);
      const projected = new SessionBridge(null, null, service)
        .project(service.store.get(id))
        .runs.find((r) => r.id === runId);
      check(
        "reloaded evidence identical",
        deliveryHash !== null &&
          hash(JSON.stringify(reloaded.delivery ?? null)) === deliveryHash &&
          hash(JSON.stringify(projected.delivery ?? null)) === deliveryHash,
      );
      check(
        "reloaded outcome delivered",
        reloaded.outcome === "delivered" && projected.outcome === "delivered",
      );
    }
    check("source unchanged", sourceHash() === frozen);
    result.status =
      result.checks.every((c) => c.passed) && !result.timedOut
        ? "passed"
        : "failed";
  } catch (error) {
    result.status = [
      "MODEL_NOT_CONFIGURED",
      "SANDBOX_BACKEND",
      "SANDBOX_IMAGE",
      "SOURCE_CHANGED",
    ].includes(error.code)
      ? "blocked"
      : "failed";
    result.errorCode = error.code || error.name || "ERROR";
    result.error = sanitize(error.message);
  } finally {
    clearTimeout(watchdog);
    controller.abort();
    handle?.controller.abort();
    await service?.extensions.close().catch(() => {});
    db?.close();
    result.elapsedMs = Date.now() - started;
    result.endedAt = new Date().toISOString();
    result.temporaryDataRemoved = true;
    rmSync(base, { recursive: true, force: true });
    writeFileSync(
      taskResultPath(round, spec.id),
      JSON.stringify(result, null, 2),
    );
  }
  return result;
}
async function orchestrate() {
  mkdirSync(output, { recursive: true });
  const frozen = sourceHash();
  const manifest = {
    sourceHash: frozen,
    node: process.version,
    rounds: 2,
    concurrency: 2,
    timeoutMs,
    retries: 0,
    configuration: safeProvider(configuredProvider()),
    tasks: taskSpecs.map(({ id, name, message, completion, expected }) => ({
      id,
      name,
      input: message + common,
      completion,
      expected,
    })),
  };
  writeFileSync(
    join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  const results = [];
  const child = (spec, round) =>
    new Promise((done) => {
      const processChild = spawn(
        process.execPath,
        [self, "--task", spec.id, "--round", String(round), "--source", frozen],
        { cwd: project, stdio: "ignore" },
      );
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        processChild.kill("SIGKILL");
      }, timeoutMs);
      processChild.once("exit", (code) => {
        clearTimeout(timer);
        let record;
        try {
          record = JSON.parse(readFileSync(taskResultPath(round, spec.id)));
        } catch {
          record = {
            task: spec.id,
            round,
            status: "failed",
            errorCode: killed ? "TASK_TIMEOUT" : "WORKER_EXIT",
            exitCode: code,
            sourceHash: frozen,
          };
          writeFileSync(
            taskResultPath(round, spec.id),
            JSON.stringify(record, null, 2),
          );
        }
        results.push(record);
        console.log(
          JSON.stringify({
            task: spec.id,
            round,
            status: record.status,
            elapsedMs: record.elapsedMs,
            errorCode: record.errorCode,
            failedChecks: (record.checks || [])
              .filter((c) => !c.passed)
              .map((c) => c.name),
          }),
        );
        done();
      });
    });
  for (let round = 1; round <= 2; round++)
    for (let index = 0; index < taskSpecs.length; index += 2)
      await Promise.all(
        taskSpecs.slice(index, index + 2).map((spec) => child(spec, round)),
      );
  const summary = {
    sourceHash: frozen,
    finalSourceHash: sourceHash(),
    realModel: true,
    retries: 0,
    counts: {
      total: results.length,
      passed: results.filter((r) => r.status === "passed").length,
      failed: results.filter((r) => r.status === "failed").length,
      blocked: results.filter((r) => r.status === "blocked").length,
    },
    stable:
      results.length === 12 &&
      results.every((r) => r.status === "passed") &&
      sourceHash() === frozen,
    results: results.map(({ task, round, status, elapsedMs, errorCode }) => ({
      task,
      round,
      status,
      elapsedMs,
      errorCode,
    })),
  };
  writeFileSync(join(output, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  process.exitCode = summary.stable ? 0 : 1;
}
const taskIndex = process.argv.indexOf("--task");
if (taskIndex >= 0) {
  const spec = taskSpecs.find(
    (item) => item.id === process.argv[taskIndex + 1],
  );
  const round = Number(process.argv[process.argv.indexOf("--round") + 1]);
  const sourceIndex = process.argv.indexOf("--source");
  const frozen =
    sourceIndex >= 0 ? process.argv[sourceIndex + 1] : sourceHash();
  mkdirSync(output, { recursive: true });
  if (!spec) throw new Error("Unknown task");
  await runTask(spec, round, frozen);
} else await orchestrate();
