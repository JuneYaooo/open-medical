// LanceDB-backed vector index for the guideline knowledge base — an
// embedded local vector database (no server, prebuilt binaries, Lance
// columnar files on disk). One table per embedding model so dimension
// changes never mix vectors. Falls back gracefully: when the native
// module is unavailable the knowledge base degrades to full-text matching.
import {
  Schema,
  Field,
  Utf8,
  Int32,
  Float32,
  FixedSizeList,
} from "apache-arrow";

export class LanceVectorStore {
  constructor(dir) {
    this.dir = dir;
    this.init = null;
    this.unavailable = false;
    this.pendingWrite = Promise.resolve();
  }
  // Lazy connect: construction is synchronous so composition roots can hold
  // the store before async resources exist; first use awaits the connect.
  static create(dir) {
    const store = new LanceVectorStore(dir);
    store.init = (async () => {
      try {
        const lancedb = await import("@lancedb/lancedb");
        store.db = await lancedb.connect(dir);
      } catch (error) {
        store.unavailable = true;
        store.loadError = error.message || String(error);
      }
    })();
    return store;
  }
  async ensureDb() {
    await this.init;
    if (this.unavailable)
      throw new Error(
        `LanceDB 不可用（${this.loadError}）；知识检索已降级为全文匹配`,
      );
    return this.db;
  }
  static encodeModel(model) {
    return Buffer.from(String(model), "utf8").toString("base64url");
  }
  static decodeModel(token) {
    try {
      return Buffer.from(token, "base64url").toString("utf8");
    } catch {
      return token;
    }
  }
  tableName(model) {
    return `chunks_${this.constructor.encodeModel(model)}`;
  }
  write(operation) {
    const result = this.pendingWrite.then(operation);
    // Serialize creation and mutations; failed writes do not block later work.
    this.pendingWrite = result.catch(() => {});
    return result;
  }
  // rows: [{doc_id, ord, title, org, year, start_line, end_line, text, vector}]
  async upsertDoc(docId, model, rows) {
    checkRows(docId, rows);
    return this.write(async () => {
      const db = await this.ensureDb(),
        name = this.tableName(model);
      if (!(await db.tableNames()).includes(name)) {
        if (rows.length)
          await db.createTable(name, rows, {
            schema: documentSchema(rows[0].vector.length),
          });
        return;
      }
      const table = await db.openTable(name),
        id = sqlString(docId);
      if (!rows.length) {
        await table.delete(`doc_id = ${id}`);
        return;
      }
      const schema = await table.schema();
      const dimensions = schema.fields.find((field) => field.name === "vector")
        ?.type.listSize;
      if (dimensions !== rows[0].vector.length)
        throw new Error("向量维度与现有模型索引不一致");
      // Replace this document in one transaction, including obsolete chunks.
      // Failed conversion/commit retains the previous searchable version.
      await table
        .mergeInsert(["doc_id", "ord"])
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .whenNotMatchedBySourceDelete({ where: `doc_id = ${id}` })
        .execute(rows);
    });
  }
  async removeDocs(ids) {
    if (!ids.length) return;
    return this.write(async () => {
      const db = await this.ensureDb();
      const predicate = "doc_id IN (" + ids.map(sqlString).join(",") + ")";
      for (const name of await db.tableNames()) {
        if (!name.startsWith("chunks_")) continue;
        const table = await db.openTable(name);
        await table.delete(predicate);
      }
    });
  }
  async search(model, vector, limit = 20) {
    const db = await this.ensureDb();
    const name = this.tableName(model);
    if (!(await db.tableNames()).includes(name)) return [];
    const table = await db.openTable(name);
    const rows = await table
      .search(vector)
      .distanceType("cosine")
      .limit(limit)
      .toArray();
    return rows.map((row) => ({
      docId: row.doc_id,
      ord: Number(row.ord),
      startLine: Number(row.start_line),
      endLine: Number(row.end_line),
      text: row.text,
      title: row.title,
      org: row.org,
      year:
        row.year === null || row.year === undefined ? null : Number(row.year),
      // Lance cosine distance ∈ [0,2]; convert to similarity ∈ [-1,1].
      score: Math.round((1 - Number(row._distance)) * 1000) / 1000,
    }));
  }
  async dropOtherModels(model) {
    return this.write(async () => {
      const db = await this.ensureDb();
      const keep = this.tableName(model);
      for (const name of await db.tableNames())
        if (name.startsWith("chunks_") && name !== keep)
          await db.dropTable(name);
    });
  }
  async stats() {
    const db = await this.ensureDb();
    const models = [];
    let chunks = 0;
    for (const name of await db.tableNames()) {
      if (!name.startsWith("chunks_")) continue;
      const table = await db.openTable(name);
      const count = Number(await table.countRows());
      models.push({
        model: this.constructor.decodeModel(name.slice(7)),
        chunks: count,
      });
      chunks += count;
    }
    return { backend: "lancedb", chunks, models };
  }
}

function sqlString(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function documentSchema(dimensions) {
  // Inferring from the first document fails when its year is null or missing.
  return new Schema([
    new Field("doc_id", new Utf8(), false),
    new Field("ord", new Int32(), false),
    new Field("title", new Utf8(), true),
    new Field("org", new Utf8(), true),
    new Field("year", new Int32(), true),
    new Field("start_line", new Int32(), false),
    new Field("end_line", new Int32(), false),
    new Field("text", new Utf8(), false),
    new Field(
      "vector",
      new FixedSizeList(dimensions, new Field("item", new Float32(), true)),
      false,
    ),
  ]);
}

function checkRows(docId, rows) {
  if (typeof docId !== "string" || !docId || !Array.isArray(rows))
    throw new Error("向量文档标识或数据无效");
  if (!rows.length) return;
  const dim = rows[0]?.vector?.length,
    ords = new Set();
  for (const row of rows) {
    if (
      !row ||
      row.doc_id !== docId ||
      !Number.isInteger(row.ord) ||
      row.ord < 0 ||
      ords.has(row.ord)
    )
      throw new Error("向量分段标识无效或重复");
    ords.add(row.ord);
    if (
      !Array.isArray(row.vector) ||
      !dim ||
      row.vector.length !== dim ||
      !row.vector.every(Number.isFinite)
    )
      throw new Error("向量维度不一致");
  }
}
