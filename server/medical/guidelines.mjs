import { createHash } from "node:crypto";
import { check, string } from "../errors.mjs";

// Local clinical guideline library. Documents (usually PDFs extracted to
// text by the UI) are stored with line numbers and split into chunks;
// search returns chunk hits with document + line provenance so guideline
// answers can cite the original text like every other medical artifact.
const CHUNK_LINES = 60;
const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

export class GuidelineLibrary {
  constructor(store, embedder = null) {
    this.store = store;
    this.embedder = embedder; // { available(), embed(inputs) } — optional
  }
  ragStatus() {
    const vectors = this.store.db
      .prepare("SELECT COUNT(*) n FROM guideline_chunk_vectors")
      .get()?.n || 0;
    return {
      embeddedChunks: vectors,
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
  async addDocument({ title, org = "", year, text, source = "local", fileName = "" } = {}) {
    const name = string(title, "指南标题", 150);
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
    // embedding service is down — search degrades to full-text matching.
    let embedded = 0;
    if (this.embedder?.available()) {
      try {
        const vectors = await this.embedder.embed(chunks.map((chunk) => chunk.text.slice(0, 4000)));
        const insertVector = this.store.db.prepare(
          "INSERT INTO guideline_chunk_vectors(doc_id,ord,dim,vector) VALUES (?,?,?,?)",
        );
        this.store.db.exec("BEGIN IMMEDIATE");
        for (const [index, chunk] of chunks.entries())
          insertVector.run(doc.id, chunk.ord, vectors[index].length, JSON.stringify(vectors[index]));
        this.store.db.exec("COMMIT");
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
  async search({ query, org, year, limit = 8 } = {}) {
    const text = string(query, "检索词", 200);
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
    const docs = this.store.db
      .prepare("SELECT data FROM guideline_docs")
      .all()
      .map((row) => JSON.parse(row.data))
      .filter((doc) => !org || !doc.org || doc.org.toLowerCase().includes(String(org).toLowerCase()))
      .filter((doc) => !year || doc.year === year);
    // Vector similarity pass (RAG): cosine over chunk embeddings, merged
    // with the text score. Unavailable embeddings degrade silently.
    const vectorScores = new Map();
    if (this.embedder?.available()) {
      try {
        const [queryVector] = await this.embedder.embed([text]);
        const rows = this.store.db
          .prepare(
            "SELECT v.doc_id, v.ord, v.vector FROM guideline_chunk_vectors v",
          )
          .all();
        const cosine = (await import("./embeddings.mjs")).cosineSimilarity;
        for (const row of rows) {
          const score = cosine(queryVector, JSON.parse(row.vector));
          const key = `${row.doc_id}:${row.ord}`;
          vectorScores.set(key, score);
        }
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
        for (const term of terms) {
          const index = lower.indexOf(term);
          if (index < 0) {
            missing = true;
            break;
          }
          let occurrences = 0;
          let at = lower.indexOf(term);
          while (at >= 0) {
            occurrences++;
            at = lower.indexOf(term, at + term.length);
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
          matchedVia: vectorScore !== undefined && score < vectorScore * 40 ? "vector" : "text",
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
    return {
      query: text,
      count: results.length,
      hits: results.slice(0, limit),
      rag: this.ragStatus(),
      note: "指南检索结果为本地混合检索（向量语义 + 全文匹配），引用时请核对原文行号；指南内容不构成处方或剂量建议。",
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

export function guidelineTools(library) {
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
        "guideline_search",
        "在本地指南库中检索临床指南条文，返回带文档名与行号出处的原文块。仅搜索本地已导入的指南。",
        {
          query: textDef,
          org: textDef,
          year: intDef,
          limit: intDef,
        },
        ["query"],
      ),
      execute: (args) => library.search(args),
    },
    {
      definition: definition(
        "guideline_list",
        "列出本地指南库中的全部指南文档（标题、机构、年份）。",
        {},
        [],
      ),
      execute: () => ({ documents: library.list() }),
    },
    {
      definition: definition(
        "guideline_read",
        "按行区间读取本地指南库中某文档的原文，用于核对引用。",
        { docId: textDef, startLine: intDef, endLine: intDef },
        ["docId", "startLine", "endLine"],
      ),
      execute: (args) => library.readLines(args.docId, args.startLine, args.endLine),
    },
  ];
}

function chunkify(text) {
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
