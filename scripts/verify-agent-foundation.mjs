// Task-level synthetic acceptance. Each task runs in a separate process with a fixed deadline.
// Never reads project configuration, credentials or application databases; never starts Docker.
import assert from "node:assert/strict";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { WorkspaceDatabase, WorkspaceService } from "../server/core/index.mjs";
import { WorkspaceFiles, hashText } from "../server/core/workspace-files.mjs";
import { SessionBridge } from "../server/session-bridge.mjs";
import { searchWeb, fetchWeb } from "../server/core/web-tools.mjs";
import { compactContext } from "../server/core/context-manager.mjs";
import { contextBudget } from "../server/core/context-budget.mjs";
const self = fileURLToPath(import.meta.url);
const project = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = join(project, "output/codex-foundation-20260921");
const cases = [
  ["Ordinary answer", "Answer without inventing file delivery"],
  ["Create specified file", "Applied current-run content and hash match"],
  [
    "Modify specified file",
    "Only intended content changes with current-run evidence",
  ],
  [
    "Old file and unsupported completion claim",
    "Existing files cannot count as new delivery",
  ],
  ["Pending and rejected approval", "No write or successful delivery"],
  [
    "Code agent synthetic calculation",
    "Real product container computes independently known sum",
  ],
  [
    "Repair deterministic program",
    "Actual file tool edit and independent program behavior pass",
  ],
  ["Failed command", "Nonzero exit/output visible and delivery rejected"],
  ["Cancel run", "No subsequent write and final status cancelled"],
  [
    "Container loss and recovery",
    "Capability/execution agree before and after real recovery",
  ],
  [
    "Read session after backend loss",
    "Existing output remains available with owner enforcement",
  ],
  ["Large/deep repository search", "Find known target beyond original limits"],
  ["Scoped glob regex context search", "Exact known paths, lines and context"],
  ["Paged search", "No omissions/duplicates and bounded page length"],
  [
    "Protected and escaped search paths",
    "Deny protected, traversal and symlink paths",
  ],
  [
    "Search quality and filters",
    "Relevant, empty, low relevance and domain filtering distinguishable",
  ],
  [
    "Failed search source and cancellation",
    "Failure structured and cancellation promptly propagated",
  ],
  [
    "Redirect and long article",
    "Every hop authorized and segments reconstruct exact article",
  ],
  [
    "Large context compaction",
    "Budget fits, durable facts and complete tool batches survive; archive readable",
  ],
  [
    "Combined search/write and reload",
    "Current-run evidence/hash survive reload and session projection",
  ],
].map(([input, expected], index) => ({
  id: String(index + 1).padStart(2, "0"),
  input,
  expected,
  timeoutMs: 20000,
}));
const put = (root, p, text) => {
  const full = join(root, p);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
};
const IMAGE = "open-medical-runtime:0.8-full";
async function enableContainer(f) {
  await f.service.extensions.operation(f.id, {
    action: "configure",
    revision: f.service.get(f.id).revision,
    consent: true,
    terminal: true,
    browser: false,
    plugins: false,
    mcp: false,
    memoryRead: false,
    memoryWrite: false,
    origins: [],
    memory: { provider: "lsa" },
    image: IMAGE,
  });
}
const terminal = (command, paths = []) => ({
  name: "terminal_run",
  args: { command, paths, timeoutMs: 10000 },
});
const resultOf = (f, call) =>
  JSON.parse(
    f.service.store
      .get(f.id)
      .runs.at(-1)
      .contextMessages.find(
        (message) => message.role === "tool" && message.tool_call_id === call,
      ).content,
  );
async function serviceFixture(root, steps = [], { review = false } = {}) {
  mkdirSync(root, { recursive: true });
  const db = new WorkspaceDatabase(join(root, "..", "state", "agent.sqlite"));
  let index = 0;
  const provider = {
    local: true,
    model: "scripted-synthetic-provider",
    complete: async (...args) => {
      const step = steps[index++];
      if (typeof step === "function") return step(...args);
      return {
        message: step
          ? {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: `call-${index}`,
                  type: "function",
                  function: {
                    name: step.name,
                    arguments: JSON.stringify(step.args),
                  },
                },
              ],
            }
          : { role: "assistant", content: "Synthetic task ended." },
      };
    },
  };
  const service = new WorkspaceService(db.db, provider);
  let w = service.create({ root, directoryConsent: true });
  w = service.update(w.id, {
    revision: w.revision,
    profile: "standard",
    allowWrite: true,
    approvalPolicy: review ? "review" : "workspace-write",
    autoApplyConsent: !review,
  });
  const prepare = (message, completion) =>
    service.prepare(w.id, {
      revision: service.get(w.id).revision,
      message,
      externalConsent: true,
      completion,
    });
  const run = async (message, completion) => {
    const h = prepare(message, completion);
    await service.execute(h);
    return service.get(w.id).runs.at(-1);
  };
  return {
    service,
    db,
    id: w.id,
    root,
    prepare,
    run,
    close: async () => {
      await service.extensions.close();
      db.close();
    },
  };
}
const write = (path, content, expectedHash) => ({
  name: "propose_file_write",
  args: { path, content, ...(expectedHash ? { expectedHash } : {}) },
});
async function webFixture() {
  let version = 0;
  const article = "中文段落 & content. ".repeat(7000);
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    const u = new URL(req.url, "http://fixture");
    if (u.pathname === "/redirect") {
      res.writeHead(302, { location: "/article" });
      res.end();
    } else if (u.pathname === "/escape") {
      res.writeHead(302, { location: "https://unauthorized.invalid/data" });
      res.end();
    } else if (u.pathname === "/article") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        `<title>Fixture</title><article><p>${article}${version ? "changed" : ""}</p></article>`,
      );
    } else if (u.pathname === "/fail") {
      res.writeHead(503);
      res.end("failure");
    } else if (u.pathname === "/slow") {
      /* intentionally no response; cancelled by client */
    } else {
      res.setHeader("content-type", "application/json");
      const query = u.searchParams.get("q");
      res.end(
        JSON.stringify({
          results:
            query === "empty"
              ? []
              : [
                  {
                    title:
                      query === "low" ? "unrelated weather" : "pelican bicycle",
                    url: "https://example.com/pelican",
                    content: "pelican bicycle",
                  },
                  {
                    title: "pelican",
                    url: "https://other.invalid/x",
                    content: "pelican bicycle",
                  },
                ],
        }),
      );
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    article,
    hits,
    change: () => version++,
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
async function scenario(id, dir) {
  const root = join(dir, "project");
  mkdirSync(root, { recursive: true });
  const files = new WorkspaceFiles(root);
  let f, web;
  try {
    if (["01", "02", "03", "04", "05", "07", "08", "09", "20"].includes(id)) {
      let steps = [];
      const initial = "old synthetic value";
      if (["03", "04"].includes(id)) put(root, "report.md", initial);
      if (id === "02" || id === "05")
        steps = [write("report.md", "synthetic verified content")];
      if (id === "09")
        steps = [
          (_messages, _tools, options) =>
            new Promise((_resolve, reject) => {
              options.signal.addEventListener(
                "abort",
                () => reject(options.signal.reason),
                { once: true },
              );
            }),
          write("report.md", "must never be written"),
        ];
      if (id === "08")
        steps = [terminal("printf 'synthetic error\\n' >&2; exit 7")];
      if (id === "03")
        steps = [write("report.md", "updated exact value", hashText(initial))];
      if (id === "07") {
        put(root, "sum.mjs", "export const sum=(a,b)=>a-b;");
        steps = [
          { name: "read_file", args: { path: "sum.mjs" } },
          write(
            "sum.mjs",
            "export const sum=(a,b)=>a+b;",
            hashText("export const sum=(a,b)=>a-b;"),
          ),
        ];
      }
      if (id === "20") {
        put(root, "source.txt", "known target value=42");
        steps = [
          { name: "search_files", args: { query: "value=42" } },
          write("report.md", "source value=42"),
        ];
      }
      if (id === "07")
        steps.push(
          terminal(
            "node --input-type=module -e 'import {sum} from \"./sum.mjs\"; if(sum(19,23)!==42)process.exit(1); console.log(sum(19,23));'",
            ["sum.mjs"],
          ),
        );
      if (id === "20")
        steps.push(
          terminal(
            'node -e \'const fs=require("fs"); if(fs.readFileSync("report.md","utf8")!=="source value=42")process.exit(1); console.log("verified value=42");\'',
            ["report.md"],
          ),
        );
      f = await serviceFixture(root, steps, { review: id === "05" });
      if (["07", "08", "20"].includes(id)) await enableContainer(f);
      if (id === "09") {
        const h = f.prepare("Create cancelled file", {
          files: [{ path: "report.md" }],
        });
        const running = f.service.execute(h);
        setTimeout(() => f.service.cancel(f.id), 25);
        await running;
        const run = f.service.get(f.id).runs.at(-1);
        assert.equal(run.status, "cancelled");
        assert.equal(readdirSync(root).length, 0);
        return { run };
      }
      if (id === "08") {
        const run = await f.run("Run failing synthetic command", {
          requireExecution: true,
        });
        const execution = resultOf(f, "call-1");
        assert.equal(execution.exitCode, 7);
        assert.match(execution.output, /synthetic error/);
        assert.equal(run.delivery.delivered, false);
        assert.ok(
          run.delivery.gaps.some((g) => g.reason === "execution_not_passed"),
        );
        return {
          mode: "actual product terminal_run in real Docker",
          execution,
          delivery: run.delivery,
        };
      }
      const completion =
        id === "01"
          ? { kind: "answer" }
          : id === "07"
            ? {
                files: [{ path: "sum.mjs", contains: "a+b" }],
                requireExecution: true,
              }
            : id === "05"
              ? undefined
              : {
                  ...(id === "20" ? { requireExecution: true } : {}),
                  files: [
                    {
                      path: "report.md",
                      ...(id === "02" ? { contains: "verified content" } : {}),
                    },
                  ],
                };
      const run = await f.run(cases[Number(id) - 1].input, completion);
      assert.equal(run.status, "completed", run.error);
      if (["01", "04", "05"].includes(id)) {
        // 0.9.9 distinguishes failed execution delivery from an ordinary answer.
        assert.equal(run.outcome, id === "01" ? "answered" : "delivery_failed");
        assert.notEqual(run.delivery?.delivered, true);
      } else {
        assert.equal(run.outcome, "delivered", JSON.stringify(run.delivery));
        assert.equal(
          run.delivery.evidence[0].hash,
          hashText(
            readFileSync(join(root, id === "07" ? "sum.mjs" : "report.md")),
          ),
        );
      }
      if (id === "03")
        assert.equal(files.read("report.md").text, "updated exact value");
      if (id === "05") {
        assert.equal(readdirSync(root).length, 0);
        const w = f.service.get(f.id);
        assert.equal(w.approvals[0].status, "pending");
        f.service.decide(f.id, w.approvals[0].id, {
          revision: w.revision,
          decision: "reject",
        });
        assert.equal(
          (await f.service.verifyDelivery(f.id, run.id)).delivered,
          false,
        );
        assert.equal(readdirSync(root).length, 0);
      }
      if (id === "07") {
        const execution = resultOf(f, "call-3");
        assert.equal(execution.exitCode, 0, JSON.stringify(execution));
        assert.equal(execution.output.trim(), "42");
      }
      if (id === "20") {
        const execution = resultOf(f, "call-3");
        assert.equal(execution.exitCode, 0, JSON.stringify(execution));
        assert.match(execution.output, /verified value=42/);
        const saved = f.service.store.get(f.id).runs.at(-1);
        const searchResult = saved.contextMessages.find(
          (message) =>
            message.role === "tool" && message.tool_call_id === "call-1",
        );
        assert.ok(searchResult, "actual search tool result must be persisted");
        assert.match(searchResult.content, /known target value=42/);
        assert.equal(files.read("report.md").text, "source value=42");
        const reloaded = new WorkspaceService(f.db.db, f.service.provider);
        assert.deepEqual(reloaded.get(f.id).runs.at(-1).delivery, run.delivery);
        assert.deepEqual(
          new SessionBridge(null, null, reloaded)
            .project(reloaded.store.get(f.id))
            .runs.at(-1).delivery,
          run.delivery,
        );
        await reloaded.extensions.close();
      }
      return {
        run,
        mode:
          id === "07"
            ? "scripted provider + real file tools + actual Docker terminal behavior check"
            : "scripted provider + real workspace service/files",
      };
    }
    if (id === "06") {
      f = await serviceFixture(root, [
        {
          name: "code_execute",
          args: {
            code: "return {sum:[2,4,6,8].reduce((a,b)=>a+b,0), mean:[2,4,6,8].reduce((a,b)=>a+b,0)/4};",
          },
        },
      ]);
      await enableContainer(f);
      const run = await f.run("Compute sum and mean of [2,4,6,8]", {
        kind: "execution",
        requireExecution: true,
      });
      const execution = resultOf(f, "call-1");
      assert.equal(execution.exitCode, 0, JSON.stringify(execution));
      assert.deepEqual(execution.value, { sum: 20, mean: 5 });
      assert.equal(run.delivery.delivered, true, JSON.stringify(run.delivery));
      return {
        mode: "scripted provider + actual code_execute in real Docker",
        execution,
        delivery: run.delivery,
      };
    }
    if (id === "10") {
      f = await serviceFixture(root);
      await enableContainer(f);
      const runner = f.service.extensions.runner,
        docker = runner.docker;
      runner.docker = "/nonexistent/synthetic-docker";
      f.service.probe.invalidate(f.id);
      const down = f.service
        .capabilitySnapshot(f.id)
        .tools.find((t) => t.name === "terminal_run");
      assert.equal(down.ready, false);
      assert.equal(down.reasonCode, "BACKEND_UNAVAILABLE");
      const failedExecution = await f.service.tool(f.id, {
        tool: "terminal_run",
        arguments: { command: "printf unreachable", timeoutMs: 10000 },
      });
      assert.equal(failedExecution.status, "failed");
      assert.notEqual(failedExecution.exitCode, 0);
      assert.match(failedExecution.output, /ENOENT/);
      runner.docker = docker;
      f.service.probe.invalidate(f.id);
      const restored = f.service
        .capabilitySnapshot(f.id)
        .tools.find((t) => t.name === "terminal_run");
      assert.equal(restored.executable, true, JSON.stringify(restored));
      const execution = await f.service.tool(f.id, {
        tool: "terminal_run",
        arguments: { command: "printf recovered", timeoutMs: 10000 },
      });
      assert.equal(execution.exitCode, 0, JSON.stringify(execution));
      assert.equal(execution.output, "recovered");
      return {
        mode: "actual unavailable executable then restored real Docker; daemon never stopped",
        down,
        failedExecution,
        restored,
        execution,
      };
    }
    if (id === "11") {
      f = await serviceFixture(root);
      await enableContainer(f);
      const execution = await f.service.tool(f.id, {
        tool: "terminal_run",
        arguments: {
          command: "printf 'synthetic saved output'",
          timeoutMs: 10000,
        },
      });
      assert.equal(execution.exitCode, 0);
      const runner = f.service.extensions.runner;
      runner.docker = "/nonexistent/synthetic-docker";
      f.service.probe.invalidate(f.id);
      assert.equal(runner.status().available, false);
      assert.equal(
        f.service
          .capabilitySnapshot(f.id)
          .tools.find((t) => t.name === "terminal_read").executable,
        true,
      );
      const saved = await f.service.tool(f.id, {
        tool: "terminal_read",
        arguments: { id: execution.id },
      });
      assert.equal(saved.output, "synthetic saved output");
      assert.throws(() => runner.read("other-workspace", execution.id), {
        code: "PROCESS_NOT_FOUND",
      });
      return {
        mode: "real product terminal completion then unavailable instance executable; actual read and owner check",
        saved,
      };
    }
    if (["12", "13", "14", "15"].includes(id)) {
      for (let i = 0; i < 155; i++)
        put(
          root,
          `f${String(i).padStart(3, "0")}.txt`,
          i === 154 ? "needle 42" : "hay",
        );
      put(root, "深 层/a/b/c/d/e/f/target.mjs", "before\nneedle 42\nafter");
      if (id === "12") {
        const r = await files.search("needle");
        assert.equal(r.matches.length, 2);
        assert.ok(r.matches.some((m) => m.path === "f154.txt"));
        return r;
      }
      if (id === "13") {
        const r = await files.search({
          regex: "needle [0-9]+",
          path: "深 层",
          glob: "*.mjs",
          context: 1,
        });
        assert.equal(r.matches.length, 1);
        assert.equal(r.matches[0].line, 2);
        assert.equal(r.matches[0].before[0].text, "before");
        assert.equal(r.matches[0].after[0].text, "after");
        return r;
      }
      if (id === "14") {
        put(root, "many.txt", "page\n".repeat(141));
        let offset = 0;
        const lines = [];
        do {
          const r = await files.search({ query: "page", offset, limit: 13 });
          assert.ok(r.matches.length <= 13);
          lines.push(...r.matches.map((m) => m.line));
          offset = r.nextOffset;
        } while (offset !== undefined);
        assert.deepEqual(
          lines,
          Array.from({ length: 141 }, (_, i) => i + 1),
        );
        return { count: lines.length, unique: new Set(lines).size };
      }
      put(root, ".env", "synthetic secret needle");
      symlinkSync(join(root, ".env"), join(root, "link"));
      for (const path of [".env", "../outside", "link"])
        await assert.rejects(files.search({ query: "needle", path }), {
          code: "PATH_DENIED",
        });
      const r = await files.search("needle");
      assert.equal(r.matches.length, 2);
      return r;
    }
    if (["16", "17", "18"].includes(id)) {
      web = await webFixture();
      const config = {
        searchUrl: web.origin + "/search",
        origins: [web.origin],
      };
      // Configured engine and page requests use real loopback HTTP. External fallback routes are controlled empty responses.
      const transport = (url, init) =>
        new URL(url).origin === web.origin
          ? fetch(url, init)
          : Promise.resolve(
              new Response("<rss></rss>", {
                headers: { "content-type": "text/xml" },
              }),
            );
      if (id === "16") {
        const good = await searchWeb(
          "pelican bicycle",
          config,
          null,
          transport,
          null,
          { domains: ["example.com"] },
        );
        assert.equal(good.quality, "ok");
        assert.equal(good.results.length, 1);
        const empty = await searchWeb("empty", config, null, transport);
        assert.equal(empty.quality, "no-results");
        const low = await searchWeb(
          "low",
          { ...config, searchUrl: web.origin + "/search" },
          null,
          transport,
        );
        assert.equal(low.quality, "low-relevance");
        return {
          good,
          empty,
          low,
          transport:
            "real loopback configured engine; empty synthetic external fallback",
        };
      }
      if (id === "17") {
        const fail = await searchWeb(
          "pelican",
          { ...config, searchUrl: web.origin + "/fail" },
          null,
          async (url, init) =>
            new URL(url).origin === web.origin
              ? fetch(url, init)
              : new Response("fail", { status: 503 }),
        );
        assert.equal(fail.quality, "source-failure");
        const c = new AbortController();
        const pending = searchWeb(
          "pelican",
          { ...config, searchUrl: web.origin + "/slow" },
          c.signal,
          transport,
        );
        setTimeout(() => c.abort(), 25);
        await assert.rejects(pending, (e) => e.name === "AbortError");
        return { fail, cancelled: true };
      }
      let offset = 0,
        hash = null,
        text = "";
      do {
        const page = await fetchWeb(
          web.origin + "/redirect",
          [web.origin],
          null,
          fetch,
          { offset, expectedHash: hash, segmentChars: 10000 },
        );
        hash ??= page.hash;
        assert.equal(page.hash, hash);
        text += page.text;
        offset = page.nextOffset;
      } while (offset !== null && offset !== undefined);
      assert.ok(text.includes(web.article.trim()));
      await assert.rejects(fetchWeb(web.origin + "/escape", [web.origin]));
      web.change();
      const changed = await fetchWeb(
        web.origin + "/article",
        [web.origin],
        null,
        fetch,
        { expectedHash: hash },
      );
      assert.equal(changed.contentChanged, true);
      return {
        chars: text.length,
        hash,
        hops: web.hits,
        changed: changed.contentChanged,
      };
    }
    if (id === "19") {
      const messages = [
        {
          role: "system",
          content: "Only synthetic files; approvals required.",
        },
      ];
      for (let i = 0; i < 35; i++)
        messages.push(
          {
            role: "user",
            content: "historic synthetic " + i + "x".repeat(1200),
          },
          { role: "assistant", content: "previous observation" },
        );
      messages.push(
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "paired",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "paired",
          content: "observed synthetic data",
        },
        { role: "user", content: "Keep current task exact" },
      );
      const provider = {
        model: "small-synthetic",
        contextWindow: 32768,
        maxTokens: 2048,
        complete: async () => ({
          message: {
            role: "assistant",
            content: "Synthetic history; original records are archived.",
          },
        }),
      };
      const before = contextBudget({ provider, messages });
      assert.equal(before.shouldCompact, true);
      const archived = join(dir, "context-archive.json");
      const result = await compactContext({
        messages,
        provider,
        maxChars: 20000,
        durableMessages: [
          {
            role: "system",
            content: "Pending approval A; no applied side effects.",
          },
        ],
        archive: async (value) => {
          writeFileSync(archived, JSON.stringify(value));
          return { id: "fixture-archive" };
        },
      });
      assert.equal(result.budget.fits, true);
      assert.ok(
        result.messages.some((m) => m.content === "Keep current task exact"),
      );
      assert.ok(
        result.messages.some(
          (m) => m.content === "Pending approval A; no applied side effects.",
        ),
      );
      assert.deepEqual(JSON.parse(readFileSync(archived, "utf8")), messages);
      const calls = result.messages
        .filter((m) => m.tool_calls)
        .flatMap((m) => m.tool_calls.map((c) => c.id));
      for (const message of result.messages.filter((m) => m.role === "tool"))
        assert.ok(calls.includes(message.tool_call_id));
      return {
        before,
        after: result.budget,
        archive: archived,
        messages: result.messages,
      };
    }
    throw Error("Unknown task " + id);
  } finally {
    await web?.close();
    await f?.close();
  }
}
function fingerprint() {
  const hash = createHash("sha256");
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:mjs|js|jsx|cjs)$/.test(entry.name))
        hash.update(path.slice(project.length)).update(readFileSync(path));
    }
  };
  for (const directory of ["server", "scripts", "src", "shared"])
    walk(join(project, directory));
  return hash.digest("hex");
}
if (process.argv[2] === "--worker") {
  const id = process.argv[3],
    dir = process.argv[4];
  const started = Date.now();
  let result;
  try {
    result = { status: "passed", actual: await scenario(id, dir) };
    if (result.actual.status === "blocked") result.status = "blocked";
  } catch (error) {
    result = {
      status: "failed",
      error: {
        name: error.name,
        code: error.code,
        message: error.message,
        stack: error.stack,
      },
    };
  }
  writeFileSync(
    join(dir, "result.json"),
    JSON.stringify({ ...result, durationMs: Date.now() - started }, null, 2),
  );
  process.exit(result.status === "failed" ? 1 : 0);
} else {
  mkdirSync(output, { recursive: true });
  const config = {
    provider: "scripted-synthetic-provider",
    realModel:
      "not exercised: this matrix uses a scripted provider; live-model results are separate",
    network: "loopback fixtures; explicit fake fallback responses",
    container:
      "existing open-medical-runtime:0.8-full; actual product tools; never install/start daemon/pull",
    deadlineMs: 20000,
  };
  const configHash = hashText(JSON.stringify(config));
  const codeHash = fingerprint();
  const records = [];
  const batch = new Date().toISOString().replaceAll(/[:.]/g, "-");
  for (let round = 1; round <= 2; round++)
    for (const task of cases) {
      const dir = join(output, batch, `round-${round}`, task.id);
      mkdirSync(dir, { recursive: true });
      const started = Date.now();
      const child = spawnSync(
        process.execPath,
        [self, "--worker", task.id, dir],
        {
          cwd: project,
          encoding: "utf8",
          timeout: task.timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: 1000000,
        },
      );
      writeFileSync(
        join(dir, "process.log"),
        `${child.stdout || ""}${child.stderr || ""}`,
      );
      let result;
      try {
        result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
      } catch {
        result = {
          status: "failed",
          error: {
            message: child.error?.message || "Worker did not produce result",
          },
        };
      }
      const record = {
        ...task,
        validationScope:
          "controlled task-level contract; not real model acceptance",
        realModelStatus: "not_tested",
        round,
        codeHash,
        configHash,
        ...result,
        durationMs: Date.now() - started,
        exitCode: child.status,
        signal: child.signal,
        artifactDirectory: dir,
      };
      records.push(record);
      console.log(`round ${round} task ${task.id}: ${record.status}`);
    }
  const finalHash = fingerprint();
  const report = {
    createdAt: new Date().toISOString(),
    config,
    configHash,
    codeHash,
    finalHash,
    frozenCode: codeHash === finalHash,
    realModel: "not_tested_by_this_harness",
    stableComplete: false,
    controlledTwoRoundsPassed:
      codeHash === finalHash && records.every((r) => r.status !== "failed"),
    totals: Object.fromEntries(
      ["passed", "failed", "blocked"].map((status) => [
        status,
        records.filter((r) => r.status === status).length,
      ]),
    ),
    records,
  };
  writeFileSync(
    join(output, batch, "report.json"),
    JSON.stringify(report, null, 2),
  );
  writeFileSync(
    join(output, "latest.json"),
    JSON.stringify({ report: join(output, batch, "report.json") }, null, 2),
  );
  console.log(
    JSON.stringify({
      report: join(output, batch, "report.json"),
      totals: report.totals,
      frozenCode: report.frozenCode,
    }),
  );
  process.exit(
    report.totals.failed || !report.frozenCode
      ? 1
      : report.totals.blocked
        ? 2
        : 0,
  );
}
