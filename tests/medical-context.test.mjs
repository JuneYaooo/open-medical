import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";
import { MedicalRuntime } from "../server/runtime.mjs";
import { SkillRegistry } from "../server/skills.mjs";
import { MaterialLibrary } from "../server/medical/materials.mjs";
import { LanceVectorStore } from "../server/medical/vector-store.mjs";

test("context archives roundtrip, page back and die with the session", () => {
  const store = new Store(":memory:");
  const session = store.create({});
  const payload = [{ role: "user", content: "早期对话内容" }];
  const ref = store.archive(session.id, "run-1", payload);
  assert.ok(ref.id);
  assert.equal(ref.chars, JSON.stringify(payload).length);

  const page = store.readArchive(session.id, ref.id, 0, 10);
  assert.equal(page.total, ref.chars);
  assert.equal(page.hasMore, true);
  const full = store.readArchive(session.id, ref.id);
  assert.equal(full.chunk, JSON.stringify(payload));
  assert.equal(full.hasMore, false);

  assert.throws(
    () => store.readArchive("another-session", ref.id),
    /归档不存在或不属于当前会话/,
  );
  assert.throws(
    () => store.readArchive(session.id, ref.id, -1),
    /归档读取范围无效/,
  );
  store.delete(session.id);
  assert.throws(() => store.readArchive(session.id, ref.id), /不存在/);
  store.close();
});

test("long medical sessions compact and continue instead of failing with CONTEXT_LIMIT", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const calls = [];
  const filler = "检查与观察记录。".repeat(400);
  const provider = {
    apiKey: "synthetic",
    model: "synthetic",
    async complete(messages) {
      calls.push(messages);
      if (messages[0]?.content?.includes("历史压缩器"))
        return {
          message: {
            role: "assistant",
            content: "此前对话围绕合成资料整理展开，无未决事项。",
          },
        };
      if (calls.length === 1)
        return {
          message: { role: "assistant", content: filler },
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        };
      return { message: { role: "assistant", content: "已完成。" } };
    },
  };
  const runtime = new MedicalRuntime(store, provider, {
    maxContextChars: 4000,
    maxRounds: 4,
  });
  const session = store.create({});
  const first = runtime.prepare(session.id, {
    message: "第一轮任务",
    mode: "model",
    externalConsent: true,
  });
  await runtime.execute(first);
  const second = runtime.prepare(session.id, {
    message: "第二轮任务",
    mode: "model",
    externalConsent: true,
  });
  const result = await runtime.execute(second);
  assert.equal(result.status, "completed");
  // 压缩器确实被调用，且后续请求带上了摘要而不是原始长历史。
  assert.ok(
    calls.some((m) => m[0]?.content?.includes("历史压缩器")),
    "compaction summarizer should run",
  );
  const finalRequest = calls.findLast(
    (m) => !m[0]?.content?.includes("历史压缩器"),
  );
  assert.ok(JSON.stringify(finalRequest).includes("历史摘要"));
  assert.ok(
    !JSON.stringify(finalRequest).includes(filler),
    "raw oversized history should be compacted away",
  );
  assert.ok(
    store.db.prepare("SELECT COUNT(*) n FROM context_archives").get().n >= 1,
  );
});

test("read_context_archive returns archived text scoped to the session", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const session = store.create({});
  const ref = store.archive(session.id, "seed-run", {
    note: "合成归档中的原始记录",
  });
  const calls = [];
  const provider = {
    apiKey: "synthetic",
    model: "synthetic",
    async complete(messages) {
      calls.push(messages);
      if (calls.length === 1)
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-archive",
                function: {
                  name: "read_context_archive",
                  arguments: JSON.stringify({
                    archiveId: ref.id,
                    offset: 0,
                    limit: 16000,
                  }),
                },
              },
            ],
          },
        };
      return { message: { role: "assistant", content: "已读回归档。" } };
    },
  };
  const runtime = new MedicalRuntime(store, provider, { maxContextChars: 40000 });
  const handle = runtime.prepare(session.id, {
    message: "读取归档内容",
    mode: "model",
    externalConsent: true,
  });
  const result = await runtime.execute(handle);
  assert.equal(result.status, "completed");
  assert.ok(
    JSON.stringify(calls[1]).includes("合成归档中的原始记录"),
    "tool result should carry the archived chunk",
  );
});

const bagVector = (value) => {  const vector = new Array(16).fill(0);
  for (const ch of value) vector[ch.codePointAt(0) % 16] += 1;
  const total = Math.max(1, value.length);
  return vector.map((x) => x / total);
};
const stubEmbedder = {
  available: () => true,
  model: "test-embedder",
  embed: async (inputs) => inputs.map(bagVector),
};

test("material library merges semantic and keyword hits, scoped to run sources", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omw-materials-"));
  const library = new MaterialLibrary(
    stubEmbedder,
    LanceVectorStore.create(dir),
  );
  const report = {
    id: "f1",
    name: "血报告.txt",
    text: "血糖 7.8 mmol/L\n糖化血红蛋白 6.8%\n血压 130/85",
  };
  const ingest = await library.ingest(report);
  assert.equal(ingest.embedded, 1);
  const sources = [{ ...report, hash: "h1" }];
  const hits = await library.search({ sources, query: "血糖" });
  assert.equal(hits.mode, "semantic+keyword");
  assert.equal(hits.count, 1);
  assert.equal(hits.matches[0].fileId, "f1");
  assert.equal(hits.matches[0].startLine, 1);

  const other = { id: "f2", name: "其他.txt", text: "血糖相关的其他记录" };
  await library.ingest(other);
  const scoped = await library.search({ sources, query: "血糖" });
  assert.ok(scoped.matches.every((m) => m.fileId === "f1"));

  await library.remove("f1");
  const keywordOnly = await library.search({ sources, query: "血糖" });
  assert.equal(keywordOnly.mode, "keyword");
  assert.equal(keywordOnly.count, 1);

  assert.rejects(
    () => library.search({ sources: [], query: "血糖" }),
    /没有可检索的材料/,
  );
});

test("material caps are budget-backed, not the old hardcoded numbers", () => {
  const store = new Store(":memory:");
  const runtime = new MedicalRuntime(store, {
    apiKey: "synthetic",
    model: "synthetic",
  });
  const session = store.create({});
  const big = "血糖记录，".repeat(45000);
  assert.ok(big.length > 200000, "precondition: larger than the old 200KB era");
  const file = runtime.addFile(session.id, { name: "big.txt", text: big });
  assert.ok(file.text.length <= 400000);
  assert.throws(
    () =>
      runtime.addFile(session.id, {
        name: "huge.txt",
        text: "x".repeat(400001),
      }),
    /400000/,
  );
  for (let i = 0; i < 99; i++)
    runtime.addFile(session.id, { name: `f${i}.txt`, text: `内容${i}` });
  assert.throws(
    () => runtime.addFile(session.id, { name: "over.txt", text: "x" }),
    { code: "FILE_LIMIT" },
  );
  assert.throws(
    () =>
      runtime.prepare(session.id, {
        message: "整理",
        mode: "local",
        fileIds: Array.from({ length: 101 }, (_, i) => `id-${i}`),
      }),
    /最多选择 100/,
  );
  store.close();
});

test("pinned @skills validate and reach the model system context", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const skills = new SkillRegistry(["skills"]);
  const calls = [];
  const provider = {
    apiKey: "synthetic",
    model: "synthetic",
    async complete(messages) {
      calls.push(messages);
      return { message: { role: "assistant", content: "好的。" } };
    },
  };
  const runtime = new MedicalRuntime(store, provider, {
    maxContextChars: 40000,
    skills,
  });
  const session = store.create({});
  assert.throws(
    () =>
      runtime.prepare(session.id, {
        message: "x",
        mode: "model",
        externalConsent: true,
        skills: ["no-such-skill"],
      }),
    { code: "SKILL_NOT_FOUND" },
  );
  assert.throws(
    () =>
      runtime.prepare(session.id, {
        message: "x",
        mode: "model",
        externalConsent: true,
        skills: ["a", "b", "c", "d"],
      }),
    /最多固定 3 个/,
  );
  const handle = runtime.prepare(session.id, {
    message: "按技能写出院记录",
    mode: "model",
    externalConsent: true,
    skills: ["discharge-summary"],
  });
  const result = await runtime.execute(handle);
  assert.equal(result.status, "completed");
  assert.ok(
    JSON.stringify(calls[0][0]).includes("明确固定了技能"),
    "pinned skills should be injected into the system context",
  );
  assert.deepEqual(store.get(session.id).runs[0].skills, [
    "discharge-summary",
  ]);
});
