import { randomUUID } from "node:crypto";
import { check, identifier, string } from "../../../server/errors.mjs";
import { sqliteTransaction } from "../../../server/sqlite-transaction.mjs";
import { labKey } from "../../../server/medical/patient-schedule.mjs";

// Automation and evolution are part of the learning plugin. They share the
// fixed `extensions` registry table with doctor-authored skills, but own the
// automation_* / evolution_* / workbench_prefs tables.
export const KINDS = ["skill", "automation"];
export const TRIGGERS = { daily: "每天", weekly: "每周", lab: "新检验结果", appointment: "复诊前" };
export const ACTIONS = { agenda: "加入今日待办", draft_message: "起草给患者的消息", report: "生成汇总" };
const OPS = { gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b, eq: (a, b) => a === b };
const OP_TEXT = { gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=" };
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = 86400000;
const localDate = (ms) => { const d = new Date(ms); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const localTime = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const text = (value, label, max) => (value === undefined || value === null || value === "" ? "" : string(value, label, max));
export const docFamily = (title) => String(title || "").split(/ · |（|\(/)[0].trim().slice(0, 40);
const USAGE_MIN = 5;
const EDIT_SUGGEST = 3;

function describe(v) {
  const t = v.trigger, c = v.condition, a = v.action;
  const when = t.type === "daily" ? `每天 ${t.time}` : t.type === "weekly" ? `每周${"一二三四五六日"[t.weekday - 1]} ${t.time}` : t.type === "lab" ? `出现新的${t.item || ""}检验结果时` : `复诊前 ${t.daysBefore} 天`;
  const who = [c.diagnosis && `诊断含「${c.diagnosis}」`, c.tag && `标签「${c.tag}」`, c.group && `分组「${c.group}」`, c.gender && (c.gender === "female" ? "女性" : "男性"),
    (c.ageMin !== undefined || c.ageMax !== undefined) && `年龄 ${c.ageMin ?? ""}–${c.ageMax ?? ""} 岁`, c.lab && `${c.lab.item} ${OP_TEXT[c.lab.op]} ${c.lab.value}`].filter(Boolean).join("、") || "所有患者";
  const what = a.type === "agenda" ? `在今日待办提醒「${a.title}」` : a.type === "draft_message" ? "起草一条给患者的消息（需核对后发送）" : `生成「${a.title}」汇总`;
  return `${when}，${who}：${what}`;
}

export class LearningAutomation {
  constructor(store, { extensions = null, patients, schedule = null, sessions = null, care = null, now = Date.now } = {}) {
    this.store = store;
    this.db = store.db;
    this.extensions = extensions;
    this.patients = patients;
    this.schedule = schedule;
    this.sessions = sessions;
    this.care = care || (() => null);
    this.now = now;
    this.timer = null;
    this.lastEvolve = 0;
  }
  iso() { return new Date(this.now()).toISOString(); }
  row(id) {
    const r = this.db.prepare("SELECT * FROM extensions WHERE id=?").get(identifier(id));
    check(r && r.kind === "automation", "NOT_FOUND", "规则不存在", 404);
    return { ...JSON.parse(r.data), id: r.id, kind: r.kind, status: r.status };
  }
  list({ kind = "automation" } = {}) {
    return this.db.prepare("SELECT * FROM extensions WHERE kind=? ORDER BY rowid").all(kind)
      .map((r) => ({ ...JSON.parse(r.data), id: r.id, kind: r.kind, status: r.status }));
  }
  publicList() {
    return { extensions: this.list().map((e) => ({ ...e, stats: this.stats(e.id) })), triggers: TRIGGERS, actions: ACTIONS };
  }
  detail(id) {
    const ext = this.row(id);
    const versions = this.db.prepare("SELECT version, source, created_at, data FROM extension_versions WHERE extension_id=? ORDER BY version DESC").all(ext.id)
      .map((v) => ({ version: v.version, source: JSON.parse(v.source), createdAt: v.created_at, spec: JSON.parse(v.data) }));
    return { ...ext, versions, stats: this.stats(ext.id) };
  }
  normalize(kind, spec = {}) {
    check(kind === "automation", "INVALID_INPUT", "此服务只处理自动化规则");
    check(spec && typeof spec === "object", "INVALID_INPUT", "扩展内容必须是对象");
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
  save({ id, kind = "automation", spec, source = { via: "manual" } }) {
    return sqliteTransaction(this.db, () => {
      const existing = id ? this.row(id) : null;
      check(existing?.kind !== "skill", "INVALID_INPUT", "不能改变扩展类型");
      const value = this.normalize(kind, spec);
      const extId = existing?.id || randomUUID();
      const version = (existing?.version || 0) + 1, at = this.iso();
      const data = { ...value, version, source, createdAt: existing?.createdAt || at, updatedAt: at };
      if (existing) this.db.prepare("UPDATE extensions SET data=? WHERE id=?").run(JSON.stringify(data), extId);
      else this.db.prepare("INSERT INTO extensions VALUES (?,?,?,?)").run(extId, kind, "active", JSON.stringify(data));
      this.db.prepare("INSERT INTO extension_versions VALUES (?,?,?,?,?)").run(extId, version, JSON.stringify(value), JSON.stringify(source), at);
      const ext = this.row(extId);
      // A new or changed trigger/condition only applies to results from now on;
      // otherwise editing or rolling back a rule fires on every historical lab.
      const scopeChanged = existing && (JSON.stringify(existing.trigger) !== JSON.stringify(ext.trigger) || JSON.stringify(existing.condition) !== JSON.stringify(ext.condition));
      if (!existing || scopeChanged) this.baseline(ext);
      this.store.audit(null, existing ? "extension.updated" : "extension.created", { id: extId, kind, version, via: source.via });
      return ext;
    });
  }
  setStatus(id, status) {
    check(["active", "disabled"].includes(status), "INVALID_INPUT", "状态须为 active/disabled");
    const ext = this.row(id);
    return sqliteTransaction(this.db, () => {
      this.db.prepare("UPDATE extensions SET status=? WHERE id=?").run(status, ext.id);
      if (status === "active" && ext.status !== "active") this.baseline(ext);
      this.store.audit(null, "extension.status", { id: ext.id, status });
      return this.row(ext.id);
    });
  }
  rollback(id, version) {
    const ext = this.row(id);
    const row = this.db.prepare("SELECT data FROM extension_versions WHERE extension_id=? AND version=?").get(ext.id, Number(version));
    check(row, "NOT_FOUND", "没有这个版本", 404);
    return this.save({ id: ext.id, kind: ext.kind, spec: JSON.parse(row.data), source: { via: "rollback", fromVersion: Number(version) } });
  }
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
  baseline(ext) {
    if (ext.trigger.type !== "lab") return;
    const put = this.db.prepare("INSERT OR IGNORE INTO automation_seen VALUES (?,?)");
    for (const f of this.firings(ext)) put.run(ext.id, f.key);
  }
  preview(kind, spec) {
    const value = this.normalize(kind, spec);
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
    for (const ext of this.list().filter((e) => e.status === "active")) await this.run(ext, now);
    if (!this.lastEvolve || now - this.lastEvolve >= 3600000) { this.lastEvolve = now; this.evolve(); }
  }
  start(intervalMs = 60000) {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, intervalMs);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
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
  recordEdit({ title, type, note, reviewSessionId }) {
    const family = docFamily(title);
    if (!family) return;
    this.bump("doc_edit", family, { type, reviewSessionId, ...(note ? { note: String(note).slice(0, 300) } : {}) });
  }
  recordFailure(ext, message) { this.bump("failure", ext.id, { message: message.slice(0, 200) }); }
  workbenchPrefs() {
    const saved = JSON.parse(this.db.prepare("SELECT data FROM workbench_prefs WHERE id='local'").get()?.data || "{}");
    const usage = Object.fromEntries(this.db.prepare("SELECT key, count FROM evolution_signals WHERE kind='quick_task'").all().map((r) => [r.key, r.count]));
    return { autoOrder: saved.autoOrder !== false, starters: saved.starters || null, usage, quickTasks: this.extensions?.quickTasks?.() || [] };
  }
  prefs() {
    const saved = JSON.parse(this.db.prepare("SELECT data FROM workbench_prefs WHERE id='local'").get()?.data || "{}");
    return { ...this.workbenchPrefs(), learning: saved.learning || null };
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
  evolve() {
    const prefs = this.prefs();
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
    const covered = new Set(this.extensions?.list?.({ kind: "skill" })?.filter((e) => e.status === "active").flatMap((e) => e.appliesTo || []) || []);
    for (const s of this.db.prepare("SELECT * FROM evolution_signals WHERE kind='doc_edit' AND count>=?").all(EDIT_SUGGEST)) {
      if (covered.has(s.key)) continue;
      const data = JSON.parse(s.data);
      const examples = data.reviewSessionId ? this.db.prepare('SELECT before,after FROM review_diffs WHERE session_id=? LIMIT 3').all(data.reviewSessionId).map(d => `${JSON.parse(d.before)} → ${JSON.parse(d.after)}`).join('；').slice(0, 1200) : '';
      this.suggest(`doc_edit:${s.key}:${Math.floor(s.count / EDIT_SUGGEST)}`, {
        type: "create_skill", title: `为「${s.key}」建立你的专属写法`, evidence: `${examples ? `最近修改：${examples}。` : ""}你已修改过 ${s.count} 次「${s.key}」${data.notes?.length ? `，修改依据包括：${data.notes.slice(-3).join("；")}` : ""}`,
        prompt: `我经常修改AI生成的「${s.key}」。${examples ? `最近的真实修改：${examples}。请依据这些差异提炼写法，不需要我重新描述已有样例。` : ""}${data.notes?.length ? `我最近的修改依据：${data.notes.join("；")}。` : ""}请先问清我希望的结构、必写内容和措辞习惯（也可以让我上传医院模板），然后用 extension_propose 建立一个适用于「${s.key}」的技能（appliesTo 填 ${JSON.stringify([s.key])}，并设为快捷任务），给我预览后再提交。`,
      });
    }
    for (const ext of this.list().filter((e) => e.status === "active")) {
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
  normalizeProposal(type, payload = {}) {
    check(type === "ext-change", "INVALID_INPUT", "未知的扩展提案");
    const existing = payload.id ? this.row(payload.id) : null;
    const kind = existing?.kind || payload.kind;
    check(kind === "automation", "INVALID_INPUT", "学习插件只处理自动化规则提案");
    const value = this.normalize(kind, payload.spec);
    const preview = this.preview(kind, payload.spec);
    return { id: existing?.id || null, kind, spec: payload.spec, reason: text(payload.reason, "原因", 500), suggestionId: payload.suggestionId || null,
      summary: value.summary, preview, previousVersion: existing?.version || null };
  }
  applyProposal(action) {
    const p = action.payload;
    check(!p.install, "INVALID_INPUT", "技能安装不属于学习插件");
    if (p.id) check(Number.isSafeInteger(p.previousVersion) && this.row(p.id).version === p.previousVersion,
      "ACTION_CONFLICT", "扩展在提案生成后已变化，请读取最新版本并重新生成提案。", 409);
    const ext = this.save({ id: p.id, kind: "automation", spec: p.spec, source: { via: p.suggestionId ? "evolution" : "chat", proposalId: action.id, reason: p.reason } });
    if (p.suggestionId) try { this.resolveSuggestion(p.suggestionId, "accepted"); } catch { /* already handled */ }
    return ext;
  }
}
