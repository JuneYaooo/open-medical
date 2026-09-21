import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRuntime } from "../server/core/agent-runtime.mjs";
import { ToolRegistry } from "../server/core/tool-registry.mjs";
import { executeCode } from "../server/core/code-mode.mjs";

const permissions = {
  require() {},
  can() {
    return true;
  },
};
function reads(execute) {
  return new ToolRegistry([
    {
      permission: "filesystem.read",
      definition: {
        type: "function",
        function: {
          name: "read_file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              pausedTools: { type: "array", items: { type: "string" } },
            },
            required: ["path"],
          },
        },
      },
      execute,
    },
  ]);
}
const call = (path, id) => ({
  id,
  function: {
    name: "read_file",
    arguments: JSON.stringify({ path, pausedTools: [] }),
  },
});

test("direct runtime dispatch enforces the paused round before hooks and restores reads next round", async () => {
  let requests = 0;
  const executed = [],
    hooks = [],
    failures = [];
  const provider = {
    model: "synthetic",
    async complete(_messages, tools) {
      requests++;
      if (requests === 1) {
        assert.equal(
          tools.some((tool) => tool.function.name === "read_file"),
          false,
        );
        // An uncooperative model may call a tool missing from advertised definitions.
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [call("old.txt", "paused")],
          },
        };
      }
      assert.equal(
        tools.some((tool) => tool.function.name === "read_file"),
        true,
      );
      if (requests === 2)
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [call("new.txt", "normal")],
          },
        };
      return { message: { role: "assistant", content: "Read completed." } };
    },
  };
  await new AgentRuntime({ provider, maxRounds: 4 }).run({
    messages: [{ role: "user", content: "Read the new synthetic file." }],
    permissions,
    runtimeState: {
      version: 1,
      observations: [],
      failures: [],
      stalledRounds: 0,
      recoveryPending: ["read_file"],
    },
    registry: reads(({ path }, context) => {
      executed.push(path);
      assert.deepEqual(context.pausedTools, []);
      return { text: "new evidence" };
    }),
    domain: {
      beforeTool({ args }) {
        hooks.push(args.path);
      },
    },
    onTrace(event) {
      if (event.output?.code) failures.push(event.output.code);
    },
  });
  assert.deepEqual(executed, ["new.txt"]);
  assert.deepEqual(hooks, ["new.txt"]);
  assert.deepEqual(failures, ["TOOL_RECOVERY_PAUSED"]);
});

// Actual Node stdin/stdout protocol, replacing only the fixture's container mount.
// This tests bridge behavior; it does not claim local execution is a sandbox.
function childRunner(t) {
  let session;
  return {
    start(_id, config, options) {
      const directory = config.mounts[0].source;
      const bridge = readFileSync(
        join(directory, "bridge.mjs"),
        "utf8",
      ).replace(
        "'/program/code.js'",
        JSON.stringify(join(directory, "code.js")),
      );
      const child = spawn(
        process.execPath,
        ["--input-type=module", "--eval", bridge],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      t.after(() => {
        clearTimeout(timer);
        if (child.exitCode === null) child.kill("SIGKILL");
      });
      session = {
        id: "synthetic-child",
        child,
        status: "running",
        output: "",
        offset: 0,
      };
      child.stdout.on("data", (chunk) => {
        session.output += options.stdoutTransform(chunk);
      });
      child.stderr.on("data", (chunk) => {
        session.output += chunk.toString();
      });
      session.done = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => {
          clearTimeout(timer);
          session.exitCode = code;
          session.status = code === 0 ? "completed" : "failed";
          resolve({
            status: session.status,
            exitCode: code,
            output: session.output,
          });
        });
      });
      return { id: session.id };
    },
    get() {
      return session;
    },
    read() {
      return {
        status: session.status,
        exitCode: session.exitCode,
        output: session.output,
      };
    },
    stop() {
      session.child.kill("SIGKILL");
    },
  };
}

test(
  "SDK nested reads cannot override paused context or reach hooks; next round can read a new file",
  { timeout: 10000 },
  async (t) => {
    const executed = [],
      domainHooks = [],
      extensionHooks = [],
      traces = [];
    const registry = reads(({ path }) => {
      executed.push(path);
      return { text: `source:${path}` };
    });
    const service = {
      store: {
        get: () => ({
          permissions: {
            grants: {
              "process.spawn": true,
              "tools.execute": true,
              "filesystem.read": true,
            },
          },
          extensions: { image: "synthetic-fixture" },
        }),
        trace(_id, _run, event) {
          traces.push(event);
        },
      },
      domain: {
        beforeTool({ args }) {
          domainHooks.push(args.path);
        },
      },
      extensions: {
        runner: childRunner(t),
        async runHooks(_id, event) {
          extensionHooks.push(event);
        },
      },
    };
    const paused = Object.freeze(["read_file"]);
    await assert.rejects(
      registry.execute(
        "read_file",
        { path: "old.txt", pausedTools: [] },
        { pausedTools: paused },
        permissions,
      ),
      { code: "TOOL_RECOVERY_PAUSED" },
    );
    const blocked = await executeCode(
      service,
      "synthetic-owner",
      registry,
      "try { await tools.read_file({path:'old.txt', pausedTools:[]}); return {bypassed:true}; } catch(error) { return {bypassed:false,error:error.message}; }",
      { pausedTools: paused },
    );
    assert.equal(blocked.value.bypassed, false);
    assert.match(blocked.value.error, /本轮重新规划阶段/);
    assert.deepEqual(executed, []);
    assert.deepEqual(domainHooks, []);
    assert.deepEqual(extensionHooks, []);
    assert.equal(traces.length, 1);
    assert.ok(traces[0].reply.error);
    const normal = await executeCode(
      service,
      "synthetic-owner",
      registry,
      "return await tools.read_file({path:'new.txt'});",
      { pausedTools: Object.freeze([]) },
    );
    assert.equal(normal.value.text, "source:new.txt");
    assert.deepEqual(executed, ["new.txt"]);
    assert.deepEqual(domainHooks, ["new.txt"]);
    assert.deepEqual(extensionHooks, ["tool_start", "tool_end"]);
    assert.deepEqual(paused, ["read_file"]);
  },
);
