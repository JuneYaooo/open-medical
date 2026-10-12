import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import { check, identifier, string } from "../errors.mjs";
import { sqliteTransaction } from "../sqlite-transaction.mjs";
import { labKey } from "./patient-schedule.mjs";
import { stageSkillImport } from "./skill-import.mjs";

// The doctor's own building blocks. Every change is data with a version
// history and a source (chat, evolution suggestion, manual), so the
// workbench can grow new behaviour without code changes and any step can
// be undone. Automations only call existing, controlled actions.
//   skill       instructions (+ template) the agent follows; written to disk
//               so read_skill, @-mentions and the skill list see it.
//   automation  trigger → patient condition → action.
export const KINDS = ["skill", "automation"];
export const TRIGGERS = { daily: "每天", weekly: "每周", lab: "新检验结果", appointment: "复诊前" };
export const ACTIONS = { agenda: "加入今日待办", draft_message: "起草给患者的消息", report: "生成汇总" };
const OPS = { gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b, eq: (a, b) => a === b };
// Imported skill directory ids share the SkillRegistry namespace; "my-" is
// reserved for doctor-authored skills so the two stay distinguishable.
const SKILL_ID = /^(?!my-)[-a-z0-9_]+$/;
const rawString = (value, label, max) => {
  check(typeof value === "string" && value.length <= max, "INVALID_INPUT", `${label} 必须是不超过 ${max} 字符的文本`);
  return value;
};
const OP_TEXT = { gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=" };
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = 86400000;
const localDate = (ms) => { const d = new Date(ms); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
// Imported packs carry full file content; public shapes expose only a
// manifest so listings and extension_get never push megabytes into a prompt.
const fileManifest = (files) => files?.map((f) => ({ path: f.path, encoding: f.encoding, bytes: f.encoding === "base64" ? Math.ceil(f.content.length * 0.75) : f.content.length }));
const publicShape = (ext) => (ext.files ? { ...ext, files: fileManifest(ext.files) } : ext);
const localTime = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const iso = (ms) => new Date(ms).toISOString();
const text = (value, label, max) => (value === undefined || value === null || value === "" ? "" : string(value, label, max));
// Title family of a generated document: "出院小结草稿 · 林某（…）" → "出院小结草稿".
export const docFamily = (title) => String(title || "").split(/ · |（|\(/)[0].trim().slice(0, 40);
// Quick-task auto-ordering needs this many uses before it changes anything.
const USAGE_MIN = 5;
const EDIT_SUGGEST = 3;

export class Extensions {
  constructor({ store, patients, schedule, skillsDir, care = () => null, sessions = null, now = Date.now, skillExists = null, importer = null, proxyResolver = null }) {
    Object.assign(this, { store, patients, schedule, skillsDir, care, sessions, now, skillExists, importer: importer || stageSkillImport, proxyResolver });
    this.db = store.db;
    mkdirSync(skillsDir, { recursive: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS extensions(id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS extension_versions(extension_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(extension_id, version));
      CREATE TABLE IF NOT EXISTS automation_seen(extension_id TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(extension_id, key));
      CREATE TABLE IF NOT EXISTS automation_items(id TEXT PRIMARY KEY, extension_id TEXT NOT NULL, patient_id TEXT, status TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT);
      CREATE TABLE IF NOT EXISTS evolution_signals(kind TEXT NOT NULL, key TEXT NOT NULL, count INTEGER NOT NULL, data TEXT NOT NULL, first_at TEXT NOT NULL, last_at TEXT NOT NULL, PRIMARY KEY(kind, key));
      CREATE TABLE IF NOT EXISTS evolution_suggestions(id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evolution_changes(id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workbench_prefs(id TEXT PRIMARY KEY, data TEXT NOT NULL);
    `);
    // Skill files are derived from the database; rebuild them on start.
    for (const ext of this.list({ kind: "skill" }).filter((e) => e.status === "active")) this.writeSkill(ext);
  }
  iso() { return iso(this.now()); }

  // ---------- registry ----------
  row(id) {
    const row = this.db.prepare("SELECT * FROM extensions WHERE id=?").get(string(id, "扩展编号", 80));
    check(row, "NOT_FOUND", "扩展不存在", 404);
    return { id: row.id, kind: row.kind, status: row.status, ...JSON.parse(row.data) };
  }
  list({ kind } = {}) {
    return this.db.prepare(`SELECT * FROM extensions ${kind ? "WHERE kind=?" : ""} ORDER BY rowid DESC`).all(...(kind ? [kind] : []))
      .map((row) => ({ id: row.id, kind: row.kind, status: row.status, ...JSON.parse(row.data) }));
  }
  publicList({ kind } = {}) {
    return { extensions: this.list({ kind }).map((e) => ({ ...publicShape(e), stats: e.kind === "automation" ? this.stats(e.id) : undefined })), triggers: TRIGGERS, actions: ACTIONS };
  }
  detail(id) {
    const ext = this.row(id);
    const versions = this.db.prepare("SELECT version, source, created_at, data FROM extension_versions WHERE extension_id=? ORDER BY version DESC").all(ext.id)
      .map((v) => ({ version: v.version, source: JSON.parse(v.source), createdAt: v.created_at, spec: publicShape(JSON.parse(v.data)) }));
    return { ...publicShape(ext), versions, stats: ext.kind === "automation" ? this.stats(ext.id) : undefined };
  }

  // Validates a spec and returns the stored shape plus a readable summary.
  normalize(kind, spec = {}) {
    check(KINDS.includes(kind), "INVALID_INPUT", "扩展类型须为 skill 或 automation");
    check(spec && typeof spec === "object", "INVALID_INPUT", "扩展内容必须是对象");
    if (kind === "skill") {
      if (spec.imported) return this.normalizeImportedSkill(spec);
      const appliesTo = typeof spec.appliesTo === "string" ? [spec.appliesTo] : spec.appliesTo ?? [];
      check(Array.isArray(appliesTo), "INVALID_INPUT", "适用文书须为名称数组或单个名称");
      const value = {
        name: string(spec.name, "技能名称", 60),
        description: string(spec.description, "何时使用（description）", 600),
        body: string(spec.body, "技能说明", 20000),
        template: text(spec.template, "模板", 20000),
        appliesTo: appliesTo.map((x) => string(x, "适用文书", 40)).slice(0, 10),
        quickTask: spec.quickTask ? { title: string(spec.quickTask.title || spec.name, "快捷任务名称", 30), desc: text(spec.quickTask.desc, "快捷任务说明", 80), prompt: string(spec.quickTask.prompt, "快捷任务提示", 2000) } : null,
      };
      return { ...value, summary: `技能「${value.name}」：${value.description.slice(0, 80)}` };
    }
    const t = spec.trigger || {}, c = spec.condition || {}, a = spec.action || {};
    check(TRIGGERS[t.type], "INVALID_INPUT", `触发方式须为：${Object.keys(TRIGGERS).join("/")}`);
    const trigger = { type: t.type };
    if (t.type === "daily" || t.type === "weekly") { check(TIME.test(t.time || ""), "INVALID_INPUT", "时间须为 HH:MM"); trigger.time = t.time; }
    if (t.type === "weekly") { check(Number.isInteger(t.weekday) && t.weekday >= 1 && t.weekday <= 7, "INVALID_INPUT", "weekday 须为 1–7（周一至周日）"); trigger.weekday = t.weekday; }
    if (t.type === "lab" && t.item) trigger.item = string(t.item, "检验项目", 40);
    if (t.type === "appointment") { check(Number.isInteger(t.daysBefore) && t.daysBefore >= 0 && t.daysBefore <= 14, "INVALID_INPUT", "daysBefore 须为 0–14"); trigger.daysBefore = t.daysBefore; }
    const condition = {};
    for (const key of ["diagnosis", "tag", "group"]) if (c[key]) condition[key] = string(c[key], key, 60);
    if (c.gender) { check(["male", "female"].includes(c.gender), "INVALID_INPUT", "gender 须为 male/female"); condition.gender = c.gender; }
    for (const key of ["ageMin", "ageMax"]) if (c[key] !== undefined && c[key] !== null) { check(Number.isInteger(c[key]) && c[key] >= 0 && c[key] <= 130, "INVALID_INPUT", `${key} 无效`); condition[key] = c[key]; }
    if (c.lab) {
      check(OPS[c.lab.op] && typeof c.lab.value === "number" && Number.isFinite(c.lab.value), "INVALID_INPUT", "检验条件须包含 item、op（gt/gte/lt/lte/eq）和数值 value");
      condition.lab = { item: string(c.lab.item, "检验项目", 40), op: c.lab.op, value: c.lab.value };
    }
    check(ACTIONS[a.type], "INVALID_INPUT", `动作须为：${Object.keys(ACTIONS).join("/")}`);
    const action = { type: a.type };
    if (a.type === "agenda") { action.title = string(a.title, "待办标题", 60); action.detail = text(a.detail, "待办说明", 200); }
    if (a.type === "draft_message") action.text = string(a.text, "消息内容", 1000);
    if (a.type === "report") { action.title = string(a.title || spec.name, "汇总标题", 60); action.fields = ["diagnoses", "labs", "appointments", "followups"]; }
    check(!(a.type === "report" && !["daily", "weekly"].includes(trigger.type)), "INVALID_INPUT", "汇总只能按每天或每周定时生成");
    const value = { name: string(spec.name, "规则名称", 60), trigger, condition, action };
    return { ...value, summary: describe(value) };
  }
  // A skill imported from an external archive: id comes from the pack
  // (frontmatter name === directory id), files ship verbatim, origin records
  // where it came from so re-imports can version and the UI can link back.
  normalizeImportedSkill(spec) {
    const id = string(spec.id, "技能编号", 80);
    check(SKILL_ID.test(id), "INVALID_INPUT", "导入技能编号须为小写字母/数字/-/_，且不以 my- 开头");
    const name = string(spec.name, "技能名称", 100);
    check(name === id, "INVALID_INPUT", "导入技能的 name 必须与编号一致");
    const description = string(spec.description, "何时使用（description）", 4000);
    const body = rawString(spec.body ?? "", "技能说明", 100000);
    check(Array.isArray(spec.files) && spec.files.length >= 1 && spec.files.length <= 700, "INVALID_INPUT", "导入技能文件清单无效");
    let bytes = 0;
    const files = spec.files.map((file) => {
      check(file && typeof file === "object", "INVALID_INPUT", "导入技能文件无效");
      const path = string(file.path, "文件路径", 200);
      check(!path.includes("\\") && !path.startsWith("/") && !path.split("/").includes(".."), "INVALID_INPUT", "导入技能文件路径越界");
      const encoding = file.encoding === "base64" ? "base64" : "utf8";
      const content = rawString(file.content, `文件 ${path}`, encoding === "base64" ? 5_400_000 : 4_050_000);
      bytes += encoding === "base64" ? Math.ceil(content.length * 0.75) : content.length;
      return { path, encoding, content };
    });
    check(bytes <= 40_000_000, "INVALID_INPUT", "导入技能总大小超过 40MB");
    const url = string(spec.origin?.url || "", "来源地址", 500);
    check(/^https:\/\//.test(url), "INVALID_INPUT", "导入技能必须带有 HTTPS 来源地址");
    const origin = { url, repo: text(spec.origin?.repo, "仓库", 200), ref: text(spec.origin?.ref, "分支", 100), hash: text(spec.origin?.hash, "校验值", 80) };
    return { imported: true, id, name, title: text(spec.title, "标题", 200), description, body, files, origin,
      summary: `技能「${name}」（来自 ${new URL(url).host}）：${description.slice(0, 80)}` };
  }
  save({ id, kind, spec, source = { via: "manual" } }) {
    let writtenId;
    try { return sqliteTransaction(this.db, () => {
      const existing = id ? this.row(id) : null;
      if (existing) check(existing.kind === kind, "INVALID_INPUT", "不能改变扩展类型");
      const value = this.normalize(kind, spec);
      const extId = existing?.id || (value.imported ? value.id : kind === "skill" ? `my-${randomUUID().slice(0, 8)}` : randomUUID());
      const version = (existing?.version || 0) + 1, at = this.iso();
      const data = { ...value, version, source, createdAt: existing?.createdAt || at, updatedAt: at };
      if (existing) this.db.prepare("UPDATE extensions SET data=? WHERE id=?").run(JSON.stringify(data), extId);
      else this.db.prepare("INSERT INTO extensions VALUES (?,?,?,?)").run(extId, kind, "active", JSON.stringify(data));
      this.db.prepare("INSERT INTO extension_versions VALUES (?,?,?,?,?)").run(extId, version, JSON.stringify(value), JSON.stringify(source), at);
      const ext = this.row(extId);
      if (kind === "skill" && ext.status === "active") { writtenId = ext.id; this.writeSkill(ext); }
      if (kind === "automation" && !existing) this.baseline(ext);
      this.store.audit(null, existing ? "extension.updated" : "extension.created", { id: extId, kind, version, via: source.via });
      return ext;
    }); } catch (error) {
      if (writtenId) this.restoreSkill(writtenId);
      throw error;
    }
  }
  setStatus(id, status) {
    check(["active", "disabled"].includes(status), "INVALID_INPUT", "状态须为 active/disabled");
    const ext = this.row(id);
    try { return sqliteTransaction(this.db, () => {
    this.db.prepare("UPDATE extensions SET status=? WHERE id=?").run(status, ext.id);
    if (ext.kind === "skill") status === "active" ? this.writeSkill({ ...ext, status }) : this.removeSkill(ext.id);
    // Re-enabling must not replay everything that happened while it was off.
    if (ext.kind === "automation" && status === "active" && ext.status !== "active") this.baseline(ext);
    this.store.audit(null, "extension.status", { id: ext.id, status });
    return this.row(ext.id);
    }); } catch (error) {
      if (ext.kind === "skill") this.restoreSkill(ext.id);
      throw error;
    }
  }
  rollback(id, version) {
    const ext = this.row(id);
    const row = this.db.prepare("SELECT data FROM extension_versions WHERE extension_id=? AND version=?").get(ext.id, Number(version));
    check(row, "NOT_FOUND", "没有这个版本", 404);
    return this.save({ id: ext.id, kind: ext.kind, spec: JSON.parse(row.data), source: { via: "rollback", fromVersion: Number(version) } });
  }

  // ---------- skills on disk ----------
  skillFile(ext) {
    const front = yaml.dump({ name: ext.id, title: ext.name, description: `${ext.description}${ext.appliesTo?.length ? `（适用：${ext.appliesTo.join("、")}）` : ""}` }, { lineWidth: -1 });
    return `---\n${front}---\n\n# ${ext.name}\n\n> 医生自定义技能（第 ${ext.version} 版）。与系统安全规则冲突时，以安全规则为准。\n\n${ext.body}\n${ext.template ? `\n## 模板\n\n按以下模板的结构和栏目输出，缺失信息标「待补充」，不要编造：\n\n${ext.template}\n` : ""}`;
  }
  writeSkill(ext) {
    const dir = join(this.skillsDir, ext.id);
    if (ext.imported && ext.files?.length) {
      // Imported packs ship verbatim (frontmatter included), so the registry
      // sees exactly what upstream published; the directory is rebuilt from
      // the committed database state on every write.
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      for (const file of ext.files) {
        const target = join(dir, ...file.path.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.encoding === "base64" ? Buffer.from(file.content, "base64") : file.content);
      }
      return;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), this.skillFile(ext));
  }
  removeSkill(id) { rmSync(join(this.skillsDir, id), { recursive: true, force: true }); }
  // Disk files are a projection of committed extension state. Restore after
  // an audit/write failure or a caller's confirmation transaction rolls back.
  restoreSkill(id) {
    const row = this.db.prepare("SELECT id FROM extensions WHERE id=?").get(id);
    const ext = row ? this.row(id) : null;
    if (ext?.kind === "skill" && ext.status === "active") this.writeSkill(ext);
    else this.removeSkill(id);
  }
  quickTasks() {
    return this.list({ kind: "skill" }).filter((e) => e.status === "active" && e.quickTask)
      .map((e) => ({ id: `ext:${e.id}`, skillId: e.id, title: e.quickTask.title, desc: e.quickTask.desc || e.description.slice(0, 40), prompt: e.quickTask.prompt, custom: true }));
  }

  // ---------- automations ----------
  matches(patient, condition, lab = null) {
    if (patient.archived) return false;
    const has = (list, v) => (list || []).some((x) => String(x).includes(v));
    if (condition.diagnosis && !(patient.diagnoses || []).some((d) => d.name.includes(condition.diagnosis))) return false;
    if (condition.tag && !has(patient.tags, condition.tag)) return false;
    if (condition.group && !has(patient.groups, condition.group)) return false;
    if (condition.gender && patient.gender !== condition.gender) return false;
    if (condition.ageMin !== undefined || condition.ageMax !== undefined) {
      if (!patient.birthYear) return false;
      const age = new Date(this.now()).getFullYear() - Number(patient.birthYear);
      if (condition.ageMin !== undefined && age < condition.ageMin) return false;
      if (condition.ageMax !== undefined && age > condition.ageMax) return false;
    }
    if (condition.lab) {
      const item = condition.lab.item;
      const value = lab && lab.item.includes(item) ? lab : (patient.labs || []).filter((l) => l.item.includes(item)).sort((a, b) => b.date.localeCompare(a.date))[0];
      if (!value || !OPS[condition.lab.op](value.value, condition.lab.value)) return false;
    }
    return true;
  }
  // Firings for one automation: { key, patient, lab?, appointment? }.
  firings(ext, { dryRun = false } = {}) {
    const now = this.now(), today = localDate(now), out = [];
    const patients = this.patients.all().filter((p) => !p.archived);
    const t = ext.trigger;
    if (t.type === "daily" || t.type === "weekly") {
      const weekday = ((new Date(now).getDay() + 6) % 7) + 1;
      const due = dryRun || (localTime(now) >= t.time && (t.type === "daily" || weekday === t.weekday));
      if (!due) return out;
      const key = `${t.type}:${today}`;
      const matched = patients.filter((p) => this.matches(p, ext.condition));
      if (ext.action.type === "report") return matched.length || dryRun ? [{ key, patients: matched }] : [];
      for (const p of matched) out.push({ key: `${key}:${p.id}`, patient: p });
    }
    if (t.type === "lab") {
      const since = localDate(now - 30 * DAY);
      for (const p of patients) for (const lab of p.labs || []) {
        if (t.item && !lab.item.includes(t.item)) continue;
        if (dryRun && lab.date < since) continue;
        if (this.matches(p, ext.condition, lab)) out.push({ key: `lab:${p.id}:${labKey(lab)}`, patient: p, lab });
      }
    }
    if (t.type === "appointment" && this.schedule) {
      const target = localDate(Date.parse(`${today}T12:00:00`) + t.daysBefore * DAY);
      for (const a of this.db.prepare("SELECT data FROM appointments WHERE status='scheduled' AND date>=? AND date<=?").all(today, dryRun ? localDate(now + 14 * DAY) : target).map((r) => JSON.parse(r.data))) {
        if (!dryRun && a.date !== target) continue;
        const p = patients.find((x) => x.id === a.patientId);
        if (p && this.matches(p, ext.condition)) out.push({ key: `appt:${a.id}:${a.date}`, patient: p, appointment: a });
      }
    }
    return out;
  }
  fill(template, f) {
    const values = { 姓名: f.patient?.name || "", 检验: f.lab?.item || "", 数值: f.lab ? `${f.lab.value}${f.lab.unit || ""}` : "", 日期: f.lab?.date || "",
      复诊日期: f.appointment ? `${f.appointment.date}${f.appointment.time ? ` ${f.appointment.time}` : ""}` : "", 复诊事项: f.appointment?.reason || "" };
    return String(template || "").replace(/\{(姓名|检验|数值|日期|复诊日期|复诊事项)\}/g, (_, k) => values[k]);
  }
  // Mark what already exists as handled so a new rule starts from now.
  baseline(ext) {
    if (ext.trigger.type !== "lab") return;
    const put = this.db.prepare("INSERT OR IGNORE INTO automation_seen VALUES (?,?)");
    for (const f of this.firings(ext)) put.run(ext.id, f.key);
  }
  // What the rule would produce against current data, without doing it.
  preview(kind, spec) {
    const value = this.normalize(kind, spec);
    if (kind === "skill" && value.imported) {
      const bytes = value.files.reduce((n, f) => n + (f.encoding === "base64" ? Math.ceil(f.content.length * 0.75) : f.content.length), 0);
      return { summary: value.summary, fileCount: value.files.length, bytes, files: value.files.slice(0, 30).map((f) => f.path), origin: value.origin };
    }
    if (kind === "skill") return { summary: value.summary, skill: this.skillFile({ id: "my-preview", version: 1, ...value }) };
    const firings = this.firings({ id: "preview", ...value }, { dryRun: true });
    const label = (f) => value.action.type === "report" ? `${value.action.title}：${f.patients.length} 位患者` : `${f.patient.name}：${value.action.type === "agenda" ? this.fill(value.action.title, f) : this.fill(value.action.text, f).slice(0, 60)}`;
    return { summary: value.summary, count: value.action.type === "report" ? firings[0]?.patients.length || 0 : firings.length, samples: firings.slice(0, 8).map(label),
      note: value.trigger.type === "lab" ? "按最近 30 天的检验记录试算；正式启用后只对新结果生效。" : value.trigger.type === "appointment" ? "按未来 14 天的预约试算。" : "按当前患者档案试算。" };
  }
  async run(ext, now) {
    const seen = this.db.prepare("SELECT 1 FROM automation_seen WHERE extension_id=? AND key=?");
    const mark = this.db.prepare("INSERT OR IGNORE INTO automation_seen VALUES (?,?)");
    let produced = 0;
    for (const f of this.firings(ext)) {
      if (seen.get(ext.id, f.key)) continue;
      mark.run(ext.id, f.key);
      try {
        if (ext.action.type === "agenda") this.addItem(ext, f.patient.id, { title: this.fill(ext.action.title, f), detail: this.fill(ext.action.detail, f) });
        if (ext.action.type === "draft_message") {
          const care = this.care();
          check(care, "CARE_UNAVAILABLE", "患者消息模块未启用");
          const reply = care.createReply({ patientId: f.patient.id, text: this.fill(ext.action.text, f), mode: "draft", reason: `自动化「${ext.name}」` });
          this.addItem(ext, f.patient.id, { title: "已起草消息，待核对发送", detail: reply.text.slice(0, 80), replyId: reply.id, auto: true });
        }
        if (ext.action.type === "report") this.report(ext, f.patients, now);
        produced++;
      } catch (error) {
        this.store.audit(null, "extension.failed", { id: ext.id, error: error.message });
        this.recordFailure(ext, error.message);
      }
    }
    return produced;
  }
  // Deterministic, local summary (no model call) saved as a task the doctor can open or continue with AI.
  report(ext, patients, now) {
    const lines = [`# ${ext.action.title}`, "", `生成时间：${new Date(now).toLocaleString("zh-CN")} · 规则「${ext.name}」 · 共 ${patients.length} 位患者`, ""];
    for (const p of patients) {
      const labs = (p.labs || []).slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4).map((l) => `${l.item} ${l.value}${l.unit || ""}（${l.date}）`);
      const next = this.db.prepare("SELECT data FROM appointments WHERE patient_id=? AND status='scheduled' ORDER BY date LIMIT 1").get(p.id);
      const due = this.db.prepare("SELECT COUNT(*) n FROM reminders WHERE patient_id=? AND status='pending'").get(p.id).n;
      lines.push(`## ${p.name}${p.patientNumber ? `（${p.patientNumber}）` : ""}`,
        `- 诊断：${(p.diagnoses || []).map((d) => d.name).join("、") || "未记录"}`,
        `- 近期检验：${labs.join("；") || "无"}`,
        `- 下次复诊：${next ? JSON.parse(next.data).date : "未预约"}`,
        `- 待登记随访：${due} 项`, "");
    }
    const text = lines.join("\n");
    let sessionId = null;
    if (this.sessions) {
      const session = this.sessions.createSession({ title: `${ext.action.title} · ${localDate(now)}` });
      this.sessions.addMaterial(session.id, { name: `${ext.action.title}.md`, text });
      sessionId = session.id;
    }
    this.addItem(ext, null, { title: `「${ext.action.title}」已生成（${patients.length} 位患者）`, detail: "打开后可以让 AI 继续分析", sessionId, lane: "work" });
  }
  addItem(ext, patientId, data) {
    this.db.prepare("INSERT INTO automation_items VALUES (?,?,?,?,?,?,?)").run(randomUUID(), ext.id, patientId, "open", JSON.stringify({ ...data, rule: ext.name }), this.iso(), null);
  }
  openItems() {
    return this.db.prepare("SELECT i.* FROM automation_items i JOIN extensions e ON e.id=i.extension_id WHERE i.status='open'").all()
      .map((r) => ({ id: r.id, extensionId: r.extension_id, patientId: r.patient_id, createdAt: r.created_at, ...JSON.parse(r.data) }));
  }
  resolveItem(id, status) {
    check(["done", "dismissed"].includes(status), "INVALID_INPUT", "状态须为 done/dismissed");
    const row = this.db.prepare("SELECT * FROM automation_items WHERE id=?").get(identifier(id));
    check(row, "NOT_FOUND", "待办不存在", 404);
    this.db.prepare("UPDATE automation_items SET status=?, resolved_at=? WHERE id=?").run(status, this.iso(), row.id);
    return { id: row.id, status };
  }
  stats(id) {
    const rows = this.db.prepare("SELECT status, COUNT(*) n FROM automation_items WHERE extension_id=? GROUP BY status").all(id);
    const n = (s) => rows.find((r) => r.status === s)?.n || 0;
    const last = this.db.prepare("SELECT MAX(created_at) t FROM automation_items WHERE extension_id=?").get(id).t;
    return { produced: n("open") + n("done") + n("dismissed"), open: n("open"), done: n("done"), dismissed: n("dismissed"), lastAt: last, failures: this.signal("failure", id)?.count || 0 };
  }
  async tick() {
    const now = this.now();
    for (const ext of this.list({ kind: "automation" }).filter((e) => e.status === "active")) await this.run(ext, now);
    if (!this.lastEvolve || now - this.lastEvolve >= 3600000) { this.lastEvolve = now; this.evolve(); }
  }
  start(intervalMs = 60000) {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, intervalMs);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  // ---------- evolution ----------
  signal(kind, key) {
    const row = this.db.prepare("SELECT * FROM evolution_signals WHERE kind=? AND key=?").get(kind, key);
    return row ? { ...row, data: JSON.parse(row.data) } : null;
  }
  bump(kind, key, patch = {}) {
    const at = this.iso(), old = this.signal(kind, key);
    const data = { ...(old?.data || {}), ...patch };
    if (patch.note) data.notes = [...(old?.data.notes || []), patch.note].slice(-8);
    delete data.note;
    this.db.prepare("INSERT INTO evolution_signals VALUES (?,?,?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET count=count+1, data=excluded.data, last_at=excluded.last_at")
      .run(kind, key, 1, JSON.stringify(data), at, at);
  }
  recordUsage(flowId) { this.bump("quick_task", string(flowId, "任务模板", 80)); return this.prefs(); }
  recordEdit({ title, type, note }) {
    const family = docFamily(title);
    if (!family) return;
    this.bump("doc_edit", family, { type, ...(note ? { note: String(note).slice(0, 300) } : {}) });
  }
  recordFailure(ext, message) { this.bump("failure", ext.id, { message: message.slice(0, 200) }); }
  prefs() {
    const saved = JSON.parse(this.db.prepare("SELECT data FROM workbench_prefs WHERE id='local'").get()?.data || "{}");
    const usage = Object.fromEntries(this.db.prepare("SELECT key, count FROM evolution_signals WHERE kind='quick_task'").all().map((r) => [r.key, r.count]));
    return { autoOrder: saved.autoOrder !== false, starters: saved.starters || null, usage, quickTasks: this.quickTasks() };
  }
  setPrefs(changes) {
    const saved = JSON.parse(this.db.prepare("SELECT data FROM workbench_prefs WHERE id='local'").get()?.data || "{}");
    this.db.prepare("INSERT INTO workbench_prefs VALUES ('local',?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(JSON.stringify({ ...saved, ...changes }));
    return this.prefs();
  }
  suggest(key, data) {
    const existing = this.db.prepare("SELECT status FROM evolution_suggestions WHERE key=?").get(key);
    if (existing) return;
    this.db.prepare("INSERT INTO evolution_suggestions VALUES (?,?,?,?,?,?)").run(randomUUID(), key, "open", JSON.stringify(data), this.iso(), this.iso());
  }
  // Looks at usage and outcomes; low-risk layout changes apply directly
  // (with an undo entry), anything touching content becomes a suggestion.
  evolve() {
    const prefs = this.prefs();
    // 1. Quick tasks: the three most-used become the starters.
    const used = Object.entries(prefs.usage).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
    const total = used.reduce((s, [, n]) => s + n, 0);
    if (prefs.autoOrder && total >= USAGE_MIN && used.length) {
      const starters = used.slice(0, 3).map(([id]) => id);
      if (JSON.stringify(starters) !== JSON.stringify(prefs.starters)) {
        this.db.prepare("INSERT INTO evolution_changes VALUES (?,?,?,?)").run(randomUUID(), "applied",
          JSON.stringify({ type: "starters", title: "把你最常用的任务放到了首页最前面", detail: starters.join("、"), before: prefs.starters, after: starters }), this.iso());
        this.setPrefs({ starters });
      }
    }
    // 2. Documents the doctor keeps correcting → propose a personal skill.
    const covered = new Set(this.list({ kind: "skill" }).filter((e) => e.status === "active").flatMap((e) => e.appliesTo || []));
    for (const s of this.db.prepare("SELECT * FROM evolution_signals WHERE kind='doc_edit' AND count>=?").all(EDIT_SUGGEST)) {
      if (covered.has(s.key)) continue;
      const data = JSON.parse(s.data);
      this.suggest(`doc_edit:${s.key}:${Math.floor(s.count / EDIT_SUGGEST)}`, {
        type: "create_skill", title: `为「${s.key}」建立你的专属写法`, evidence: `你已修改过 ${s.count} 次「${s.key}」${data.notes?.length ? `，修改依据包括：${data.notes.slice(-3).join("；")}` : ""}`,
        prompt: `我经常修改AI生成的「${s.key}」。${data.notes?.length ? `我最近的修改依据：${data.notes.join("；")}。` : ""}请先问清我希望的结构、必写内容和措辞习惯（也可以让我上传医院模板），然后用 extension_propose 建立一个适用于「${s.key}」的技能（appliesTo 填 ${JSON.stringify([s.key])}，并设为快捷任务），给我预览后再提交。`,
      });
    }
    // 3. Rules whose to-dos are mostly ignored → propose to adjust or stop.
    for (const ext of this.list({ kind: "automation" }).filter((e) => e.status === "active")) {
      const st = this.stats(ext.id), closed = st.done + st.dismissed;
      if (closed >= 5 && st.dismissed / closed >= 0.7)
        this.suggest(`ignored:${ext.id}:v${ext.version}`, { type: "adjust_automation", extensionId: ext.id, title: `规则「${ext.name}」产生的待办大多被忽略`,
          evidence: `最近 ${closed} 条中忽略了 ${st.dismissed} 条`, prompt: `规则「${ext.name}」（${ext.summary}）产生的待办大多被我忽略。请帮我分析原因，建议更合适的条件，用 extension_preview 试算后再用 extension_propose 提交修改；如果没必要保留，就建议停用。` });
      if (st.failures >= 3) this.suggest(`failing:${ext.id}:v${ext.version}`, { type: "adjust_automation", extensionId: ext.id, title: `规则「${ext.name}」多次运行失败`,
        evidence: this.signal("failure", ext.id)?.data.message || "", prompt: `规则「${ext.name}」多次运行失败：${this.signal("failure", ext.id)?.data.message || ""}。请帮我检查并修正。` });
    }
  }
  suggestions({ status = "open" } = {}) {
    return this.db.prepare("SELECT * FROM evolution_suggestions WHERE status=? ORDER BY created_at DESC").all(status).map((r) => ({ id: r.id, status: r.status, createdAt: r.created_at, ...JSON.parse(r.data) }));
  }
  resolveSuggestion(id, status) {
    check(["accepted", "dismissed"].includes(status), "INVALID_INPUT", "状态须为 accepted/dismissed");
    const r = this.db.prepare("UPDATE evolution_suggestions SET status=?, updated_at=? WHERE id=? AND status='open'").run(status, this.iso(), identifier(id));
    check(r.changes === 1, "NOT_FOUND", "建议不存在或已处理", 404);
    return { id, status };
  }
  changes() {
    return this.db.prepare("SELECT * FROM evolution_changes ORDER BY created_at DESC LIMIT 20").all().map((r) => ({ id: r.id, status: r.status, createdAt: r.created_at, ...JSON.parse(r.data) }));
  }
  // Undo restores the previous layout and stops further automatic ordering.
  undoChange(id) {
    const row = this.db.prepare("SELECT * FROM evolution_changes WHERE id=?").get(identifier(id));
    check(row && row.status === "applied", "NOT_FOUND", "该调整不存在或已撤销", 404);
    const change = JSON.parse(row.data);
    if (change.type === "starters") this.setPrefs({ starters: change.before || null, autoOrder: false });
    this.db.prepare("UPDATE evolution_changes SET status='undone' WHERE id=?").run(row.id);
    return { id: row.id, status: "undone", prefs: this.prefs() };
  }
  overview() {
    return { ...this.publicList(), suggestions: this.suggestions(), changes: this.changes(), prefs: this.prefs() };
  }

  // ---------- proposals (chat) ----------
  normalizeProposal(type, payload = {}) {
    if (type === "ext-install") {
      const install = payload.install || {};
      check(install.source && typeof install.source.url === "string" && Array.isArray(install.skills) && install.skills.length >= 1,
        "INVALID_INPUT", "安装提案缺少来源或技能清单");
      check(install.skills.length <= 8, "INVALID_INPUT", "一次最多安装 8 个技能");
      const totalBytes = install.skills.reduce((n, s) => n + (s.files || []).reduce((m, f) => m + (f.encoding === "base64" ? Math.ceil((f.content || "").length * 0.75) : (f.content || "").length), 0), 0);
      check(totalBytes <= 48_000_000, "INVALID_INPUT", `技能包总量 ${Math.round(totalBytes / 1_000_000)}MB 超过 48MB 单次安装上限，请分批或精选安装`);
      const values = install.skills.map((spec) => this.normalize("skill", spec));
      const conflicts = values.filter((value) => {
        const existing = this.findImported(value.id);
        return existing ? !(existing.kind === "skill" && existing.imported && existing.version === (install.skills.find((s) => s.id === value.id)?.previousVersion ?? -1)) : false;
      });
      return {
        install: { source: install.source, skills: install.skills },
        reason: text(payload.reason, "原因", 500),
        summary: `安装 ${values.length} 个技能：${values.map((v) => v.name).join("、")}`.slice(0, 300),
        preview: { skills: values.map((value, index) => ({ id: value.id, name: value.name, title: value.title, description: value.description.slice(0, 200),
          files: value.files.length, bytes: value.files.reduce((n, f) => n + (f.encoding === "base64" ? Math.ceil(f.content.length * 0.75) : f.content.length), 0),
          update: install.skills[index].previousVersion || null })), stale: conflicts.map((value) => value.id) },
      };
    }
    check(type === "ext-change", "INVALID_INPUT", "未知的扩展提案");
    const existing = payload.id ? this.row(payload.id) : null;
    const kind = existing?.kind || payload.kind;
    const value = this.normalize(kind, payload.spec);
    const preview = this.preview(kind, payload.spec);
    return { id: existing?.id || null, kind, spec: payload.spec, reason: text(payload.reason, "原因", 500), suggestionId: payload.suggestionId || null,
      summary: value.summary, preview, previousVersion: existing?.version || null };
  }
  applyProposal(action) {
    const p = action.payload;
    if (p.install) return this.applyInstall(action);
    if (p.id) check(Number.isSafeInteger(p.previousVersion) && this.row(p.id).version === p.previousVersion,
      "ACTION_CONFLICT", "扩展在提案生成后已变化，请读取最新版本并重新生成提案。", 409);
    const ext = this.save({ id: p.id, kind: p.kind, spec: p.spec, source: { via: p.suggestionId ? "evolution" : "chat", proposalId: action.id, reason: p.reason } });
    if (p.suggestionId) try { this.resolveSuggestion(p.suggestionId, "accepted"); } catch { /* already handled */ }
    return ext;
  }
  // Confirming an install applies each staged skill through save() so version
  // history, disk materialization and audit stay on one path. Re-importing an
  // already-installed skill is an update guarded by its staged version.
  applyInstall(action) {
    const install = action.payload.install;
    const appliedIds = [];
    try {
      for (const spec of install.skills) {
        const value = this.normalize("skill", spec);
        const existing = this.findImported(value.id);
        if (existing) {
          check(existing.kind === "skill" && existing.imported && Number.isSafeInteger(spec.previousVersion) && existing.version === spec.previousVersion,
            "ACTION_CONFLICT", `技能 ${value.id} 在提案生成后已变化，请重新生成安装提案。`, 409);
        } else {
          const taken = (() => { try { return this.skillExists ? this.skillExists(value.id) : false; } catch { return false; } })();
          check(!taken, "INVALID_INPUT", `技能 ${value.id} 与内置技能重名，未安装。`);
        }
        const ext = this.save({ id: existing?.id || null, kind: "skill", spec, source: { via: "import", url: value.origin.url, proposalId: action.id, reason: action.payload.reason } });
        appliedIds.push(ext.id);
      }
      return { kind: "skill", ids: appliedIds, extensions: appliedIds.map((id) => this.row(id)) };
    } catch (error) {
      for (const id of appliedIds) this.restoreSkill(id);
      throw error;
    }
  }
  // Download, validate and stage a skill pack for a proposal. Network and
  // parsing happen here so the pending payload carries exactly what was
  // previewed — confirming an install never re-fetches anything.
  async stageImport({ url, select }) {
    check(typeof url === "string" && url.trim(), "INVALID_INPUT", "请提供 GitHub 仓库或 tar.gz 压缩包地址");
    const chosen = [...new Set((Array.isArray(select) ? select : []).map((id) => string(id, "技能名", 80)))];
    return this.importer({
      url,
      select: chosen,
      skillExists: (id) => { try { return this.skillExists ? this.skillExists(id) : false; } catch { return false; } },
      lookupExtension: (id) => this.findImported(id),
      ...(this.proxyResolver ? { resolveProxy: this.proxyResolver } : {}),
    });
  }
  findImported(id) {
    try {
      return this.row(id);
    } catch (error) {
      if (error.code === "NOT_FOUND") return null;
      throw error;
    }
  }
  // Hard delete of a skill extension (row, history, files). Automations stay
  // toggle-only: their历史 preserves what was produced while active.
  remove(id) {
    const ext = this.row(id);
    check(ext.kind === "skill", "INVALID_INPUT", "规则不能删除，只能停用");
    return sqliteTransaction(this.db, () => {
      this.db.prepare("DELETE FROM extension_versions WHERE extension_id=?").run(ext.id);
      this.db.prepare("DELETE FROM extensions WHERE id=?").run(ext.id);
      this.removeSkill(ext.id);
      this.store.audit(null, "extension.deleted", { id: ext.id, via: ext.source?.via, imported: Boolean(ext.imported) });
      return { ok: true, id: ext.id };
    });
  }
}

function describe(v) {
  const t = v.trigger, c = v.condition, a = v.action;
  const when = t.type === "daily" ? `每天 ${t.time}` : t.type === "weekly" ? `每周${"一二三四五六日"[t.weekday - 1]} ${t.time}` : t.type === "lab" ? `出现新的${t.item || ""}检验结果时` : `复诊前 ${t.daysBefore} 天`;
  const who = [c.diagnosis && `诊断含「${c.diagnosis}」`, c.tag && `标签「${c.tag}」`, c.group && `分组「${c.group}」`, c.gender && (c.gender === "female" ? "女性" : "男性"),
    (c.ageMin !== undefined || c.ageMax !== undefined) && `年龄 ${c.ageMin ?? ""}–${c.ageMax ?? ""} 岁`, c.lab && `${c.lab.item} ${OP_TEXT[c.lab.op]} ${c.lab.value}`].filter(Boolean).join("、") || "所有患者";
  const what = a.type === "agenda" ? `在今日待办提醒「${a.title}」` : a.type === "draft_message" ? "起草一条给患者的消息（需核对后发送）" : `生成「${a.title}」汇总`;
  return `${when}，${who}：${what}`;
}
