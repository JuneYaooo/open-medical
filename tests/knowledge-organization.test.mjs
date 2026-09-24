import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fixture } from "./helpers.mjs";
import {
  validateKnowledgeBatch,
  splitKnowledge,
} from "../server/medical/knowledge-organizer.mjs";
import {
  sourceLines,
  subtitles,
  transcribe,
} from "../server/medical/knowledge-media.mjs";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  organizerProvider,
  library,
  upload,
  waitJob,
} from "./knowledge-organization-helpers.mjs";
test("background upload creates grounded graph, source navigation, dedupes and cleans up on deletion", async (t) => {
  const f = await fixture(t, { provider: organizerProvider });
  const name = await library(f);
  const denied = await upload(
    f,
    name,
    "合成.txt",
    "合成疾病讨论合成检查。",
    false,
  );
  assert.equal(denied.status, 412);
  const submitted = await upload(f, name, "合成.txt", "合成疾病讨论合成检查。");
  assert.equal(submitted.status, 202);
  const job = await waitJob(f, submitted.data.id);
  assert.equal(job.status, "completed", job.error);
  assert.equal(job.batchDone, 1);
  const map = (
    await f.json("/api/knowledge/map?collection=" + encodeURIComponent(name))
  ).data;
  assert.equal(map.nodes.length, 2);
  assert.equal(map.edges.length, 1);
  assert.match(map.edges[0].quote, /合成疾病/);
  const duplicate = await upload(
    f,
    name,
    "同内容.txt",
    "合成疾病讨论合成检查。",
  );
  assert.equal(duplicate.data.duplicate, true);
  assert.equal(f.server.guidelines.list().length, 1);
  const ticket = (
    await f.json(
      "/api/knowledge/organization/" + job.id + "/playback",
      "POST",
      {},
    )
  ).data.url;
  const part = await fetch(f.origin + ticket, {
    headers: { Range: "bytes=0-5" },
  });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 6);
  assert.equal(
    (await fetch(f.origin + "/api/knowledge/organization")).status,
    401,
  );
  const collections = (await f.json("/api/knowledge/collections")).data
    .collections;
  assert.equal(
    (
      await f.json(
        "/api/knowledge/collections/" + encodeURIComponent(name),
        "DELETE",
        { deletionToken: collections[0].deletionToken },
      )
    ).status,
    200,
  );
  assert.equal(f.server.knowledgeOrganizer.list().length, 0);
  assert.equal((await fetch(f.origin + ticket)).status, 401);
  assert.equal(existsSync(f.server.knowledgeOrganizer.folder(job.id)), false);
});
test("audio progress resumes only unfinished chunks; missing configuration retains original", async (t) => {
  let configured = false,
    secondFails = true;
  const calls = [];
  const f = await fixture(t, {
    provider: organizerProvider,
    knowledgeOrganizerOptions: {
      getTranscription: () =>
        configured
          ? { model: "whisper-1", baseUrl: "http://127.0.0.1:1/v1" }
          : null,
      media: async () => ({ duration: 610, hasAudio: true, hasVideo: true }),
      audio: async (_p, folder, index) => join(folder, "fake-" + index),
      transcribeImpl: async (_p, _c, start, length) => {
        calls.push(start);
        if (start === 300 && secondFails) throw new Error("合成分段失败");
        return [
          {
            start,
            end: start + length,
            text: "合成疾病讨论合成检查。",
            kind: "speech",
            timing: "segment",
          },
        ];
      },
      frame: async (_p, _f, index, start) => ({
        start,
        text: "合成课件讨论合成检查。",
        kind: "frame",
        frame: "frame-" + index + ".jpg",
        timing: "sample",
      }),
    },
  });
  const name = await library(f),
    created = await upload(
      f,
      name,
      "讲座.mp4",
      Buffer.from("synthetic fixture"),
    );
  let job = await waitJob(f, created.data.id);
  assert.equal(job.status, "needs_input");
  assert.ok(existsSync(job.sourcePath));
  configured = true;
  f.server.knowledgeOrganizer.retry(job.id, { externalConsent: true });
  job = await waitJob(f, job.id);
  assert.equal(job.status, "failed");
  assert.equal(job.audioDone, 1);
  secondFails = false;
  f.server.knowledgeOrganizer.retry(job.id, { externalConsent: true });
  job = await waitJob(f, job.id);
  assert.equal(job.status, "completed", job.error);
  assert.deepEqual(calls, [0, 300, 300, 600]);
  assert.equal(job.framesDone, 21);
  const detail = f.server.knowledgeOrganizer.detail(job.docId);
  assert.ok(detail.locators.some((l) => l.kind === "frame"));
  assert.ok(detail.locators.some((l) => l.start === 600));
  const pub = f.server.knowledgeOrganizer.list()[0];
  assert.equal(pub.sourcePath, undefined);
  assert.equal(pub.parts, undefined);
});
test("unconfigured organizer keeps searchable text; cancellation prevents further graph writes", async (t) => {
  const f = await fixture(t, {
    provider: { provider: "stub", model: "stub", apiKey: "" },
  });
  const name = await library(f),
    created = await upload(f, name, "先保存.txt", "合成资料讨论检查。");
  const job = await waitJob(f, created.data.id);
  assert.equal(job.status, "needs_input");
  assert.ok(job.docId);
  assert.equal(
    (await f.server.guidelines.search({ query: "合成资料" })).hits.length,
    1,
  );
  await f.json("/api/knowledge/organization/" + job.id + "/cancel", "POST", {});
  assert.equal(f.server.knowledgeOrganizer.get(job.id).status, "cancelled");
});
test("quotes and cross-batch invented links are rejected; subtitle timing remains explicit", () => {
  const batch = { startLine: 10, endLine: 10, text: "原文讨论甲和乙的关系。" };
  assert.throws(
    () =>
      validateKnowledgeBatch(
        {
          title: "主题",
          summary: "摘要",
          nodes: [
            {
              label: "甲",
              type: "疾病",
              quote: "原文没有这些话",
              startLine: 10,
              endLine: 10,
            },
          ],
          relations: [],
        },
        batch,
      ),
    /连续原文/,
  );
  assert.throws(
    () =>
      validateKnowledgeBatch(
        {
          title: "主题",
          summary: "摘要",
          nodes: [],
          relations: [
            {
              from: "甲",
              to: "乙",
              relation: "导致",
              quote: batch.text,
              startLine: 10,
              endLine: 10,
            },
          ],
        },
        batch,
      ),
    /不同节点/,
  );
  const parts = subtitles(
    "1\n00:00:01,000 --> 00:00:04,000\n合成疾病讨论合成检查。\n\n2\n00:00:06,500 --> 00:00:10,000\n合成字幕。",
  );
  assert.equal(parts[1].start, 6.5);
  const prepared = sourceLines(parts);
  assert.ok(prepared.text.includes("00:00:01"));
  assert.equal(prepared.locators[1].startLine, 3);
  const batches = splitKnowledge("文字\n".repeat(201));
  assert.equal(batches.length, 3);
  assert.equal(batches[1].startLine, 101);
});
test("transcription adapter sends bounded multipart and preserves timestamp or chunk precision", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "omw-transcription-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "audio.m4a");
  await writeFile(path, "fixture");
  const signal = new AbortController().signal;
  const cfg = {
    model: "whisper-1",
    baseUrl: "https://example.org/v1",
    apiKey: "synthetic",
  };
  const segments = await transcribe(
    path,
    cfg,
    300,
    30,
    signal,
    async (url, options) => {
      assert.equal(url, "https://example.org/v1/audio/transcriptions");
      assert.equal(options.body.get("response_format"), "verbose_json");
      assert.equal(options.body.get("timestamp_granularities[]"), "segment");
      return new Response(
        JSON.stringify({ segments: [{ start: 1, end: 2, text: "合成转写" }] }),
      );
    },
  );
  assert.equal(segments[0].start, 301);
  assert.equal(segments[0].timing, "segment");
  const approximate = await transcribe(
    path,
    { ...cfg, model: "custom" },
    0,
    30,
    signal,
    async () => new Response(JSON.stringify({ text: "合成转写" })),
  );
  assert.equal(approximate[0].timing, "chunk");
  assert.equal(approximate[0].end, 30);
});
test("moving organized documents preserves original ownership when old library is deleted", async (t) => {
  const f = await fixture(t, { provider: organizerProvider });
  const old = await library(f, "原库"),
    next = await library(f, "新库");
  const created = await upload(f, old, "合成.txt", "合成疾病讨论合成检查。");
  const job = await waitJob(f, created.data.id);
  const doc = f.server.guidelines.get(job.docId);
  f.server.guidelines.updateMetadata(doc.id, {
    expectedRevision: doc.revision,
    collection: next,
  });
  assert.equal(f.server.knowledgeOrganizer.list(next).length, 1);
  const list = (await f.json("/api/knowledge/collections")).data.collections;
  assert.equal(
    (
      await f.json(
        "/api/knowledge/collections/" + encodeURIComponent(old),
        "DELETE",
        { deletionToken: list.find((c) => c.name === old).deletionToken },
      )
    ).status,
    200,
  );
  assert.ok(existsSync(job.sourcePath));
  assert.equal(f.server.knowledgeOrganizer.graph(next).nodes.length, 2);
  assert.equal(
    (await f.json("/api/knowledge/" + doc.id, "DELETE")).status,
    200,
  );
  assert.equal(existsSync(job.sourcePath), false);
  assert.equal(f.server.knowledgeOrganizer.graph(next).nodes.length, 0);
});
test("stopped uploads can resume or be discarded without orphan originals", async (t) => {
  const f = await fixture(t, {
    knowledgeOrganizerOptions: {
      media: async () => ({ duration: 10, hasAudio: true, hasVideo: false }),
      getTranscription: () => null,
    },
  });
  const name = await library(f),
    created = await upload(f, name, "合成.mp3", "synthetic");
  const job = await waitJob(f, created.data.id);
  assert.equal(job.status, "needs_input");
  f.server.knowledgeOrganizer.cancel(job.id);
  f.server.knowledgeOrganizer.retry(job.id, { externalConsent: true });
  assert.equal((await waitJob(f, job.id)).status, "needs_input");
  assert.equal(
    (await f.json("/api/knowledge/organization/" + job.id, "DELETE")).status,
    200,
  );
  assert.equal(existsSync(job.sourcePath), false);
});
