import { randomUUID, createHash } from "node:crypto";
import { mkdir, rm, open } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { AgentRuntime } from "../core/agent-runtime.mjs";
import { ToolRegistry } from "../core/tool-registry.mjs";
import { PermissionEngine } from "../core/permissions.mjs";
import { check, string, AppError } from "../errors.mjs";
import { providerConfigured } from "../core/provider-status.mjs";
import { visionTranscriber } from "../core/image-text.mjs";
import {
  MEDIA_EXTENSIONS,
  KNOWLEDGE_EXTENSIONS,
  mediaAvailable,
  extractDocument,
  nativeJson,
  extractAudioChunk,
  extractFrame,
  transcribe,
  sourceLines,
} from "./knowledge-media.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const skill = readFileSync(
  resolve(import.meta.dirname, "../../skills/knowledge-organizer/SKILL.md"),
  "utf8",
);
const sourceKinds = ["资料", "指南/共识", "课程/讲座", "病例报告", "笔记/经验"];
const types = ["疾病", "阶段", "检查", "治疗", "药物", "随访", "主题"];
const terminal = new Set(["completed", "cancelled"]);
export function splitKnowledge(text) {
  const lines = text.split("\n"),
    batches = [];
  let current = [],
    start = 1,
    size = 0;
  for (let i = 0; i < lines.length; i++) {
    if (
      current.length &&
      (size + lines[i].length > 12000 || current.length >= 100)
    ) {
      batches.push({ startLine: start, endLine: i, text: current.join("\n") });
      current = [];
      size = 0;
      start = i + 1;
    }
    current.push(lines[i]);
    size += lines[i].length + 1;
  }
  if (current.length)
    batches.push({
      startLine: start,
      endLine: lines.length,
      text: current.join("\n"),
    });
  return batches;
}
export function validateKnowledgeBatch(value, batch) {
  check(
    value && typeof value === "object",
    "KNOWLEDGE_OUTPUT",
    "整理结果格式无效",
  );
  const title = string(value.title, "主题", 100),
    summary = string(value.summary, "摘要", 1000);
  check(
    Array.isArray(value.nodes) &&
      value.nodes.length <= 12 &&
      Array.isArray(value.relations) &&
      value.relations.length <= 16,
    "KNOWLEDGE_OUTPUT",
    "知识节点或关系超出本批限制",
  );
  const lines = batch.text.split("\n");
  // 引文不匹配时收集而不是立即抛出：一次性把每处不匹配对应的去空白原文
  // 回给模型，下一次调用照抄即可。PDF 提取文本断行、夹空格频繁，模型靠
  // 猜测逐字引用往往要试两三次，立即抛出会把批次预算耗在重复试探上。
  const citationErrors = [];
  const evidence = (item, kind, label) => {
    const inRange =
      Number.isInteger(item?.startLine) &&
      Number.isInteger(item?.endLine) &&
      item.startLine >= batch.startLine &&
      item.endLine <= batch.endLine &&
      item.endLine >= item.startLine &&
      item.endLine - item.startLine <= 40;
    if (!inRange) {
      citationErrors.push({
        kind,
        label,
        problem: `出处行号须在本批原文内，且不超过 40 行（当前 startLine/endLine：${item?.startLine}/${item?.endLine}，本批 L${batch.startLine}–L${batch.endLine}）`,
      });
      return null;
    }
    const quote = string(item.quote, "连续原文", 800);
    const reference = lines
      .slice(
        item.startLine - batch.startLine,
        item.endLine - batch.startLine + 1,
      )
      .join("\n")
      .replace(/\s+/g, "");
    if (quote.length >= 4 && reference.includes(quote.replace(/\s+/g, "")))
      return { quote, startLine: item.startLine, endLine: item.endLine };
    citationErrors.push({
      kind,
      label,
      problem: `quote 不是 L${item.startLine}–L${item.endLine} 内的连续原文（至少 4 字）`,
      reference: reference.slice(0, 800),
    });
    return null;
  };
  const nodes = value.nodes.map((n) => {
    check(types.includes(n.type), "KNOWLEDGE_OUTPUT", "节点类别无效");
    const label = string(n.label, "节点名称", 80);
    return { label, type: n.type, ...evidence(n, "节点", label) };
  });
  const labels = new Set(nodes.map((n) => n.label));
  const relations = value.relations.map((r) => {
    check(
      labels.has(r.from) && labels.has(r.to) && r.from !== r.to,
      "KNOWLEDGE_OUTPUT",
      "关系两端必须对应本批不同节点",
    );
    const relation = string(r.relation, "关系", 80);
    return {
      from: r.from,
      to: r.to,
      relation,
      ...evidence(r, "关系", `${r.from}→${r.to}`),
    };
  });
  if (citationErrors.length) {
    const listed = citationErrors.slice(0, 3),
      rest = citationErrors.length - listed.length;
    throw new AppError(
      "KNOWLEDGE_CITATION",
      `引文必须是所指行内的连续原文，不能改写、缩写或用省略号拼接（本批共 ${citationErrors.length} 处不匹配）。校验忽略所有空白；请从下方对应范围的去空白原文中逐字复制一段连续文字作为 quote，startLine/endLine 与该范围保持一致：` +
        listed
          .map(
            (e, i) =>
              `\n${i + 1}.[${e.kind}]${e.label}：${e.problem}。该范围原文（已去空白）：${e.reference || "见上"}`,
          )
          .join("") +
        (rest ? `\n（另有 ${rest} 处不匹配未列出，保存前请逐项自查。）` : ""),
    );
  }
  return { title, summary, nodes, relations };
}
export class KnowledgeOrganizer {
  constructor({
    store,
    library,
    root,
    getProvider,
    getTranscription,
    extract = extractDocument,
    media = nativeJson,
    transcribeImpl = transcribe,
    frame = extractFrame,
    audio = extractAudioChunk,
  }) {
    Object.assign(this, {
      store,
      library,
      root,
      getProvider,
      getTranscription,
      extract,
      media,
      transcribeImpl,
      frame,
      audio,
    });
    this.active = new Map();
    this.stopping = false;
    this.playbacks = new Map();
    this.uploads = 0;
    this.uploadingCollections = new Map();
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS knowledge_jobs(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS knowledge_analysis(doc_id TEXT PRIMARY KEY,data TEXT NOT NULL)",
    );
    for (const job of this.listRaw())
      if (["running", "queued"].includes(job.status))
        this.write({
          ...job,
          status: "interrupted",
          error: "应用已重启。资料和已完成分段已保存，可继续整理。",
        });
  }
  folder(id) {
    check(/^[a-f0-9-]{36}$/.test(id), "INVALID_ID", "资料任务编号无效");
    return join(this.root, id);
  }
  write(job) {
    job.updatedAt = new Date().toISOString();
    this.store.db
      .prepare(
        "INSERT INTO knowledge_jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(job.id, JSON.stringify(job));
    return job;
  }
  get(id) {
    const row = this.store.db
      .prepare("SELECT data FROM knowledge_jobs WHERE id=?")
      .get(id);
    check(row, "NOT_FOUND", "整理任务不存在", 404);
    return JSON.parse(row.data);
  }
  listRaw() {
    return this.store.db
      .prepare("SELECT data FROM knowledge_jobs ORDER BY rowid DESC")
      .all()
      .map((r) => JSON.parse(r.data));
  }
  public(job) {
    const {
      parts: _parts,
      prepared: _prepared,
      sourcePath: _path,
      transcriptionIdentity: _identity,
      ...value
    } = job;
    return {
      ...value,
      hasOriginal: Boolean(job.sourcePath),
      transcriptSegments:
        job.parts?.filter((p) => p.kind === "speech").length || 0,
    };
  }
  list(collection) {
    return this.listRaw()
      .filter((j) => !collection || j.collection === collection)
      .map((j) => this.public(j));
  }
  capabilities() {
    const cfg = this.getTranscription();
    return {
      modelReady: providerConfigured(this.getProvider()),
      mediaReady: mediaAvailable(),
      transcriptionReady: Boolean(cfg?.model),
      transcription: cfg
        ? {
            model: cfg.model,
            baseUrl: cfg.baseUrl,
            hasKey: Boolean(cfg.apiKey),
            timestampFormat: cfg.timestampFormat,
          }
        : null,
      maxFileMB: 250,
      maxDocumentMB: 100,
      maxFilesPerBatch: 200,
      sourceKinds,
    };
  }
  async upload(req, input) {
    check(
      input.externalConsent === true,
      "CONSENT_REQUIRED",
      "请确认使用当前模型整理资料；音轨交由所配置的转写服务处理",
      412,
    );
    const collection = string(input.collection, "知识库名称", 60);
    check(
      this.library.collections().some((c) => c.name === collection),
      "NOT_FOUND",
      "请先创建或选择知识库",
      404,
    );
    const fileName = string(input.name, "文件名", 180),
      ext = extname(fileName).toLowerCase();
    check(
      KNOWLEDGE_EXTENSIONS.has(ext),
      "FILE_TYPE",
      "暂不支持此格式，请使用文档、图片、MP3/M4A/WAV、MP4/MOV 或 SRT/VTT",
    );
    check(
      sourceKinds.includes(input.sourceKind || "资料"),
      "INVALID_INPUT",
      "资料类型无效",
    );
    check(
      this.uploads < 3,
      "UPLOAD_BUSY",
      "已有 3 份资料上传中，请稍后再试",
      429,
    );
    this.uploads++;
    this.uploadingCollections.set(
      collection,
      (this.uploadingCollections.get(collection) || 0) + 1,
    );
    const id = randomUUID(),
      folder = this.folder(id),
      path = join(folder, "source" + ext);
    try {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const handle = await open(path, "wx", 0o600);
      let bytes = 0;
      const digest = createHash("sha256");
      try {
        for await (const chunk of req) {
          bytes += chunk.length;
          check(
            bytes <= (MEDIA_EXTENSIONS.has(ext) ? 250 : 100) * 1024 * 1024,
            "BODY_LIMIT",
            "文件超过容量：音视频 250MB，其他资料 100MB",
            413,
          );
          digest.update(chunk);
          await handle.writeFile(chunk);
        }
      } finally {
        await handle.close();
      }
      check(bytes > 0, "EMPTY_FILE", "文件为空");
      const sha256 = digest.digest("hex");
      const existing = this.listRaw().find(
        (j) =>
          j.collection === collection &&
          j.sha256 === sha256 &&
          j.status !== "cancelled" &&
          (!j.docId || this.library.list().some((d) => d.id === j.docId)),
      );
      if (existing) {
        await rm(folder, { recursive: true });
        return { ...this.public(existing), duplicate: true };
      }
      const job = {
        id,
        collection,
        fileName,
        sourceKind: input.sourceKind || "资料",
        sourcePath: path,
        sha256,
        bytes,
        status: "queued",
        stage: "资料已保存，等待整理",
        createdAt: new Date().toISOString(),
        parts: [],
        batchDone: 0,
        batchTotal: 0,
      };
      this.write(job);
      this.kick();
      return this.public(job);
    } catch (e) {
      await rm(folder, { recursive: true, force: true }).catch(() => {});
      throw e;
    } finally {
      this.uploads--;
      this.uploadingCollections.set(
        collection,
        (this.uploadingCollections.get(collection) || 1) - 1,
      );
    }
  }
  async organizeDocument(docId, input) {
    check(
      input?.externalConsent === true,
      "CONSENT_REQUIRED",
      "请确认使用当前模型整理此资料",
      412,
    );
    check(sourceKinds.includes(input.sourceKind || "资料"), "INVALID_INPUT", "资料类型无效");
    const doc = this.library.docRow(docId);
    const existing = this.listRaw().find(
      (j) => j.docId === docId && !terminal.has(j.status),
    );
    if (existing) {
      if (!this.active.has(existing.id)) this.retry(existing.id, input);
      return this.public(this.get(existing.id));
    }
    const job = {
      id: randomUUID(),
      collection: doc.collection || "默认知识库",
      fileName: doc.fileName || doc.title,
      sourceKind: input.sourceKind || "资料",
      sha256: doc.sha256,
      docId,
      status: "queued",
      stage: "等待整理",
      createdAt: new Date().toISOString(),
      prepared: { text: doc.text, locators: [] },
      parts: [],
      batchDone: 0,
      batchTotal: 0,
    };
    this.store.db
      .prepare("DELETE FROM knowledge_analysis WHERE doc_id=?")
      .run(docId);
    this.write(job);
    this.kick();
    return this.public(job);
  }
  retry(id, input) {
    check(
      input?.externalConsent === true,
      "CONSENT_REQUIRED",
      "请确认继续使用配置的模型与转写服务",
      412,
    );
    const job = this.get(id);
    check(
      !this.active.has(id) && job.status !== "completed",
      "JOB_STATE",
      "此任务无需重试或仍在处理中",
      409,
    );
    check(
      this.library.collections().some((c) => c.name === job.collection),
      "NOT_FOUND",
      "原知识库已删除",
      404,
    );
    this.write({ ...job, status: "queued", error: "", stage: "等待继续整理" });
    this.kick();
    return this.public(this.get(id));
  }
  cancel(id) {
    const job = this.get(id);
    check(job.status !== "completed", "JOB_STATE", "整理已经完成", 409);
    this.write({
      ...job,
      status: "cancelled",
      stage: "已停止，已保存资料仍可查看",
    });
    this.active.get(id)?.controller.abort();
    return this.public(this.get(id));
  }
  kick() {
    if (this.stopping || this.active.size) return;
    const job = this.listRaw()
      .reverse()
      .find((j) => j.status === "queued");
    if (!job) return;
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => this.process(job.id, controller.signal))
      .catch((error) => {
        const current = this.get(job.id);
        if (current.status !== "cancelled")
          this.write({
            ...current,
            status: this.stopping
              ? "interrupted"
              : [
                    "MODEL_NOT_CONFIGURED",
                    "TRANSCRIPTION_CONFIG",
                    "MEDIA_UNAVAILABLE",
                  ].includes(error.code)
                ? "needs_input"
                : "failed",
            error: error.message || "整理未完成",
            stage: "已保存进度，可继续",
          });
      })
      .finally(() => {
        this.active.delete(job.id);
        this.kick();
      });
    this.active.set(job.id, { controller, promise });
  }
  update(id, changes, signal) {
    signal?.throwIfAborted();
    const job = this.get(id);
    check(job.status !== "cancelled", "JOB_CANCELLED", "整理已停止", 409);
    return this.write({ ...job, ...changes });
  }
  async process(id, signal) {
    let job = this.update(
      id,
      { status: "running", error: "", stage: "正在读取资料" },
      signal,
    );
    if (!job.prepared) {
      if (MEDIA_EXTENSIONS.has(extname(job.fileName).toLowerCase())) {
        const info =
          job.mediaInfo ||
          (await this.media("native-media", { path: job.sourcePath }, signal));
        job = this.update(id, { mediaInfo: info }, signal);
        if (info.hasAudio) {
          const config = this.getTranscription();
          check(
            config?.model,
            "TRANSCRIPTION_CONFIG",
            "请配置音频转写服务后继续，原文件无需重新上传",
            409,
          );
          const identity = hash(
            JSON.stringify({ baseUrl: config.baseUrl, model: config.model }),
          );
          check(
            !job.audioDone ||
              !job.transcriptionIdentity ||
              job.transcriptionIdentity === identity,
            "TRANSCRIPTION_CONFIG",
            "转写连接已变化，不能混用两套转写结果。请恢复原连接后继续",
            409,
          );
          job = this.update(id, { transcriptionIdentity: identity }, signal);
          const total = Math.ceil(info.duration / 300);
          for (let index = job.audioDone || 0; index < total; index++) {
            job = this.update(
              id,
              {
                stage: `正在转写第 ${index + 1}/${total} 段`,
                audioTotal: total,
              },
              signal,
            );
            const start = index * 300,
              length = Math.min(300, info.duration - start);
            const path = await this.audio(
              job.sourcePath,
              this.folder(id),
              index,
              start,
              length,
              signal,
            );
            let segments;
            try {
              segments = await this.transcribeImpl(
                path,
                config,
                start,
                length,
                signal,
              );
            } finally {
              await rm(path, { force: true }).catch(() => {});
            }
            job = this.update(
              id,
              { parts: [...job.parts, ...segments], audioDone: index + 1 },
              signal,
            );
          }
        }
        if (info.hasVideo) {
          const total = Math.ceil(info.duration / 30);
          for (let index = job.framesDone || 0; index < total; index++) {
            job = this.update(
              id,
              {
                stage: `正在识别画面 ${index + 1}/${total}`,
                framesTotal: total,
              },
              signal,
            );
            const frame = await this.frame(
              job.sourcePath,
              this.folder(id),
              index,
              index * 30,
              signal,
            );
            job = this.update(
              id,
              { parts: [...job.parts, frame], framesDone: index + 1 },
              signal,
            );
          }
        }
        job.parts.sort((a, b) => (a.start || 0) - (b.start || 0));
      } else {
        // 图片资料回退链的最后一级:本机 OCR 都不可用时,用当前配置的视觉模型转录文字。
        const analyzeImage = visionTranscriber(
          providerConfigured(this.getProvider()) ? this.getProvider() : null,
        );
        job.parts = await this.extract(job.sourcePath, job.fileName, signal, {
          analyzeImage,
        });
      }
      check(
        job.parts.some((p) => p.text?.trim()),
        "EXTRACTION_EMPTY",
        "未能识别可用文字，原文件已保存，请检查音轨或清晰度",
      );
      const prepared = sourceLines(job.parts);
      check(
        prepared.text.length <= 2000000,
        "TEXT_LIMIT",
        "提取内容超过 200 万字符，请拆分资料",
      );
      job = this.update(id, { parts: job.parts, prepared }, signal);
    }
    if (!job.docId) {
      job = this.update(id, { stage: "正在保存全文与检索索引" }, signal);
      let doc;
      try {
        doc = await this.library.addDocument({
          title: job.fileName.replace(/\.[^.]+$/, "").slice(0, 140),
          text: job.prepared.text,
          collection: job.collection,
          kind: job.sourceKind === "指南/共识" ? "指南" : "资料",
          source: MEDIA_EXTENSIONS.has(extname(job.fileName).toLowerCase())
            ? "audio-video"
            : "upload",
          fileName: job.fileName,
        });
      } catch (e) {
        if (e.code !== "CONFLICT") throw e;
        doc = this.library
          .list({ collection: job.collection })
          .find((d) => d.sha256 === hash(job.prepared.text));
        check(doc, "KNOWLEDGE_SAVE", "保存资料失败");
      }
      // Always retain the document receipt even if cancellation arrived during indexing.
      job = this.write({ ...this.get(id), docId: doc.id });
      signal.throwIfAborted();
    }
    const provider = this.getProvider();
    check(
      providerConfigured(provider),
      "MODEL_NOT_CONFIGURED",
      "资料已入库，关键词检索可用。请配置整理模型后继续",
      409,
    );
    const batches = splitKnowledge(job.prepared.text);
    job = this.update(id, { batchTotal: batches.length }, signal);
    for (let index = job.batchDone; index < batches.length; index++) {
      job = this.update(
        id,
        { stage: `正在整理知识 ${index + 1}/${batches.length}` },
        signal,
      );
      const batch = batches[index];
      let saved;
      const registry = new ToolRegistry([
        {
          definition: {
            type: "function",
            function: {
              name: "save_knowledge_batch",
              description: "保存有连续原文依据的知识节点与关系。",
              parameters: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  summary: { type: "string" },
                  nodes: {
                    type: "array",
                    maxItems: 12,
                    items: {
                      type: "object",
                      properties: {
                        label: { type: "string" },
                        type: { type: "string", enum: types },
                        quote: { type: "string" },
                        startLine: { type: "integer" },
                        endLine: { type: "integer" },
                      },
                      required: [
                        "label",
                        "type",
                        "quote",
                        "startLine",
                        "endLine",
                      ],
                      additionalProperties: false,
                    },
                  },
                  relations: {
                    type: "array",
                    maxItems: 16,
                    items: {
                      type: "object",
                      properties: {
                        from: { type: "string" },
                        to: { type: "string" },
                        relation: { type: "string" },
                        quote: { type: "string" },
                        startLine: { type: "integer" },
                        endLine: { type: "integer" },
                      },
                      required: [
                        "from",
                        "to",
                        "relation",
                        "quote",
                        "startLine",
                        "endLine",
                      ],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["title", "summary", "nodes", "relations"],
                additionalProperties: false,
              },
            },
          },
          permission: "filesystem.write",
          capability: { backend: "local" },
          execute: (value) => {
            saved = validateKnowledgeBatch(value, batch);
            return {
              saved: true,
              nodes: saved.nodes.length,
              relations: saved.relations.length,
            };
          },
        },
      ]);
      // 每批是一个小运行：最多 7 轮、6 次真实保存调用。引文校验失败的
      // 重试消耗预算，预算过紧会让大批量资料在压线状态下整批失败。
      await new AgentRuntime({
        provider,
        maxRounds: 7,
        maxToolCalls: 1,
        maxTotalToolCalls: 6,
        maxContextChars: 65000,
      }).run({
        messages: [
          { role: "system", content: skill },
          {
            role: "user",
            content:
              `资料类型：${job.sourceKind}（用户提供，未核验）。文件：${job.fileName}。本批第 ${batch.startLine}–${batch.endLine} 行。\n` +
              batch.text
                .split("\n")
                .map((line, i) => `L${batch.startLine + i}: ${line}`)
                .join("\n"),
          },
        ],
        registry,
        permissions: new PermissionEngine({
          profile: "standard",
          grants: { "filesystem.write": true },
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(240000)]),
        thinking: "disabled",
        domain: {
          // COMPLETE_RETRY：模型没保存就以文字收尾时，运行时把本批打回
          // 再试一轮，而不是让整批失败。
          beforeComplete: () =>
            check(
              saved,
              "COMPLETE_RETRY",
              "尚未成功调用 save_knowledge_batch。若上一次调用因引文或参数被拒，请按返回的错误说明修正后重新调用；保存成功后再简短结束。",
            ),
        },
      });
      signal.throwIfAborted();
      const analysis = this.analysis(job.docId) || {
        docId: job.docId,
        jobId: id,
        sourceKind: job.sourceKind,
        batches: [],
      };
      analysis.batches[index] = {
        ...saved,
        startLine: batch.startLine,
        endLine: batch.endLine,
      };
      analysis.updatedAt = new Date().toISOString();
      this.store.db
        .prepare(
          "INSERT INTO knowledge_analysis VALUES(?,?) ON CONFLICT(doc_id) DO UPDATE SET data=excluded.data",
        )
        .run(job.docId, JSON.stringify(analysis));
      if (index === 0 && job.sourcePath && batches.length === 1) {
        const current = this.library.docRow(job.docId);
        if ((current.revision || 0) === 0)
          this.library.updateMetadata(job.docId, {
            expectedRevision: 0,
            title: saved.title,
          });
      }
      job = this.update(id, { batchDone: index + 1 }, signal);
    }
    this.update(
      id,
      { status: "completed", stage: "整理完成，知识条目待核对" },
      signal,
    );
  }
  analysis(docId) {
    const row = this.store.db
      .prepare("SELECT data FROM knowledge_analysis WHERE doc_id=?")
      .get(docId);
    return row ? JSON.parse(row.data) : null;
  }
  detail(docId) {
    this.library.docRow(docId);
    const job = this.listRaw().find((j) => j.docId === docId);
    return {
      analysis: this.analysis(docId),
      job: job ? this.public(job) : null,
      locators: job?.prepared?.locators || [],
    };
  }
  graph(collection) {
    const docs = this.library
      .list({ collection })
      .filter((d) => d.reviewStatus !== "retired");
    const nodes = new Map(),
      edges = [];
    let analyzed = 0;
    for (const doc of docs) {
      const analysis = this.analysis(doc.id);
      if (!analysis) continue;
      analyzed++;
      for (const batch of analysis.batches) {
        if (!batch) continue;
        for (const node of batch.nodes) {
          const key = hash(
            node.type + ":" + node.label.toLowerCase().trim(),
          ).slice(0, 16);
          const item = nodes.get(key) || {
            id: key,
            label: node.label,
            type: node.type,
            evidence: [],
          };
          item.evidence.push({
            ...node,
            docId: doc.id,
            docTitle: doc.title,
            sourceKind: analysis.sourceKind,
            status: "待核对",
          });
          nodes.set(key, item);
        }
        for (const edge of batch.relations) {
          const from = batch.nodes.find((n) => n.label === edge.from),
            to = batch.nodes.find((n) => n.label === edge.to);
          edges.push({
            ...edge,
            id: hash(JSON.stringify([doc.id, edge])).slice(0, 20),
            from: hash(from.type + ":" + from.label.toLowerCase().trim()).slice(
              0,
              16,
            ),
            to: hash(to.type + ":" + to.label.toLowerCase().trim()).slice(
              0,
              16,
            ),
            docId: doc.id,
            docTitle: doc.title,
            sourceKind: analysis.sourceKind,
            status: "待核对",
          });
        }
      }
    }
    return {
      nodes: [...nodes.values()],
      edges,
      documentCount: docs.length,
      analyzedDocuments: analyzed,
    };
  }
  assertRemovable(collection, ids = []) {
    check(
      !this.uploadingCollections.get(collection),
      "KNOWLEDGE_BUSY",
      "此库正在上传资料，请上传完成后再删除",
      409,
    );
    check(
      !this.listRaw().some(
        (j) =>
          (j.collection === collection || ids.includes(j.docId)) &&
          (["queued", "running"].includes(j.status) || this.active.has(j.id)),
      ),
      "KNOWLEDGE_BUSY",
      "此库有正在整理的资料，请先停止整理再删除",
      409,
    );
  }
  moveDocument(id, collection) {
    for (const job of this.listRaw().filter((j) => j.docId === id))
      this.write({ ...job, collection });
  }
  async discard(id) {
    const job = this.get(id);
    check(!job.docId, "JOB_STATE", "此资料已入库，请从资料列表删除", 409);
    check(
      !this.active.has(id) && !["running", "queued"].includes(job.status),
      "KNOWLEDGE_BUSY",
      "请先停止整理，稍后再删除",
      409,
    );
    this.store.db.prepare("DELETE FROM knowledge_jobs WHERE id=?").run(id);
    await rm(this.folder(id), { recursive: true, force: true });
    for (const [token, p] of this.playbacks)
      if (p.id === id) this.playbacks.delete(token);
    return { ok: true };
  }
  async purge(ids, collection) {
    const jobs = this.listRaw().filter(
      (j) =>
        ids.includes(j.docId) || (collection && j.collection === collection),
    );
    for (const id of ids)
      this.store.db
        .prepare("DELETE FROM knowledge_analysis WHERE doc_id=?")
        .run(id);
    for (const job of jobs) {
      this.store.db
        .prepare("DELETE FROM knowledge_jobs WHERE id=?")
        .run(job.id);
      await rm(this.folder(job.id), { recursive: true, force: true });
    }
    for (const [token, p] of this.playbacks)
      if (jobs.some((j) => j.id === p.id)) this.playbacks.delete(token);
  }
  playback(id) {
    const job = this.get(id);
    check(job.sourcePath, "NOT_FOUND", "此资料未保存原文件", 404);
    for (const [key, p] of this.playbacks)
      if (p.expires < Date.now()) this.playbacks.delete(key);
    const ticket = randomUUID();
    this.playbacks.set(ticket, { id, expires: Date.now() + 3600000 });
    return {
      url: `/api/knowledge/playback/${ticket}`,
      media: MEDIA_EXTENSIONS.has(extname(job.fileName).toLowerCase()),
      video: job.mediaInfo?.hasVideo === true,
    };
  }
  playbackFile(ticket) {
    const item = this.playbacks.get(ticket);
    check(
      item && item.expires > Date.now(),
      "UNAUTHORIZED",
      "原文件链接已过期，请重新打开",
      401,
    );
    const job = this.get(item.id);
    return { path: job.sourcePath, name: job.fileName };
  }
  async stop() {
    this.stopping = true;
    for (const a of this.active.values()) a.controller.abort();
    await Promise.allSettled([...this.active.values()].map((a) => a.promise));
  }
}
