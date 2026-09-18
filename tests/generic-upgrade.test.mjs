import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import tar from "tar-stream";
import {
  WorkspaceDatabase,
  WorkspaceService,
  ResponsesProvider,
} from "../server/core/index.mjs";
import { nextCron } from "../server/core/workspace-scheduler.mjs";
import { fetchWeb } from "../server/core/web-tools.mjs";
import { fetchPlugin } from "../server/core/remote-plugin.mjs";
import { PluginPackages } from "../server/core/plugins.mjs";
const exec = promisify(execFile);
function fixture(t, provider = {}) {
  const dir = mkdtempSync(join(process.cwd(), "output/generic-upgrade-"));
  const root = join(dir, "project");
  mkdirSync(root);
  const db = new WorkspaceDatabase(join(dir, "workspace.sqlite"));
  const service = new WorkspaceService(db.db, provider, {
    extensions: { directory: join(dir, "plugins") },
  });
  const w = service.create({ root, directoryConsent: true });
  t.after(async () => {
    await service.extensions.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const configure = (body) =>
    service.extensions.operation(w.id, {
      action: "configure",
      consent: true,
      revision: service.get(w.id).revision,
      origins: [],
      terminal: false,
      browser: false,
      plugins: false,
      mcp: false,
      memoryRead: false,
      memoryWrite: false,
      memory: { provider: "lsa" },
      ...body,
    });
  const tool = (tool, args = {}) =>
    service.tool(w.id, { tool, arguments: args });
  return { dir, root, service, id: w.id, configure, tool };
}
const stream = (events) =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
test("Responses replay preserves encrypted reasoning, tool call identity and terminal usage", async () => {
  let count = 0;
  const reasoning = {
    type: "reasoning",
    id: "rs1",
    summary: [],
    encrypted_content: "opaque-test",
  };
  const call = {
    type: "function_call",
    call_id: "c1",
    name: "read_file",
    arguments: '{"path":"a"}',
  };
  const provider = new ResponsesProvider({
    apiKey: "synthetic",
    model: "test",
    fetchImpl: async (url, options) => {
      assert.match(url, /\/responses$/);
      const body = JSON.parse(options.body);
      assert.equal(body.store, false);
      assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
      if (count++ === 0)
        return stream([
          {
            type: "response.completed",
            response: { status: "completed", output: [reasoning, call] },
          },
        ]);
      assert.deepEqual(body.input.slice(-3), [
        reasoning,
        call,
        { type: "function_call_output", call_id: "c1", output: "contents" },
      ]);
      return stream([
        { type: "response.output_text.delta", delta: "done" },
        {
          type: "response.completed",
          response: {
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "done" }],
              },
            ],
            usage: { total_tokens: 12 },
          },
        },
      ]);
    },
  });
  const history = [
    { role: "system", content: "system" },
    { role: "user", content: "read" },
  ];
  const first = await provider.complete(history, []);
  assert.equal(first.message.tool_calls[0].id, "c1");
  const final = await provider.complete(
    [
      ...history,
      first.message,
      { role: "tool", tool_call_id: "c1", content: "contents" },
    ],
    [],
  );
  assert.equal(final.message.content, "done");
  assert.equal(final.usage.total_tokens, 12);
});
test("Responses truncated stream and incomplete response cannot count as success", async () => {
  for (const events of [
    [{ type: "response.output_text.delta", delta: "partial" }],
    [{ type: "response.incomplete" }],
  ]) {
    const provider = new ResponsesProvider({
      apiKey: "synthetic",
      fetchImpl: async () => stream(events),
    });
    await assert.rejects(
      provider.complete([{ role: "user", content: "go" }], []),
      (e) => e.code === "PROVIDER_INCOMPLETE",
    );
  }
});
test("Cron honors timezone and DST and rejects malformed schedules", () => {
  assert.equal(
    new Date(
      nextCron(
        "0 9 * * 1-5",
        "Asia/Shanghai",
        Date.parse("2026-09-10T02:00:00Z"),
      ),
    ).toISOString(),
    "2026-09-11T01:00:00.000Z",
  );
  assert.equal(
    new Date(
      nextCron(
        "0 9 * * *",
        "America/New_York",
        Date.parse("2026-03-07T15:00:00Z"),
      ),
    ).toISOString(),
    "2026-03-08T13:00:00.000Z",
  );
  for (const args of [
    ["* * * * * *", "UTC"],
    ["0 9 * * *", "Bogus/Zone"],
    ["60 9 * * *", "UTC"],
  ])
    assert.throws(
      () => nextCron(...args),
      (e) => e.code === "SCHEDULE_CRON",
    );
});
test("Web evidence strips executable HTML, bounds output and checks origin before fetch", async () => {
  let count = 0;
  const fake = async () => {
    count++;
    return new Response("<script>bad()</script><p>Evidence &amp; source</p>", {
      headers: { "content-type": "text/html" },
    });
  };
  const result = await fetchWeb(
    "https://example.com/a",
    ["https://example.com"],
    undefined,
    fake,
  );
  assert.match(result.text, /Evidence & source/);
  assert.doesNotMatch(result.text, /bad/);
  assert.equal(result.hash.length, 64);
  await assert.rejects(
    fetchWeb("https://other.test", ["https://example.com"], undefined, fake),
  );
  assert.equal(count, 1);
  await assert.rejects(
    fetchWeb(
      "https://example.com",
      ["https://example.com"],
      undefined,
      async () =>
        new Response("x".repeat(2000001), {
          headers: { "content-type": "text/plain" },
        }),
    ),
    (e) => e.code === "WEB_LIMIT",
  );
});
async function archive(entries) {
  const pack = tar.pack(),
    chunks = [];
  const collect = (async () => {
    for await (const chunk of pack) chunks.push(chunk);
  })();
  for (const [header, body] of entries) pack.entry(header, body);
  pack.finalize();
  await collect;
  return Buffer.concat(chunks);
}
test("remote plugin verifies hash, stages review and rejects archive traversal", async (t) => {
  const f = fixture(t);
  const packages = new PluginPackages(join(f.dir, "download-test"));
  const data = await archive([
    [
      { name: "plugin.json" },
      JSON.stringify({
        manifestVersion: 1,
        id: "test-plugin",
        name: "Test",
        version: "1.0.0",
      }),
    ],
  ]);
  const request = {
    url: "https://example.com/plugin.tar",
    sha256: createHash("sha256").update(data).digest("hex"),
  };
  const result = await fetchPlugin(
    packages,
    f.id,
    request,
    async () => new Response(data),
  );
  assert.ok(
    readFileSync(join(result.path, "plugin.json"), "utf8").includes(
      "test-plugin",
    ),
  );
  assert.equal(f.service.get(f.id).extensions?.plugins?.length || 0, 0);
  await assert.rejects(
    fetchPlugin(
      packages,
      f.id,
      { ...request, sha256: "0".repeat(64) },
      async () => new Response(data),
    ),
    (e) => e.code === "PLUGIN_CHANGED",
  );
  const escape = await archive([[{ name: "../escape.txt" }, "oops"]]);
  await assert.rejects(
    fetchPlugin(
      packages,
      f.id,
      { ...request, sha256: createHash("sha256").update(escape).digest("hex") },
      async () => new Response(escape),
    ),
    /越界/,
  );
});
test(
  "Code SDK uses real isolated Node, parallel authorized reads, proposals and denies recursive invocation",
  { skip: !process.env.TEST_DOCKER_IMAGE },
  async (t) => {
    const f = fixture(t);
    f.service.update(f.id, {
      revision: f.service.get(f.id).revision,
      profile: "standard",
      allowWrite: true,
    });
    await f.configure({ terminal: true, image: process.env.TEST_DOCKER_IMAGE });
    writeFileSync(join(f.root, "a.txt"), "original");
    writeFileSync(join(f.root, "b.txt"), "second");
    const result = await f.tool("code_execute", {
      code: `const [a,b]=await Promise.all([tools.read_file({path:'a.txt'}),tools.read_file({path:'b.txt'})]); await tools.propose_file_write({path:'c.txt',content:a.text+b.text}); let recursion; try{await tools.code_execute({code:'return 1'})}catch(e){recursion=e.message};return {text:a.text+b.text,recursion};`,
    });
    assert.equal(result.value.text, "originalsecond");
    assert.match(result.value.recursion, /递归/);
    assert.equal(result.toolCalls, 4);
    assert.equal(f.service.get(f.id).approvals.length, 1);
    assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "original");
    await assert.rejects(
      f.tool("code_execute", {
        code: `return require('node:fs').readFileSync('/Users/june/.env','utf8')`,
      }),
      (e) => e.code === "CODE_FAILED",
    );
  },
);
test(
  "Binary files moved in the container keep the host original and surface the copy as an artifact",
  { skip: !process.env.TEST_DOCKER_IMAGE },
  async (t) => {
    const f = fixture(t);
    f.service.update(f.id, {
      revision: f.service.get(f.id).revision,
      profile: "standard",
      allowWrite: true,
    });
    await f.configure({ terminal: true, image: process.env.TEST_DOCKER_IMAGE });
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
    ]);
    writeFileSync(join(f.root, "photo.jpg"), bytes);
    writeFileSync(join(f.root, "note.txt"), "text line\n");
    let result = await f.tool("terminal_run", {
      command:
        "mkdir -p images && mv photo.jpg images/photo.jpg && mv note.txt docs-note.txt",
      snapshot: true,
      timeoutMs: 60000,
    });
    while (["running", "finalizing"].includes(result?.status))
      result = await f.tool("terminal_wait", {
        id: result.id,
        timeoutMs: 30000,
      });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    // 移动的二进制成为成果，宿主原文件不出删除提案。
    const approvals = f.service.get(f.id).approvals;
    assert.ok(
      approvals.every((a) => a.path !== "photo.jpg"),
      "moved binary must not produce a deletion proposal",
    );
    assert.ok(
      (result.result?.skipped || []).some((s) => s.includes("photo.jpg")),
      "result must explain the preserved binary",
    );
    const artifact = f.service.store
      .get(f.id)
      .artifacts.find((a) => a.name === "images/photo.jpg");
    assert.ok(artifact, "moved binary must be stored as an artifact");
    assert.deepEqual(f.service.artifacts.read(f.id, artifact.id).data, bytes);
    // 文本移动仍是「新路径写入 + 旧路径删除」提案，批准后宿主完成移动。
    for (const path of ["docs-note.txt", "note.txt"]) {
      const approval = approvals.find((a) => a.path === path);
      assert.ok(approval, `missing proposal for ${path}`);
      f.service.decide(f.id, approval.id, {
        revision: f.service.get(f.id).revision,
        decision: "approve",
      });
    }
    assert.equal(
      readFileSync(join(f.root, "docs-note.txt"), "utf8"),
      "text line\n",
    );
    assert.equal(existsSync(join(f.root, "note.txt")), false);
    assert.equal(existsSync(join(f.root, "photo.jpg")), true);
  },
);
test("vision tool requires active consent, sends detected image format and accounts usage", async (t) => {
  let called = false;
  const f = fixture(t, {
    vision: true,
    apiKey: "synthetic",
    model: "test",
    complete: async (messages) => {
      if (Array.isArray(messages.at(-1).content)) {
        called = true;
        assert.match(
          messages.at(-1).content[1].image_url,
          /^data:image\/png;base64,/,
        );
        return {
          message: { role: "assistant", content: "blue pixel" },
          usage: { total_tokens: 10 },
        };
      }
      if (!messages.some((m) => m.role === "tool"))
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "v1",
                function: {
                  name: "inspect_image",
                  arguments: JSON.stringify({
                    path: "pixel.png",
                    question: "color?",
                  }),
                },
              },
            ],
          },
        };
      return { message: { role: "assistant", content: "done" } };
    },
  });
  writeFileSync(
    join(f.root, "pixel.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await assert.rejects(
    f.tool("inspect_image", { path: "pixel.png", question: "color?" }),
    (e) => e.code === "CONSENT_REQUIRED",
  );
  const handle = f.service.prepare(f.id, {
    message: "inspect",
    externalConsent: true,
    revision: f.service.get(f.id).revision,
  });
  const result = await f.service.execute(handle);
  assert.equal(result.status, "completed");
  assert.ok(called);
  assert.equal(f.service.get(f.id).runs.at(-1).usage.total_tokens, 10);
});
test("daemon survives launcher exit, restarts a killed server and stops cleanly", async (t) => {
  const f = fixture(t);
  const directory = join(f.dir, "daemon");
  const port = String(19000 + Math.floor(Math.random() * 10000));
  const args = ["scripts/agent-daemon.mjs"];
  const invoke = (command) =>
    exec(
      process.execPath,
      [...args, command, "--directory", directory, "--port", port],
      { timeout: 20000 },
    );
  let started = false;
  t.after(async () => {
    if (started) await invoke("stop").catch(() => {});
  });
  await invoke("start");
  started = true;
  const initial = JSON.parse((await invoke("status")).stdout);
  assert.equal(initial.running, true);
  assert.ok(initial.supervisor.serverPid);
  process.kill(initial.supervisor.serverPid, "SIGKILL");
  let restarted;
  for (let i = 0; i < 30; i++) {
    restarted = JSON.parse((await invoke("status")).stdout);
    if (restarted.running && restarted.supervisor.serverPid !== initial.supervisor.serverPid) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(restarted.running, true);
  assert.notEqual(restarted.supervisor.serverPid, initial.supervisor.serverPid);
  assert.equal(restarted.supervisor.restarts, 1);
  await invoke("stop");
  started = false;
  assert.equal(JSON.parse((await invoke("status")).stdout).running, false);
});
test(
  "plugin hooks remain inactive until individually granted and can veto model execution",
  { skip: !process.env.TEST_DOCKER_IMAGE },
  async (t) => {
    let requests = 0;
    const f = fixture(t, {
      apiKey: "synthetic",
      model: "test",
      complete: async () => {
        requests++;
        return { message: { role: "assistant", content: "done" } };
      },
    });
    await f.configure({
      terminal: true,
      plugins: true,
      image: process.env.TEST_DOCKER_IMAGE,
    });
    const source = join(f.dir, "hook-plugin");
    mkdirSync(source);
    writeFileSync(
      join(source, "plugin.json"),
      JSON.stringify({
        manifestVersion: 1,
        id: "hook-test",
        name: "Hook test",
        version: "1.0.0",
        hooks: [{ id: "guard", event: "run_start", command: "exit 7" }],
      }),
    );
    const manage = (body) =>
      f.service.extensions.operation(f.id, {
        revision: f.service.get(f.id).revision,
        ...body,
      });
    const inspection = await manage({ action: "inspect-plugin", path: source });
    await manage({
      action: "install-plugin",
      path: source,
      hash: inspection.hash,
      consent: true,
    });
    const state = {
      action: "plugin-state",
      pluginId: "hook-test",
      enabled: true,
      allowedSkills: [],
      allowedCommands: [],
    };
    await manage(state);
    const run = () =>
      f.service.execute(
        f.service.prepare(f.id, {
          revision: f.service.get(f.id).revision,
          message: "go",
          externalConsent: true,
        }),
      );
    assert.equal((await run()).status, "completed");
    assert.equal(requests, 1);
    await manage({ ...state, allowedHooks: ["guard"] });
    assert.equal((await run()).status, "failed");
    assert.equal(requests, 1);
    assert.match(
      JSON.stringify(f.service.get(f.id).runs.at(-1).error),
      /HOOK_FAILED|未通过/,
    );
  },
);
test(
  "document helper roundtrips Chinese docx, xlsx formulas, pptx and PDF; rejects escape",
  { skip: !process.env.TEST_DOCUMENT_PYTHON },
  async (t) => {
    const f = fixture(t),
      script = join(process.cwd(), "desktop/full-runtime/document.py");
    const invoke = async (request) =>
      JSON.parse(
        (
          await exec(
            process.env.TEST_DOCUMENT_PYTHON,
            [
              script,
              "--base64",
              Buffer.from(JSON.stringify(request)).toString("base64"),
            ],
            { cwd: f.root, timeout: 30000 },
          )
        ).stdout,
      );
    const cases = [
      ["docx", { title: "中文验收", paragraphs: ["合成资料"] }, "合成资料"],
      [
        "xlsx",
        {
          sheets: [
            {
              name: "数据",
              rows: [
                ["number", "formula"],
                [3, "=A2*2"],
              ],
            },
          ],
        },
        "=A2*2",
      ],
      [
        "pptx",
        { slides: [{ title: "中文验收", paragraphs: ["合成资料"] }] },
        "合成资料",
      ],
      [
        "pdf",
        { title: "Document test", paragraphs: ["synthetic evidence"] },
        "synthetic evidence",
      ],
    ];
    for (const [extension, content, expected] of cases) {
      const path = "output." + extension;
      const made = await invoke({ action: "create", path, content });
      assert.ok(made.result.bytes > 0);
      const read = await invoke({ action: "read", path });
      assert.ok(JSON.stringify(read).includes(expected), JSON.stringify(read));
    }
    await assert.rejects(invoke({ action: "read", path: "../outside.txt" }));
  },
);
