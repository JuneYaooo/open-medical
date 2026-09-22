import { chunkify } from "./guidelines.mjs";
import { check, string } from "../errors.mjs";

// Session-material retrieval: files are chunked and embedded into a
// dedicated LanceDB namespace at import time, so the model can pull the
// few relevant fragments instead of requiring every file in the prompt
// window. Keyword scoring always runs over the run's in-memory sources;
// semantic scores merge in when an embedder is configured. Both passes
// are scoped to the sources of the current run — a file outside the
// run's selection is never retrievable, matching the consent model.
const MAX_EMBEDDED_CHUNKS = 400;
const CHUNK_CHAR_LIMIT = 4000;

export class MaterialLibrary {
  constructor(embedder = null, vectorStore = null) {
    this.embedder = embedder; // { available(), model, embed(inputs) } — optional
    this.vectorStore = vectorStore; // LanceVectorStore over a materials-only dir
  }

  // Patient material indexing is local-only. An ordinary model-generation
  // consent does not authorize background embeddings or search queries.
  canEmbedLocally() {
    return this.embedder?.available() && this.embedder.status?.().mode === "local";
  }

  // Fire-and-forget from addFile; failures degrade to keyword search only.
  async ingest(file) {
    const chunks = chunkify(file.text);
    if (!this.canEmbedLocally() || !this.vectorStore || !chunks.length)
      return { fileId: file.id, chunks: chunks.length, embedded: 0 };
    const embeddable = chunks.slice(0, MAX_EMBEDDED_CHUNKS);
    try {
      const vectors = await this.embedder.embed(
        embeddable.map((chunk) => chunk.text.slice(0, CHUNK_CHAR_LIMIT)),
      );
      await this.vectorStore.upsertDoc(
        file.id,
        this.embedder.model,
        embeddable.map((chunk, index) => ({
          doc_id: file.id,
          ord: chunk.ord,
          title: file.name,
          org: "",
          start_line: chunk.startLine,
          end_line: chunk.endLine,
          text: chunk.text,
          vector: vectors[index],
        })),
      );
      return {
        fileId: file.id,
        chunks: chunks.length,
        embedded: embeddable.length,
        truncated: chunks.length > embeddable.length,
      };
    } catch {
      return { fileId: file.id, chunks: chunks.length, embedded: 0 };
    }
  }

  async remove(fileId) {
    if (!this.vectorStore) return;
    try {
      // upsertDoc deletes by doc_id before adding; an empty re-add is not
      // possible, so delete through the same table path with a no-op row.
      const model = this.embedder?.model;
      if (!model) return;
      await this.vectorStore.upsertDoc(fileId, model, []);
    } catch {
      /* vector cleanup is best-effort; session data remains authoritative */
    }
  }

  async search({ sources = [], query, limit = 8 } = {}) {
    const text = string(query, "检索词", 200);
    check(
      Number.isInteger(limit) && limit >= 1 && limit <= 30,
      "INVALID_INPUT",
      "返回数量须为 1–30",
    );
    const scope = new Map(sources.map((s) => [s.id, s]));
    check(scope.size > 0, "INVALID_INPUT", "当前运行没有可检索的材料");
    const terms = text
      .split(/\s+/)
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean);
    // Vector pass over the run's file ids only.
    const vectorScores = new Map();
    let semantic = false;
    if (this.canEmbedLocally() && this.vectorStore && terms.length) {
      try {
        const [queryVector] = await this.embedder.embed([text]);
        const hits = await this.vectorStore.search(
          this.embedder.model,
          queryVector,
          40,
        );
        for (const hit of hits)
          if (scope.has(hit.docId))
            vectorScores.set(`${hit.docId}:${hit.ord}`, hit.score);
        semantic = vectorScores.size > 0;
      } catch {
        /* degrade to keyword-only */
      }
    }
    const matches = [];
    for (const source of scope.values()) {
      for (const chunk of chunkify(source.text)) {
        const lower = chunk.text.toLowerCase();
        let score = 0;
        let missing = false;
        for (const term of terms) {
          if (!lower.includes(term)) {
            missing = true;
            break;
          }
          let at = lower.indexOf(term);
          while (at >= 0) {
            score++;
            at = lower.indexOf(term, at + term.length);
          }
        }
        const vectorScore = vectorScores.get(`${source.id}:${chunk.ord}`);
        if (missing || (!score && vectorScore === undefined)) continue;
        matches.push({
          fileId: source.id,
          fileName: source.name,
          ord: chunk.ord,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          text: chunk.text.slice(0, 2000),
          score: Math.round((score + (vectorScore ?? 0)) * 1000) / 1000,
        });
      }
    }
    matches.sort((a, b) => b.score - a.score);
    return {
      query: text,
      mode: semantic ? "semantic+keyword" : "keyword",
      count: matches.length,
      matches: matches.slice(0, limit),
      scope: "当前运行选中的材料；未检索会话外内容",
      note: "片段为原文摘录，引用时请标注文件名与行号。",
    };
  }
}

export const materialSearchTools = (materials) => [
  {
    definition: {
      type: "function",
      function: {
        name: "semantic_material_search",
        description:
          "在当前运行选中的会话材料内做检索（向量语义 + 关键词合并），返回相关原文片段与行号。材料多或问题宽泛时优先使用，不要假设未返回的内容不存在。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "integer" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
    execute: (args, context) =>
      materials.search({ ...args, sources: context.sources }),
  },
];
