import { createHash, randomUUID } from "node:crypto";
import { check } from "../errors.mjs";

export class WorkspaceStore {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS agent_workspaces (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_events (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL, type TEXT NOT NULL, time TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_events_workspace ON agent_events(workspace_id,id);`);
    db.exec(`CREATE TABLE IF NOT EXISTS agent_context_archives (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL,
      authority TEXT NOT NULL, identity TEXT NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_trace (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL,
      run_id TEXT NOT NULL, time TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_trace_run ON agent_trace(workspace_id,run_id,id);`);
    db.exec(`CREATE TABLE IF NOT EXISTS agent_run_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL,
      request_id TEXT NOT NULL, authority TEXT NOT NULL, identity TEXT NOT NULL,
      data TEXT NOT NULL, messages TEXT NOT NULL, UNIQUE(workspace_id,run_id));
      CREATE INDEX IF NOT EXISTS agent_history_workspace ON agent_run_history(workspace_id,id);
      CREATE INDEX IF NOT EXISTS agent_history_request ON agent_run_history(workspace_id,request_id);`);
    for (const workspace of this.list()) {
      if (
        workspace.extensions?.actions?.some((a) =>
          ["pending", "applying"].includes(a.status),
        )
      )
        this.update(workspace.id, (w) => {
          for (const a of w.extensions.actions)
            if (["pending", "applying"].includes(a.status))
              a.status = a.status === "applying" ? "interrupted" : "revoked";
        });
      if ((workspace.schedules || []).some((j) => j.status === "running"))
        this.update(workspace.id, (w) => {
          for (const job of w.schedules.filter((j) => j.status === "running")) {
            const run = w.runs.find((r) => r.id === job.runId || r.requestId === `schedule_${job.id}_${job.nextRunAt}`);
            if (run?.resumeOnRestart && run.contextMessages?.length) {
              job.status = "recovering";
              job.runId = run.id;
            } else {
              job.status = "paused";
              job.error = "运行时重启，计划中断，请手动恢复";
            }
          }
        });
      if (workspace.runs.some((r) => r.status === "running"))
        this.update(workspace.id, (w) => {
          for (const run of w.runs.filter((r) => r.status === "running")) {
            run.status = "interrupted";
            run.error = "运行时重启，执行已中断";
            run.endedAt = Date.now();
            for (const child of run.children || [])
              if (["running", "queued"].includes(child.status)) {
                child.status = "interrupted";
                child.error = "运行时重启";
              }
          }
        });
      // Applying is uncertain after a crash: never repeat a file mutation automatically.
      if (workspace.approvals.some((a) => a.status === "applying"))
        this.update(workspace.id, (w) => {
          for (const approval of w.approvals.filter(
            (a) => a.status === "applying",
          ))
            approval.status = "interrupted";
        });
    }
  }
  create({ title = "新工作区", root, permissions }) {
    const workspace = {
      id: randomUUID(),
      title,
      root,
      permissions,
      revision: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runs: [],
      messages: [],
      approvals: [],
    };
    this.db
      .prepare("INSERT INTO agent_workspaces VALUES (?,?)")
      .run(workspace.id, JSON.stringify(workspace));
    return workspace;
  }
  list() {
    return this.db
      .prepare("SELECT data FROM agent_workspaces")
      .all()
      .map((r) => JSON.parse(r.data))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  recoveryCandidates() {
    return this.db.prepare(`SELECT data FROM agent_workspaces
      WHERE json_extract(data,'$.runs[#-1].status')='interrupted'
      AND json_extract(data,'$.runs[#-1].resumeOnRestart')=1
      AND json_extract(data,'$.runs[#-1].recoveryBlocked') IS NULL`)
      .all().map((row) => JSON.parse(row.data));
  }
  scheduled() {
    return this.db.prepare(`SELECT data FROM agent_workspaces
      WHERE EXISTS (SELECT 1 FROM json_each(agent_workspaces.data,'$.schedules')
      WHERE json_extract(value,'$.status') IN ('active','recovering'))`)
      .all().map((row) => JSON.parse(row.data));
  }
  hasRequest(id, requestId) {
    return this.get(id).runs.some((r) => r.requestId === requestId) || Boolean(
      this.db.prepare("SELECT 1 FROM agent_run_history WHERE workspace_id=? AND request_id=?").get(id, requestId));
  }
  archiveHistory(id, keep = 50) {
    check(Number.isInteger(keep) && keep >= 1, "HISTORY_LIMIT", "历史保留数量无效");
    if (this.get(id).runs.length <= keep) return;
    this.update(id, (w) => {
      const archived = w.runs.slice(0, -keep).filter((r) => r.status !== "running");
      const ids = new Set(archived.map((r) => r.id));
      const insert = this.db.prepare(`INSERT INTO agent_run_history
        (workspace_id,run_id,request_id,authority,identity,data,messages) VALUES (?,?,?,?,?,?,?)`);
      for (const run of archived) insert.run(id, run.id, run.requestId,
        run.authority || "", run.contextIdentity || "", JSON.stringify(run),
        JSON.stringify(w.messages.filter((m) => m.runId === run.id)));
      w.runs = w.runs.filter((r) => !ids.has(r.id));
      w.messages = w.messages.filter((m) => !ids.has(m.runId));
      w.archivedRuns = (w.archivedRuns || 0) + archived.length;
    });
  }
  history(id, { before = Number.MAX_SAFE_INTEGER, query = "", limit = 10, authority, identity } = {}) {
    this.get(id);
    check(Number.isSafeInteger(before) && before > 0 && Number.isInteger(limit) && limit > 0 && limit <= 20
      && typeof query === "string" && query.length <= 200, "HISTORY_QUERY", "历史检索参数无效");
    const rows = this.db.prepare(`SELECT * FROM agent_run_history
      WHERE workspace_id=? AND id<? AND instr(lower(messages),lower(?))>0
      ${authority !== undefined ? "AND authority=? AND identity=?" : ""}
      ORDER BY id DESC LIMIT ?`).all(id, before, query,
        ...(authority !== undefined ? [authority, identity] : []), limit);
    return { entries: rows.map((row) => {
      const { contextMessages: _context, providerMessages: _provider, children: _children, ...run } = JSON.parse(row.data);
      return { cursor: row.id, run, messages: JSON.parse(row.messages) };
    }), nextCursor: rows.length === limit ? rows.at(-1).id : null };
  }
  get(id) {
    const row = this.db
      .prepare("SELECT data FROM agent_workspaces WHERE id=?")
      .get(id);
    check(row, "NOT_FOUND", "工作区不存在", 404);
    return JSON.parse(row.data);
  }
  update(id, callback, revision) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const workspace = this.get(id);
      if (revision !== undefined)
        check(
          workspace.revision === revision,
          "REVISION_CONFLICT",
          "工作区已变化，请刷新",
          409,
        );
      callback(workspace);
      workspace.revision++;
      workspace.updatedAt = Date.now();
      this.db
        .prepare("UPDATE agent_workspaces SET data=? WHERE id=?")
        .run(JSON.stringify(workspace), id);
      this.db.exec("COMMIT");
      return workspace;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  event(id, runId, type, payload) {
    const time = new Date().toISOString();
    const result = this.db
      .prepare(
        "INSERT INTO agent_events(workspace_id,run_id,type,time,payload) VALUES (?,?,?,?,?)",
      )
      .run(id, runId, type, time, JSON.stringify(payload));
    return {
      id: Number(result.lastInsertRowid),
      workspace_id: id,
      run_id: runId,
      type,
      time,
      payload,
    };
  }
  // Newest window for UI loads: after=0 pagination on a busy workspace would
  // otherwise always return the OLDEST `limit` events, hiding new activity.
  eventsLatest(id, limit = 500) {
    this.get(id);
    check(
      Number.isInteger(limit) && limit > 0 && limit <= 1000,
      "INVALID_INPUT",
      "事件数量无效",
    );
    return this.db
      .prepare(
        "SELECT * FROM agent_events WHERE workspace_id=? ORDER BY id DESC LIMIT ?",
      )
      .all(id, limit)
      .reverse()
      .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }
  events(id, after = 0, limit = 500) {
    this.get(id);
    check(
      Number.isSafeInteger(after) &&
        after >= 0 &&
        Number.isInteger(limit) &&
        limit > 0 &&
        limit <= 1000,
      "INVALID_INPUT",
      "事件游标无效",
    );
    return this.db
      .prepare(
        "SELECT * FROM agent_events WHERE workspace_id=? AND id>? ORDER BY id LIMIT ?",
      )
      .all(id, after, limit)
      .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }
  archive(id, runId, messages, authority, identity) {
    const data = JSON.stringify(messages),
      hash = createHash("sha256").update(data).digest("hex"),
      archiveId = randomUUID();
    this.db
      .prepare("INSERT INTO agent_context_archives VALUES (?,?,?,?,?,?,?)")
      .run(archiveId, id, runId, authority, identity, hash, data);
    return { id: archiveId, hash, chars: data.length };
  }
  readArchive(id, archiveId, authority, identity, offset = 0, limit = 8000) {
    check(
      Number.isSafeInteger(offset) &&
        offset >= 0 &&
        Number.isInteger(limit) &&
        limit > 0 &&
        limit <= 16000,
      "INVALID_INPUT",
      "历史读取范围无效",
    );
    const row = this.db
      .prepare(
        "SELECT * FROM agent_context_archives WHERE id=? AND workspace_id=?",
      )
      .get(archiveId, id);
    check(
      row && row.authority === authority && row.identity === identity,
      "CONTEXT_ACCESS",
      "历史不存在或不属于当前授权和模型",
      403,
    );
    return {
      id: archiveId,
      hash: row.hash,
      totalChars: row.data.length,
      offset,
      text: row.data.slice(offset, offset + limit),
      nextOffset: offset + limit < row.data.length ? offset + limit : null,
    };
  }
  trace(id, runId, data) {
    this.db
      .prepare(
        "INSERT INTO agent_trace(workspace_id,run_id,time,data) VALUES (?,?,?,?)",
      )
      .run(id, runId, new Date().toISOString(), JSON.stringify(data));
  }
  trajectory(id, runId, after = 0) {
    this.get(id);
    check(
      Number.isSafeInteger(after) && after >= 0,
      "INVALID_INPUT",
      "轨迹游标无效",
    );
    return this.db
      .prepare(
        "SELECT * FROM agent_trace WHERE workspace_id=? AND run_id=? AND id>? ORDER BY id LIMIT 100",
      )
      .all(id, runId, after)
      .map(({ data, ...row }) => ({ ...row, data: JSON.parse(data) }));
  }
  fork(id, { runId, revision } = {}) {
    const source = this.get(id);
    check(
      source.revision === revision,
      "REVISION_CONFLICT",
      "分支前请刷新工作区",
      409,
    );
    const index = runId
      ? source.runs.findIndex((r) => r.id === runId)
      : source.runs.length - 1;
    check(!runId || index >= 0, "NOT_FOUND", "分支截点不存在", 404);
    const runs = source.runs.slice(0, index + 1);
    check(
      runs.every((r) => r.status !== "running"),
      "RUN_ACTIVE",
      "请在当前执行结束后分支",
      409,
    );
    const selected = new Set(runs.map((r) => r.id));
    const fork = this.create({
      title: source.title + " · 分支",
      root: source.root,
      permissions: {
        ...source.permissions,
        grants: {
          ...source.permissions.grants,
          "filesystem.write": false,
          "process.spawn": false,
          network: false,
          "mcp.execute": false,
          "plugins.execute": false,
          "browser.read": false,
          "memory.read": false,
          "memory.write": false,
        },
      },
    });
    return this.update(fork.id, (w) => {
      w.runs = structuredClone(runs);
      w.messages = structuredClone(
        source.messages.filter((m) => selected.has(m.runId)),
      );
      w.forkedFrom = {
        workspaceId: id,
        revision: source.revision,
        runId: runs.at(-1)?.id || null,
      };
      // History remains visible; old authority and approvals cannot authorize new effects.
      const sourceAuthority = createHash("sha256")
        .update(JSON.stringify(source.permissions))
        .digest("hex");
      const authority = createHash("sha256")
        .update(JSON.stringify(w.permissions))
        .digest("hex");
      for (const run of w.runs) {
        delete run.contextMessages;
        if (run.authority === sourceAuthority && run.status === "completed") {
          // Continue from the visible transcript, not historic tool invocations or approvals.
          run.providerMessages = w.messages
            .filter((m) => m.runId === run.id)
            .map(({ role, content }) => ({ role, content }));
          run.authority = authority;
        } else {
          delete run.authority;
          delete run.providerMessages;
        }
      }
    });
  }
}
