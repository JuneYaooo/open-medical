import { createHash } from "node:crypto";
import { check, string } from "../errors.mjs";

// Local clinical guideline library. Documents (usually PDFs extracted to
// text by the UI) are stored with line numbers and split into chunks;
// search returns chunk hits with document + line provenance so guideline
// answers can cite the original text like every other medical artifact.
const CHUNK_LINES = 60;
export const KNOWLEDGE_KINDS = ["指南", "书籍", "资料", "文献", "其他"];
const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

export class GuidelineLibrary {
  constructor(store, embedder = null, vectorStore = null) {
    this.store = store;
    this.embedder = embedder; // { available(), model, embed(inputs) } — optional
    this.vectorStore = vectorStore; // LanceVectorStore — optional
  }
  async ragStatus() {
    const stats = this.vectorStore
      ? await this.vectorStore.stats()
      : { backend: "none", chunks: 0, models: [] };
    const current = this.embedder?.model || null;
    const indexedModels = stats.models.map((m) => m.model);
    const stale =
      stats.chunks > 0 && current !== null && !indexedModels.includes(current);
    return {
      backend: stats.backend,
      embeddedChunks: stats.chunks,
      indexedModels,
      currentModel: current,
      stale,
      embedder: this.embedder ? this.embedder.status() : { enabled: false },
    };
  }
  docRow(id) {
    check(typeof id === "string" && id, "INVALID_INPUT", "文档编号无效");
    const row = this.store.db
      .prepare("SELECT data FROM guideline_docs WHERE id=?")
      .get(id);
    check(row, "NOT_FOUND", "指南文档不存在", 404);
    return JSON.parse(row.data);
  }
  list() {
    return this.store.db
      .prepare("SELECT data FROM guideline_docs")
      .all()
      .map((row) => {
        const doc = JSON.parse(row.data);
        const chunks = this.store.db
          .prepare("SELECT COUNT(*) n FROM guideline_chunks WHERE doc_id=?")
          .get(doc.id)?.n || 0;
        return { ...doc, chunkCount: chunks, text: undefined };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  async addDocument({
    title,
    org = "",
    year,
    text,
    source = "local",
    fileName = "",
    kind = "指南",
    collection = "默认知识库",
  } = {}) {
    const name = string(title, "文档标题", 150);
    const body = string(text, "指南全文", 500000);
    check(
      body.length >= 100,
      "INVALID_INPUT",
      "指南全文太短（至少 100 字符），请确认导入的是完整文档",
    );
    const doc = {
      id: `gl_${sha256(body).slice(0, 16)}`,
      title: name,
      org: org ? string(org, "机构", 80) : "",
      year: optionalYear(year),
      kind: kind ? string(kind, "类别", 20) : "指南",
      collection: collection
        ? string(collection, "所属知识库", 60)
        : "默认知识库",
      source: string(source, "来源", 40),
      fileName: fileName ? string(fileName, "文件名", 180) : "",
      sha256: sha256(body),
      createdAt: Date.now(),
      revision: 0,
      text: body,
    };
    const exists = this.store.db
      .prepare("SELECT id FROM guideline_docs WHERE id=?")
      .get(doc.id);
    check(
      !exists,
      "CONFLICT",
      "内容相同的指南已存在于库中",
      409,
    );
    const chunks = chunkify(body);
    const insertDoc = this.store.db.prepare(
      "INSERT INTO guideline_docs(id,data) VALUES (?,?)",
    );
    const insertChunk = this.store.db.prepare(
      "INSERT INTO guideline_chunks(doc_id,ord,start_line,end_line,text) VALUES (?,?,?,?,?)",
    );
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      insertDoc.run(doc.id, JSON.stringify(doc));
      for (const chunk of chunks) insertChunk.run(doc.id, chunk.ord, chunk.startLine, chunk.endLine, chunk.text);
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
    // Best-effort RAG indexing: ingestion never fails when the local
    // embedding service or vector store is unavailable — search degrades
    // to full-text matching.
    let embedded = 0;
    if (this.embedder?.available() && this.vectorStore) {
      try {
        const vectors = await this.embedder.embed(
          chunks.map((chunk) => chunk.text.slice(0, 4000)),
        );
        await this.vectorStore.upsertDoc(
          doc.id,
          this.embedder.model,
          chunks.map((chunk, index) => ({
            doc_id: doc.id,
            ord: chunk.ord,
            title: doc.title,
            org: doc.org,
            year: doc.year,
            start_line: chunk.startLine,
            end_line: chunk.endLine,
            text: chunk.text.slice(0, 2000),
            vector: vectors[index],
          })),
        );
        embedded = vectors.length;
      } catch {
        embedded = 0;
      }
    }
    const { text: _text, ...rest } = doc;
    return { ...rest, chunkCount: chunks.length, embedded };
  }
  removeDocument(id) {
    this.docRow(id);
    this.store.db.prepare("DELETE FROM guideline_chunks WHERE doc_id=?").run(id);
    this.store.db.prepare("DELETE FROM guideline_docs WHERE id=?").run(id);
    return { ok: true };
  }
  get(id) {
    const doc = this.docRow(id);
    const lines = doc.text.split("\n").length;
    return { ...doc, lineCount: lines };
  }
  // Deterministic local search: every term must appear inside the chunk;
  // score is the total occurrence count. Works for Chinese without a
  // tokenizer (substring matching over a small local corpus).
  async search({ query, org, year, kind, collection, limit = 8 } = {}) {
    const text = string(query, "检索词", 200);
    const cjk = /[\u4e00-\u9fff]/;
    const terms = text
      .split(/\s+/)
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean);
    check(terms.length, "INVALID_INPUT", "检索词不能为空");
    check(
      Number.isInteger(limit) && limit >= 1 && limit <= 30,
      "INVALID_INPUT",
      "返回数量须为 1–30",
    );
    // 无分词器的中文长查询（自然语言整句）做重叠 bigram 退化匹配，
    // 任一 bigram 命中即视为该词命中，避免整句子串匹配必然落空。
    const termDefs = terms.map((term) => {
      const subs = [];
      if (term.length >= 4 && cjk.test(term)) {
        for (let i = 0; i + 2 <= term.length; i++) subs.push(term.slice(i, i + 2));
      }
      return { term, subs };
    });
    const docs = this.store.db
      .prepare("SELECT data FROM guideline_docs")
      .all()
      .map((row) => JSON.parse(row.data))
      .filter((doc) => !org || !doc.org || doc.org.toLowerCase().includes(String(org).toLowerCase()))
      .filter((doc) => !year || doc.year === year)
      .filter((doc) => !kind || (doc.kind || "指南") === kind)
      .filter(
        (doc) => !collection || (doc.collection || "默认知识库") === collection,
      );
    // Vector similarity pass (RAG): cosine over chunk embeddings, merged
    // with the text score. Unavailable embeddings degrade silently.
    const vectorScores = new Map();
    let vectorStale = false;
    if (this.embedder?.available() && this.vectorStore) {
      try {
        const [queryVector] = await this.embedder.embed([text]);
        const rag = await this.vectorStore.stats();
        vectorStale =
          rag.chunks > 0 && !rag.models.some((m) => m.model === this.embedder.model);
        const vectorHits = await this.vectorStore.search(
          this.embedder.model,
          queryVector,
          20,
        );
        for (const hit of vectorHits)
          vectorScores.set(`${hit.docId}:${hit.ord}`, hit.score);
      } catch {
        // degrade silently to text-only
      }
    }
    const results = [];
    const selectChunks = this.store.db.prepare(
      "SELECT ord,start_line,end_line,text FROM guideline_chunks WHERE doc_id=? ORDER BY ord ASC",
    );
    for (const doc of docs) {
      for (const chunk of selectChunks.all(doc.id)) {
        const lower = chunk.text.toLowerCase();
        let score = 0;
        let missing = false;
        for (const { term, subs } of termDefs) {
          let needle = term;
          let index = lower.indexOf(needle);
          if (index < 0 && subs.length) {
            for (const sub of subs) {
              const at = lower.indexOf(sub);
              if (at >= 0) {
                needle = sub;
                index = at;
                break;
              }
            }
          }
          if (index < 0) {
            missing = true;
            break;
          }
          let occurrences = 0;
          let at = lower.indexOf(needle);
          while (at >= 0) {
            occurrences++;
            at = lower.indexOf(needle, at + needle.length);
          }
          score += occurrences;
        }
        const vectorKey = `${doc.id}:${chunk.ord}`;
        const vectorScore = vectorScores.get(vectorKey);
        if (missing || (!score && vectorScore === undefined)) continue;
        const lines = chunk.text.split("\n");
        const matched = lines
          .map((line, i) => ({ line, i }))
          .filter(({ line }) => terms.some((term) => line.toLowerCase().includes(term)))
          .slice(0, 3)
          .map(({ line, i }) => ({
            lineNo: chunk.start_line + i,
            text: line.slice(0, 300),
          }));
        results.push({
          docId: doc.id,
          docTitle: doc.title,
          org: doc.org,
          year: doc.year,
          ord: chunk.ord,
          startLine: chunk.start_line,
          endLine: chunk.end_line,
          score,
          vectorScore: vectorScore === undefined ? null : Math.round(vectorScore * 1000) / 1000,
          matchedVia:
            vectorScore >= 0.9 ? (score >= 1 ? "hybrid" : "vector") : "text",
          matches: matched,
          snippet: lines.slice(0, 4).join("\n").slice(0, 500),
        });
      }
    }
    results.sort(
      (a, b) =>
        (b.vectorScore || 0) * 40 + b.score - ((a.vectorScore || 0) * 40 + a.score) ||
        a.startLine - b.startLine,
    );
    const rag = await this.ragStatus();
    return {
      query: text,
      count: results.length,
      hits: results.slice(0, limit),
      rag: { ...rag, stale: rag.stale || vectorStale },
      note:
        "知识库检索为本地混合检索（向量语义 + 全文匹配），引用时请核对原文行号；知识库内容不构成处方或剂量建议。" +
        (rag.stale || vectorStale
          ? " 嵌入模型已变更：部分向量为旧模型所建，建议执行重建索引。"
          : ""),
    };
  }
  // Re-embed every stored document with the current embedder model.
  async reindex() {
    check(
      this.embedder?.available(),
      "EMBEDDING_UNAVAILABLE",
      "未配置本地嵌入服务，无法重建向量索引",
      502,
    );
    const docs = this.store.db
      .prepare("SELECT data FROM guideline_docs")
      .all()
      .map((row) => JSON.parse(row.data));
    let chunks = 0;
    for (const doc of docs) {
      const pieces = chunkify(doc.text);
      const vectors = await this.embedder.embed(
        pieces.map((chunk) => chunk.text.slice(0, 4000)),
      );
      await this.vectorStore.upsertDoc(
        doc.id,
        this.embedder.model,
        pieces.map((chunk, index) => ({
          doc_id: doc.id,
          ord: chunk.ord,
          title: doc.title,
          org: doc.org,
          year: doc.year,
          start_line: chunk.startLine,
          end_line: chunk.endLine,
          text: chunk.text.slice(0, 2000),
          vector: vectors[index],
        })),
      );
      chunks += pieces.length;
    }
    await this.vectorStore.dropOtherModels(this.embedder.model);
    return {
      docs: docs.length,
      chunks,
      model: this.embedder.model,
      ...(await this.ragStatus()),
    };
  }
  readLines(id, startLine, endLine) {
    const doc = this.docRow(id);
    const lines = doc.text.split("\n");
    check(
      Number.isInteger(startLine) && startLine >= 1 && startLine <= lines.length,
      "INVALID_INPUT",
      `起始行须为 1–${lines.length}`,
    );
    check(
      Number.isInteger(endLine) && endLine >= startLine && endLine <= lines.length,
      "INVALID_INPUT",
      `结束行须为 ${startLine}–${lines.length}`,
    );
    check(endLine - startLine <= 200, "INVALID_INPUT", "一次最多读取 200 行");
    return {
      docId: doc.id,
      docTitle: doc.title,
      startLine,
      endLine,
      lines: lines.slice(startLine - 1, endLine),
    };
  }
}

export function knowledgeTools(library) {
  const definition = (name, description, properties, required = []) => ({
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    },
  });
  const textDef = { type: "string" };
  const intDef = { type: "integer" };
  return [
    {
      definition: definition(
        "knowledge_search",
        "在本地医学知识库中检索（指南/书籍/资料等全部类别），返回带文档名与行号出处的原文块。回答医学问题前优先检索。collection/kind/org 为精确匹配筛选，不确定时请省略，先用自然语言检索词即可。",
        {
          query: textDef,
          kind: textDef,
          collection: textDef,
          org: textDef,
          year: intDef,
          limit: intDef,
        },
        ["query"],
      ),
      execute: async (args) => {
        const result = await library.search(args);
        // 模型常凭猜测传 collection/kind/org 精确过滤（实际是精确匹配），
        // 猜错就全军覆没：无命中时自动去过滤重试一次并明示。
        if ((result.count || 0) > 0 || !(args.collection || args.kind || args.org))
          return result;
        const widened = await library.search({
          ...args,
          collection: undefined,
          kind: undefined,
          org: undefined,
        });
        if (!widened.count) return result;
        const dropped = [
          args.collection && `库:${args.collection}`,
          args.kind && `类别:${args.kind}`,
          args.org && `机构:${args.org}`,
        ]
          .filter(Boolean)
          .join("、");
        return {
          ...widened,
          note: `筛选条件（${dropped}）下无命中，已自动返回全库检索结果；可先用 knowledge_list 查看有哪些知识库与类别，或省略筛选词重试。`,
        };
      },
    },
    {
      definition: definition(
        "knowledge_list",
        "列出本地医学知识库中的全部文档（标题、类别、所属知识库、机构、年份）。",
        {
          kind: textDef,
          collection: textDef,
        },
        [],
      ),
      execute: (args) => ({
        documents: library.list({
          kind: args.kind,
          collection: args.collection,
        }),
      }),
    },
    {
      definition: definition(
        "knowledge_read",
        "按行区间读取本地知识库中某文档的原文，用于核对引用。",
        { docId: textDef, startLine: intDef, endLine: intDef },
        ["docId", "startLine", "endLine"],
      ),
      execute: (args) => library.readLines(args.docId, args.startLine, args.endLine),
    },
    {
      definition: definition(
        "knowledge_ingest",
        "把一份指南/书籍/资料全文存入本地医学知识库（自动分块并向量化索引）。仅当用户明确要求入库或已确认保存时调用；入库前请说明来源。",
        {
          title: textDef,
          text: textDef,
          kind: textDef,
          collection: textDef,
          org: textDef,
          year: intDef,
          fileName: textDef,
        },
        ["title", "text"],
      ),
      execute: (args) => library.addDocument(args),
    },
  ];
}

// Shared deterministic line-window chunker; the material library reuses it
// so in-memory keyword chunks and indexed vector chunks share ord/line refs.
export function chunkify(text) {
  const lines = text.split("\n");
  const chunks = [];
  let start = 0;
  let ord = 1;
  while (start < lines.length) {
    const slice = lines.slice(start, start + CHUNK_LINES);
    chunks.push({
      ord,
      startLine: start + 1,
      endLine: start + slice.length,
      text: slice.join("\n"),
    });
    start += CHUNK_LINES;
    ord++;
  }
  return chunks;
}

function optionalYear(value) {
  if (value === undefined || value === null || value === "") return null;
  check(
    Number.isInteger(value) && value >= 1950 && value <= new Date().getFullYear(),
    "INVALID_INPUT",
    `年份须为 1950–${new Date().getFullYear()}`,
  );
  return value;
}
