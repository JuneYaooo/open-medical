import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceDatabase, WorkspaceService } from "../server/core/index.mjs";
import { AgentTeam } from "../server/core/agent-team.mjs";
import { compactContext } from "../server/core/context-manager.mjs";

const answer = (content) => ({ message: { role: "assistant", content } });
const call = (name, args) => ({
  message: {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call-" + name,
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  },
});
function fixture(t, provider) {
  const dir = mkdtempSync(join(tmpdir(), "agent-capabilities-"));
  const root = join(dir, "project");
  mkdirSync(root);
  const db = new WorkspaceDatabase(join(dir, "agent.sqlite"));
  const service = new WorkspaceService(db.db, {
    apiKey: "synthetic",
    model: "test",
    ...provider,
  });
  const w = service.create({ root, directoryConsent: true });
  const prepare = (message = "task", extra = {}) =>
    service.prepare(w.id, {
      message,
      externalConsent: true,
      revision: service.get(w.id).revision,
      ...extra,
    });
  t.after(async () => {
    await service.extensions.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    service,
    db,
    id: w.id,
    root,
    prepare,
    run: (message, extra) => service.execute(prepare(message, extra)),
  };
}

test("automatic compaction preserves latest requirements and archived originals across future turns", async (t) => {
  let summaries = 0;
  const f = fixture(t, {
    async complete(messages) {
      if (messages[0].content.includes("会话历史压缩器")) {
        summaries++;
        return answer("目标：逐步整理资料。已完成前几步，保留当前请求。");
      }
      assert.ok(
        messages.some((m) => m.role === "user" && m.content.startsWith("任务")),
      );
      assert.ok(JSON.stringify(messages).length <= 10000);
      return answer("工作结果" + "a".repeat(1800));
    },
  });
  for (let n = 0; n < 9; n++)
    assert.equal(
      (await f.run("任务" + n, { limits: { maxContextChars: 10000 } })).status,
      "completed",
    );
  assert.ok(summaries > 0);
  const summaryTrace = f.db.db.prepare("SELECT data FROM agent_trace WHERE workspace_id=? AND json_extract(data, '$.phase')='compaction'")
    .all(f.id).map((r) => JSON.parse(r.data));
  assert.equal(summaryTrace.filter((e) => e.type === "model.request").length, summaries);
  assert.equal(summaryTrace.filter((e) => e.type === "model.response").length, summaries);
  assert.ok(summaryTrace.every((e) => e.archiveId && e.fragment >= 1));
  assert.ok(summaryTrace.filter((e) => e.type === "model.response").every((e) => e.durationMs >= 0));
  const events = f.service.store.events(f.id);
  const compact = events.find((e) => e.type === "context.compacted");
  assert.ok(compact.payload.afterChars < compact.payload.beforeChars);
  const original = await f.service.tool(f.id, {
    tool: "read_context_archive",
    arguments: { archiveId: compact.payload.archiveId, limit: 16000 },
  });
  assert.match(original.text, /任务0/);
  const w = f.service.get(f.id);
  assert.equal(w.runs.at(-1).contextMessages, undefined);
  assert.ok(f.service.store.trajectory(f.id, w.runs.at(-1).id).length > 0);
  f.service.provider.model = "other";
  await assert.rejects(
    f.service.tool(f.id, {
      tool: "read_context_archive",
      arguments: { archiveId: original.id },
    }),
    (e) => e.code === "CONTEXT_ACCESS",
  );
});

test("compaction preserves tool batches, rejects invalid summaries without replacing source", async () => {
  const messages = [
    { role: "system", content: "system" },
    { role: "user", content: "original goal" },
    { role: "assistant", content: "x".repeat(9000) },
    { role: "user", content: "latest requirement" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "tool1", function: { name: "read", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "tool1", content: "evidence" },
  ];
  let archived;
  const args = {
    messages,
    provider: { complete: async () => answer("old goal and facts") },
    model: "test",
    maxChars: 10000,
    signal: new AbortController().signal,
    archive: (v) => {
      archived = structuredClone(v);
      return { id: "archive" };
    },
  };
  const result = await compactContext(args);
  assert.deepEqual(result.messages.slice(-3), messages.slice(-3));
  assert.deepEqual(archived, messages);
  await assert.rejects(
    compactContext({
      ...args,
      provider: { complete: async () => call("unsafe", {}) },
    }),
    (e) => e.code === "COMPACTION_RESPONSE",
  );
  assert.equal(messages[2].content.length, 9000);
});

test("steering during a model request is persisted, idempotent and consumed before finishing", async (t) => {
  let release, entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let count = 0;
  const f = fixture(t, {
    async complete(messages) {
      if (++count === 1) {
        entered();
        await gate;
        return answer("first answer");
      }
      assert.ok(messages.some((m) => m.content === "追加：输出中文"));
      return answer("已按新要求完成");
    },
  });
  const handle = f.prepare();
  const execution = f.service.execute(handle);
  await ready;
  assert.throws(
    () => f.service.steer(f.id, { runId: handle.run.id, message: "x" }),
    (e) => e.code === "CONSENT_REQUIRED",
  );
  const body = {
    runId: handle.run.id,
    message: "追加：输出中文",
    externalConsent: true,
    requestId: "input-1",
  };
  const first = f.service.steer(f.id, body);
  assert.equal(f.service.steer(f.id, body).id, first.id);
  release();
  assert.equal((await execution).status, "completed");
  const w = f.service.get(f.id);
  assert.equal(w.runs.at(-1).inputs.length, 1);
  assert.equal(w.runs.at(-1).inputs[0].status, "consumed");
  assert.equal(count, 2);
});

test("asynchronous writer agents create scoped proposals and dependent readers receive results", async (t) => {
  const f = fixture(t, {
    async complete(messages) {
      const task = messages.find((m) => m.role === "user").content;
      if (task.startsWith("write")) {
        if (!messages.some((m) => m.role === "tool"))
          return call("propose_file_write", {
            path: "result.txt",
            content: "hello",
          });
        assert.match(messages.at(-1).content, /pending/);
        return answer("writer complete");
      }
      assert.match(task, /writer complete/);
      return answer("review complete");
    },
  });
  f.service.update(f.id, {
    revision: f.service.get(f.id).revision,
    profile: "standard",
    allowWrite: true,
  });
  const handle = f.prepare();
  const team = new AgentTeam(
    f.service,
    f.id,
    handle.run.id,
    handle.controller.signal,
    () => {},
    () => {},
  );
  f.service.teams.set(f.id, team);
  const writer = team.spawn({
    task: "write",
    role: "writer",
    writePaths: ["result.txt"],
  });
  assert.throws(
    () =>
      team.spawn({
        task: "conflict",
        role: "writer",
        writePaths: ["result.txt"],
      }),
    (e) => e.code === "AGENT_CONFLICT",
  );
  const reader = team.spawn({ task: "review", dependsOn: [writer.id] });
  const results = await team.wait([writer.id, reader.id], 2000);
  assert.ok(results.every((r) => r.status === "completed"));
  const proposals = f.service.get(f.id).approvals;
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].status, "pending");
  await team.close();
  f.service.teams.delete(f.id);
  f.service.active.delete(f.id);
});

test("writer escape fails as a tool error without producing a proposal", async (t) => {
  const f = fixture(t, {
    async complete(messages) {
      if (!messages.some((m) => m.role === "tool"))
        return call("propose_file_write", {
          path: "other.txt",
          content: "escape",
        });
      assert.match(messages.at(-1).content, /AGENT_SCOPE/);
      return answer("could not write");
    },
  });
  f.service.update(f.id, {
    revision: f.service.get(f.id).revision,
    profile: "standard",
    allowWrite: true,
  });
  const handle = f.prepare();
  const team = new AgentTeam(
    f.service,
    f.id,
    handle.run.id,
    handle.controller.signal,
    () => {},
    () => {},
  );
  f.service.teams.set(f.id, team);
  const job = team.spawn({
    task: "write",
    role: "writer",
    writePaths: ["allowed.txt"],
  });
  await team.wait([job.id], 2000);
  assert.equal(f.service.get(f.id).approvals.length, 0);
  await team.close();
  f.service.active.delete(f.id);
  f.service.teams.delete(f.id);
});

test("resume uses complete compacted checkpoint, without duplicated previous context", async (t) => {
  let n = 0;
  const f = fixture(t, {
    async complete(messages) {
      if (++n === 1) return call("read_file", { path: "a.txt" });
      if (n === 2) throw new Error("interrupted");
      assert.equal(messages.filter((m) => m.role === "tool").length, 1);
      return answer("done");
    },
  });
  writeFileSync(join(f.root, "a.txt"), "data");
  assert.equal((await f.run("start")).status, "failed");
  const previous = f.service.get(f.id).runs.at(-1);
  assert.equal(previous.canResume, true);
  assert.equal(
    (await f.run("resume", { resumeRunId: previous.id })).status,
    "completed",
  );
  assert.equal((await f.run("next")).status, "completed");
});

test("cancelling a running agent blocks dependent jobs without executing them", async (t) => {
  let started,
    count = 0;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const f = fixture(t, {
    async complete(_messages, _tools, { signal }) {
      count++;
      started();
      await new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });
  const handle = f.prepare();
  const team = new AgentTeam(
    f.service,
    f.id,
    handle.run.id,
    handle.controller.signal,
    () => {},
    () => {},
  );
  f.service.teams.set(f.id, team);
  const first = team.spawn({ task: "long task" });
  const dependent = team.spawn({ task: "dependent", dependsOn: [first.id] });
  await ready;
  team.cancel(first.id);
  const jobs = await team.wait([first.id, dependent.id], 2000);
  assert.equal(jobs[0].status, "cancelled");
  assert.equal(jobs[1].status, "blocked");
  assert.equal(count, 1);
  await team.close();
  f.service.teams.delete(f.id);
  f.service.active.delete(f.id);
});

test("dependent writers may hand off a file while unrelated aliases and parent paths remain locked", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, {
    async complete(messages) {
      await gate;
      const task = messages.find((m) => m.role === "user").content;
      if (messages.some((m) => m.role === "tool")) return answer("writer done");
      if (task.startsWith("first")) return call("propose_file_write", { path: "result.txt", content: "first" });
      return call("revise_file_proposal", { approvalId: f.service.get(f.id).approvals.at(-1).id, content: "second" });
    },
  });
  f.service.update(f.id, { revision: f.service.get(f.id).revision, profile: "standard", allowWrite: true });
  const handle = f.prepare();
  const team = new AgentTeam(f.service, f.id, handle.run.id, handle.controller.signal, () => {}, () => {});
  f.service.teams.set(f.id, team);
  try {
    const first = team.spawn({ task: "first", role: "writer", writePaths: ["result.txt"] });
    const second = team.spawn({ task: "second", role: "writer", writePaths: ["result.txt"], dependsOn: [first.id] });
    assert.doesNotThrow(() => f.service.assertWriteScope(f.id, "result.txt", first.id));
    assert.throws(() => team.spawn({ task: "parent conflict", role: "writer", writePaths: ["result.txt/child"] }), { code: "AGENT_CONFLICT" });
    if (["darwin", "win32"].includes(process.platform))
      assert.throws(() => team.spawn({ task: "case conflict", role: "writer", writePaths: ["Result.txt"] }), { code: "AGENT_CONFLICT" });
    release();
    const result = await team.wait([first.id, second.id], 2000);
    assert.ok(result.every((job) => job.status === "completed"));
    const approvals = f.service.get(f.id).approvals;
    assert.equal(approvals[0].status, "revoked");
    assert.equal(approvals[1].content, "second");
  } finally { release(); await team.close(); f.service.teams.delete(f.id); f.service.active.delete(f.id); }
});

test('long task runs through automatic chunking and original input remains readable from the authorized archive', async t => {
  const input = 'Only explain; never write. BEGIN\n' + 'synthetic source row, value 12.5 mg.\n'.repeat(1500) + 'END exact requirement';
  const parts = [];
  const f = fixture(t, { async complete(messages) {
    if (messages[0].content.includes('长输入分片压缩器')) {
      parts.push(JSON.parse(messages.at(-1).content).part.text);
      return answer('Only explain; no write authorized. Synthetic value 12.5 mg. BEGIN and END retained.');
    }
    if (messages[0].content.includes('会话历史压缩器')) return answer('Historical notes.');
    assert.ok(messages.some(m => m.content?.includes('当前任务输入的有损摘要')));
    return answer('Long input completed without writes.');
  }});
  const result = await f.run(input, { limits: { maxContextChars: 10000 } });
  assert.equal(result.status, 'completed', result.error);
  assert.ok(parts.length > 1); assert.ok(parts.join('') === input);
  const event = f.service.store.events(f.id).find(e => e.type === 'context.compacted');
  assert.equal(event.payload.inputChars, input.length);
  let text = '', offset = 0;
  do {
    const page = await f.service.tool(f.id, {tool:'read_context_archive', arguments:{archiveId:event.payload.archiveId, offset, limit:16000}});
    text += page.text; offset = page.nextOffset;
  } while (offset !== null);
  assert.ok(JSON.parse(text).some(m => m.role === 'user' && m.content === input));
  assert.equal(f.service.get(f.id).approvals.length, 0);
});
