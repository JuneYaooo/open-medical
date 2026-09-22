// Session Bridge：把「统一内核工作区（kind:"session"）」投影成首页医疗
// 会话的 API 形状，并按会话类别双轨分派——新建会话走 WorkspaceService
// （通用内核 + 医疗叠层），既有 sessions 表会话继续走 MedicalRuntime。
// 患者页、随访、计划任务、消息摘要通过 dispatcher 对两类引擎透明。
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
  constructor(store, runtime, service, { sessionsRoot, skills = null, doctor = null, plugins = [], contextBudget = 80000, maxRounds = 512, onMaterialIngest } = {}) {
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
    check(
      /\.(txt|md|csv|json|pdf)$/i.test(name),
      "FILE_TYPE",
      "当前支持 TXT、Markdown、CSV、JSON 和 PDF 抽取文本",
    );
    const text = string(input.text, "文件内容", 400000);
    check(Buffer.byteLength(text) <= 2000000, "FILE_SIZE", "文件超过 2MB");
    let extraction;
    if (/\.pdf$/i.test(name)) {
      const e = input.extraction;
      check(
        e?.type === "pdf_text" &&
          Number.isInteger(e.pageCount) &&
          e.pageCount > 0 &&
          e.pageCount <= 300 &&
          Array.isArray(e.emptyPages) &&
          e.emptyPages.length < e.pageCount &&
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
      const facts = runFacts(run);
      const waitingReason = waitingReasonFor(run, facts);
      return {
        id: run.id,
        requestId: run.requestId,
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
        artifacts: run.artifacts || [],
        children: run.children || [],
        events: run.events || recentEvents.filter((event) => event.run_id === run.id).map((event) => ({ ...event, seq: event.id })),
        sourceHashes: (run.sourceHashes || []).map((source, index) => typeof source === "string" ? { id: String(index), hash: source } : source),
        ...(run.delivery ? { delivery: run.delivery } : {}),
        ...(run.outcome ? { outcome: run.outcome } : {}),
      };
    });
    const intentOf = (runId) =>
      runs.find((r) => r.id === runId)?.policy?.intent;
    const messages = (w.messages || []).map((m) => ({
      ...m,
      ...(m.role === "assistant" ? { intent: intentOf(m.runId) } : {}),
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
      artifacts: runs.flatMap((run) => run.artifacts),
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
      updatedAt: projected.updatedAt,
      revision: projected.revision,
      messageCount: projected.messages.length,
      reviewCount: projected.artifacts.filter((a) => a.status === "draft")
        .length,
      running: this.service.active.has(w.id),
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
    const message = string(body.message, "任务", 20000);
    const requestedMode = body.mode || "local";
    const mode = resolveMode(requestedMode);
    const policy = medicalPolicy(message);
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
    const fileIds = this.selectMaterials(w, body.fileIds);
    const sources = this.buildSources(w, message, fileIds);
    const handle = this.service.prepare(id, {
      revision: body.sessionRevision ?? body.revision ?? w.revision,
      message,
      externalConsent: true,
      completion: body.completion,
      requestId: body.requestId,
      thinking: body.thinking,
      skills: body.skills,
      isolatedContext: body.isolatedContext === true,
      policy,
      collectArtifacts: true,
      skipArtifact: (output) =>
        policy.intent === "consultation" && output.type === "source_search",
      fileIds,
      sourceHashes: sources.map((s) => s.hash),
      sources,
      limits: {
        maxContextChars: Math.max(this.contextBudget, 10000),
        ...(Number.isFinite(this.maxRounds) ? { maxRounds: this.maxRounds } : {}),
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
    // 上下文预算预检：系统提示+本轮输入+材料超过预算时直接失败，
    // 与旧引擎「不静默截断病历历史」的行为一致。
    {
      const budget = this.contextBudget;
      const approx =
        this.service.systemFor(this.workspace(workspaceId)).length +
        (prepared.handle.message || "").length +
        (prepared.handle.sources || []).reduce((n, src) => n + src.text.length, 0);
      if (Number.isFinite(budget) && approx > budget) {
        const message = "上下文超过预算，请减少本轮勾选的材料";
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
          payload: event.payload,
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
      if (fileIds.includes(file.id)) this.addMaterial(created.id, file);
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
        const message = string(body.message, "任务", 20000);
        const mode = resolveMode(body.mode);
        const policy = medicalPolicy(message);
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
