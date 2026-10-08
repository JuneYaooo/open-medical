import {taskPresentation} from '../shared/task-presentation.mjs';
import {requestsMedicalDeliverable} from '../shared/medical-delivery.mjs';
import { collectWorkspaceDelivery } from "./core/workspace-delivery.mjs";
import {similarCaseQuestion} from './medical/similar-case-workflow.mjs';
import { assessmentQuestion } from "./medical/assessment-tools.mjs";
// Session Bridge：把「统一内核工作区（kind:"session"）」投影成首页医疗
// 会话的 API 形状，并按会话类别双轨分派——新建会话走 WorkspaceService
// （通用内核 + 医疗叠层），既有 sessions 表会话继续走 MedicalRuntime。
// 患者页、随访、计划任务、消息摘要通过 dispatcher 对两类引擎透明。
import { imageTextWithFallback, visionTranscriber } from "./core/image-text.mjs";
import { assessOcrQuality } from "../shared/ocr-quality.mjs";
import { sqliteTransaction } from "./sqlite-transaction.mjs";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AppError, check, string } from "./errors.mjs";
import { medicalPolicy } from "../shared/medical.mjs";
import { runTool, localWork } from "./medical-core.mjs";
import { consultationNotice, publicSession } from "./runtime.mjs";
import { providerConfigured } from "./core/provider-status.mjs";
import {
  assertRunTransition,
  deriveRunStatus,
  waitingReasonFor,
} from "./core/run-status.mjs";

const hashText = (value) => createHash("sha256").update(value).digest("hex");
const iso = () => new Date().toISOString();
const sessionKind = (w) => w?.kind === "session";
// Extraction steps a run performs on the way to its deliverable.
const SUPPORTING = new Set(["clinical_timeline", "observations"]);
// Drafts a doctor actually has to review: a run's intermediate extractions
// are not counted once the run produced a final draft, and trial screening
// drafts are reviewed on the trial page.
function reviewItems(runs) {
  const items = [];
  for (const run of runs) {
    if (run.draftsArchived) continue;
    const drafts = run.artifacts.filter((a) => a.status === "draft" && a.type !== "trial_eligibility");
    const final = drafts.filter((a) => !SUPPORTING.has(a.type));
    for (const a of final.length ? final : drafts) items.push(a.title || "整理结果");
  }
  return items;
}
// 与旧引擎一致的运行方式别名（standard/creator→model，minimal/code→local）。
const resolveMode = (mode) => {
  const requested = mode || "local";
  check(
    ["local", "model", "standard", "minimal", "creator", "code"].includes(
      requested,
    ),
    "INVALID_INPUT",
    "运行方式无效",
  );
  return ["standard", "creator", "minimal"].includes(requested)
    ? "model"
    : requested === "code"
      ? "local"
      : requested;
};

export class SessionBridge {
  // store：旧医疗会话存储；runtime：旧医疗引擎；service：统一内核；
  // sessionsRoot：会话工作区自动目录的父目录（数据库目录下）。
  constructor(store, runtime, service, { sessionsRoot, skills = null, doctor = null, plugins = [], contextBudget = 80000, maxRounds = 512, onMaterialIngest, onMaterialReingest } = {}) {
    Object.assign(this, {
      store,
      runtime,
      service,
      sessionsRoot,
      skills,
      doctor,
      plugins: new Map(plugins.map((p) => [p.definition.function.name, p])),
      contextBudget,
      maxRounds,
      onMaterialIngest,
      onMaterialReingest,
    });
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
  createSession({ title, patientId, copiedFrom } = {}) {
    const root = join(this.sessionsRoot, randomUUID());
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const w = this.service.create({
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
      approvalPolicy: "workspace-write",
      autoApplyConsent: true,
    });
    if (copiedFrom)
      this.service.store.update(w.id, (current) => {
        current.copiedFrom = copiedFrom;
      });
    if (image)
      // 延迟一拍执行：调用方（材料副本/分支）会在返回后立刻写材料并推进
      // 版本，配置时重新读取当前 revision；失败静默，可在设置中重配。
      Promise.resolve()
        .then(() =>
          this.service.extensions.operation(w.id, {
            action: "configure",
            revision: this.service.get(w.id).revision,
            consent: true,
            origins: [],
            terminal: true,
            image,
            browser: false,
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
    this.service.extensions.close(id).catch(() => {});
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

  // ---------- 材料（session.files 的内核等价物） ----------
  addMaterial(id, input) {
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
      check(new Set(pages.map((p) => p.page)).size === pages.length && pages.every((p) => extraction.emptyPages.includes(p.page) && typeof p.data === "string" && p.data.length <= 5333336 && /^[A-Za-z0-9+/]+={0,2}$/.test(p.data)), "PDF_EXTRACTION", "扫描页面无效");
      const digest = hashText(text + pages.map((p) => p.data).join(""));
      const current = this.requireSessionWorkspace(id);
      check((current.materials || []).length < 100, "FILE_LIMIT", "每个会话最多 100 份材料");
      check(!(current.materials || []).some((f) => f.extraction?.imageHash === digest), "DUPLICATE_FILE", "相同内容已在本会话中", 409);
      extraction.imageHash = digest;
      extraction.pageImages = pages.map((p) => {
        const artifact = this.service.uploadImage(id, { name: `PDF-page-${p.page}.jpg`, data: p.data });
        text += `\n[PDF 第 ${p.page} 页扫描图] artifactId: ${artifact.id}，使用 inspect_image 读取原文，不能猜测不清晰内容。`;
        return { page: p.page, artifactId: artifact.id };
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
        current.materials.every((f) => f.hash !== file.hash),
        "DUPLICATE_FILE",
        "相同内容已在本会话中",
        409,
      );
      current.materials.push(file);
    });
    if (this.onMaterialIngest)
      try {
        this.onMaterialIngest(file);
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
    const images = file.extraction?.type === "image"
      ? [{ artifactId: file.extraction.artifactId }]
      : file.extraction?.pageImages || [];
    // 纯文本/表格材料没有可识别页：无需 OCR，原样返回。
    if (!images.length) return file;
    if (!force && file.extraction?.ocr?.status === "ready") return file;
    // 回退链:macOS 本地 OCR → Windows 本地 OCR → 当前配置的视觉模型(若支持图片)。
    const analyzeImage = visionTranscriber(this.service.provider);
    if (preferVision) {
      check(typeof analyzeImage === "function", "OCR_UNAVAILABLE",
        "当前模型不支持图片读取。请在模型设置中切换为多模态（视觉）模型后重试", 503);
    }
    const transcribe = async (data) => {
      if (preferVision) return { kind: "vision", text: await analyzeImage(data, signal) };
      return imageTextWithFallback(data, signal, analyzeImage);
    };
    const pages = [];
    let kind = "ocr";
    let upgraded = false;
    for (const image of images) {
      signal?.throwIfAborted();
      const original = this.service.artifacts.read(id, image.artifactId);
      let result = await transcribe(original.data);
      // 本地 OCR 质量过差且视觉模型可用时自动升级重转录，避免垃圾文本流入病历。
      // 干净的模板页（标签重复但常用字规整，如系统导出的无数值清单）升级也读不出
      // 原文没有的数值，跳过以省去无效的视觉调用。
      if (result.kind !== "vision" && typeof analyzeImage === "function") {
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
    let prepared;
    this.service.store.update(id, current => {
      const target = current.materials.find(item => item.id === fileId);
      check(target, "NOT_FOUND", "材料已移除", 404);
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
      target.text = (file.extraction.type === "image" ? "" : target.extraction.originalText + "\n\n") + text + "\n[文字识别结果需核对原图；不能据此解读 CT 或病理图像。]";
      prepared = target;
    });
    this.reingestMaterial(prepared);
    this.store.audit(id, "file.ocr.completed", { fileId, pages: pages.length, method: kind, quality: quality.level, upgraded });
    return prepared;
  }
  // 材料文本变化后同步检索索引，否则助手检索到的仍是旧识别文本。
  reingestMaterial(file) {
    if (!this.onMaterialReingest) return;
    try { this.onMaterialReingest(file); } catch {}
  }
  // 医生在对照视图里直接修正识别文本：与重新识别同权重，重算质量并刷新索引。
  updateMaterialText(id, fileId, text) {
    this.requireSessionWorkspace(id);
    check(!this.service.active.has(id), "RUN_ACTIVE", "执行期间不能变更材料", 409);
    const value = string(text, "识别文本", 400000);
    let prepared;
    this.service.store.update(id, current => {
      const target = current.materials.find(item => item.id === fileId);
      check(target, "NOT_FOUND", "材料不存在", 404);
      target.text = value;
      target.hash = hashText(value);
      target.extraction.edited = { at: iso() };
      const quality = assessOcrQuality(value);
      if (target.extraction.ocr) target.extraction.ocr.quality = quality;
      prepared = target;
    });
    this.reingestMaterial(prepared);
    this.store.audit(id, "file.text.edited", { fileId, chars: value.length });
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
          ["patient-assessment", "similar-case-search"].includes(run.policy?.workflow) &&
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
      files: (w.materials || []).map((f) => ({ ...f })),
      intakeIssues: w.intakeIssues || [],
      intakeJob: w.intakeJob || null,
      artifacts: runs.flatMap((run) => run.artifacts.filter(a => !run.draftsArchived || a.status !== "draft")),
      runs,
    };
  }
  get(id) {
    if (this.isSessionWorkspace(id)) return this.project(this.workspace(id));
    return publicSession(this.store.get(id));
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
      reviewCount: projected.artifacts.filter((a) => a.status === "draft")
        .length,
      background: w.runs.some((run) => run.policy?.workflow === "trial-eligibility"),
      reviewItems: reviewItems(projected.runs),
      running: this.service.active.has(w.id) || w.intakeJob?.status === "running",
      lastRunStatus: w.runs.at(-1)?.status || null,
      lastRunError: w.runs.at(-1)?.error || null,
    };
  }
  list() {
    const sessionWorkspaces = this.service.store
      .list()
      .filter(sessionKind)
      .map((w) => this.summary(w));
    const legacy = this.store.list().map((s) => ({
      id: s.id,
      title: s.title,
      patientId: s.patientId,
      updatedAt: s.updatedAt,
      revision: s.revision,
      messageCount: s.messages.length,
      reviewCount: s.artifacts.filter((a) => a.status === "draft").length,
      running: this.runtime.active.has(s.id),
      lastRunStatus: s.runs.at(-1)?.status || null,
      lastRunError: s.runs.at(-1)?.error || null,
    }));
    return [...sessionWorkspaces, ...legacy].sort(
      (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
    );
  }

  // ---------- 发送：构建 sources 并分派 ----------
  // fileIds 语义与旧引擎一致：undefined = 不带材料（摘要类任务）；
  // 数组 = 显式选择，未知材料 ID 视为越权引用（404）。
  selectMaterials(w, fileIds) {
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
        name: f.name,
        text: f.text,
        hash: f.hash,
        extraction: f.extraction,
      })),
      {
        id: randomUUID(),
        name: "本轮输入",
        text: message,
        hash: hashText(message),
      },
    ];
  }
  // 返回 {kind:"workspace", handle} | {kind:"legacy", handle}；本地规则
  // 模式返回 {kind:"local", plan}，由 executeSend 同步执行。
  prepareSend(id, body) {
    if (!this.isSessionWorkspace(id))
      return { kind: "legacy", handle: this.runtime.prepare(id, body) };
    const w = this.requireSessionWorkspace(id);
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
    const requestedMode = body.mode || "local";
    const mode = resolveMode(requestedMode);
    const policy = medicalPolicy(message);
    if (body.workflow === "patient-intake") policy.workflow = "patient-intake";
    if (body.requestId !== undefined)
      check(
        !this.service.store.hasRequest(id, body.requestId),
        "DUPLICATE_REQUEST",
        "请求已执行，不能重复提交",
        409,
      );
    if (requestedMode === "code") {
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
      return {
        kind: "local",
        plan: {
          type: "sandbox",
          sessionId: id,
          code: body.sandboxCode,
          message,
          policy,
          fileIds: [],
          requestId: body.requestId || randomUUID(),
        },
      };
    }
    if (mode === "local")
      return {
        kind: "local",
        plan: {
          type: "local",
          sessionId: id,
          policy,
          message,
          sources: this.buildSources(w, message, this.selectMaterials(w, body.fileIds)),
          fileIds: this.selectMaterials(w, body.fileIds),
          requestId: body.requestId || randomUUID(),
        },
      };
    check(
      providerConfigured(this.runtime.provider),
      "MODEL_NOT_CONFIGURED",
      "服务端尚未配置模型密钥",
      503,
    );
    check(
      body.externalConsent === true,
      "CONSENT_REQUIRED",
      "请先确认本次输入可以发送给所配置的模型服务",
      412,
    );
    const assessment = Boolean(w.patientId && policy.workflow !== "patient-intake" && assessmentQuestion(message));
    const similarCases = Boolean(w.patientId && policy.workflow !== "patient-intake" && similarCaseQuestion(message));
    if (assessment) policy.workflow = "patient-assessment";
    if (similarCases) { policy.workflow = "similar-case-search"; policy.intent = "similar_cases"; policy.searchScope = /(?:只|仅).{0,6}本地|不要.{0,3}(?:联网|网上)/.test(message) ? "local" : "online"; }
    policy.presentation = taskPresentation(message);
    const focused = assessment || similarCases || ["diagnostic", "literature", "calculator"].includes(policy.presentation);
    const fileIds = this.selectMaterials(w, body.fileIds);
    const sources = this.buildSources(w, message, fileIds);
    const handle = this.service.prepare(id, {
      revision: body.sessionRevision ?? body.revision ?? w.revision,
      message,
      externalConsent: true,
      completion: body.completion ?? (focused ? {kind:"answer"} : requestsMedicalDeliverable(message) ? {kind:"execution"} : undefined),
      requestId: body.requestId,
      thinking: body.thinking,
      skills: body.skills,
      isolatedContext: w.patientId ? !body.conversationParentRunId : focused || body.isolatedContext === true,
      ...(w.patientId && body.conversationParentRunId ? { conversationParentRunId: body.conversationParentRunId } : {}),
      policy,
      collectArtifacts: true,
      skipArtifact: (output) =>
        (similarCases ? output.type !== "similar_cases" : assessment ? output.type !== "treatment_review" : policy.intent === "consultation" && output.type === "source_search"),
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
    if (prepared.kind === "legacy") {
      const run = await this.runtime.execute(prepared.handle, notify);
      return { status: run.status, runId: run.id, error: run.error };
    }
    if (prepared.kind === "local")
      return this.executeLocal(prepared.plan, notify);
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
    if (this.isSessionWorkspace(id)) {
      const handle = this.service.active.get(id);
      this.service.cancel(id);
      return Boolean(handle);
    }
    return this.runtime.cancel(id);
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

  // ---------- 本地规则 / 沙箱模式（无模型） ----------
  async executeLocal(plan, notify = () => {}) {
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
    emit("message.start", { provider: "local" });
    emit("policy.evaluated", plan.policy);
    let text;
    const artifacts = [];
    if (plan.type === "sandbox") {
      const started = Date.now();
      emit("sandbox.started", {});
      let output;
      try {
        output = await this.service.sandbox.run({
          code: plan.code,
          sources: [],
        });
      } catch (error) {
        emit("sandbox.failed", { error: error.message });
        this.persistLocalRun(id, {
          runId,
          requestId: plan.requestId,
          policy: plan.policy,
          message: plan.message,
          text: "",
          artifacts: [],
          fileIds: [],
          status: "failed",
          error: error.message,
          startedAt: started,
        });
        throw error;
      }
      emit("sandbox.completed", { durationMs: Date.now() - started });
      text = `沙箱计算结果（待复核）：\n${JSON.stringify(output.result, null, 2)}`;
    } else {
      const work = localWork(plan.policy, plan.sources);
      let result = null;
      try {
        result = await runTool(work.tool, work.args, {
          sources: plan.sources,
          skills: this.skills,
          plugins: this.plugins,
        });
      } catch (error) {
        if (error.code !== "UNKNOWN_TOOL") throw error;
        result = null;
      }
      if (result) {
        emit("tool.start", { tool: work.tool, call_id: randomUUID() });
        if (result.id) {
          result.provenance = "local_rule";
          artifacts.push(result);
        }
        emit("tool.complete", { tool: work.tool, artifact: result });
      }
      text = this.localNotice(result, plan.policy);
    }
    this.persistLocalRun(id, {
      runId,
      requestId: plan.requestId,
      policy: plan.policy,
      message: plan.message,
      text,
      artifacts,
      fileIds: plan.fileIds || [],
      status: "completed",
    });
    emit("message.delta", { text });
    emit("message.complete", {
      text,
      risk: plan.policy.risk,
      artifacts,
      status: "completed",
      usage: { total_tokens: 0, rounds: 1 },
    });
    return { status: "completed", runId, error: undefined };
  }
  localNotice(result, policy) {
    return result?.type === "observations"
      ? `已摘录 ${result.observations.length} 个原文检验数值，保留单位和来源，未进行异常判断。`
      : result?.type === "clinical_timeline"
        ? `已从本次材料中识别 ${result.events.length} 条带日期的原文事件。请在产物中逐项核对来源后复核。没有完整日期的内容未被推断。`
        : result?.type === "medication_review"
          ? `已生成用药资料核对表，列出 ${result.missing.length} 类待补充信息。这是资料检查，尚未执行药理、剂量或相互作用核查。`
          : result?.type === "evidence_plan"
            ? "已创建循证任务的 PICO 草稿和检索步骤。尚未联网检索；请在产物中补充人群、干预、对照和结局。"
            : policy.intent === "consultation"
              ? consultationNotice(result)
              : "已生成可编辑的医疗工作流程草稿。请检查材料范围与人工复核要求。";
  }
  persistLocalRun(id, spec) {
    this.service.store.update(id, (current) => {
      current.runs.push({
        id: spec.runId,
        requestId: spec.requestId,
        status: spec.status,
        mode: "local",
        policy: spec.policy,
        startedAt: spec.startedAt || Date.now(),
        endedAt: Date.now(),
        partial: spec.text,
        error: spec.error,
        artifacts: spec.artifacts,
        fileIds: spec.fileIds,
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
    const title = string(body.title, "产物标题", 150);
    const changedNotes = [];
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
    try { const edited = this.findArtifact(id, artifactId); this.evolution?.recordEdit({ title: edited.title, type: edited.type, note: changedNotes[0] }); } catch { /* evolution signals are best effort */ }
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
    } else return this.addMaterial(targetId, file);
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
    if (!this.isSessionWorkspace(id)) {
      const session = this.store.get(id);
      return runTool("search_materials", { query }, {
        sources: session.files.map((f) => ({
          id: f.id,
          name: f.name,
          text: f.text,
          hash: f.hash,
          extraction: f.extraction,
        })),
      });
    }
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

  // ---------- 消费方（患者/随访/调度/摘要）双轨分派 ----------
  get dispatcher() {
    const bridge = this;
    return {
      get provider() {
        return bridge.runtime.provider;
      },
      get maxActive() {
        return bridge.service.maxActive;
      },
      active: {
        has: (id) =>
          bridge.service.active.has(id) || bridge.runtime.active.has(id),
      },
      prepare(sessionId, body) {
        if (!bridge.isSessionWorkspace(sessionId))
          return bridge.runtime.prepare(sessionId, body);
        const w = bridge.requireSessionWorkspace(sessionId);
        const message = string(body.message, "任务", 200000);
        const mode = resolveMode(body.mode);
        const policy = medicalPolicy(message);
    if (body.workflow === "patient-intake") policy.workflow = "patient-intake";
        const fileIds = bridge.selectMaterials(w, body.fileIds || []);
        const sources = bridge.buildSources(w, message, fileIds);
        if (mode === "local")
          return {
            run: { id: `local_${randomUUID()}` },
            local: {
              type: "local",
              sessionId,
              policy,
              message,
              sources,
              fileIds,
              requestId: body.requestId || randomUUID(),
            },
          };
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
      async execute(handle, notify = () => {}) {
        if (handle.local) return bridge.executeLocal(handle.local, notify);
        // 旧引擎 handle 无 id 字段（只有 sessionId）。
        const handleWorkspaceId = handle.id ?? null;
        if (
          handleWorkspaceId !== null &&
          bridge.isSessionWorkspace(handleWorkspaceId)
        ) {
          const execution = await bridge.service.execute(handle);
          return {
            status: execution.status,
            runId: execution.runId,
            error: execution.error,
          };
        }
        return bridge.runtime.execute(handle);
      },
      cancel(sessionId) {
        return bridge.cancel(sessionId);
      },
    };
  }
}
