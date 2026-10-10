// 微信历史导入向导的服务端:组件下载、聊天备份、内置 wx-cli 协议桥接。
// 设计边界:解密逻辑全部在用户授权后下载的第三方组件 wechat_exp.exe 内,
// 本模块只负责拉起子进程、解析其文本产物、并把结果适配成 wx-cli 协议;
// 桥接只监听 127.0.0.1,随连接启停。每一步都有明确的用户主动触发。
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, readFileSync, existsSync, mkdirSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { check, AppError } from "./errors.mjs";

const run = promisify(execFile);
const RELEASE_API = "https://api.github.com/repos/sunhanaix/pc_wechat_exp/releases/latest";
const WARNING = "⚠️ 该组件需要从微信进程内存提取数据库密钥，此行为可能被微信感知上报，存在账号被平台处罚的先例（一次性备份风险较低但不为零）。请仅用你自己拥有的账号与数据，知情后启用。";
const CONTACTS_TTL = 5 * 60_000, CHAT_TTL = 5 * 60_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clip = (value, n) => { const s = String(value || ""); return s.length > n ? `${s.slice(0, n)}…` : s; };
const splitCsvLine = line => {
  const cells = []; let cur = "", inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (ch === "," && !inQ) { cells.push(cur); cur = ""; }
    else cur += ch;
  }
  cells.push(cur);
  return cells.map(c => c.trim());
};

export class WechatExpService {
  constructor({ dataDir, port = 9101, log = () => {}, now = () => new Date().toISOString(), fetchImpl = fetch, spawnTool = null } = {}) {
    Object.assign(this, { dataDir: resolve(dataDir), port, log, now, fetchImpl, spawnTool });
    this.home = join(this.dataDir, "wechat-exp");
    this.contactsCache = null;
    this.chatCache = new Map();
    this.job = null;
    this.lastError = "";
    this.lastBackupAt = null;
    this.account = "";
    this.bridge = null;
    this.bridgeSignature = "";
  }
  get exePath() { return join(this.home, "wechat_exp.exe"); }
  get backupDir() { return join(this.home, "backup"); }
  get toolReady() { return existsSync(this.exePath); }
  status() {
    return {
      warning: WARNING,
      toolReady: this.toolReady,
      toolPath: this.exePath,
      backupReady: existsSync(this.backupDir) && readdirSync(this.backupDir).length > 0,
      account: this.account || "",
      bridgeRunning: Boolean(this.bridge),
      job: this.job ? { ...this.job } : null,
      lastError: this.lastError || "",
      lastBackupAt: this.lastBackupAt || null,
    };
  }
  // ---- ① 下载导出组件(用户点按钮触发;安装包本身不含该组件) ----
  async downloadTool() {
    this.checkIdle("download");
    this.begin("download", "正在获取最新版本地址…");
    try {
      const releases = await this.fetchImpl(RELEASE_API, { signal: AbortSignal.timeout(30000), headers: { "user-agent": "open-medical-workbench" } });
      check(releases.ok, "WECHAT_EXP_DOWNLOAD", "无法获取组件版本信息，请检查网络后重试", 502);
      const release = await releases.json();
      const asset = (release.assets || []).find(a => /^wechat_exp_.*\.exe$/.test(a.name));
      check(asset, "WECHAT_EXP_DOWNLOAD", "版本信息里没有找到组件文件", 502);
      this.job.note = `正在下载 ${asset.name}（约 ${Math.round(asset.size / 1048576)}MB，视网络需要几分钟）…`;
      const response = await this.fetchImpl(asset.browser_download_url, { signal: AbortSignal.timeout(1800000), headers: { "user-agent": "open-medical-workbench" } });
      check(response.ok, "WECHAT_EXP_DOWNLOAD", "组件下载失败，请检查网络后重试", 502);
      const bytes = Buffer.from(await response.arrayBuffer());
      check(bytes.length === asset.size, "WECHAT_EXP_DOWNLOAD", "下载不完整，请重试", 502);
      mkdirSync(this.home, { recursive: true });
      const staging = `${this.exePath}.staging`;
      writeFileSync(staging, bytes);
      this.renameWithRetry(staging, this.exePath);
      this.finish("导出组件已就绪");
      return { ready: true, message: "导出组件已就绪" };
    } catch (e) {
      this.fail(e);
      throw e instanceof AppError ? e : new AppError("WECHAT_EXP_DOWNLOAD", "下载失败，请检查网络后重试", 502);
    }
  }
  // ---- ② 备份微信聊天记录 ----
  backup({ days = 30, wxid = "" } = {}) {
    this.checkIdle("backup");
    this.begin("backup", "正在备份微信聊天记录…");
    return this.runBackup({ days, wxid })
      .then(result => { this.job = null; this.lastError = ""; if (!result.needAccount) this.lastBackupAt = this.now(); this.log(result.message); return result; })
      .catch(e => { this.fail(e); throw e instanceof AppError ? e : new AppError("WECHAT_EXP_BACKUP", "备份失败，请重试", 502); });
  }
  // ---- ③ wx-cli 协议桥接(连接启用时自动随启停;仅监听 127.0.0.1) ----
  async reconcile(followups) {
    let enabled = false, secret = "", revision = 0, accountId = "";
    try {
      const row = followups.db.prepare("SELECT data FROM chat_connections WHERE channel=?").get("wechat-exp");
      const c = row ? JSON.parse(row.data) : null;
      enabled = Boolean(c?.enabled);
      revision = c?.revision || 0;
      accountId = c?.accountId || "";
      secret = enabled ? followups.vault.get("chat:wechat-exp").token || "" : "";
    } catch { return; }
    const want = enabled && this.toolReady;
    const signature = want ? `${revision}:${secret}` : "";
    if (signature === this.bridgeSignature && (!want || Boolean(this.bridge) === want)) return;
    this.stopBridge();
    this.bridgeSignature = signature;
    if (!want) return;
    this.account = accountId;
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const m = url.pathname.match(/^\/api\/v1\/(\w+)$/);
      if (!m) { res.writeHead(404, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "not found" })); }
      this.api(m[1], url.searchParams).then(
        body => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); },
        e => {
          const status = e instanceof AppError ? e.status || 502 : 502;
          this.log(`桥接错误:${e?.message || e}`);
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: e?.message || String(e) }));
        },
      );
    });
    server.listen(this.port, "127.0.0.1");
    server.on("error", e => this.log(`桥接端口错误:${e?.message || e}`));
    this.bridge = server;
    this.log(`wx-cli 协议桥接已启动: http://127.0.0.1:${this.port}/api/v1 (账号 ${this.account})`);
  }
  get bridgeLive() { return Boolean(this.bridge); }
  async api(path, query) {
    check(Boolean(this.account), "WXCLI_IDENTITY", "桥接尚未配置账号", 409);
    if (path === "health") return { ready: true, current_account: { wxid: this.account }, worker_id: "wechat-exp-embedded" };
    if (path === "sessions") {
      const limit = Math.min(Number(query.get("limit")) || 100, 100), offset = Number(query.get("offset")) || 0;
      const { rows } = await this.contacts();
      const items = rows.map(r => ({ username: r.wxid, display_name: r.display_name || r.remark || r.nick_name || r.wxid, sort_timestamp: Number(r.last_msg_time) || 0 }))
        .sort((a, b) => b.sort_timestamp - a.sort_timestamp);
      return { items: items.slice(offset, offset + limit), paging: { has_more: offset + limit < items.length, limit, offset } };
    }
    if (path === "messages") {
      const since = Number(query.get("since")) || 0, until = Number(query.get("until")) || Math.floor(Date.now() / 1000);
      const limit = Math.min(Number(query.get("limit")) || 100, 100), offset = Number(query.get("offset")) || 0;
      const { messages } = await this.chatMessages(query.get("contact"));
      const windowed = messages.filter(m => m.create_time >= since && m.create_time <= until);
      return { items: windowed.slice(offset, offset + limit), paging: { has_more: offset + limit < windowed.length, limit, offset } };
    }
    throw new AppError("WXCLI_PROTOCOL", "未知请求", 404);
  }
  checkIdle(kind) { check(!this.job, "WECHAT_EXP_BUSY", "上一个任务还在进行中，请稍候", 409); void kind; }
  begin(kind, note) { this.checkIdle(kind); this.job = { kind, note }; this.lastError = ""; }
  finish(note) { this.job = null; this.lastError = ""; this.log(note); }
  fail(e) { this.job = null; this.lastError = e instanceof AppError ? e.message : clip(e?.message, 200); this.log(`失败:${this.lastError}`); }
  checkTool() { check(this.toolReady, "WECHAT_EXP_TOOL", "请先下载导出组件", 409); }
  async runBackup({ days, wxid }) {
    const args = ["backup", "--days", String(days), "--output", this.backupDir];
    if (wxid) args.push("--wxid", wxid);
    const raw = await this.spawnCapture(args);
    if (/请用 --wxid 指定要备份的账号/.test(raw))
      return { needAccount: true, accounts: [...raw.matchAll(/^(wxid_[^\s]+)\s+/gm)].map(m => m[1]), message: "检测到多个微信账号，请选择要备份的账号" };
    check(/备份完成/.test(raw), "WECHAT_EXP_BACKUP", clip(raw.split("\n").filter(Boolean).at(-1) || "备份未完成，请重试", 200), 502);
    const accountMatch = raw.match(/备份账号[::]\s*(wxid_\S+)/);
    return { needAccount: false, account: accountMatch?.[1] || "", message: "备份完成" };
  }
  async spawnCapture(args) {
    this.checkTool();
    mkdirSync(this.home, { recursive: true });
    try {
      const result = this.spawnTool
        ? await this.spawnTool(args)
        : await run(this.exePath, args, { cwd: this.home, maxBuffer: 16 * 1024 * 1024 });
      return (typeof result === "string" ? result : result?.stdout) || "";
    } catch (e) {
      throw new AppError("WECHAT_EXP_RUN", clip(e?.stderr || e?.message, 200), 502);
    }
  }
  parseContactsCsv(text) {
    const lines = text.split(/\r?\n/).filter(Boolean);
    const cols = splitCsvLine(lines[0]);
    return lines.slice(1).map(line => Object.fromEntries(cols.map((c, i) => [c, splitCsvLine(line)[i] || ""])));
  }
  parseChatTxt(text, talker, account) {
    const messages = [];
    const stamp = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\](?: \[([^\]]+)\])? ([^:：]+)[::] ?([\s\S]*)$/;
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(stamp);
      if (!m) {
        if (messages.length) messages[messages.length - 1].content.Text += `\n${line}`;
        continue;
      }
      const [, time, kind, rawSender, content] = m;
      const create_time = Math.floor(new Date(time.replaceAll("-", "/")).getTime() / 1000);
      if (!Number.isFinite(create_time)) continue;
      const sender = rawSender.trim() === "我" ? account : rawSender.trim();
      messages.push({ talker, sender, msg_type: 1, server_id: "0", sort_seq: "0", content: { Text: ((kind ? `[${kind}] ` : "") + content).slice(0, 20000) }, create_time });
    }
    messages.forEach((msg, i) => { msg.sort_seq = String(i); });
    return messages;
  }
  freshContacts() {
    return this.withTmp(async out => {
      await this.spawnCapture(["export", "-m", "contacts", "--has-chat", "--format", "csv", "-o", join(out, "contacts.csv")]);
      const csv = join(out, "contacts.csv");
      check(existsSync(csv), "WXCLI_PROTOCOL", "会话列表导出失败，请确认已完成备份", 502);
      return { at: Date.now(), rows: this.parseContactsCsv(readFileSync(csv, "utf8")) };
    });
  }
  async contacts() {
    if (!this.contactsCache || Date.now() - this.contactsCache.at > CONTACTS_TTL) this.contactsCache = await this.freshContacts();
    return this.contactsCache;
  }
  async chatMessages(wxid) {
    const cached = this.chatCache.get(wxid);
    if (cached && Date.now() - cached.at < CHAT_TTL) return cached;
    const list = (await this.contacts()).rows;
    const contact = list.find(r => r.wxid === wxid);
    check(contact, "WXCLI_PROTOCOL", "会话不在列表中，请刷新会话列表", 409);
    const name = contact.display_name || contact.remark || contact.nick_name || wxid;
    const value = await this.withTmp(async out => {
      await this.spawnCapture(["export", "-m", "chat", "--chat", name, "-o", out]);
      const files = readdirSync(out).filter(f => f.endsWith(".txt"));
      let chosen = null;
      for (const f of files) {
        const text = readFileSync(join(out, f), "utf8");
        if (text.includes(`微信号: ${wxid}`) || text.includes(`微信号:${wxid}`)) { chosen = text; break; }
      }
      if (chosen === null && files.length === 1) chosen = readFileSync(join(out, files[0]), "utf8");
      check(chosen !== null, "WXCLI_PROTOCOL", `未找到 ${clip(name, 40)} 的导出文本`, 502);
      return { at: Date.now(), messages: this.parseChatTxt(chosen, wxid, this.account) };
    });
    this.chatCache.set(wxid, value);
    return value;
  }
  async withTmp(fn) {
    const out = join(this.home, "bridge-tmp-" + randomUUID().slice(0, 8));
    mkdirSync(out, { recursive: true });
    try { return await fn(out); } finally { rmSync(out, { recursive: true, force: true }); }
  }
  start(followups) {
    this.followups = followups;
    if (this.timer) return;
    this.timer = setInterval(() => this.reconcile(followups).catch(() => {}), 10000);
    this.timer.unref?.();
    this.reconcile(followups).catch(() => {});
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopBridge();
  }
}

// API:/api/wechat-exp/{status,download,backup,refresh}。download/backup 是长任务,
// 前端发起后轮询 status 读 job 进度。
export async function wechatExpApi(service, req, url, { body, send }) {
  const p = url.pathname.split('/').filter(Boolean);
  if (p[0] !== 'api' || p[1] !== 'wechat-exp') return false;
  const reply = (value, status = 200) => { send(status, value); return true; };
  if (!service) return reply({ error: '微信历史导入服务未注册' }, 404);
  if (p.length === 3 && p[2] === 'status' && req.method === 'GET') return reply(service.status());
  if (p.length === 3 && p[2] === 'download' && req.method === 'POST') return reply(await service.downloadTool());
  if (p.length === 3 && p[2] === 'backup' && req.method === 'POST') return reply(await service.backup(await body()));
  if (p.length === 3 && p[2] === 'refresh' && req.method === 'POST') { await service.contacts(); return reply({ refreshed: true }); }
  return false;
}
