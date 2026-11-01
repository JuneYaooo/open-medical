import {taskPresentation} from '../shared/task-presentation.mjs';
import {requestsMedicalDeliverable} from '../shared/medical-delivery.mjs';
import { collectWorkspaceDelivery } from "./core/workspace-delivery.mjs";
import { assessmentQuestion } from "./medical/assessment-tools.mjs";
import { assessmentPatientSource } from "./medical/assessment-source.mjs";
// Session Bridge：把「统一内核工作区（kind:"session"）」投影成首页医疗
// 会话的 API 形状。所有会话只走一套引擎：WorkspaceService（通用内核 +
// 医疗叠层）。旧版 sessions 表里的会话在启动时一次性迁移成会话工作区
// （migrateLegacySessions），之后不再有第二条执行路径。患者页、随访、
// 计划任务、消息摘要通过 dispatcher 使用同一引擎。
import { imageTextWithFallback, localOcrLines, visionTranscriber } from "./core/image-text.mjs";
import { redactImage, replacedSpans } from "./medical/image-redact.mjs";
import { assessOcrQuality } from "../shared/ocr-quality.mjs";
import { autoClassifyMaterial, suggestDocumentDate, isCalendarDate, MATERIAL_CATEGORIES } from "../shared/material-classify.mjs";
import { sqliteTransaction } from "./sqlite-transaction.mjs";
import { materialTextHash, rulesIdentity } from "./medical/privacy.mjs";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AppError, check, identifier, string } from "./errors.mjs";
import { medicalPolicy } from "../shared/medical.mjs";
import { resolveTaskContexts, normalizeTaskContexts, taskContextIntentText, taskContextWorkflow } from "./medical/task-context.mjs";

// Classify immediately; the date remains a separate, reviewable suggestion.
const materialSuggestions = (name, text) => {
  const { category, categorySource, categorySuggestion } = autoClassifyMaterial({ name, text });
  const date = suggestDocumentDate({ name, text });
  return { category, categorySource, categorySuggestion, ...(date ? { dateSuggestion: date } : {}) };
};
import { runTool } from "./medical-core.mjs";
import { providerConfigured } from "./core/provider-status.mjs";
import { ToolRegistry } from "./core/tool-registry.mjs";
import {
  assertRunTransition,
  deriveRunStatus,
  waitingReasonFor,
} from "./core/run-status.mjs";

const hashText = (value) => createHash("sha256").update(value).digest("hex");
const iso = () => new Date().toISOString();
// 病历整理文本里模型自述「读不清原文」的措辞，与它引用的文件名。
// 统计评分（assessOcrQuality）对"页眉词完整+正文乱码"的词汤式页面会误判
// 良好；模型整理时却明确知道哪份材料缺数值——把它的判断回写为质量标注。
const UNREADABLE_MARKER = /不可读|无法辨认|难以辨认|无法识别|缺字|乱码|字迹不清|模糊不清/i;
const FILE_REF = /([^\s,，、;；:：()（）[\]【】「」《》"'']+\.(?:jpe?g|png|webp|pdf|txt|md|docx|xlsx))/gi;
const sessionKind = (w) => w?.kind === "session";
// 对话与任务一律由模型执行（"model"，未配置模型时返回 MODEL_NOT_CONFIGURED）。
// "code" 只表示医生手动提交的受控沙箱代码，不产生助手回答。
const MODEL_NOT_CONFIGURED_MESSAGE = "尚未连接模型：请先在 设置 → 模型与运行 中连接模型，再发送任务。";
const resolveMode = (mode) => {
  const requested = mode || "model";
  check(["model", "code"].includes(requested), "INVALID_INPUT", "运行方式无效");
  return requested;
};
const requireModel = (provider) =>
  check(providerConfigured(provider), "MODEL_NOT_CONFIGURED", MODEL_NOT_CONFIGURED_MESSAGE, 503);

export class SessionBridge {
  // store：医疗存储（审计日志；sessions 表只在迁移时读取）；service：统一内核；
  // sessionsRoot：会话工作区自动目录的父目录（数据库目录下）。
  constructor(store, service, { sessionsRoot, patientRecord = null, skills = null, doctor = null, pluginHost = null, learning = null, plugins = [], contextBudget = 80000, maxRounds = 512, onMaterialIngest, onMaterialReingest, ocrModel = null, ocrStrategy = null, privacy = null } = {}) {
    Object.assign(this, {
      store,
      service,
      sessionsRoot,
      patientRecord,
      skills,
      doctor,
      pluginHost,
      learning,
      plugins: new Map(plugins.map((p) => [p.definition.function.name, p])),
      contextBudget,
      maxRounds,
      onMaterialIngest,
      onMaterialReingest,
      // OCR 设置挂钩：ocrModel() 返回专用识别模型 provider 或 null；
      // ocrStrategy() 返回 auto|model|local（见 core/ocr-settings.mjs）。
      ocrModel,
      ocrStrategy,
      // 去隐私（medical/privacy.mjs 的 MaterialPrivacy）：开启后发给模型的
      // 资料文本一律是脱敏版本，原文只留在本机给医生看。
      privacy,
      privacyJobs: new Map(),
    });
  }

  // ---------- 去隐私 ----------
  // 开启后，资料保存的就是脱敏文本（原文不保留），图片保存的是打码图。
  // 刚导入、脱敏还在进行时，发给模型的文本按模式用本地规则兜底或给出
  // 占位说明，并排队脱敏。
  privacyReady(file) {
    return file.privacy?.status === "ready" && file.privacy.textHash === materialTextHash(file.text);
  }
  // 公开资料（如 PubMed 摘要）不是患者资料，不做脱敏。只有服务端内部调用
  // addMaterial(..., { publicSource: true }) 才能打这个标记。
  privacyExempt(file) {
    return file?.publicSource === true;
  }
  modelText(sessionId, file) {
    if (!this.privacy?.enabled() || this.privacyExempt(file) || this.privacyReady(file)) return file.text;
    // 尚未识别的图片材料只有索引说明，没有病历内容。
    if (file.extraction?.type === "image" && file.extraction?.ocr?.status !== "ready") return this.privacy.rules(file.text, this.sessionIdentities(sessionId)).text;
    this.protectMaterial(sessionId, file.id);
    if (this.privacy.strict())
      return `[资料「${this.modelName(sessionId, file)}」${file.privacy?.status === "failed" && file.privacy.textHash === materialTextHash(file.text) ? `脱敏失败：${file.privacy.error}` : "正在脱敏"}。严格模式下脱敏完成前不能读取内容，请稍后再试，或请医生检查脱敏服务设置。]`;
    return this.privacy.rules(file.text, this.sessionIdentities(sessionId)).text;
  }
  modelName(sessionId, file) {
    if (!this.privacy?.enabled() || this.privacyExempt(file) || this.privacyReady(file)) return file.name;
    return this.privacy.rules(file.name, this.sessionIdentities(sessionId)).text;
  }
  sessionIdentities(sessionId) {
    try {
      const patientId = this.workspace(sessionId)?.patientId;
      const p = patientId && this.patientRecord ? this.patientRecord(patientId) : null;
      return p ? [p.name, p.phone, p.patientNumber].filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  indexView(sessionId, file) {
    return this.privacy?.enabled() ? { ...file, name: this.modelName(sessionId, file), text: this.modelText(sessionId, file) } : file;
  }
  // 脱敏一段文本：服务优先；失败时按模式用规则兜底（返回 method:"rules"）
  // 或返回 failed。
  async deidentifyForStorage(sessionId, text) {
    try {
      check(this.privacy.hasService(), "PRIVACY_SERVICE_MISSING", "未配置脱敏服务");
      return await this.privacy.protect(text);
    } catch (error) {
      const reason = String(error.message || error).slice(0, 300);
      if (this.privacy.strict()) return { failed: true, error: reason };
      return { ...this.privacy.rules(text, this.sessionIdentities(sessionId)), identity: rulesIdentity(text), serviceError: reason };
    }
  }
  deidentifyName(sessionId, name, identity) {
    let out = String(name);
    for (const value of [identity?.name].filter((v) => typeof v === "string" && v.length >= 2)) out = out.split(value).join("[患者姓名]");
    return this.privacy.rules(out, this.sessionIdentities(sessionId)).text;
  }
  privacyRecord(result, sourceHash, textHash, extra = {}) {
    return {
      status: "ready",
      method: result.method,
      textHash,
      sourceHash,
      at: iso(),
      ...(result.policy ? { policy: result.policy } : {}),
      ...(result.identity ? { identity: result.identity } : {}),
      ...(result.serviceError ? { serviceError: result.serviceError } : {}),
      ...extra,
    };
  }
  // 后台脱敏一份资料并把脱敏文本写回（原文不再保留）。同一份资料同时只跑
  // 一个任务；文本在脱敏期间变化则丢弃结果（变化处会重新排队）。
  protectMaterial(sessionId, fileId, { force = false } = {}) {
    if (!this.privacy?.enabled()) return null;
    const key = `${sessionId}:${fileId}`;
    if (this.privacyJobs.has(key)) return this.privacyJobs.get(key);
    const job = (async () => {
      const file = (this.workspace(sessionId).materials || []).find((item) => item.id === fileId);
      if (!file || this.privacyExempt(file)) return file || null;
      if (!force && this.privacyReady(file) && file.privacy.method === "service") return file;
      if (file.extraction?.type === "image" && file.extraction?.ocr?.status !== "ready") return file; // 等识别时一起打码
      const sourceHash = materialTextHash(file.text);
      const result = await this.deidentifyForStorage(sessionId, file.text);
      const original = file.extraction?.originalText;
      const originalResult = original && !file.extraction.originalTextDeidentified && !result.failed ? await this.deidentifyForStorage(sessionId, original) : null;
      let updated = null;
      this.service.store.update(sessionId, (current) => {
        const target = (current.materials || []).find((item) => item.id === fileId);
        if (!target || materialTextHash(target.text) !== sourceHash) return;
        if (result.failed) {
          target.privacy = { status: "failed", error: result.error, textHash: sourceHash, at: iso() };
        } else {
          target.text = result.text;
          target.hash = materialTextHash(result.text);
          target.size = Buffer.byteLength(result.text);
          target.name = this.deidentifyName(sessionId, target.name, result.identity);
          if (originalResult && !originalResult.failed) {
            target.extraction.originalText = originalResult.text;
            target.extraction.originalTextDeidentified = true;
          }
          target.privacy = this.privacyRecord(result, file.privacy?.sourceHash || sourceHash, target.hash, file.privacy?.images ? { images: file.privacy.images } : {});
        }
        updated = target;
      });
      if (updated) {
        this.store.audit(sessionId, "file.deidentified", { fileId, status: updated.privacy.status, method: updated.privacy.method || null });
        if (updated.privacy.status === "ready" && this.onMaterialReingest)
          try {
            this.onMaterialReingest(updated);
          } catch {}
      }
      return updated;
    })().finally(() => this.privacyJobs.delete(key));
    this.privacyJobs.set(key, job);
    job.catch(() => {});
    return job;
  }
  // 开启脱敏或服务恢复后补处理：没有服务脱敏结果的资料重新排队。
  async reprocessPrivacy({ onlyMissing = true } = {}) {
    if (!this.privacy?.enabled()) return { queued: 0 };
    const jobs = [];
    for (const w of this.service.store.list?.() || []) {
      if (!sessionKind(w)) continue;
      for (const file of w.materials || []) {
        if (this.privacyExempt(file)) continue;
        const done = this.privacyReady(file) && file.privacy.method === "service";
        if (onlyMissing && done) continue;
        jobs.push({ id: w.id, fileId: file.id });
      }
    }
    // 逐个处理，避免占满 worker 的并发预算。
    (async () => {
      for (const job of jobs) await this.protectMaterial(job.id, job.fileId, { force: !onlyMissing }).catch(() => {});
    })();
    return { queued: jobs.length };
  }

  // ---------- 类别判定 ----------
  workspace(id) {
    return this.service.store.get(id);
  }
  isSessionWorkspace(id) {
    try {
      return sessionKind(this.workspace(id));
    } catch (error) {
      if (error.code === "NOT_FOUND") return false;
      throw error;
    }
  }
  requireSessionWorkspace(id) {
    const w = this.workspace(id);
    check(sessionKind(w), "NOT_FOUND", "会话不存在", 404);
    return w;
  }

  // ---------- 创建 / 删除 / 改名 ----------
  createSession({ id, title, patientId, copiedFrom, global = false, channelSource = null } = {}) {
    if (id !== undefined) {
      identifier(id);
      check(!this.isSessionWorkspace(id), "CONFLICT", "会话已存在", 409);
    }
    const root = join(this.sessionsRoot, randomUUID());
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const w = this.service.create({
      ...(id !== undefined ? { id } : {}),
      kind: "session",
      root,
      title: string(title || "新会话", "会话名称", 100),
      ...(patientId ? { patientId } : {}),
      directoryConsent: true,
    });
    // 会话根目录由应用自管（不在用户文档区），写入走自动应用策略，
    // 终端在镜像可用时默认开启；浏览器来源授权保持手动。
    const image = this.detectImage();
    this.service.update(w.id, {
      revision: w.revision,
      profile: "standard",
      allowWrite: true,
      approvalPolicy: channelSource ? "review" : "workspace-write",
      autoApplyConsent: true,
    });
    if (channelSource) this.service.store.update(w.id, current => { current.channelSource = channelSource; });
    // 旧版全局助手入口的兼容标记；不再限制能力与工作流。
    if (global) this.service.setModeFlag(w.id, "global", true);
    if (copiedFrom)
      this.service.store.update(w.id, (current) => {
        current.copiedFrom = copiedFrom;
      });
    if (image && !channelSource)
      // 延迟一拍执行：调用方（材料副本/分支）会在返回后立刻写材料并推进
      // 版本，配置时重新读取当前 revision；失败静默，可在设置中重配。
      Promise.resolve()
        .then(() =>
          this.service.extensions.operation(w.id, {
            action: "configure",
            revision: this.service.get(w.id).revision,
            consent: true,
            terminal: true,
            image,
            // configure 会按 browser/mcp/terminalNetwork 重算 network 并覆写
            // browser.read；这里必须沿用 create 的默认放开值（联网读取对所有
            // 工作区默认可用），传 false 会把新会话的 web_search/web_fetch
            // 静默掐断。助手浏览器同样依赖 browser.read + network，可访问任意网站。
            browser: true,
            plugins: false,
            mcp: false,
            memoryRead: false,
            memoryWrite: false,
            memory: { provider: "lsa" },
          }),
        )
        .catch(() => {});
    return this.get(w.id);
  }
  // 旧版 sessions 表会话 → 会话工作区（保留同一 id，患者、随访、计划
  // 任务、聊天渠道里的引用都不用改）。启动时执行，逐条事务：材料、消息、
  // 执行记录和成果原样搬过去，旧行在同一事务里删除；失败的那条保持原样，
  // 下次启动再试。执行中被中断的记录标为 interrupted，不会自动续跑。
  migrateLegacySessions() {
    const db = this.store.db;
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get())
      return { migrated: 0, failed: [] };
    const rows = db.prepare("SELECT id, data FROM sessions").all();
    let migrated = 0;
    const failed = [];
    for (const row of rows) {
      try {
        sqliteTransaction(db, () => {
          const legacy = JSON.parse(row.data);
          if (!this.isSessionWorkspace(row.id)) {
            this.createSession({
              id: row.id,
              title: String(legacy.title || "新会话").slice(0, 100),
              ...(legacy.patientId ? { patientId: legacy.patientId } : {}),
              ...(legacy.copiedFrom ? { copiedFrom: legacy.copiedFrom } : {}),
            });
            const artifacts = new Map((legacy.artifacts || []).map((a) => [a.id, a]));
            const used = new Set();
            const runs = (legacy.runs || []).map((run) => {
              const own = (run.artifacts || [])
                .map((ref) => (typeof ref === "string" ? artifacts.get(ref) : ref))
                .filter(Boolean);
              for (const a of own) used.add(a.id);
              // 迁移时还在执行的记录（旧服务中途退出）如实标为中断。
              const cut = ["running", "waiting", "queued"].includes(run.status);
              const endedAt = run.endedAt || (cut ? new Date().toISOString() : null);
              return {
                ...run,
                ...(cut ? { status: "interrupted", error: run.error || "服务重新启动，执行已中断。", endedAt } : {}),
                children: (run.children || []).map((child) =>
                  ["running", "queued"].includes(child.status)
                    ? { ...child, status: "interrupted", error: "服务重启，子代理执行已中断", endedAt }
                    : child),
                artifacts: own,
                legacyMigrated: true,
              };
            });
            const orphans = (legacy.artifacts || []).filter((a) => !used.has(a.id));
            if (orphans.length && runs.length) runs.at(-1).artifacts.push(...orphans);
            else if (orphans.length)
              runs.push({ id: randomUUID(), status: "completed", mode: "local", startedAt: new Date(legacy.createdAt || Date.now()).toISOString(), endedAt: new Date(legacy.updatedAt || Date.now()).toISOString(), events: [], fileIds: [], artifacts: orphans, children: [], legacyMigrated: true });
            this.service.store.update(row.id, (w) => {
              w.materials = legacy.files || [];
              w.messages = legacy.messages || [];
              w.runs = runs;
              if (legacy.createdAt) w.createdAt = legacy.createdAt;
              if (legacy.updatedAt) w.updatedAt = legacy.updatedAt;
              w.legacyMigratedAt = Date.now();
            }, undefined, { touch: false });
          }
          db.prepare("DELETE FROM sessions WHERE id=?").run(row.id);
          this.store.audit(row.id, "session.migrated", { to: "session-workspace" });
        });
        migrated++;
      } catch (error) {
        failed.push(row.id);
        console.error(`旧会话 ${row.id} 迁移失败，将在下次启动重试:`, error);
      }
    }
    return { migrated, failed };
  }
  // 医疗会话的领域工具名（医疗核心工具 + 已启用插件工具），不含通用内核
  // 工具（文件、终端、git、浏览器、委派等）。每次实时计算，插件启停、渠道
  // 配置变化立即反映，不在启动时固定。
  toolNames() {
    const registry = new ToolRegistry();
    this.service.domain?.registerTools?.({
      registry,
      workspace: { id: "tool-catalog", kind: "session", runs: [], materials: [] },
      runId: null,
    });
    return [...registry.tools.keys()];
  }
  detectImage() {
    try {
      const runner = this.service.extensions.runner;
      return runner.image ? runner.image("open-medical-runtime:0.8-full") : null;
    } catch {
      return null;
    }
  }
  removeSession(id) {
    const w = this.requireSessionWorkspace(id);
    check(
      !this.service.active.has(id),
      "RUN_ACTIVE",
      "会话正在执行，请先停止",
      409,
    );
    this.service.extensions
      .close(id)
      .then(() => this.service.extensions.browser.forget(id))
      .catch(() => {});
    this.service.store.remove(id);
    this.store.audit(id, "session.deleted", { kind: "session-workspace" });
    try {
      rmSync(w.root, { recursive: true, force: true });
    } catch {}
  }
  renameSession(id, title) {
    const w = this.requireSessionWorkspace(id);
    const name = string(title, "会话名称", 100);
    // WorkspaceService.update configures permissions, not metadata. Renaming
    // must preserve approval policy, grants and pending file proposals.
    sqliteTransaction(this.store.db, () => {
      this.service.store.update(id, (current) => { current.title = name; }, w.revision);
      this.store.audit(id, "session.renamed", { title: name });
    });
  }
  // 全局助手会话（单例）：常驻跨模块对话入口，重复调用复用同一会话。
  ensureGlobalSession() {
    const existing = this.service.store.db
      .prepare(
        "SELECT id FROM agent_workspaces WHERE json_extract(data,'$.kind')='session' AND json_extract(data,'$.modeFlags.global')=1 ORDER BY json_extract(data,'$.createdAt') DESC LIMIT 1",
      )
      .get();
    if (existing) return this.get(existing.id);
    return this.createSession({ title: "全局助手", global: true });
  }

  // ---------- 材料（session.files 的内核等价物） ----------
  addMaterial(id, input, { publicSource = false } = {}) {
    this.requireSessionWorkspace(id);
    check(
      !this.service.active.has(id),
      "RUN_ACTIVE",
      "执行期间不能变更材料",
      409,
    );
    const name = string(input.name, "文件名", 180);
    if (/\.(png|jpe?g|webp)$/i.test(name)) {
      const current = this.requireSessionWorkspace(id);
      check((current.materials || []).length < 100, "FILE_LIMIT", "每个会话最多 100 份材料");
      check(typeof input.image === "string", "IMAGE_REQUIRED", "请通过图片上传流程导入原图");
      const digest = hashText(Buffer.from(input.image, "base64"));
      check(!(current.materials || []).some((f) => f.hash === digest), "DUPLICATE_FILE", "相同内容已在本会话中", 409);
      const artifact = this.service.uploadImage(id, { name, data: input.image });
      const file = {
        id: randomUUID(), name, hash: artifact.hash, size: artifact.size, createdAt: iso(),
        text: `[图片材料：${name}]\n原图 artifactId: ${artifact.id}。使用 inspect_image 读取病历文字、日期、数值及单位，无法辨认的内容标记待核对，禁止猜测。Mac 文本模型可用本地 OCR；无可用读取工具时请切换视觉模型；本条索引不是 OCR 结果。`,
        extraction: { type: "image", artifactId: artifact.id, originalRetained: true },
        ...materialSuggestions(name, ""),
      };
      this.service.store.update(id, (w) => { w.materials ||= []; w.materials.push(file); });
      this.store.audit(id, "file.added", { fileId: file.id, hash: file.hash });
      return file;
    }
    check(
      /\.(txt|md|markdown|csv|tsv|json|pdf|docx|xlsx)$/i.test(name),
      "FILE_TYPE",
      "支持图片、PDF、Word、Excel、TXT、Markdown、CSV、TSV 和 JSON",
    );
    let text = string(input.text, "文件内容", 400000);
    check(Buffer.byteLength(text) <= 2000000, "FILE_SIZE", "文件超过 2MB");
    let extraction;
    if (/\.(docx|xlsx)$/i.test(name)) extraction = { type: /\.docx$/i.test(name) ? "docx_text" : "xlsx_text", originalRetained: false };
    if (/\.pdf$/i.test(name)) {
      const e = input.extraction;
      check(
        e?.type === "pdf_text" &&
          Number.isInteger(e.pageCount) &&
          e.pageCount > 0 &&
          e.pageCount <= 300 &&
          Array.isArray(e.emptyPages) &&
          e.emptyPages.length <= e.pageCount &&
          (e.emptyPages.length < e.pageCount || input.pageImages?.length === e.emptyPages.length) &&
          e.emptyPages.every(
            (p) => Number.isInteger(p) && p >= 1 && p <= e.pageCount,
          ),
        "PDF_EXTRACTION",
        "请通过工作台的 PDF 文字抽取流程导入",
      );
      extraction = {
        type: "pdf_text",
        pageCount: e.pageCount,
        emptyPages: e.emptyPages,
        originalRetained: false,
      };
    }
    if (input.pageImages !== undefined) {
      check(/\.pdf$/i.test(name) && Array.isArray(input.pageImages) && input.pageImages.length <= 30 && input.pageImages.length === extraction?.emptyPages.length,
        "PDF_EXTRACTION", "扫描页面与 PDF 空白页索引不一致");
      const pages = input.pageImages;
      check(new Set(pages.map((p) => p.page)).size === pages.length && pages.every((p) => extraction.emptyPages.includes(p.page) && (typeof p.data === "string" || typeof p.artifactId === "string")), "PDF_EXTRACTION", "扫描页面无效");
      // 页面图片两种来源：内嵌 base64（旧客户端 / 会话复制），或先经
      // /api/workspaces/:id/images 逐页上传的 artifactId（建档大扫描件，
      // 避免单份材料一个请求超过 8MB 体积上限）。统一解析回 base64 做
      // 校验与查重，两种来源对相同页面得到相同指纹。
      const datas = pages.map((p) => {
        if (typeof p.data === "string") return p.data;
        const { item, data } = this.service.artifacts.read(id, p.artifactId);
        check(/^image\//.test(item.mime), "PDF_EXTRACTION", "扫描页面无效");
        return data.toString("base64");
      });
      check(datas.every((data) => data.length <= 5333336 && /^[A-Za-z0-9+/]+={0,2}$/.test(data)), "PDF_EXTRACTION", "扫描页面无效");
      const digest = hashText(text + datas.join(""));
      const current = this.requireSessionWorkspace(id);
      check((current.materials || []).length < 100, "FILE_LIMIT", "每个会话最多 100 份材料");
      check(!(current.materials || []).some((f) => f.extraction?.imageHash === digest), "DUPLICATE_FILE", "相同内容已在本会话中", 409);
      extraction.imageHash = digest;
      extraction.pageImages = pages.map((p) => {
        const artifactId = typeof p.data === "string"
          ? this.service.uploadImage(id, { name: `PDF-page-${p.page}.jpg`, data: p.data }).id
          : p.artifactId;
        text += `\n[PDF 第 ${p.page} 页扫描图] artifactId: ${artifactId}，使用 inspect_image 读取原文，不能猜测不清晰内容。`;
        return { page: p.page, artifactId };
      });
    }
    const file = {
      id: randomUUID(),
      name,
      text,
      hash: hashText(text),
      createdAt: iso(),
      size: Buffer.byteLength(text),
      ...(extraction ? { extraction } : {}),
      ...(publicSource ? { publicSource: true } : {}),
      ...materialSuggestions(name, text),
    };
    this.service.store.update(id, (current) => {
      current.materials ||= [];
      check(
        current.materials.length < 100,
        "FILE_LIMIT",
        "每个会话最多 100 份材料",
        422,
      );
      check(
        // 开启脱敏后保存的是脱敏文本，同时比对脱敏前的原文指纹。
        current.materials.every((f) => f.hash !== file.hash && f.privacy?.sourceHash !== file.hash),
        "DUPLICATE_FILE",
        "相同内容已在本会话中",
        409,
      );
      current.materials.push(file);
    });
    this.protectMaterial(id, file.id);
    if (this.onMaterialIngest)
      try {
        this.onMaterialIngest(this.indexView(id, file));
      } catch {}
    return file;
  }
  saveIntakeIssues(id, issues) {
    this.requireSessionWorkspace(id);
    check(Array.isArray(issues) && issues.length <= 200, "INVALID_INPUT", "资料问题清单无效");
    const cleaned = issues.map(item => ({ name: string(item.name, "文件名", 180), error: string(item.error, "失败原因", 2000), stage: item.stage === "ocr" ? "ocr" : "upload" }));
    this.service.store.update(id, current => { current.intakeIssues = cleaned; });
    return { ok: true };
  }
  async prepareMaterial(id, fileId, { signal, force = false, preferVision = false } = {}) {
    const workspace = this.requireSessionWorkspace(id);
    check(!this.service.active.has(id), "RUN_ACTIVE", "执行期间不能变更材料", 409);
    const file = (workspace.materials || []).find(file => file.id === fileId);
    check(file, "NOT_FOUND", "材料不存在", 404);
    const originalRevision = file.revision || 0;
    const images = file.extraction?.type === "image"
      ? [{ artifactId: file.extraction.artifactId }]
      : file.extraction?.pageImages || [];
    // 纯文本/表格材料没有可识别页：无需 OCR，原样返回。
    if (!images.length) return file;
    if (!force && file.extraction?.ocr?.status === "ready") return file;
    // 识别引擎选择（策略来自 OCR 设置，见 core/ocr-settings.mjs）：
    //   auto  本机 OCR → 专用识别模型或主模型视觉转录，质量差自动升级
    //   model 识别模型先行，失败回本机 OCR
    //   local 仅本机 OCR，图片字节不发往任何模型
    // 医生手动「重新识别」（preferVision）视为明确同意用模型，越过策略开关。
    // 开启脱敏后原图里的身份信息无法打码，原图只交给 OCR（OCR 服务或本机
    // 组件），识别出的文字再脱敏；不发给视觉模型。
    // 已打码的图片（重新识别时）可以交给视觉模型；未打码的原图不行。
    const privacyOn = Boolean(this.privacy?.enabled());
    const maskedIds = new Set((workspace.artifacts || []).filter((a) => a.privacy === "masked").map((a) => a.id));
    const allMasked = images.every((image) => maskedIds.has(image.artifactId));
    const imagesLocal = privacyOn && !allMasked;
    check(!(preferVision && imagesLocal), "PRIVACY_IMAGES_LOCAL", "已开启患者资料脱敏：原图不会发给视觉模型，只能用文字识别（OCR）。如确需模型识别，请先在设置中关闭脱敏。", 409);
    const strategy = imagesLocal ? "local" : preferVision ? "model" : this.ocrStrategy?.() || "auto";
    const mainProvider = this.service.provider;
    const visionProvider =
      this.ocrModel?.() || (mainProvider?.vision === true ? mainProvider : null);
    const analyzeImage = visionTranscriber(visionProvider);
    if (preferVision) {
      check(typeof analyzeImage === "function", "OCR_UNAVAILABLE",
        "当前没有可用的多模态（视觉）模型。请在模型设置中勾选「此模型支持图片」，或在文字识别（OCR）设置中配置专用识别模型", 503);
    }
    const transcribe = async (data) => {
      if (strategy === "local")
        return imageTextWithFallback(data, signal, null, { strategy: "local" });
      if (strategy === "model") {
        if (typeof analyzeImage === "function") {
          try {
            return { kind: "vision", text: await analyzeImage(data, signal) };
          } catch (error) {
            signal?.throwIfAborted();
            // 识别模型失败：落到本机识别，不再重复请求模型。
          }
        }
        return imageTextWithFallback(data, signal, analyzeImage, { strategy: "model", modelFailed: true });
      }
      return imageTextWithFallback(data, signal, analyzeImage);
    };
    const pages = [];
    const boxPages = []; // 开启脱敏时：每页 OCR 行坐标，用于打码
    let kind = "ocr";
    let upgraded = false;
    for (const image of images) {
      signal?.throwIfAborted();
      const original = this.service.artifacts.read(id, image.artifactId);
      let result;
      if (imagesLocal) {
        // 原图只交给 OCR（OCR 服务或本机组件），保留行坐标用于打码。
        const local = await localOcrLines(original.data, signal);
        check(local.available, "OCR_UNAVAILABLE", "已开启患者资料脱敏：图片只能用文字识别（OCR）读取，但当前没有可用的 OCR 服务或本机识别组件。请在文字识别设置中配置 OCR 服务。", 503);
        result = { kind: "ocr", text: local.lines.map((line) => line.text).join("\n") };
        boxPages.push({ artifactId: image.artifactId, page: image.page, lines: local.lines, data: original.data });
      } else result = await transcribe(original.data);
      // 本地 OCR 质量过差且识别模型可用时自动升级重转录，避免垃圾文本流入病历。
      // 干净的模板页（标签重复但常用字规整，如系统导出的无数值清单）升级也读不出
      // 原文没有的数值，跳过以省去无效的视觉调用。「仅本机」策略绝不外发。
      if (strategy !== "local" && result.kind !== "vision" && typeof analyzeImage === "function") {
        const quality = assessOcrQuality(result.text);
        const templateLike =
          (quality.signals.dedupRatio ?? 0) > 0.15 &&
          (quality.signals.commonRatio ?? 1) > 0.92;
        if (quality.level === "poor" && !templateLike) {
          try {
            const visionResult = { kind: "vision", text: await analyzeImage(original.data, signal) };
            if (assessOcrQuality(visionResult.text).score > quality.score) {
              result = visionResult;
              upgraded = true;
            }
          } catch (error) {
            signal?.throwIfAborted();
            if (!["VISION_EMPTY", "OCR_UNAVAILABLE"].includes(error?.code)) throw error;
            // 升级失败时保留本地结果，由质量标注提示医生兜底。
          }
        }
      }
      if (result.kind === "vision") kind = "vision";
      const lines = result.text.split("\n").filter(Boolean).map(text => ({ text, confidence: 1 }));
      check(lines.some(line => line.text?.trim()), "OCR_EMPTY", "未识别出文字，请换清晰图片；医学影像需由医生或视觉模型另行核对", 422);
      pages.push({ page: image.page, lines });
    }
    signal?.throwIfAborted();
    check(!this.service.active.has(id), "RUN_ACTIVE", "执行期间不能变更材料", 409);
    const sourceLabel = kind === "vision" ? "视觉模型转录" : "本地文字识别";
    const text = pages.map(page => `[${file.name}${page.page ? ` 第 ${page.page} 页` : ""} · ${sourceLabel}]
` + page.lines.map(line => `${line.text}${line.confidence < 0.7 ? " [识别置信度低，请核对原图]" : ""}`).join("\n")).join("\n\n");
    const quality = assessOcrQuality(text);
    // 开启脱敏：识别出的文字脱敏后再保存，图片按脱敏结果打码并替换原图。
    let privacyResult = null;
    let originalResult = null;
    let sourceHash = null;
    const replacements = [];
    // 失败或取消时清掉已生成的打码图，原图和原记录保持不变。
    const discardRedacted = () => {
      for (const replacement of replacements)
        try {
          this.service.artifacts.remove(id, replacement.to);
        } catch {}
    };
    if (privacyOn) try {
      const baseRaw = file.extraction.type === "image" ? "" : file.extraction.originalText || file.text;
      const finalRaw = (file.extraction.type === "image" ? "" : `${baseRaw}\n\n`) + text;
      sourceHash = file.privacy?.sourceHash || materialTextHash(finalRaw);
      privacyResult = await this.deidentifyForStorage(id, finalRaw);
      if (!privacyResult.failed) {
        const spans = replacedSpans(finalRaw, privacyResult.text);
        const identity = privacyResult.identity || {};
        const secrets = [...new Set([...(spans || []), identity.name, identity.birthDate].filter((v) => typeof v === "string" && v.trim().length >= 2))];
        for (const page of boxPages) {
          signal?.throwIfAborted();
          const redacted = await redactImage(page.data, page.lines, secrets);
          const complete = redacted.complete && spans !== null;
          const saved = this.service.artifacts.save(id, `已打码-${page.page ? `第${page.page}页` : "图片"}.jpg`, redacted.image, "privacy");
          this.service.artifacts.mark(id, saved.id, { privacy: complete ? "masked" : "partial" });
          replacements.push({ from: page.artifactId, to: saved.id, complete, masked: redacted.masked });
        }
        if (baseRaw && !file.extraction.originalTextDeidentified) originalResult = await this.deidentifyForStorage(id, baseRaw);
      }
    } catch (error) {
      discardRedacted();
      throw error;
    }
    const swapIds = (value) => replacements.reduce((out, r) => out.split(r.from).join(r.to), String(value));
    let prepared;
    try { this.service.store.update(id, current => {
      const target = current.materials.find(item => item.id === fileId);
      check(target, "NOT_FOUND", "材料已移除", 404);
      check((target.revision || 0) === originalRevision, "REVISION_CONFLICT", "识别期间资料已变化，请核对最新文字后重试", 409);
      target.revision = originalRevision + 1;
      // Preserve original artifact ownership and hash; OCR is a derived, cached view.
      if (force && target.extraction.ocr?.status === "ready") {
        target.extraction.ocrPrevious = {
          method: target.extraction.ocr.method,
          quality: target.extraction.ocr.quality || null,
          completedAt: target.extraction.ocr.completedAt,
        };
      }
      target.extraction.ocr = {
        status: "ready",
        method: kind === "vision" ? "vision" : "local-ocr",
        pages: pages.length,
        lines: pages.reduce((n, page) => n + page.lines.length, 0),
        completedAt: iso(),
        quality,
        ...(upgraded ? { upgradedFrom: "local-ocr" } : {}),
      };
      target.extraction.originalText = file.extraction.originalText || file.text;
      target.text = (file.extraction.type === "image" ? "" : target.extraction.originalText + "\n\n") + text;
      if (privacyResult && !privacyResult.failed) {
        target.text = swapIds(privacyResult.text);
        if (originalResult && !originalResult.failed) {
          target.extraction.originalText = swapIds(originalResult.text);
          target.extraction.originalTextDeidentified = true;
        } else if (file.extraction.type === "image") target.extraction.originalText = swapIds(this.privacy.rules(target.extraction.originalText).text);
        if (target.extraction.type === "image" && replacements[0]) target.extraction.artifactId = replacements[0].to;
        if (Array.isArray(target.extraction.pageImages))
          target.extraction.pageImages = target.extraction.pageImages.map((p) => ({ ...p, artifactId: replacements.find((r) => r.from === p.artifactId)?.to || p.artifactId }));
        target.name = this.deidentifyName(id, target.name, privacyResult.identity);
        target.hash = materialTextHash(target.text);
        target.size = Buffer.byteLength(target.text);
        target.privacy = this.privacyRecord(privacyResult, sourceHash, target.hash, {
          images: replacements.map((r) => ({ artifactId: r.to, complete: r.complete, masked: r.masked })),
        });
      } else if (privacyResult?.failed) {
        target.privacy = { status: "failed", error: privacyResult.error, textHash: materialTextHash(target.text), at: iso() };
      }
      Object.assign(target, autoClassifyMaterial(target));
      if (!target.documentDate) {
        const date = suggestDocumentDate({ name: target.name, text: target.text });
        if (date) target.dateSuggestion = date;
        else delete target.dateSuggestion;
      }
      prepared = target;
    }); } catch (error) {
      discardRedacted();
      throw error;
    }
    // 打码图已替换引用，原图不再保留。
    for (const replacement of replacements)
      try {
        this.service.artifacts.remove(id, replacement.from);
      } catch {}
    if (replacements.length) this.store.audit(id, "file.images.redacted", { fileId, images: replacements.map((r) => ({ masked: r.masked, complete: r.complete })) });
    this.reingestMaterial(prepared, id);
    this.store.audit(id, "file.ocr.completed", { fileId, pages: pages.length, method: kind, quality: quality.level, upgraded, strategy });
    return prepared;
  }
  // 材料文本变化后同步检索索引，否则助手检索到的仍是旧识别文本。
  reingestMaterial(file, sessionId) {
    if (sessionId) this.protectMaterial(sessionId, file.id);
    if (!this.onMaterialReingest) return;
    try { this.onMaterialReingest(sessionId ? this.indexView(sessionId, file) : file); } catch {}
  }
  // 病历整理回写质量标注：从建档/档案更新提案的正文里找出模型自述读不清的
  // 原文文件，把它们的识别质量降为「待核对」（已有更差的评级则不动）。
  // 只降级、不升级，重新识别后随新文本重算，标注自然失效。
  flagSuspectMaterials(id, payload = {}) {
    this.requireSessionWorkspace(id);
    const texts = [];
    for (const visit of payload?.visits || []) texts.push(visit?.note, visit?.reason, visit?.source);
    for (const dx of payload?.diagnoses || []) {
      texts.push(dx?.note, dx?.source);
      // needs_review 的语义即"OCR 无法辨认或等待病理，须医生核对"。
      if (dx?.status === "needs_review") texts.push(dx?.source, dx?.sources, dx?.note);
    }
    for (const dx of payload?.diagnoses || []) if (Array.isArray(dx?.sources)) texts.push(...dx.sources);
    texts.push(payload?.clinicalSummary?.text, payload?.clinicalSummary?.source);
    const flagged = new Set();
    for (const value of texts) {
      if (typeof value !== "string" || !value) continue;
      if (!UNREADABLE_MARKER.test(value)) continue;
      for (const match of value.matchAll(FILE_REF)) flagged.add(match[1]);
    }
    if (!flagged.size) return [];
    const changed = [];
    this.service.store.update(id, current => {
      for (const file of current.materials || []) {
        if (!flagged.has(file.name)) continue;
        const ocr = file.extraction?.ocr;
        if (ocr?.status !== "ready") continue;
        const level = ocr.quality?.level;
        if (level === "poor") continue;
        ocr.quality = {
          ...(ocr.quality || {}),
          level: "fair",
          score: Math.min(ocr.quality?.score ?? 100, 65),
          flaggedBy: "agent-review",
          flaggedReason: "整理病历时模型标注该材料原文存在不可读内容",
          flaggedAt: iso(),
        };
        changed.push(file.name);
      }
    });
    if (changed.length) this.store.audit(id, "file.ocr.agent-flagged", { files: changed });
    return changed;
  }
  // 医生在对照视图里直接修正识别文本：与重新识别同权重，重算质量并刷新索引。
  updateMaterialText(id, fileId, text, expectedRevision) {
    this.requireSessionWorkspace(id);
    check(!this.service.active.has(id), "RUN_ACTIVE", "执行期间不能变更材料", 409);
    const value = string(text, "识别文本", 400000);
    let prepared;
    this.service.store.update(id, current => {
      const target = current.materials.find(item => item.id === fileId);
      check(target, "NOT_FOUND", "材料不存在", 404);
      check(expectedRevision === (target.revision || 0), "REVISION_CONFLICT", "资料已变化，请核对最新文字；本地修正尚未保存", 409);
      target.revision = (target.revision || 0) + 1;
      target.text = value;
      target.hash = hashText(value);
      Object.assign(target, autoClassifyMaterial(target));
      target.extraction ||= { type: "text" };
      target.extraction.edited = { at: iso() };
      const quality = assessOcrQuality(value);
      if (target.extraction.ocr) target.extraction.ocr.quality = quality;
      prepared = target;
    });
    this.reingestMaterial(prepared, id);
    this.store.audit(id, "file.text.edited", { fileId, chars: value.length });
    return prepared;
  }
  // 医生确认资料类型与资料日期:报告文件夹视图的最终分类来源。
  setFileMeta(id, fileId, input = {}) {
    this.requireSessionWorkspace(id);
    check(!this.service.active.has(id), "RUN_ACTIVE", "执行期间不能变更材料", 409);
    let prepared;
    this.service.store.update(id, (current) => {
      const target = (current.materials || []).find((item) => item.id === fileId);
      check(target, "NOT_FOUND", "材料不存在", 404);
      check(input.expectedRevision === (target.revision || 0), "REVISION_CONFLICT", "资料已变化，请核对最新类型与日期；本地修改尚未保存", 409);
      target.revision = (target.revision || 0) + 1;
      if (input.category !== undefined) {
        check((input.category === "" || MATERIAL_CATEGORIES.includes(input.category)), "INVALID_INPUT", "资料类型无效");
        target.category = input.category;
        target.categorySource = "manual";
      }
      if (input.documentDate !== undefined) {
        if (input.documentDate === "" || input.documentDate === null) {
          target.documentDate = "";
        } else {
          check(
            isCalendarDate(input.documentDate),
            "INVALID_INPUT",
            "资料日期须为真实日历日期（YYYY-MM-DD）",
          );
          target.documentDate = input.documentDate;
        }
      }
      prepared = target;
    });
    this.store.audit(id, "file.meta.updated", { fileId, category: prepared.category || "", documentDate: prepared.documentDate || "" });
    return prepared;
  }
  // 重新识别/人工修正后按最新文本自动发起一次病历整理：与工作区纪律一致，
  // 助手只提交 patient_record_propose 提案，医生确认后才写入档案。
  refreshRecord(id, { fileIds, reason = "" } = {}) {
    const w = this.requireSessionWorkspace(id);
    check(Array.isArray(fileIds) && fileIds.length, "INVALID_INPUT", "请指定要重新整理的资料");
    const files = (w.materials || []).filter(file => fileIds.includes(file.id));
    check(files.length, "NOT_FOUND", "材料不存在", 404);
    check(w.patientId, "NO_PATIENT", "该会话尚未关联患者档案，请先完成建档", 422);
    const names = files.map(file => file.name).join("、");
    const reasonText = typeof reason === "string" && reason.trim()
      ? string(reason, "更新原因", 100)
      : "重新识别";
    const message = `资料「${names}」的识别文本刚刚更新（${reasonText}）。请先用 read_source 通读这些资料的最新文本，再用 read_patient_brief 读取当前档案，逐项核对就诊经过、诊断、用药、过敏与检验：只提交材料支持且确实有出入的 patient_record_propose 档案更新提案，不要直接写入档案，也不要补齐材料里没有的内容；在回复中列出本次更新了哪些条目、哪些仍待核对。`;
    const prepared = this.prepareSend(id, {
      mode: "model",
      message,
      externalConsent: true,
      fileIds: files.map(file => file.id),
      requestId: `record-refresh:${randomUUID()}`,
    });
    const runId = prepared.handle.run.id;
    // 后台执行：立即返回，状态变化经既有 run 记录与完成通知送达医生。
    void this.executeSend(prepared).catch(() => {});
    this.store.audit(id, "record.refresh", { runId, fileIds: files.map(file => file.id) });
    return { runId, fileIds: files.map(file => file.id) };
  }
  removeMaterial(id, fileId) {
    this.requireSessionWorkspace(id);
    this.service.store.update(id, (current) => {
      current.materials = (current.materials || []).filter(
        (f) => f.id !== fileId,
      );
    });
  }
  materialsOf(id) {
    return this.workspace(id).materials || [];
  }

  // ---------- 投影：workspace → session 形状 ----------
  // 运行状态判定复用 run-status.mjs 的单一实现（W4）：桥接层只提供
  // 持久事实（该 run 的 pending 审批数、是否为当前活跃运行），不自行
  // 推导；status 原值保持不变，derivedStatus/waitingReason 为新增字段。
  project(w) {
    const recentEvents = w.kind === "session" ? this.service.store.eventsLatest(w.id, 500, { excludeDeltas: true }) : [];
    const activeRunId = this.service.active.get(w.id)?.run?.id || null;
    const runFacts = (run) => ({
      pendingApprovals: (w.approvals || []).filter(
        (a) => a.status === "pending" && a.runId === run.id,
      ).length,
      active: run.id === activeRunId,
    });
    const runs = (w.runs || []).map((run) => {
      // Recheck the old answer-with-artifact classification against current runtime
      // receipts. Preserve audit records and never clear genuine delivery gaps.
      let delivery = run.delivery, outcome = run.outcome;
      if (run.status === "completed" && outcome === "delivery_failed" &&
          (run.policy?.workflow === "patient-assessment" || this.pluginHost?.workflow(run.policy?.workflow)) &&
          run.completion?.kind === "answer" && run.artifacts?.length &&
          delivery?.gaps?.length === 1 && delivery.gaps[0].reason === "no_verifiable_output") {
        try {
          const verified = collectWorkspaceDelivery(this.service, w.id, run.id);
          if (verified.delivered) { delivery = verified; outcome = "delivered"; }
        } catch { /* Keep the recorded failure when receipts cannot be checked. */ }
      }
      const facts = runFacts(run);
      const waitingReason = waitingReasonFor(run, facts);
      return {
        id: run.id,
        requestId: run.requestId,
        conversationParentRunId: run.conversationParentRunId || null,
        resumes: run.resumes || null,
        status: run.status,
        derivedStatus: deriveRunStatus(run, facts),
        ...(waitingReason ? { waitingReason } : {}),
        mode: run.mode || "model",
        policy: run.policy,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        partial: run.partial,
        error: run.error,
        roundsUsed: run.roundsUsed || run.usage?.rounds || 0,
        usage: {
          total_tokens: run.usage?.total_tokens || 0,
          rounds: run.roundsUsed || run.usage?.rounds || 0,
        },
        fileIds: run.fileIds || [],
        artifacts: (run.artifacts || []).filter(a => a.type !== "source_search"),
        displayResults: run.displayResults || [],
        draftsArchived: run.draftsArchived === true,
        children: run.children || [],
        events: run.events || recentEvents.filter((event) => event.run_id === run.id).map((event) => ({ ...event, seq: event.id })),
        sourceHashes: (run.sourceHashes || []).map((source, index) => typeof source === "string" ? { id: String(index), hash: source } : source),
        ...(delivery ? { delivery } : {}),
        ...(outcome ? { outcome } : {}),
      };
    });
    const intentOf = (runId) =>
      runs.find((r) => r.id === runId)?.policy?.intent;
    const messages = (w.messages || []).map((m) => ({
      ...m,
      ...(m.role === "assistant" ? { intent: intentOf(m.runId), outcome: runs.find(r => r.id === m.runId)?.outcome || m.outcome } : {}),
    }));
    return {
      id: w.id,
      title: w.title,
      patientId: w.patientId,
      kind: "session",
      copiedFrom: w.copiedFrom,
      createdAt: new Date(w.createdAt).toISOString(),
      updatedAt: new Date(w.updatedAt).toISOString(),
      revision: w.revision,
      messages,
      files: (w.materials || []).map(autoClassifyMaterial),
      intakeIssues: w.intakeIssues || [],
      intakeJob: w.intakeJob || null,
      artifacts: runs.flatMap((run) => run.artifacts.filter(a => !run.draftsArchived || a.status !== "draft")),
      runs,
    };
  }
  get(id) {
    return this.project(this.requireSessionWorkspace(id));
  }
  summary(w) {
    const projected = this.project(w);
    return {
      id: projected.id,
      title: projected.title,
      patientId: projected.patientId,
      kind: "session",
      ...(projected.title === "上传资料建档" ? { intake: {
        job: projected.intakeJob,
        fileCount: projected.files.length,
        firstFileName: projected.files[0]?.name || "",
        issueCount: projected.intakeIssues?.length || 0,
        firstIssueName: projected.intakeIssues?.[0]?.name || "",
      } } : {}),
      updatedAt: projected.updatedAt,
      revision: projected.revision,
      messageCount: projected.messages.length,
      userMessageCount: projected.messages.filter((message) => message.role === "user").length,
      resultCount: projected.artifacts.length,
      reviewCount: 0,
      background: w.runs.some((run) => run.policy?.workflow === "trial-eligibility"),
      reviewItems: [],
      running: this.service.active.has(w.id) || w.intakeJob?.status === "running",
      lastRunStatus: w.runs.at(-1)?.status || null,
      lastRunError: w.runs.at(-1)?.error || null,
    };
  }
  list() {
    return this.service.store
      .list()
      .filter(sessionKind)
      .map((w) => this.summary(w))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  // ---------- 发送：构建 sources 并分派 ----------
  // fileIds 语义与旧引擎一致：undefined = 不带材料（摘要类任务）；
  // 数组 = 显式选择，未知材料 ID 视为越权引用（404）。
  selectMaterials(w, fileIds, contextMode) {
    check(contextMode === undefined || contextMode === "auto" || contextMode === "selected", "INVALID_INPUT", "资料读取方式无效");
    // Make this session's library searchable locally; the agent chooses what to
    // read. This does not preload material text into the model prompt.
    if (contextMode === "auto") return (w.materials || []).map(file => file.id);
    check(
      (fileIds || []).length <= 100,
      "INVALID_INPUT",
      "材料数量超过限制",
    );
    const known = new Set((w.materials || []).map((f) => f.id));
    for (const fid of fileIds || [])
      check(
        known.has(fid),
        "SOURCE_NOT_FOUND",
        "只能引用当前会话中的材料",
        404,
      );
    return fileIds || [];
  }
  buildSources(w, message, fileIds) {
    const materials = Array.isArray(fileIds)
      ? (w.materials || []).filter((f) => fileIds.includes(f.id))
      : [];
    return [
      ...materials.map((f) => ({
        id: f.id,
        name: this.modelName(w.id, f),
        text: this.modelText(w.id, f),
        hash: f.hash,
        extraction: f.extraction,
        // 仅本机使用（建档时回填身份），不进入模型上下文。
        ...(f.privacy?.identity ? { privacy: { identity: f.privacy.identity } } : {}),
      })),
      {
        id: randomUUID(),
        name: "本轮输入",
        text: message,
        hash: hashText(message),
      },
    ];
  }
  // 返回 {kind:"workspace", handle}；代码模式（医生手动提交的沙箱代码）
  // 返回 {kind:"sandbox", plan}，由 executeSend 同步执行。未配置模型时，
  // 除沙箱代码外的一切提交都以 MODEL_NOT_CONFIGURED 拒绝。
  prepareSend(id, body) {
    const w = this.requireSessionWorkspace(id);
    const mode = resolveMode(body.mode);
    if (mode !== "code") requireModel(this.service.provider);
    check(
      !this.service.active.has(id),
      "RUN_ACTIVE",
      "当前会话正在执行，请先停止",
      409,
    );
    check(
      body.sessionRevision === undefined ||
        body.sessionRevision === w.revision,
      "REVISION_CONFLICT",
      "会话资料已更新，请刷新核对后再发送",
      409,
    );
    const message = string(body.message, "任务", 200000);
    // 页面入口附带的任务上下文（检索限定、模板要求、档案快照等）不进入
    // 医生可见的消息；分类器仍看到入口的任务要求，路由与旧版拼接文本一致。
    const contextOptions = { pluginHost: this.pluginHost };
    const { contexts, inherited } = resolveTaskContexts(body, w, contextOptions);
    const intentText = taskContextIntentText(message, contexts, contextOptions);
    const workflowRequest = body.workflow || taskContextWorkflow(contexts, contextOptions);
    const policy = medicalPolicy(intentText);
    if (contexts.length) {
      policy.contexts = contexts;
      if (inherited) policy.contextInherited = true;
    }
    if (body.contextMode === "auto") policy.contextMode = "auto";
    if (["patient-intake", "knowledge-answer", "literature-research"].includes(workflowRequest)) policy.workflow = workflowRequest;
    if (body.requestId !== undefined)
      check(
        !this.service.store.hasRequest(id, body.requestId),
        "DUPLICATE_REQUEST",
        "请求已执行，不能重复提交",
        409,
      );
    if (mode === "code") {
      // 代码模式 = 受控沙箱手动任务，契约与旧引擎一致。
      check(
        body.sandboxCode !== undefined,
        "INVALID_INPUT",
        "代码模式需要提供受控沙箱代码",
      );
      string(body.sandboxCode, "Python 代码", 12000);
      const status = this.service.sandbox?.status?.();
      check(
        status?.available,
        "SANDBOX_UNAVAILABLE",
        status?.reason || "沙箱不可用",
        503,
      );
      // 所选材料（与模型任务同样经脱敏投影）和本轮输入原文作为 sources 传入沙箱。
      const sandboxFileIds = this.selectMaterials(w, body.fileIds);
      return {
        kind: "sandbox",
        plan: {
          sessionId: id,
          code: body.sandboxCode,
          message,
          policy,
          fileIds: sandboxFileIds,
          sources: this.buildSources(w, message, sandboxFileIds).map(({ id: sourceId, name, text, hash }) => ({ id: sourceId, name, text, hash })),
          requestId: body.requestId || randomUUID(),
        },
      };
    }
    check(
      body.externalConsent === true,
      "CONSENT_REQUIRED",
      "请先确认本次输入可以发送给所配置的模型服务",
      412,
    );
    // 患者页一键入口可显式指定评估工作流，不再依赖草稿文本命中正则。
    const assessment = Boolean(w.patientId && !["patient-intake", "literature-research"].includes(policy.workflow) && (body.workflow === "patient-assessment" || assessmentQuestion(intentText)));
    const detectedWorkflow = w.patientId && !["patient-intake", "literature-research"].includes(policy.workflow) ? this.pluginHost?.matchWorkflow?.(intentText, policy) : null;
    check(!detectedWorkflow || detectedWorkflow.enabled, "PLUGIN_UNAVAILABLE", `任务所属插件未启用：${detectedWorkflow?.pluginId || ""}`, 409);
    const similarCases = Boolean(detectedWorkflow);
    if (assessment) policy.workflow = "patient-assessment";
    if (detectedWorkflow) detectedWorkflow.workflow.applyPolicy(policy, intentText);
    policy.presentation = policy.workflow === "literature-research" ? "literature" : taskPresentation(intentText);
    const focused = assessment || similarCases || ["diagnostic", "literature", "calculator"].includes(policy.presentation);
    const fileIds = this.selectMaterials(w, body.fileIds, body.contextMode);
    const sources = this.buildSources(w, message, fileIds);
    if (w.patientId && this.patientRecord && (policy.workflow === "patient-assessment" || body.contextMode === "auto")) sources.push(assessmentPatientSource(this.patientRecord(w.patientId)));
    const handle = this.service.prepare(id, {
      revision: body.sessionRevision ?? body.revision ?? w.revision,
      message,
      externalConsent: true,
      completion: body.completion ?? (focused ? {kind:"answer"} : requestsMedicalDeliverable(intentText) ? {kind:"execution"} : undefined),
      requestId: body.requestId,
      thinking: body.thinking,
      skills: body.skills,
      isolatedContext: w.patientId ? !body.conversationParentRunId : focused || body.isolatedContext === true,
      ...(w.patientId && body.conversationParentRunId ? { conversationParentRunId: body.conversationParentRunId } : {}),
      policy,
      collectArtifacts: true,
      skipArtifact: (output) =>
        (similarCases ? output.type !== detectedWorkflow.workflow.artifactType : assessment ? output.type !== "treatment_review" : policy.intent === "consultation" && output.type === "source_search"),
      fileIds,
      sourceHashes: sources.map((s) => s.hash),
      sources,
      limits: {
        maxContextChars: Math.max(this.contextBudget, 10000),
        ...(Number.isFinite(this.maxRounds) ? { maxRounds: this.maxRounds } : {}),
        ...(focused ? {maxRounds:20,maxTotalToolCalls:48,timeoutMs:480000} : {}),
      },
    });
    return { kind: "workspace", handle };
  }
  async executeSend(prepared, notify = () => {}) {
    if (prepared.kind === "sandbox")
      return this.executeSandbox(prepared.plan, notify);
    const workspaceId = prepared.handle.id;
    let seq = 0;
    const emitError = (code, message) => {
      const event = this.service.store.event(workspaceId, prepared.handle.run.id, "error", { code, error: message });
      notify({
        seq: event.id || ++seq,
        type: "error",
        session_id: workspaceId,
        run_id: event.run_id,
        payload: event.payload,
        time: event.time,
      });
    };
    // Only fixed system policy can fail this preflight. Active input and
    // source/history data must reach the runtime's archive + compaction path.
    {
      const budget = this.contextBudget;
      const approx = this.service.systemFor(this.workspace(workspaceId)).length;
      if (Number.isFinite(budget) && approx > budget) {
        const message = "系统提示超过上下文预算，请增加上下文预算或缩小系统配置";
        this.service.store.update(workspaceId, (current) => {
          const target = current.runs.find((r) => r.id === prepared.handle.run.id);
          if (target) {
            assertRunTransition(target.status, "failed");
            target.status = "failed";
            target.error = message;
          }
        });
        emitError("CONTEXT_LIMIT", message);
        return { status: "failed", runId: prepared.handle.run.id, error: message };
      }
    }
    const execution = await this.service.execute(
      prepared.handle,
      (event) => {
        notify({
          seq: event.id || ++seq,
          type: event.type,
          session_id: workspaceId,
          run_id: event.run_id,
          payload: event.type === "tool.complete" && event.payload?.tool === "save_intake_notes"
            ? { ...event.payload, batchesSaved: this.workspace(workspaceId).runs.find(run => run.id === event.run_id)?.intakeNotes?.length || 0 }
            : event.payload,
          time: event.time,
        });
      },
    );
    return {
      status: execution.status,
      runId: execution.runId,
      error: execution.error,
    };
  }
  cancel(id) {
    this.requireSessionWorkspace(id);
    const handle = this.service.active.get(id);
    this.service.cancel(id);
    return Boolean(handle);
  }
  // 事件页读取：agent_events → 旧 event_log 行形状。
  workspaceEvents(id, { after = 0, limit = 1000 } = {}) {
    this.requireSessionWorkspace(id);
    check(
      Number.isInteger(after) && after >= 0,
      "INVALID_INPUT",
      "事件分页参数无效",
    );
    return this.service.store
      .events(id, after, Math.min(Math.max(limit, 1), 1000))
      .map((e) => ({
        id: e.id,
        run_id: e.run_id,
        seq: e.id,
        type: e.type,
        time: e.time,
        payload: e.payload,
      }));
  }

  // ---------- 代码模式：医生手动提交的受控沙箱代码（不调用模型） ----------
  // 只返回沙箱的计算结果，不生成任何助手式回答。
  async executeSandbox(plan, notify = () => {}) {
    const id = plan.sessionId;
    check(
      !this.service.active.has(id),
      "RUN_ACTIVE",
      "会话正在执行",
      409,
    );
    check(
      !this.service.store.hasRequest(id, plan.requestId),
      "DUPLICATE_REQUEST",
      "请求已执行，不能重复提交",
      409,
    );
    const runId = randomUUID();
    let seq = 0;
    const emit = (type, payload) => {
      const event = this.service.store.event(id, runId, type, payload);
      notify({
        seq: event.id || ++seq,
        type,
        session_id: id,
        run_id: runId,
        payload,
        time: event.time,
      });
    };
    emit("message.start", { provider: "sandbox" });
    // No model is involved in a sandbox run; its limits are the sandbox's.
    emit("policy.evaluated", {
      ...plan.policy,
      limitations: ["结果由你提交的代码在本机隔离环境中计算，未经模型处理，也未发送到外部；请自行核对代码与结果。"],
    });
    const started = Date.now();
    emit("sandbox.started", { sourceHashes: plan.sources.map((source) => source.hash) });
    let output;
    try {
      output = await this.service.sandbox.run({
        code: plan.code,
        sources: plan.sources,
      });
    } catch (error) {
      emit("sandbox.failed", { error: error.message });
      this.persistSandboxRun(id, {
        runId,
        requestId: plan.requestId,
        policy: plan.policy,
        message: plan.message,
        text: "",
        fileIds: plan.fileIds,
        status: "failed",
        error: error.message,
        startedAt: started,
      });
      throw error;
    }
    emit("sandbox.completed", { durationMs: Date.now() - started });
    const text = `沙箱计算结果（待复核）：\n${JSON.stringify(output.result, null, 2)}`;
    this.persistSandboxRun(id, {
      runId,
      requestId: plan.requestId,
      policy: plan.policy,
      message: plan.message,
      text,
      fileIds: plan.fileIds,
      status: "completed",
    });
    emit("message.delta", { text });
    emit("message.complete", {
      text,
      risk: plan.policy.risk,
      artifacts: [],
      status: "completed",
      usage: { total_tokens: 0, rounds: 1 },
    });
    return { status: "completed", runId, error: undefined };
  }
  persistSandboxRun(id, spec) {
    this.service.store.update(id, (current) => {
      current.runs.push({
        id: spec.runId,
        requestId: spec.requestId,
        status: spec.status,
        mode: "code",
        policy: spec.policy,
        startedAt: spec.startedAt || Date.now(),
        endedAt: Date.now(),
        partial: spec.text,
        error: spec.error,
        artifacts: [],
        fileIds: spec.fileIds || [],
        usage: { total_tokens: 0, rounds: 1 },
        roundsUsed: 1,
      });
      if (spec.status === "completed")
        current.messages.push(
          { role: "user", content: spec.message, runId: spec.runId },
          {
            role: "assistant",
            content: spec.text,
            runId: spec.runId,
            intent: spec.policy.intent,
            status: "completed",
          },
        );
      else
        current.messages.push({
          role: "user",
          content: spec.message,
          runId: spec.runId,
        });
    });
  }

  // ---------- 产物复核 / 编辑（会话工作区侧） ----------
  mutateArtifact(id, artifactId, mutator) {
    this.requireSessionWorkspace(id);
    let result;
    this.service.store.update(id, (current) => {
      for (const run of current.runs) {
        const a = (run.artifacts || []).find((x) => x.id === artifactId);
        if (a) {
          result = mutator(a);
          return;
        }
      }
      throw new AppError("NOT_FOUND", "产物不存在", 404);
    });
    return result;
  }
  findArtifact(id, artifactId) {
    const w = this.requireSessionWorkspace(id);
    for (const run of w.runs) {
      const a = (run.artifacts || []).find((x) => x.id === artifactId);
      if (a) return a;
    }
    throw new AppError("NOT_FOUND", "产物不存在", 404);
  }
  archiveRunDrafts(id, runId, archived) {
    check(typeof archived === "boolean", "INVALID_INPUT", "请指定是否归档");
    this.workspace(id);
    this.service.store.update(id, w => {
      const run = w.runs.find(r => r.id === runId);
      check(run, "NOT_FOUND", "找不到本次执行", 404);
      check(["failed", "cancelled", "interrupted"].includes(run.status), "RUN_ACTIVE", "只能归档未完成执行的草稿", 409);
      run.draftsArchived = archived;
    });
    return this.get(id);
  }
  reviewArtifact(id, artifactId, body) {
    const reviewer = body.reviewer
      ? string(body.reviewer, "复核者代号", 80)
      : "本机使用者";
    const note = string(body.note, "复核说明", 3000);
    check(
      ["approved", "rejected"].includes(body.decision),
      "INVALID_INPUT",
      "复核决定无效",
    );
    check(body.attested === true, "REVIEW_REQUIRED", "请确认已检查原文和适用范围", 412);
    const reviewed = this.mutateArtifact(id, artifactId, (a) => {
      check(a.version === body.version, "REVISION_CONFLICT", "产物已改变，请刷新后复核", 409);
      a.status = body.decision;
      a.review = {
        reviewer,
        note,
        at: iso(),
        attestation: "local_user",
        reviewedVersion: a.version,
        decision: body.decision,
      };
      a.reviews ||= [];
      a.reviews.push(a.review);
      a.version++;
      return a;
    });
    if (body.decision === "rejected" && note && this.doctor && reviewed)
      this.doctor.recordSignal({
        content: `复核拒绝${reviewed.type === "observations" ? "检验摘录" : reviewed.type === "clinical_timeline" ? "时间线" : reviewed.type === "medication_review" ? "用药核对" : "草稿"}：${note}`,
        topic: "复核反馈",
        note,
        source: { type: "review_rejected", sessionId: id, artifactId },
      });
    this.store.audit(id, "artifact.reviewed", {
      artifactId,
      decision: body.decision,
      reviewer,
    });
    return this.findArtifact(id, artifactId);
  }
  editArtifact(id, artifactId, body) {
    return sqliteTransaction(this.store.db, () => this.editArtifactTransaction(id, artifactId, body));
  }
  editArtifactTransaction(id, artifactId, body) {
    const title = string(body.title, "产物标题", 150);
    const changedNotes = [];
    const beforeArtifact = structuredClone(this.findArtifact(id, artifactId));
    this.mutateArtifact(id, artifactId, (a) => {
      check(a.version === body.version, "REVISION_CONFLICT", "产物版本已改变", 409);
      let events, items, pico;
      if (body.events !== undefined) {
        check(
          a.events &&
            Array.isArray(body.events) &&
            body.events.length === a.events.length,
          "INVALID_INPUT",
          "事件数量不可改变；请修订现有事件",
        );
        events = body.events.map((e, i) => {
          check(
            e &&
              Object.keys(e).every((k) =>
                ["date", "event", "correctionNote"].includes(k),
              ),
            "INVALID_INPUT",
            "不能替换原文来源",
          );
          const date = string(e.date, "事件日期", 20),
            event = string(e.event, "事件内容", 3000);
          check(
            /^\d{4}-\d{2}-\d{2}$/.test(date) &&
              !Number.isNaN(Date.parse(date)) &&
              new Date(date).toISOString().slice(0, 10) === date,
            "INVALID_INPUT",
            "请填写真实的 YYYY-MM-DD 日期",
          );
          const changed =
            date !== a.events[i].date || event !== a.events[i].event;
          const correctionNote = changed
            ? string(e.correctionNote, "修改依据", 1500)
            : a.events[i].correctionNote;
          if (changed && correctionNote) changedNotes.push(correctionNote);
          return {
            ...a.events[i],
            date,
            event,
            dateValid: true,
            needs_review: true,
            ...(correctionNote ? { correctionNote } : {}),
          };
        });
      }
      if (body.items !== undefined) {
        check(
          a.items &&
            Array.isArray(body.items) &&
            body.items.length > 0 &&
            body.items.length <= 40,
          "INVALID_INPUT",
          "请保留 1–40 条流程条目",
        );
        items = body.items.map((item) => string(item, "条目", 2000));
      }
      if (a.pico) {
        pico = {};
        for (const key of ["population", "intervention", "comparison", "outcome"])
          pico[key] = string(body.pico?.[key], key, 300);
      }
      a.history ||= [];
      a.history.push({
        version: a.version,
        title: a.title,
        status: a.status,
        events: a.events,
        items: a.items,
        pico: a.pico,
        review: a.review,
        at: iso(),
      });
      a.title = title;
      a.version++;
      a.status = "draft";
      delete a.review;
      if (events) a.events = events;
      if (items) a.items = items;
      if (pico) {
        a.pico = pico;
        a.query = [pico.population, pico.intervention]
          .map((v) => '"' + v.replace(/"/g, " ") + '"')
          .join(" AND ");
        a.searchUrl = `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(a.query)}`;
      }
      return a;
    });
    const edited = this.findArtifact(id, artifactId);
    const artifactText = a => a.text || (a.items ? a.items.join('\n\n') : a.events ? a.events.map(e => `${e.date} ${e.event}`).join('\n\n') : a.pico ? Object.entries(a.pico).map(([k, v]) => `${k}: ${v}`).join('\n\n') : a.title);
    const review = this.learning?.()?.reviewLog?.record({ kind: 'artifact', patientId: this.get(id).patientId, ai: { text: artifactText(beforeArtifact) }, final: { text: artifactText(edited) } });
    if (review) this.learning?.()?.automation?.recordEdit({ title: edited.title, type: edited.type, note: changedNotes[0], reviewSessionId: review.id });
    if (this.doctor && changedNotes.length)
      for (const note of changedNotes)
        this.doctor.recordSignal({
          content: `修订草稿时补充依据：${note}`,
          topic: "修订依据",
          source: { type: "artifact_edited", sessionId: id, artifactId },
        });
    this.store.audit(id, "artifact.edited", { artifactId });
    return this.findArtifact(id, artifactId);
  }

  copyMaterial(sourceId, targetId, file) {
    let copied;
    if (file.extraction?.type === "image") {
      const original = this.service.artifacts.read(sourceId, file.extraction.artifactId);
      copied = this.addMaterial(targetId, { name: file.name, image: original.data.toString("base64") });
    } else if (file.extraction?.pageImages?.length) {
      const pageImages = file.extraction.pageImages.map((p) => ({ page: p.page, data: this.service.artifacts.read(sourceId, p.artifactId).data.toString("base64") }));
      const text = (file.extraction.originalText || file.text).replace(/\n\[PDF 第 \d+ 页扫描图\] artifactId:.*$/gm, "");
      copied = this.addMaterial(targetId, { ...file, text, pageImages });
    } else return this.addMaterial(targetId, file, { publicSource: this.privacyExempt(file) });
    if (file.extraction.ocr?.status === "ready") {
      this.service.store.update(targetId, workspace => {
        const target = workspace.materials.find(item => item.id === copied.id);
        const replaceIds = text => {
          const from = file.extraction.type === "image" ? [file.extraction] : file.extraction.pageImages;
          const to = copied.extraction.type === "image" ? [copied.extraction] : copied.extraction.pageImages;
          return from.reduce((value, item, index) => value.replaceAll(item.artifactId, to[index].artifactId), text);
        };
        target.extraction.originalText = copied.text;
        target.extraction.ocr = { ...file.extraction.ocr };
        target.text = replaceIds(file.text);
        copied = target;
      });
    }
    return copied;
  }

  // ---------- 材料副本 / 分支（契约与旧 copyMaterials 一致） ----------
  copyMaterials(id, body) {
    const w = this.requireSessionWorkspace(id);
    check(
      body.sessionRevision === undefined ||
        body.sessionRevision === w.revision,
      "REVISION_CONFLICT",
      "会话资料已更新，请刷新核对后再发送",
      409,
    );
    const fork = body.fork === true;
    const all = (w.materials || []).map((f) => f.id);
    const fileIds = fork
      ? all
      : (body.fileIds || []).filter((fid) => all.includes(fid));
    const created = this.createSession({
      title: fork ? `${w.title} · 分支` : `${w.title} · 材料副本`,
      copiedFrom: fork ? { sessionId: id } : undefined,
    });
    for (const file of w.materials || [])
      if (fileIds.includes(file.id)) this.copyMaterial(id, created.id, file);
    return this.get(created.id);
  }

  // ---------- 材料检索（会话工作区侧） ----------
  searchMaterials(id, query) {
    const w = this.requireSessionWorkspace(id);
    return runTool("search_materials", { query }, {
      sources: (w.materials || []).map((f) => ({
        id: f.id,
        name: f.name,
        text: f.text,
        hash: f.hash,
        extraction: f.extraction,
      })),
    });
  }

  // ---------- 消费方（患者/随访/调度/摘要）统一入口 ----------
  get dispatcher() {
    const bridge = this;
    return {
      get provider() {
        return bridge.service.provider;
      },
      get maxActive() {
        return bridge.service.maxActive;
      },
      active: {
        has: (id) => bridge.service.active.has(id),
      },
      prepare(sessionId, body) {
        const w = bridge.requireSessionWorkspace(sessionId);
        const message = string(body.message, "任务", 200000);
        check(resolveMode(body.mode) === "model", "INVALID_INPUT", "后台任务只能由模型执行");
        requireModel(bridge.service.provider);
        // 后台消费方只接受显式上下文，不沿用上一轮。
        const contexts = body.context === undefined ? [] : normalizeTaskContexts(body.context, { pluginHost: bridge.pluginHost });
        const policy = medicalPolicy(taskContextIntentText(message, contexts, { pluginHost: bridge.pluginHost }));
        if (contexts.length) policy.contexts = contexts;
        if (["patient-intake", "knowledge-answer", "literature-research"].includes(body.workflow)) policy.workflow = body.workflow;
        const fileIds = bridge.selectMaterials(w, body.fileIds || []);
        const sources = bridge.buildSources(w, message, fileIds);
        const handle = bridge.service.prepare(sessionId, {
          revision: w.revision,
          message,
          externalConsent: body.externalConsent === true,
          completion: body.completion,
          requestId: body.requestId,
          isolatedContext: body.isolatedContext === true,
          policy,
          collectArtifacts: true,
          skipArtifact: (output) =>
            policy.intent === "consultation" && output.type === "source_search",
          fileIds,
          sourceHashes: sources.map((s) => s.hash),
          sources,
          limits: { maxContextChars: bridge.contextBudget },
        });
        return handle;
      },
      async execute(handle) {
        bridge.requireSessionWorkspace(handle.id);
        const execution = await bridge.service.execute(handle);
        return {
          status: execution.status,
          runId: execution.runId,
          error: execution.error,
        };
      },
      cancel(sessionId) {
        return bridge.cancel(sessionId);
      },
    };
  }
}
