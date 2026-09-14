import { createHash } from "node:crypto";
import { AppError, check, string } from "../errors.mjs";

// Doctor memory (medical preferences), stored locally in the medical store.
// Structured preferences are edited explicitly; observed signals from review
// actions can be consolidated into candidate memories that only take effect
// after the doctor confirms them. Nothing here can grant tool permissions.
export const PROFILE_TEXT_FIELDS = [
  ["specialty", "科室", 60],
  ["note", "补充说明", 500],
];
export const PROFILE_LIST_FIELDS = [
  ["medicationHabits", "常用药物与剂量习惯", 30, 200],
  ["examPanels", "常用检查组合", 20, 200],
  ["followupPreferences", "随访偏好", 20, 200],
  ["documentationStyle", "病历文风偏好", 20, 200],
  ["guidelineSources", "常用指南来源", 20, 120],
  ["terminology", "术语与缩写习惯", 20, 120],
];
const DIGEST_LIMIT = 800;
const normalize = (value) => String(value).trim().replace(/\s+/g, " ");
const hashContent = (value) =>
  createHash("sha256").update(normalize(value)).digest("hex");
const nowIso = () => new Date().toISOString();

export class DoctorProfile {
  constructor(store) {
    this.store = store;
  }
  row() {
    const row = this.store.db
      .prepare("SELECT data FROM doctor_profile WHERE id='local'")
      .get();
    return row
      ? JSON.parse(row.data)
      : {
          id: "local",
          revision: 0,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          fields: {},
        };
  }
  save(profile) {
    this.store.db
      .prepare(
        "INSERT INTO doctor_profile (id,data) VALUES ('local',?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(JSON.stringify(profile));
  }
  get() {
    const profile = this.row();
    return { ...profile, counts: this.counts(), digest: this.digest() };
  }
  update(input) {
    check(
      input && typeof input === "object" && !Array.isArray(input),
      "INVALID_INPUT",
      "更新内容无效",
    );
    const profile = this.row();
    check(
      input.expectedRevision === profile.revision,
      "REVISION_CONFLICT",
      "医生档案已变化，请刷新后重试",
      409,
    );
    const fields = { ...profile.fields };
    for (const [key, label, max] of PROFILE_TEXT_FIELDS)
      if (input[key] !== undefined) {
        check(
          input[key] === null || typeof input[key] === "string",
          "INVALID_INPUT",
          `${label}必须是文本`,
        );
        fields[key] = input[key] ? string(input[key], label, max) : "";
      }
    for (const [key, label, maxCount, maxLen] of PROFILE_LIST_FIELDS)
      if (input[key] !== undefined) {
        check(
          Array.isArray(input[key]) && input[key].length <= maxCount,
          "INVALID_INPUT",
          `${label}最多 ${maxCount} 条`,
        );
        fields[key] = input[key]
          .map((v) => string(v, label, maxLen))
          .filter(Boolean);
      }
    check(
      Object.keys(fields).every((key) =>
        [...PROFILE_TEXT_FIELDS, ...PROFILE_LIST_FIELDS].some(
          ([name]) => name === key,
        ),
      ),
      "INTERNAL",
      "档案字段无效",
    );
    profile.fields = fields;
    profile.revision++;
    profile.updatedAt = nowIso();
    this.save(profile);
    this.store.db
      .prepare(
        "INSERT INTO audit(session_id,action,time,detail) VALUES (?,?,?,?)",
      )
      .run(
        "",
        "doctor_profile.updated",
        nowIso(),
        JSON.stringify({ revision: profile.revision }),
      );
    return this.get();
  }
  counts() {
    const one = (sql, ...args) =>
      this.store.db.prepare(sql).get(...args)?.n || 0;
    return {
      active: one(
        "SELECT COUNT(*) n FROM doctor_memories WHERE status='confirmed'",
      ),
      pending: one(
        "SELECT COUNT(*) n FROM doctor_memories WHERE status='pending' AND kind='consolidated'",
      ),
      openSignals: one(
        "SELECT COUNT(*) n FROM doctor_memories WHERE status='open'",
      ),
    };
  }
  // Compact preference digest injected into the medical system prompt.
  digest(maxChars = DIGEST_LIMIT) {
    const profile = this.row().fields;
    const lines = [];
    for (const [key, label] of PROFILE_TEXT_FIELDS)
      if (profile[key]) lines.push(`- ${label}：${profile[key]}`);
    for (const [key, label] of PROFILE_LIST_FIELDS) {
      const items = profile[key] || [];
      if (items.length) lines.push(`- ${label}：${items.join("；")}`);
    }
    const memories = this.store.db
      .prepare(
        "SELECT content, pinned FROM doctor_memories WHERE status='confirmed' ORDER BY pinned DESC, updated_at DESC, id DESC",
      )
      .all()
      .map((row) => row.content);
    if (memories.length) lines.push(`- 记忆偏好：${memories.join("；")}`);
    if (!lines.length) return "";
    let text = `医生偏好档案（本机保存，供个性化输出参考；与安全规则冲突时以安全规则为准）：\n`;
    for (const line of lines) {
      if (text.length + line.length + 1 > maxChars) break;
      text += `${line}\n`;
    }
    return text.trimEnd();
  }
  memories({ status, kind } = {}) {
    check(
      ["pending", "confirmed", "dismissed", "open", "merged", undefined].includes(
        status,
      ),
      "INVALID_INPUT",
      "记忆状态无效",
    );
    check(
      ["explicit", "observed", "consolidated", undefined].includes(kind),
      "INVALID_INPUT",
      "记忆类型无效",
    );
    const where = [];
    const args = [];
    if (status) {
      where.push("status=?");
      args.push(status);
    }
    if (kind) {
      where.push("kind=?");
      args.push(kind);
    }
    return this.store.db
      .prepare(
        `SELECT id,kind,status,pinned,count,topic,content,source,created_at,updated_at
         FROM doctor_memories ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT 500`,
      )
      .all(...args)
      .map((row) => ({
        ...row,
        pinned: Boolean(row.pinned),
        source: JSON.parse(row.source),
      }));
  }
  memoryRow(id) {
    check(Number.isInteger(id) && id > 0, "INVALID_INPUT", "记忆编号无效");
    const row = this.store.db
      .prepare(
        "SELECT id,kind,status,pinned,count,topic,content,source,created_at,updated_at FROM doctor_memories WHERE id=?",
      )
      .get(id);
    check(row, "NOT_FOUND", "记忆条目不存在", 404);
    return { ...row, pinned: Boolean(row.pinned), source: JSON.parse(row.source) };
  }
  addMemory({
    kind = "explicit",
    content,
    topic = "",
    source = {},
    status,
  } = {}) {
    check(
      ["explicit", "observed", "consolidated"].includes(kind),
      "INVALID_INPUT",
      "记忆类型无效",
    );
    const text = string(content, "偏好内容", 2000);
    check(
      kind !== "observed" || status === undefined || status === "open",
      "INVALID_INPUT",
      "观察信号只能以 open 状态进入",
    );
    const resolved =
      status || (kind === "explicit" ? "confirmed" : kind === "observed" ? "open" : "pending");
    check(
      ["confirmed", "pending", "open"].includes(resolved),
      "INVALID_INPUT",
      "记忆状态无效",
    );
    const time = nowIso();
    const info = this.store.db
      .prepare(
        "INSERT INTO doctor_memories(kind,status,pinned,count,topic,content,source,created_at,updated_at) VALUES (?,?,0,1,?,?,?,?,?)",
      )
      .run(
        kind,
        resolved,
        topic ? string(topic, "主题", 60) : "",
        text,
        JSON.stringify({ ...source, at: time }),
        time,
        time,
      );
    return this.memoryRow(Number(info.lastInsertRowid));
  }
  confirmMemory(id) {
    const row = this.memoryRow(id);
    check(
      ["pending", "open"].includes(row.status),
      "INVALID_INPUT",
      "只有待确认条目和观察信号可以确认生效",
    );
    // Same-topic confirmed memories are superseded, never duplicated.
    if (row.topic)
      this.store.db
        .prepare(
          "UPDATE doctor_memories SET status='dismissed',updated_at=? WHERE status='confirmed' AND topic=? AND id<>?",
        )
        .run(nowIso(), row.topic, id);
    this.store.db
      .prepare(
        "UPDATE doctor_memories SET status='confirmed',updated_at=? WHERE id=?",
      )
      .run(nowIso(), id);
    return this.memoryRow(id);
  }
  dismissMemory(id) {
    this.memoryRow(id);
    this.store.db
      .prepare(
        "UPDATE doctor_memories SET status='dismissed',updated_at=? WHERE id=?",
      )
      .run(nowIso(), id);
    return this.memoryRow(id);
  }
  pinMemory(id, pinned) {
    this.memoryRow(id);
    check(typeof pinned === "boolean", "INVALID_INPUT", "置顶状态无效");
    this.store.db
      .prepare(
        "UPDATE doctor_memories SET pinned=?,updated_at=? WHERE id=?",
      )
      .run(pinned ? 1 : 0, nowIso(), id);
    return this.memoryRow(id);
  }
  deleteMemory(id) {
    this.memoryRow(id);
    this.store.db.prepare("DELETE FROM doctor_memories WHERE id=?").run(id);
    return { ok: true };
  }
  // Observed signals come from real doctor actions (review decisions,
  // artifact corrections, repeated choices). Identical signals are merged
  // with a count instead of duplicating rows.
  recordSignal({ content, topic = "", source = {} } = {}) {
    const text = string(content, "信号内容", 1000);
    const digest = hashContent(text);
    const existing = this.store.db
      .prepare(
        "SELECT id,count FROM doctor_memories WHERE kind='observed' AND status='open' AND content=?",
      )
      .get(text);
    const time = nowIso();
    if (existing) {
      this.store.db
        .prepare(
          "UPDATE doctor_memories SET count=count+1,updated_at=?,source=? WHERE id=?",
        )
        .run(
          time,
          JSON.stringify({ ...source, at: time, digest }),
          existing.id,
        );
      return this.memoryRow(existing.id);
    }
    const info = this.store.db
      .prepare(
        "INSERT INTO doctor_memories(kind,status,pinned,count,topic,content,source,created_at,updated_at) VALUES ('observed','open',0,1,?,?,?,?,?)",
      )
      .run(
        topic ? string(topic, "主题", 60) : "",
        text,
        JSON.stringify({ ...source, at: time, digest }),
        time,
        time,
      );
    return this.memoryRow(Number(info.lastInsertRowid));
  }
  // Deterministic pass: repeated identical signals become pending
  // candidates. One-off signals stay open for the model pass or manual
  // confirmation.
  consolidate() {
    const open = this.store.db
      .prepare(
        "SELECT id,content,count,topic FROM doctor_memories WHERE kind='observed' AND status='open' ORDER BY id ASC LIMIT 200",
      )
      .all();
    const groups = new Map();
    for (const row of open) {
      const key = hashContent(row.content);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const created = [];
    const time = nowIso();
    for (const rows of groups.values()) {
      const total = rows.reduce((sum, row) => sum + row.count, 0);
      if (total < 2) continue;
      const source = {
        mode: "repeat",
        count: total,
        signals: rows.map((row) => row.id),
      };
      const info = this.store.db
        .prepare(
          "INSERT INTO doctor_memories(kind,status,pinned,count,topic,content,source,created_at,updated_at) VALUES ('consolidated','pending',0,?,?,?,?,?,?)",
        )
        .run(
          total,
          rows[0].topic,
          rows[0].content,
          JSON.stringify(source),
          time,
          time,
        );
      created.push(this.memoryRow(Number(info.lastInsertRowid)));
      for (const row of rows)
        this.store.db
          .prepare(
            "UPDATE doctor_memories SET status='merged',updated_at=? WHERE id=?",
          )
          .run(time, row.id);
    }
    return { created, openLeft: this.counts().openSignals };
  }
  // Model-assisted pass: needs explicit external-send consent, same as any
  // other model call. Produces pending candidates only — never active ones.
  async modelConsolidate(
    provider,
    { consent = false, model, signal } = {},
  ) {
    check(consent === true, "CONSENT_REQUIRED", "请先确认信号内容可以发送给所配置的模型服务", 412);
    const open = this.store.db
      .prepare(
        "SELECT id,content,count,topic FROM doctor_memories WHERE kind='observed' AND status='open' ORDER BY updated_at DESC LIMIT 50",
      )
      .all();
    check(open.length, "NOT_FOUND", "没有待归纳的观察信号", 404);
    const listing = open
      .map((row) => `${row.id}. ${row.content}${row.count > 1 ? `（出现 ${row.count} 次）` : ""}`)
      .join("\n");
    const result = await provider.complete(
      [
        {
          role: "system",
          content:
            "你是医生偏好归纳助手。输入是医生在工作台中的操作观察信号。把同类信号归纳为 0-5 条简洁、可执行的偏好候选条目，每条一句话，不要包含患者隐私内容。只输出 JSON 数组，每项形如 {\"content\":\"偏好内容\",\"topic\":\"主题\"}。没有可归纳的偏好时输出 []。",
        },
        { role: "user", content: listing },
      ],
      [],
      { signal, model },
    );
    let parsed;
    try {
      const match = String(result.text).match(/\[[\s\S]*\]/);
      parsed = match ? JSON.parse(match[0]) : [];
    } catch {
      throw new AppError("MODEL_OUTPUT", "模型输出无法解析为偏好候选，请重试或改用手动确认");
    }
    check(
      Array.isArray(parsed) && parsed.length <= 5,
      "MODEL_OUTPUT",
      "模型输出的候选条目过多",
    );
    const time = nowIso();
    const created = [];
    for (const item of parsed) {
      check(
        item && typeof item.content === "string" && item.content.trim(),
        "MODEL_OUTPUT",
        "模型输出的候选条目无效",
      );
      const content = string(item.content, "偏好候选", 500);
      const topic =
        typeof item.topic === "string" && item.topic.trim()
          ? string(item.topic, "主题", 60)
          : "";
      const info = this.store.db
        .prepare(
          "INSERT INTO doctor_memories(kind,status,pinned,count,topic,content,source,created_at,updated_at) VALUES ('consolidated','pending',0,1,?,?,?,?,?)",
        )
        .run(topic, content, JSON.stringify({ mode: "model", at: time }), time, time);
      created.push(this.memoryRow(Number(info.lastInsertRowid)));
    }
    for (const row of open)
      this.store.db
        .prepare(
          "UPDATE doctor_memories SET status='merged',updated_at=? WHERE id=?",
        )
        .run(time, row.id);
    return { created, model: result.model || model || provider.model };
  }
}
const memoryText = { type: "string" };
// Agent-facing tools. Saving from the model always creates a pending entry
// that the doctor must confirm; forgetting deactivates instead of deleting.
export function doctorMemoryTools(doctor) {
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
  return [
    {
      definition: definition(
        "doctor_memory_get",
        "查看当前医生的偏好档案摘要和已确认的记忆条目，用于让输出符合医生习惯。",
        {},
        [],
      ),
      execute: () => ({
        digest: doctor.digest(),
        memories: doctor
          .memories({ status: "confirmed" })
          .map((m) => ({ id: m.id, content: m.content, pinned: m.pinned })),
      }),
    },
    {
      definition: definition(
        "doctor_memory_save",
        "记录一条从对话中听到的医生偏好（例如“以后随访总结用表格”）。只生成待确认候选，需医生在设置中确认后生效。",
        { content: memoryText, topic: memoryText },
        ["content"],
      ),
      execute: (args) => {
        const row = doctor.addMemory({
          kind: "consolidated",
          content: args.content,
          topic: args.topic,
          source: { mode: "agent" },
        });
        return {
          saved: true,
          id: row.id,
          status: row.status,
          note: "偏好候选已记录，等待医生在设置中确认后才会生效。",
        };
      },
    },
    {
      definition: definition(
        "doctor_memory_forget",
        "按编号停用一条已确认的医生偏好（不物理删除，可由医生恢复管理）。",
        { id: { type: "integer" } },
        ["id"],
      ),
      execute: (args) => {
        const row = doctor.dismissMemory(args.id);
        return { forgotten: true, id: row.id, status: row.status };
      },
    },
  ];
}
