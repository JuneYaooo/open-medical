// LanceDB-backed vector index for the guideline knowledge base — an
// embedded local vector database (no server, prebuilt binaries, Lance
// columnar files on disk). One table per embedding model so dimension
// changes never mix vectors. Falls back gracefully: when the native
// module is unavailable the knowledge base degrades to full-text matching.
export class LanceVectorStore {
  constructor(dir) {
    this.dir = dir;
    this.init = null;
    this.unavailable = false;
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
  async tableFor(model, rows) {
    const db = await this.ensureDb();
    const name = this.tableName(model);
    const names = await db.tableNames();
    if (names.includes(name)) return db.openTable(name);
    return db.createTable(name, rows);
  }
  // rows: [{doc_id, ord, title, org, year, start_line, end_line, text, vector}]
  async upsertDoc(docId, model, rows) {
    checkRows(rows);
    const table = await this.tableFor(model, rows);
    await table.delete(`doc_id = '${docId}'`);
    if (rows.length) await table.add(rows);
  }
  async removeDocs(ids) {
    if (!ids.length) return;
    const db = await this.ensureDb();
    const predicate = "doc_id IN (" + ids.map(id => "'" + String(id).replaceAll("'", "''") + "'").join(",") + ")";
    for (const name of await db.tableNames()) {
      if (!name.startsWith("chunks_")) continue;
      const table = await db.openTable(name);
      await table.delete(predicate);
    }
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
      year: row.year === null || row.year === undefined ? null : Number(row.year),
      // Lance cosine distance ∈ [0,2]; convert to similarity ∈ [-1,1].
      score: Math.round((1 - Number(row._distance)) * 1000) / 1000,
    }));
  }
  async dropOtherModels(model) {
    const db = await this.ensureDb();
    const keep = this.tableName(model);
    for (const name of await db.tableNames())
      if (name.startsWith("chunks_") && name !== keep)
        await db.dropTable(name);
  }
  async stats() {
    const db = await this.ensureDb();
    const models = [];
    let chunks = 0;
    for (const name of await db.tableNames()) {
      if (!name.startsWith("chunks_")) continue;
      const table = await db.openTable(name);
      const count = Number(await table.countRows());
      models.push({ model: this.constructor.decodeModel(name.slice(7)), chunks: count });
      chunks += count;
    }
    return { backend: "lancedb", chunks, models };
  }
}

function checkRows(rows) {
  if (!rows.length) return;
  const dim = rows[0].vector.length;
  for (const row of rows)
    if (!Array.isArray(row.vector) || row.vector.length !== dim)
      throw new Error("向量维度不一致");
}
