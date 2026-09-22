import { providerConfigured } from "./core/provider-status.mjs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { readFile, stat } from "node:fs/promises";
import { resolve, dirname, extname, join, sep } from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import { WorkspaceService } from "./core/workspace-service.mjs";
import { workspaceApi } from "./core/workspace-api.mjs";
import { Store } from "./store.mjs";
import { createProvider } from "./provider.mjs";
import { MedicalRuntime, publicSession } from "./runtime.mjs";
import { AppError, check, string, identifier } from "./errors.mjs";
import { runTool } from "./medical-core.mjs";
import { artifactLines } from "../shared/medical.mjs";
import { SkillRegistry } from "./skills.mjs";
import { MedicalScheduler } from "./scheduler.mjs";
import { MEDICAL_AGENTS } from "./subagents.mjs";
import {
  PatientRegistry,
  composeDigest,
  selectDigestMessages,
} from "./patients.mjs";
import { FollowUpManager } from "./followups.mjs";
import { WeChatMacBridge } from "./wechat-bridge.mjs";
import { DoctorProfile } from "./medical/doctor-profile.mjs";
import { LiteratureService, literatureTools } from "./medical/literature.mjs";
import { GuidelineLibrary, knowledgeTools } from "./medical/guidelines.mjs";
import { searchIcd10 } from "./medical/icd10.mjs";
import { PatientBrief } from "./medical/patient-brief.mjs";
import { PatientImporter } from "./medical/patient-import.mjs";
import { CareTasks } from "./medical/care-tasks.mjs";
import { DoctorOverview } from "./medical/doctor-overview.mjs";
import { RiskEngine } from "./medical/risk-rules.mjs";
import { CaseLibrary, caseTools } from "./medical/cases.mjs";
import {
  ResearchService,
  researchTools as researchToolPlugins,
} from "./medical/research.mjs";
import { DrgService, drgTools } from "./medical/drg.mjs";
import {
  evaluateMedicationSafety,
  assessAdverseReaction,
  specialPopulationCautions,
} from "./medical/med-safety.mjs";
import { calculateScale, listScales, scaleTools } from "./medical/scales.mjs";
import { searchLabKnowledge } from "./medical/lab-knowledge.mjs";
import { searchIcd9 } from "./medical/icd9.mjs";
import {
  PendingActions,
  pendingActionTools,
} from "./medical/pending-actions.mjs";
import { doctorMemoryTools } from "./medical/doctor-profile.mjs";
import { createMedicalWorkspaceDomain } from "./medical/medical-workspace-domain.mjs";
import { SessionBridge } from "./session-bridge.mjs";
import { EmbeddingService } from "./medical/embeddings.mjs";
import { LanceVectorStore } from "./medical/vector-store.mjs";
import { MaterialLibrary, materialSearchTools } from "./medical/materials.mjs";
import { ModelSettings } from "./core/model-settings.mjs";
const ROOT = dirname(fileURLToPath(import.meta.url));
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const sameSecret = (a, b) =>
  typeof a === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function body(req) {
  check(
    req.headers["content-type"]?.startsWith("application/json"),
    "CONTENT_TYPE",
    "请使用 application/json",
    415,
  );
  let bytes = 0;
  const chunks = [];
  for await (const part of req) {
    bytes += part.length;
    check(bytes <= 8 * 1024 * 1024, "BODY_LIMIT", "请求超过 8MB", 413);
    chunks.push(part);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    check(
      value && typeof value === "object" && !Array.isArray(value),
      "INVALID_JSON",
      "JSON 必须为对象",
    );
    return value;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("INVALID_JSON", "请求 JSON 无效");
  }
}
function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}
function errorResponse(res, error) {
  if (!(error instanceof AppError))
    console.error("服务内部错误:", error?.stack || error);
  send(res, error instanceof AppError ? error.status : 500, {
    error: error instanceof AppError ? error.message : "服务发生错误",
    code: error.code || "INTERNAL",
  });
}
export function exportMarkdown(session) {
  const lines = [
    `# ${session.title}`,
    "",
    "本文件为医疗工作草稿；复核状态随每个产物单独记录。",
    "",
  ];
  for (const m of session.messages)
    lines.push(`## ${m.role === "user" ? "输入" : "助理草稿"}`, m.content, "");
  for (const a of session.artifacts) {
    lines.push(
      `## ${a.title}`,
      `状态：${a.status} · 版本 ${a.version}`,
      ...artifactLines(a).map((x) => `- ${x}`),
    );
    if (a.review)
      lines.push(
        `复核者（本地声明）：${a.review.reviewer} · ${a.review.at}`,
        a.review.note,
      );
    const sources = [
      ...(a.events || []).map((e) => e.source),
      ...(a.observations || []).map((o) => o.source),
      ...(a.matches || []),
    ];
    const seen = new Set();
    for (const source of sources) {
      const key = `${source.sourceId}:${source.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(
        `来源：${source.sourceName}${source.page ? ` P${source.page}` : ""} L${source.line} · SHA256 ${source.hash}`,
        `原文：${source.quote}`,
      );
    }
    for (const event of a.events || [])
      if (event.correctionNote)
        lines.push(`修订依据（${event.date}）：${event.correctionNote}`);
    for (const review of a.reviews || [])
      lines.push(
        `历史复核：版本 ${review.reviewedVersion} · ${review.decision} · ${review.reviewer} · ${review.at} · ${review.note}`,
      );
    for (const warning of a.limitations || []) lines.push(`局限：${warning}`);
    lines.push("");
  }
  for (const r of session.runs.filter((r) => r.status !== "completed"))
    lines.push(
      `## 未完成执行：${r.status}`,
      r.error || "",
      r.partial || "",
      "",
    );
  return lines.join("\n");
}
export function createServer(options = {}) {
  const databasePath =
    options.database ||
    process.env.MEDICAL_DATABASE ||
    resolve(ROOT, "data", "medical.sqlite");
  const store = options.store || new Store(databasePath);
  // Credential vault lives beside the database; :memory: (tests) uses a
  // per-user temp directory so the repo never receives a key file.
  const vaultDir =
    databasePath === ":memory:"
      ? resolve(homedir(), ".open-medical-workbench", "tmp-keys")
      : dirname(databasePath);
  const initialProvider =
    options.provider ||
    createProvider({
      provider:
        options.providerName ||
        process.env.AI_PROVIDER ||
        process.env.MODEL_PROVIDER ||
        "deepseek",
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      model: options.model,
      thinking: options.thinking,
      maxTokens: options.maxTokens,
      timeoutMs: options.timeoutMs,
    });
  const models = new ModelSettings(store.db, vaultDir, initialProvider);
  let provider = models.provider();
  const skills =
    options.skills ||
    new SkillRegistry([
      resolve(ROOT, "../skills"),
      ...(process.env.MEDICAL_SKILLS_DIR
        ? process.env.MEDICAL_SKILLS_DIR.split(",")
        : []),
    ]);
  const doctor = options.doctor || new DoctorProfile(store);
  const literature = options.literature || new LiteratureService(store);
  const embedder = options.embedder || new EmbeddingService();
  const pending = new PendingActions(store, {
    patients: () => patients,
    followups: () => followups,
    cases: () => cases,
  });
  // Each runtime instance owns an isolated vector index directory; tests
  // (:memory:) get a per-instance temp dir so tables never leak across.
  const vectorDir =
    databasePath === ":memory:"
      ? mkdtempSync(join(tmpdir(), "omw-vec-"))
      : join(dirname(databasePath), "vector-index");
  const vectorStore = LanceVectorStore.create(vectorDir);
  // Materials get their own LanceDB namespace so knowledge-base stats and
  // model-tagged tables never mix with session material vectors.
  const materialVectors = LanceVectorStore.create(join(vectorDir, "materials"));
  // Public knowledge can use the configured embedding provider. Patient
  // materials always use a separate, local-only endpoint and no API key.
  const patientEmbedder = options.patientEmbedder || new EmbeddingService({
    apiKey: "", provider: "ollama",
    url: process.env.MEDICAL_PATIENT_EMBEDDING_URL || "http://127.0.0.1:11434",
    model: process.env.MEDICAL_PATIENT_EMBEDDING_MODEL || "bge-m3",
  });
  const materials =
    options.materials || new MaterialLibrary(patientEmbedder, materialVectors);
  const guidelines =
    options.guidelines || new GuidelineLibrary(store, embedder, vectorStore);
  const cases = options.cases || new CaseLibrary(store);
  const research = options.research || new ResearchService();
  const drg = options.drg || new DrgService(store);
  drg.load().catch(() => {});
  const medicationSafetyCheck = (args) => {
    const result = evaluateMedicationSafety(args);
    if (Array.isArray(args?.populations) && args.populations.length)
      result.populationCautions = specialPopulationCautions({
        medications: args.medications,
        populations: args.populations,
      });
    return result;
  };
  const knowledgeToolPlugins = [
    ...materialSearchTools(materials),
    {
      definition: {
        type: "function",
        function: {
          name: "knowledge_base_status",
          description:
            "查看医学知识库当前状态：文档数、向量索引块数、嵌入方式（云端/本地 Ollama/未配置）与模型。用于在用户想建知识库时给出准确的环境建议。",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      },
      execute: async () => {
        const rag = await guidelines.ragStatus();
        const docs = guidelines.list().length;
        const advice =
          rag.embedder.mode === "cloud"
            ? "云端嵌入已配置，可直接入库与语义检索。"
            : rag.embedder.provider === "ollama" && rag.embedder.enabled
              ? "本地 Ollama 嵌入已启用（bge-m3 约需 1–2GB 可用内存）；如不想占用本机资源，可改用硅基流动免费 Key。"
              : "尚未配置嵌入服务：语义检索不可用，已回退全文匹配。可让用户二选一：① 硅基流动免费 Key（零本机占用，siliconflow.cn 注册）填入 MEDICAL_EMBEDDING_KEY；② 本机 Ollama（ollama pull bge-m3，约需 2GB 内存）。";
        return { docs, ...rag, advice };
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "guideline_ingest",
          description:
            "把一份指南/共识/规范全文存入本地医疗知识库（自动分块并向量化索引）。仅当用户明确要求入库或已确认保存时调用；入库前请说明来源。",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string" },
              text: { type: "string" },
              org: { type: "string" },
              year: { type: "integer" },
            },
            required: ["title", "text"],
            additionalProperties: false,
          },
        },
      },
      execute: (args) => guidelines.addDocument(args),
    },
    ...doctorMemoryTools(doctor),
    ...literatureTools(literature),
    ...knowledgeTools(guidelines),
    ...caseTools(cases),
    ...drgTools(drg),
    {
      definition: {
        type: "function",
        function: {
          name: "medication_safety_check",
          description:
            "对用药清单做确定性安全核查（过敏匹配、内置相互作用对、重复用药），可选 populations 做特殊人群（妊娠/儿童/肾功能不全/肝功能不全/老年）提示。内置规则集非穷尽，结果为提示性草稿。",
          parameters: {
            type: "object",
            properties: {
              medications: { type: "array", items: { type: "string" } },
              allergies: { type: "array", items: { type: "string" } },
              populations: { type: "array", items: { type: "string" } },
            },
            required: ["medications"],
            additionalProperties: false,
          },
        },
      },
      execute: (args) => medicationSafetyCheck(args),
    },
    {
      definition: {
        type: "function",
        function: {
          name: "assess_adverse_reaction",
          description:
            "把当前用药清单与临床表现做匹配，筛查可能的药物不良反应（内置常见药组知识表）。提示性筛查，非因果判定。",
          parameters: {
            type: "object",
            properties: {
              medications: { type: "array", items: { type: "string" } },
              findings: { type: "string" },
            },
            required: ["medications", "findings"],
            additionalProperties: false,
          },
        },
      },
      execute: (args) => assessAdverseReaction(args),
    },
    ...scaleTools(),
    {
      definition: {
        type: "function",
        function: {
          name: "lab_knowledge_search",
          description:
            "查询常见检验指标的意义速查（升高/降低的常见原因与建议核查项）。参考范围以报告单为准。",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
              limit: { type: "integer" },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
      },
      execute: (args) => searchLabKnowledge(args),
    },
  ];

  // These are application-owned implementations: local store/rules with optional
  // semantic fallbacks; literature alone requires the public fetch backend.
  for (const plugin of knowledgeToolPlugins)
    plugin.capability = {
      backend: ["literature_search", "literature_fetch"].includes(
        plugin.definition.function.name,
      )
        ? "network"
        : "local",
    };
  const localPlugins = (items) =>
    items.map((plugin) => ({ ...plugin, capability: { backend: "local" } }));

  // Context budgets are env-tunable; explicit options.runtimeOptions wins.
  const envNumber = (name, fallback) => {
    const raw = process.env[name];
    if (!raw) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const runtime = new MedicalRuntime(store, provider, {
    maxContextChars: envNumber("MEDICAL_CONTEXT_BUDGET", 80000),
    maxRounds: envNumber("MEDICAL_MAX_ROUNDS", Infinity),
    maxToolCalls: envNumber("MEDICAL_MAX_TOOL_CALLS", 8),
    ...options.runtimeOptions,
    skills,
    toolPlugins: options.toolPlugins || [
      ...knowledgeToolPlugins,
      ...localPlugins(researchToolPlugins(research)),
    ],
    doctor,
  });
  const workspaces = new WorkspaceService(store.db, provider, {
    domain: createMedicalWorkspaceDomain({
      readPatientBrief: (patientId) => patientBrief.read(patientId),
      plugins: [
        ...knowledgeToolPlugins,
        ...localPlugins(pendingActionTools(pending, doctor)),
      ],
      // 会话叠层：医疗核心工具经 runTool 分发这些插件（材料 sources、
      // readOnly 约定与旧医疗会话一致）。
      sessionPlugins: [
        ...knowledgeToolPlugins,
        ...localPlugins(researchToolPlugins(research)),
        ...localPlugins(pendingActionTools(pending, doctor)),
      ],
      skills,
      doctor,
    }),
    onNotification: options.onNotification,
    sandbox: runtime.sandbox,
    chooseDirectory: options.chooseDirectory,
    extensions: {
      browserFactory: options.browserFactory,
      ...options.extensions,
    },
  });
  // 首页会话统一到工作区内核：新建会话 = kind:"session" 的工作区；
  // 既有 sessions 表会话继续走 MedicalRuntime。桥对两条路径透明。
  const sessionsRoot =
    databasePath === ":memory:"
      ? mkdtempSync(join(tmpdir(), "omw-sessions-"))
      : join(dirname(databasePath), "session-workspaces");
  mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
  const sessionBridge = new SessionBridge(store, runtime, workspaces, {
    sessionsRoot,
    skills,
    doctor,
    plugins: [
      ...knowledgeToolPlugins,
      ...localPlugins(researchToolPlugins(research)),
      ...localPlugins(pendingActionTools(pending, doctor)),
    ],
    contextBudget:
      options.runtimeOptions?.maxContextChars ??
      envNumber("MEDICAL_CONTEXT_BUDGET", 80000),
    maxRounds:
      options.runtimeOptions?.maxRounds ?? envNumber("MEDICAL_MAX_ROUNDS", 512),
    onMaterialIngest: (file) => {
      materials.ingest(file).catch(() => {});
    },
  });
  const agentRuntime = sessionBridge.dispatcher;

  // 能力分层快照（W6/B1）：三态判定与运行事实探测提取到
  // core/capability.mjs，由 WorkspaceService.capabilitySnapshot 提供
  // 共用实现；医疗入口（下方 capability-snapshot 路由）与通用平台 API
  //（workspace-api 的同名 action）返回同一口径，不再各自组装。
  const capabilitySnapshot = (id) => workspaces.capabilitySnapshot(id);
  const secret = options.token || randomBytes(32).toString("hex");
  const scheduler = new MedicalScheduler(store, agentRuntime, {
    ...options.schedulerOptions,
    resolveSession: (sessionId) => {
      if (sessionBridge.isSessionWorkspace(sessionId)) {
        const w = sessionBridge.workspace(sessionId);
        return {
          revision: w.revision,
          files: (w.materials || []).map((f) => ({ id: f.id, hash: f.hash })),
        };
      }
      return store.get(sessionId);
    },
  });
  const patients = new PatientRegistry(store, agentRuntime, {
    onIdentityChanged: (patient, previousName) => {
      if (sessionBridge.isSessionWorkspace(patient.sessionId)) {
        const session = sessionBridge.get(patient.sessionId);
        if (session.title === `${previousName} · 病例`) sessionBridge.renameSession(patient.sessionId, `${patient.name} · 病例`);
      } else {
        const session = store.get(patient.sessionId);
        if (session.title === `${previousName} · 病例`) store.mutate(patient.sessionId, (value) => { value.title = `${patient.name} · 病例`; });
      }
    },
    createSession: ({ title, patientId }) => {
      const projected = sessionBridge.createSession({ title, patientId });
      return { id: projected.id };
    },
    removeSession: (sessionId) => {
      if (sessionBridge.isSessionWorkspace(sessionId))
        sessionBridge.removeSession(sessionId);
      else store.delete(sessionId);
    },
  });
  const followups = new FollowUpManager(
    store,
    agentRuntime,
    options.followupOptions,
  );
  const risks = new RiskEngine(store, followups);
  const doctorOverview = new DoctorOverview(store, sessionBridge);
  const patientBrief = new PatientBrief(store, patients);
  const careTasks = new CareTasks(store, patients, followups);
  const patientImporter = new PatientImporter(store, patients);
  runtime.registerPlugins(pendingActionTools(pending, doctor));
  const swapProvider = (next) => {
    provider = next;
    runtime.provider = provider;
    runtime.agent.provider = provider;
    runtime.subagents.provider = provider;
    workspaces.provider = provider;
    workspaces.agent.provider = provider;
  };
  const wechat = new WeChatMacBridge({
    patients,
    enabled: ["1", "on", "true"].includes(
      String(
        options.wechatBridge ?? process.env.MEDICAL_WECHAT_BRIDGE ?? "",
      ).toLowerCase(),
    ),
    processNames: String(process.env.MEDICAL_WECHAT_PROCESS || "微信,WeChat")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // 测试缝:允许 fixture 注入 darwin 以覆盖桥接逻辑;默认真实平台。
    platform: options.wechatBridgePlatform ?? process.platform,
  });
  const ingestSecret =
    options.ingestSecret || process.env.MEDICAL_INGEST_SECRET || "";
  const digestMessages = async (pid, bodyData) => {
    const patient = patients.get(pid);
    const messages = patients.messages(pid, {
      unprocessedOnly: true,
      limit: 50,
    });
    check(messages.length, "NOT_FOUND", "没有待处理的患者消息", 404);
    // Stay inside the runtime's 20000-char message budget; leftovers remain
    // unprocessed and can be digested again.
    const trimmed = selectDigestMessages(messages);
    check(
      providerConfigured(runtime.provider),
      "MODEL_NOT_CONFIGURED",
      "服务端尚未配置模型密钥",
      503,
    );
    check(
      bodyData.externalConsent === true,
      "CONSENT_REQUIRED",
      "请先确认患者消息可以原文发送给所配置的模型服务",
      412,
    );
    const handle = agentRuntime.prepare(patient.sessionId, {
      message: composeDigest(trimmed, patient.name),
      mode: "model",
      externalConsent: true,
      fileIds: [],
      requestId: `digest_${pid}_${Date.now()}`,
      isolatedContext: true,
    });
    const run = await track(agentRuntime.execute(handle));
    if (run.status === "completed")
      patients.markProcessed(
        pid,
        run.runId,
        trimmed.map((message) => message.id),
      );
    return run;
  };
  const tasks = new Set();
  const allowedOrigins = new Set(
    options.allowedOrigins ||
      (
        process.env.MEDICAL_ALLOWED_ORIGINS ||
        "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:5174,http://localhost:5174"
      ).split(","),
  );
  const track = (promise) => {
    tasks.add(promise);
    promise.then(
      () => tasks.delete(promise),
      () => tasks.delete(promise),
    );
    return promise;
  };
  function guard(req, tokenRequired = true, url) {
    let host;
    try {
      host = new URL(`http://${req.headers.host}`).hostname;
    } catch {
      throw new AppError("HOST", "主机无效", 403);
    }
    check(
      ["127.0.0.1", "localhost", "[::1]"].includes(host),
      "HOST",
      "仅支持本地工作台访问",
      403,
    );
    const origin = req.headers.origin;
    check(
      !origin ||
        origin === `http://${req.headers.host}` ||
        allowedOrigins.has(origin),
      "ORIGIN",
      "拒绝跨站访问",
      403,
    );
    check(
      req.headers["sec-fetch-site"] !== "cross-site",
      "ORIGIN",
      "拒绝跨站访问",
      403,
    );
    if (tokenRequired)
      check(
        sameSecret(
          req.headers["x-medical-token"] || url?.searchParams.get("token"),
          secret,
        ),
        "UNAUTHORIZED",
        "本地会话认证失效，请刷新页面",
        401,
      );
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src blob:; media-src 'self' blob:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const path = url.pathname;
      guard(req, false);
      if (path === "/api/agent/health" && req.method === "GET")
        return send(res, 200, {
          ok: true,
          provider: providerConfigured(provider)
            ? provider.provider || "configured"
            : "local",
          model: provider.model,
          engine: "unified-runtime",
          genericWorkspaces: workspaces.domain?.id === "generic",
          modes: [
            {
              id: "standard",
              kind: "model",
              tools: true,
              description: "模型与受控医疗工具",
            },
            {
              id: "minimal",
              kind: "model",
              tools: false,
              description: "仅模型文本，不提供工具",
            },
            {
              id: "creator",
              kind: "model",
              tools: true,
              description: "模型与医疗工作流工具",
            },
            {
              id: "code",
              kind: "local",
              tools: false,
              sandbox: true,
              description: "仅在受控沙箱中运行代码",
            },
          ],
          version: "0.4.0",
          clinicalValidated: false,
        });
      if (path === "/api/skills" && req.method === "GET")
        return send(res, 200, { skills: skills.list() });
      // Message ingest for local CLI bridges: guarded by its own secret, not
      // the browser token, so external tools never need the UI credential.
      if (path === "/api/ingest/messages" && req.method === "POST") {
        check(
          Boolean(ingestSecret),
          "INGEST_DISABLED",
          "未配置 MEDICAL_INGEST_SECRET，消息接入已关闭",
          503,
        );
        check(
          sameSecret(req.headers["x-ingest-secret"] || "", ingestSecret),
          "UNAUTHORIZED",
          "消息接入密钥无效",
          401,
        );
        const b = await body(req);
        return send(res, 201, patients.ingest(b.messages));
      }
      if (path === "/api/bootstrap" && req.method === "GET")
        return send(res, 200, {
          token: secret,
          // 与 server/platform.mjs 的 App Shell 契约一致：本服务是融合
          // 应用，显式声明医疗能力可用（前端 medicalEnabled 优先读
          // capabilities，patientsEnabled 仅为旧客户端兼容回退）。
          capabilities: {
            workspaces: true,
            modelSettings: true,
            medical: true,
          },
          model: provider.model,
          modelConfigured: providerConfigured(provider),
          contextBudget: runtime.maxContextChars,
          maxRounds: runtime.maxRounds,
          thinking: provider.thinking,
          directoryPicker: typeof options.chooseDirectory === "function",
          provider: provider.provider || "deepseek",
          engine: "unified-runtime",
          modes: [
            {
              id: "standard",
              kind: "model",
              tools: true,
              description: "模型与受控医疗工具",
            },
            {
              id: "minimal",
              kind: "model",
              tools: false,
              description: "仅模型文本，不提供工具",
            },
            {
              id: "creator",
              kind: "model",
              tools: true,
              description: "模型与医疗工作流工具",
            },
            {
              id: "code",
              kind: "local",
              tools: false,
              sandbox: true,
              description: "仅在受控沙箱中运行代码",
            },
          ],
          tools: runtime.toolDefinitions.map((t) => t.function.name),
          skills: skills.list(),
          sandbox: runtime.sandbox.status(),
          subagents: Object.entries(MEDICAL_AGENTS).map(([id, agent]) => ({
            id,
            name: agent.name,
            instruction: agent.instruction,
          })),
          scheduler: {
            persistent: true,
            requiresRunningServer: true,
            minimumIntervalMinutes: 1,
          },
          ingestConfigured: Boolean(ingestSecret),
          patientsEnabled: true,
          doctorMemory: runtime.doctor.counts(),
          literature: { enabled: true, sources: ["pubmed", "europepmc"] },
          knowledge: {
            enabled: true,
            count: guidelines.list().length,
            rag: await guidelines.ragStatus(),
          },
          materials: {
            enabled: true,
            semantic: embedder.available(),
          },
          riskAlerts: risks.counts(),
          medSafety: { enabled: true },
          scales: { enabled: true, count: listScales().length },
          labKnowledge: { enabled: true, count: "常见指标内置" },
          drg: { enabled: true, ...drg.settings() },
          cases: cases.counts(),
          wechat: { enabled: wechat.enabled },
        });
      if (path.startsWith("/api/")) guard(req, true);
      // 医疗领域能力按需启用（W6）：普通项目默认通用工具面；以下显式
      // 入口打开医疗叠层。会话型工作区（首页/患者会话）始终医疗，不经
      // 此路径。这两个入口属于医疗应用组合根，通用平台服务不感知。
      {
        const domainParts = path.split("/").filter(Boolean);
        // capability-snapshot 由 workspaceApi 的共用 action 提供（B1：
        // 医疗入口与通用平台同一实现），此处只保留医疗叠层切换入口。
        if (
          domainParts[0] === "api" &&
          domainParts[1] === "workspaces" &&
          domainParts.length === 4 &&
          domainParts[3] === "domain" &&
          req.method === "POST"
        ) {
          const id = identifier(domainParts[2]);
          const b = await body(req);
          check(
            typeof b.enabled === "boolean",
            "INVALID_INPUT",
            "enabled 必须为布尔值",
          );
          const current = workspaces.get(id);
          check(
            current.kind !== "session",
            "SESSION_DOMAIN",
            "会话型工作区的医疗能力由会话本身决定，不能切换",
            409,
          );
          check(
            Number.isSafeInteger(b.revision) && b.revision === current.revision,
            "REVISION_CONFLICT",
            "工作区已变化，请刷新",
            409,
          );
          return send(
            res,
            200,
            workspaces.setModeFlag(id, "medical", b.enabled),
          );
        }
        if (path === "/api/workspaces" && req.method === "POST") {
          const b = await body(req);
          check(
            b.domain === undefined || b.domain === "medical",
            "INVALID_INPUT",
            "未知的工作领域",
          );
          const created = workspaces.create(b);
          // 创建时明确选择医疗场景：落到工作区 modeFlags.medical 开关，
          // 与运行时切换共用同一持久化字段与审计语义。
          if (b.domain === "medical" || b.medical === true)
            return send(
              res,
              201,
              workspaces.setModeFlag(created.id, "medical", true),
            );
          return send(res, 201, created);
        }
      }
      if (
        await workspaceApi({
          service: workspaces,
          path,
          req,
          res,
          url,
          body,
          send,
          track,
        })
      )
        return;
      if (path === "/api/sessions" && req.method === "GET")
        return send(res, 200, { sessions: sessionBridge.list() });
      if (path === "/api/sessions" && req.method === "POST") {
        const b = await body(req);
        // 显式 id 仅用于既有测试/迁移场景（旧引擎）；首页新建会话统一
        // 落在内核 kind:"session" 工作区上。
        if (b.id)
          return send(
            res,
            201,
            publicSession(
              store.create({
                id: identifier(b.id),
                title: b.title ? string(b.title, "标题", 100) : undefined,
              }),
            ),
          );
        return send(res, 201, sessionBridge.createSession(b));
      }
      const parts = path.split("/").filter(Boolean);
      if (parts[0] === "api" && parts[1] === "sessions" && parts[2]) {
        const id = identifier(parts[2]);
        if (sessionBridge.isSessionWorkspace(id)) {
          if (parts[3] === "schedules") {
            if (parts.length === 4 && req.method === "GET")
              return send(res, 200, { jobs: scheduler.list(id) });
            if (parts.length === 4 && req.method === "POST")
              return send(res, 201, scheduler.create(id, await body(req)));
            if (parts.length === 5) {
              const job = scheduler.get(parts[4]);
              check(
                job.sessionId === id,
                "NOT_FOUND",
                "计划不属于当前会话",
                404,
              );
              if (req.method === "PATCH")
                return send(
                  res,
                  200,
                  scheduler.update(job.id, await body(req)),
                );
              if (req.method === "DELETE") {
                scheduler.delete(job.id, (await body(req)).revision);
                return send(res, 200, { ok: true });
              }
            }
          }
          if (parts.length === 3) {
            if (req.method === "GET")
              return send(res, 200, sessionBridge.get(id));
            if (req.method === "PATCH") {
              const b = await body(req);
              sessionBridge.renameSession(id, b.title);
              return send(res, 200, sessionBridge.get(id));
            }
            if (req.method === "DELETE") {
              const projected = sessionBridge.get(id);
              check(
                !projected.patientId,
                "PATIENT_SESSION",
                "此会话是患者病例工作区，请在患者管理中删除患者档案",
                409,
              );
              for (const file of projected.files)
                materials.remove(file.id).catch(() => {});
              sessionBridge.removeSession(id);
              return send(res, 200, { ok: true });
            }
          }
          if (
            parts.length === 4 &&
            ["copy-materials", "fork"].includes(parts[3]) &&
            req.method === "POST"
          ) {
            const forkBody = await body(req);
            if (parts[3] === "fork") forkBody.fork = true;
            return send(res, 201, sessionBridge.copyMaterials(id, forkBody));
          }
          if (parts[3] === "files") {
            if (parts.length === 4 && req.method === "POST") {
              const file = sessionBridge.addMaterial(id, await body(req));
              return send(res, 201, file);
            }
            if (parts.length === 5 && req.method === "DELETE") {
              const projected = sessionBridge.get(id);
              check(
                !projected.runs.some(
                  (r) =>
                    r.status === "running" || r.fileIds?.includes(parts[4]),
                ),
                "SOURCE_IN_USE",
                "此材料已被执行记录引用。可取消勾选以排除后续任务；如需清除全部资料，请删除会话。",
                409,
              );
              check(
                projected.files.some((f) => f.id === parts[4]),
                "NOT_FOUND",
                "材料不存在",
                404,
              );
              materials.remove(parts[4]).catch(() => {});
              sessionBridge.removeMaterial(id, parts[4]);
              store.audit(id, "file.deleted", { fileId: parts[4] });
              return send(res, 200, { ok: true });
            }
          }
          if (parts[3] === "search" && req.method === "GET")
            return send(
              res,
              200,
              await sessionBridge.searchMaterials(
                id,
                string(url.searchParams.get("q"), "检索词", 200),
              ),
            );
          if (parts[3] === "audit" && req.method === "GET")
            return send(res, 200, { events: store.auditLog(id) });
          if (parts[3] === "events" && req.method === "GET")
            return send(res, 200, {
              events: sessionBridge.workspaceEvents(id, {
                after: Number(url.searchParams.get("after") || 0),
                limit: Number(url.searchParams.get("limit") || 1000),
              }),
            });
          if (parts[3] === "export" && req.method === "GET") {
            const projected = sessionBridge.get(id);
            if (url.searchParams.get("format") === "json")
              return send(res, 200, projected);
            res.writeHead(200, {
              "Content-Type": "text/markdown; charset=utf-8",
              "Cache-Control": "no-store",
            });
            res.end(exportMarkdown(projected));
            return;
          }
          if (parts[3] === "artifacts" && parts[4]) {
            if (parts[5] === "review" && req.method === "POST")
              return send(
                res,
                200,
                sessionBridge.reviewArtifact(
                  id,
                  identifier(parts[4]),
                  await body(req),
                ),
              );
            if (parts.length === 5 && req.method === "PATCH")
              return send(
                res,
                200,
                sessionBridge.editArtifact(
                  id,
                  identifier(parts[4]),
                  await body(req),
                ),
              );
          }
          return send(res, 404, { error: "会话资源不存在", code: "NOT_FOUND" });
        }
        const session = store.get(id);
        if (parts[3] === "schedules") {
          if (parts.length === 4 && req.method === "GET")
            return send(res, 200, { jobs: scheduler.list(id) });
          if (parts.length === 4 && req.method === "POST")
            return send(res, 201, scheduler.create(id, await body(req)));
          if (parts.length === 5) {
            const job = scheduler.get(parts[4]);
            check(job.sessionId === id, "NOT_FOUND", "计划不属于当前会话", 404);
            if (req.method === "PATCH")
              return send(res, 200, scheduler.update(job.id, await body(req)));
            if (req.method === "DELETE") {
              scheduler.delete(job.id, (await body(req)).revision);
              return send(res, 200, { ok: true });
            }
          }
        }
        if (parts.length === 3) {
          if (req.method === "GET")
            return send(res, 200, publicSession(session));
          if (req.method === "PATCH") {
            const b = await body(req);
            return send(
              res,
              200,
              publicSession(
                store.mutate(id, (s) => {
                  s.title = string(b.title, "标题", 100);
                }),
              ),
            );
          }
          if (req.method === "DELETE") {
            check(
              !runtime.active.has(id),
              "RUN_ACTIVE",
              "请先停止执行再删除会话",
              409,
            );
            check(
              !session.patientId,
              "PATIENT_SESSION",
              "此会话是患者病例工作区，请在患者管理中删除患者档案",
              409,
            );
            for (const file of session.files)
              materials.remove(file.id).catch(() => {});
            store.delete(id);
            return send(res, 200, { ok: true });
          }
        }
        if (
          parts.length === 4 &&
          ["copy-materials", "fork"].includes(parts[3]) &&
          req.method === "POST"
        ) {
          const forkBody = await body(req);
          if (parts[3] === "fork") {
            forkBody.sessionRevision ??= session.revision;
            forkBody.fileIds ??= session.files.map((file) => file.id);
          }
          return send(res, 201, runtime.copyMaterials(id, forkBody));
        }
        if (parts[3] === "files") {
          if (parts.length === 4 && req.method === "POST") {
            const file = runtime.addFile(id, await body(req));
            // Index for semantic retrieval in the background; keyword search
            // works immediately either way.
            materials.ingest(file).catch(() => {});
            return send(res, 201, file);
          }
          if (parts.length === 5 && req.method === "DELETE") {
            check(
              !runtime.active.has(id),
              "RUN_ACTIVE",
              "执行期间不能删除材料",
              409,
            );
            check(
              session.files.some((f) => f.id === parts[4]),
              "NOT_FOUND",
              "材料不存在",
              404,
            );
            check(
              !session.runs.some((r) => r.fileIds?.includes(parts[4])),
              "SOURCE_IN_USE",
              "此材料已被执行记录引用。可取消勾选以排除后续任务；如需清除全部资料，请删除会话。",
              409,
            );
            materials.remove(parts[4]).catch(() => {});
            store.mutate(id, (s) => {
              s.files = s.files.filter((f) => f.id !== parts[4]);
            });
            store.audit(id, "file.deleted", { fileId: parts[4] });
            return send(res, 200, { ok: true });
          }
        }
        if (parts[3] === "search" && req.method === "GET")
          return send(
            res,
            200,
            await runTool(
              "search_materials",
              { query: string(url.searchParams.get("q"), "检索词", 200) },
              { sources: session.files },
            ),
          );
        if (parts[3] === "audit" && req.method === "GET")
          return send(res, 200, { events: store.auditLog(id) });
        if (parts[3] === "events" && req.method === "GET")
          return send(res, 200, {
            events: store.eventLog(id, {
              after: Number(url.searchParams.get("after") || 0),
              limit: Number(url.searchParams.get("limit") || 1000),
            }),
          });
        if (parts[3] === "export" && req.method === "GET") {
          if (url.searchParams.get("format") === "json")
            return send(res, 200, publicSession(session));
          res.writeHead(200, {
            "Content-Type": "text/markdown; charset=utf-8",
            "Cache-Control": "no-store",
          });
          res.end(exportMarkdown(session));
          return;
        }
        if (parts[3] === "artifacts" && parts[4]) {
          if (parts[5] === "review" && req.method === "POST")
            return send(
              res,
              200,
              runtime.review(id, identifier(parts[4]), await body(req)),
            );
          if (parts.length === 5 && req.method === "PATCH")
            return send(
              res,
              200,
              runtime.editArtifact(id, identifier(parts[4]), await body(req)),
            );
        }
      }
      if (path === "/api/wechat/status" && req.method === "GET")
        return send(res, 200, wechat.status());
      if (path === "/api/wechat/read" && req.method === "POST") {
        const b = await body(req);
        return send(
          res,
          200,
          await wechat.readFrontChat(identifier(b.patientId)),
        );
      }
      if (path === "/api/wechat/send" && req.method === "POST") {
        const b = await body(req);
        return send(
          res,
          200,
          await wechat.send(identifier(b.patientId), b.text),
        );
      }
      if (path === "/api/doctor/overview" && req.method === "GET")
        return send(res, 200, doctorOverview.read({
          kind: url.searchParams.get("kind") || "all", query: url.searchParams.get("q") || "",
          offset: Number(url.searchParams.get("offset") || 0), limit: Number(url.searchParams.get("limit") || 12),
        }));
      if (path === "/api/followup-plans" && req.method === "GET")
        return send(res, 200, { plans: followups.listPlans() });
      if (path === "/api/followup-plans" && req.method === "POST")
        return send(res, 201, followups.createPlan(await body(req)));
      if (
        parts[0] === "api" &&
        parts[1] === "followup-plans" &&
        parts.length === 3 &&
        req.method === "DELETE"
      )
        return send(res, 200, followups.removePlan(parts[2]));
      if (
        parts[0] === "api" &&
        parts[1] === "followups" &&
        parts[2] === "overview" &&
        req.method === "GET"
      )
        return send(res, 200, {
          jobs: followups.overview({
            limit: url.searchParams.get("limit")
              ? Number(url.searchParams.get("limit"))
              : undefined,
          }),
        });
      if (path === "/api/risk-alerts" && req.method === "GET")
        return send(res, 200, {
          alerts: risks.list({
            patientId: url.searchParams.get("patientId") || undefined,
            status: url.searchParams.get("status") || undefined,
          }),
          counts: risks.counts(),
        });
      if (path === "/api/risk-alerts/evaluate" && req.method === "POST")
        return send(res, 200, risks.evaluateAll());
      if (
        parts[0] === "api" &&
        parts[1] === "risk-alerts" &&
        parts.length === 4 &&
        ["ack", "resolve", "reopen"].includes(parts[3]) &&
        req.method === "POST"
      ) {
        const status =
          parts[3] === "ack"
            ? "acknowledged"
            : parts[3] === "resolve"
              ? "resolved"
              : "active";
        return send(res, 200, risks.setStatus(parts[2], status));
      }
      if (path === "/api/cases" && req.method === "GET")
        return send(
          res,
          200,
          cases.list({
            query: url.searchParams.get("query") || undefined,
            diagnosis: url.searchParams.get("diagnosis") || undefined,
            limit: url.searchParams.get("limit")
              ? Number(url.searchParams.get("limit"))
              : undefined,
          }),
        );
      if (path === "/api/cases" && req.method === "POST") {
        const b = await body(req);
        if (b.patientId && !b.diagnosis) {
          const patient = patients.get(identifier(b.patientId));
          return send(res, 201, cases.fromPatient(patient, b));
        }
        return send(res, 201, cases.addCase(b));
      }
      if (path === "/api/med-safety" && req.method === "POST")
        return send(res, 200, medicationSafetyCheck(await body(req)));
      if (path === "/api/adr-assess" && req.method === "POST")
        return send(res, 200, assessAdverseReaction(await body(req)));
      if (path === "/api/pending-actions" && req.method === "GET")
        return send(res, 200, {
          actions: pending.list({
            patientId: url.searchParams.get("patientId") || undefined,
            status: url.searchParams.get("status") || undefined,
          }),
          counts: pending.counts({
            patientId: url.searchParams.get("patientId") || undefined,
          }),
        });
      if (
        parts[0] === "api" &&
        parts[1] === "pending-actions" &&
        parts.length === 4 &&
        ["confirm", "reject"].includes(parts[3]) &&
        req.method === "POST"
      )
        return send(
          res,
          200,
          parts[3] === "confirm"
            ? pending.confirm(parts[2])
            : pending.reject(parts[2]),
        );
      if (path === "/api/med-cautions" && req.method === "POST")
        return send(res, 200, specialPopulationCautions(await body(req)));
      if (path === "/api/model-settings") {
        if (req.method === "GET") return send(res, 200, models.public());
        if (req.method === "PUT") {
          const input = await body(req);
          check(
            runtime.active.size === 0 && workspaces.active.size === 0,
            "MODEL_BUSY",
            "有任务正在运行，请等待结束后切换模型",
            409,
          );
          swapProvider(models.save(models.candidate(input)));
          return send(res, 200, models.public());
        }
      }
      if (path === "/api/model-settings/test" && req.method === "POST") {
        const input = await body(req);
        return send(
          res,
          200,
          await track(models.test(models.candidate(input))),
        );
      }
      if (path === "/api/scales" && req.method === "GET")
        return send(res, 200, { scales: listScales() });
      if (
        parts[0] === "api" &&
        parts[1] === "scales" &&
        parts.length === 4 &&
        parts[3] === "calculate" &&
        req.method === "POST"
      ) {
        const b = await body(req);
        return send(res, 200, calculateScale(parts[2], b.answers || {}));
      }
      if (path === "/api/lab-knowledge" && req.method === "GET")
        return send(
          res,
          200,
          searchLabKnowledge({
            query: url.searchParams.get("q") || undefined,
            limit: url.searchParams.get("limit")
              ? Number(url.searchParams.get("limit"))
              : undefined,
          }),
        );
      if (path === "/api/icd9" && req.method === "GET")
        return send(res, 200, {
          codes: searchIcd9(url.searchParams.get("q"), {
            limit: url.searchParams.get("limit")
              ? Number(url.searchParams.get("limit"))
              : undefined,
          }),
        });
      if (parts[0] === "api" && parts[1] === "drg") {
        await drg.load();
        if (parts[2] === "group" && req.method === "POST")
          return send(res, 200, await drg.group(await body(req)));
        if (parts[2] === "batch" && req.method === "POST")
          return send(res, 200, await drg.batchAnalyze(await body(req)));
        if (parts[2] === "settings") {
          if (req.method === "GET") return send(res, 200, drg.settings());
          if (req.method === "POST")
            return send(res, 200, drg.updateSettings(await body(req)));
        }
        if (parts[2] === "import" && req.method === "POST")
          return send(res, 200, drg.importWeights((await body(req)).weights));
      }
      if (
        parts[0] === "api" &&
        parts[1] === "research" &&
        req.method === "POST"
      ) {
        const b = await body(req);
        const researchSessionId = b.sessionId ? identifier(b.sessionId) : null;
        const sources = researchSessionId
          ? sessionBridge.isSessionWorkspace(researchSessionId)
            ? (sessionBridge.materialsOf(researchSessionId) || []).map(
                ({ id: fid, name, text, hash, extraction }) => ({
                  id: fid,
                  name,
                  text,
                  hash,
                  extraction,
                }),
              )
            : store.get(researchSessionId).files
          : [];
        if (parts[2] === "profile")
          return send(res, 200, research.profile({ ...b, sources }));
        if (parts[2] === "test")
          return send(res, 200, research.test({ ...b, sources }));
        if (parts[2] === "sample-size")
          return send(res, 200, research.sampleSize(b));
        if (parts[2] === "deidentify")
          return send(res, 200, research.deidentify({ ...b, sources }));
      }
      if (
        parts[0] === "api" &&
        parts[1] === "cases" &&
        parts[2] === "similar" &&
        req.method === "POST"
      )
        return send(res, 200, cases.similar(await body(req)));
      if (parts[0] === "api" && parts[1] === "cases" && parts.length === 3) {
        if (req.method === "GET") return send(res, 200, cases.get(parts[2]));
        if (req.method === "DELETE")
          return send(res, 200, cases.removeCase(parts[2]));
      }
      if (path === "/api/icd10" && req.method === "GET")
        return send(res, 200, {
          codes: searchIcd10(url.searchParams.get("q"), {
            limit: url.searchParams.get("limit")
              ? Number(url.searchParams.get("limit"))
              : undefined,
          }),
        });
      if (path === "/api/patients/import/preview" && req.method === "POST") return send(res, 200, patientImporter.preview((await body(req)).text));
      if (path === "/api/patients/import/commit" && req.method === "POST") return send(res, 201, patientImporter.commit(await body(req)));
      if (path === "/api/patients" && req.method === "GET")
        return send(res, 200, {
          patients: patients.list({
            query: url.searchParams.get("q") || undefined,
            group: url.searchParams.get("group") || undefined,
            includeArchived: url.searchParams.get("archived") === "1",
            summary: url.searchParams.get("summary") === "1",
          }),
        });
      if (path === "/api/patients" && req.method === "POST") {
        const patient = patients.create(await body(req));
        risks.evaluatePatient(patient.id);
        return send(res, 201, patient);
      }
      if (path === "/api/inbox" && req.method === "GET")
        return send(res, 200, { messages: patients.unassigned() });
      if (
        parts[0] === "api" &&
        parts[1] === "inbox" &&
        parts[3] === "assign" &&
        req.method === "POST"
      ) {
        const b = await body(req);
        return send(
          res,
          200,
          patients.assign(identifier(parts[2]), identifier(b.patientId)),
        );
      }
      if (path === "/api/reminders" && req.method === "GET")
        return send(res, 200, followups.reminderPage({
            status: url.searchParams.get("status") || "pending",
            patientId: url.searchParams.get("patientId") || undefined,
            offset: Number(url.searchParams.get("offset") || 0),
            limit: Number(url.searchParams.get("limit") || 100),
          }));
      if (parts[0] === "api" && parts[1] === "reminders" && parts.length === 4 && parts[3] === "addendum" && req.method === "POST")
        return send(res, 200, followups.addContactAddendum(identifier(parts[2]), await body(req)));
      if (
        parts[0] === "api" &&
        parts[1] === "reminders" &&
        parts.length === 4 &&
        parts[3] === "complete" &&
        req.method === "POST"
      ) {
        const reminder = followups.completeReminder(
          identifier(parts[2]),
          await body(req),
        );
        risks.evaluatePatient(reminder.patientId);
        return send(res, 200, reminder);
      }
      if (
        parts[0] === "api" &&
        parts[1] === "reminders" &&
        parts[3] === "ack" &&
        req.method === "POST"
      )
        return send(res, 200, followups.ackReminder(identifier(parts[2])));
      if (parts[0] === "api" && parts[1] === "patients" && parts[2]) {
        const pid = identifier(parts[2]);
        if (parts[3] === "care-tasks") {
          if (parts.length === 4 && req.method === "GET") return send(res, 200, careTasks.list(pid, {
            status: url.searchParams.get("status") || "active", offset: Number(url.searchParams.get("offset") || 0), limit: Number(url.searchParams.get("limit") || 20),
          }));
          if (parts.length === 4 && req.method === "POST") return send(res, 201, careTasks.create(pid, await body(req)));
          if (parts.length === 5 && req.method === "PATCH") return send(res, 200, careTasks.update(pid, identifier(parts[4]), await body(req)));
        }
        if (parts.length === 4 && parts[3] === "brief" && req.method === "GET")
          return send(res, 200, patientBrief.read(pid));
        if (parts.length === 4 && parts[3] === "followup-records" && req.method === "POST") {
          const record = followups.recordContact(pid, await body(req));
          risks.evaluatePatient(pid);
          return send(res, 201, record);
        }
        if (parts[3] === "export" && req.method === "GET")
          return send(res, 200, patients.exportDeidentified(pid));
        if (parts.length === 3) {
          if (req.method === "GET") return send(res, 200, patients.get(pid));
          if (req.method === "PATCH") {
            const updated = patients.update(pid, await body(req));
            risks.evaluatePatient(pid);
            return send(res, 200, updated);
          }
          if (req.method === "DELETE") {
            patients.remove(pid);
            return send(res, 200, { ok: true });
          }
        }
        if (parts[3] === "messages") {
          if (parts.length === 4 && req.method === "GET")
            return send(res, 200, {
              messages: patients.messages(pid, {
                unprocessedOnly: url.searchParams.get("unprocessed") === "1",
                limit: Number(url.searchParams.get("limit") || 200),
              }),
            });
          if (parts.length === 4 && req.method === "POST")
            return send(
              res,
              201,
              patients.ingest((await body(req)).messages, {
                fallbackChannel: "manual",
                patientId: pid,
              }),
            );
          if (parts[4] === "digest" && req.method === "POST")
            return send(res, 200, await digestMessages(pid, await body(req)));
        }
        if (parts[3] === "followups") {
          if (parts.length === 4 && req.method === "GET")
            return send(res, 200, { jobs: followups.list(pid) });
          if (parts.length === 4 && req.method === "POST")
            return send(res, 201, followups.create(pid, await body(req)));
          if (
            parts.length === 5 &&
            parts[4] === "apply" &&
            req.method === "POST"
          )
            return send(
              res,
              201,
              followups.applyTemplate(pid, await body(req)),
            );
          if (parts.length === 5) {
            const job = followups.row(parts[4]);
            check(
              job.patientId === pid,
              "NOT_FOUND",
              "随访计划不属于当前患者",
              404,
            );
            if (req.method === "PATCH")
              return send(res, 200, followups.update(job.id, await body(req)));
            if (req.method === "DELETE") {
              followups.remove(job.id, (await body(req)).revision);
              return send(res, 200, { ok: true });
            }
          }
        }
      }
      if (parts[0] === "api" && parts[1] === "literature") {
        const numberParam = (key) => {
          const raw = url.searchParams.get(key);
          return raw === null || raw === "" ? undefined : Number(raw);
        };
        if (parts[2] === "search" && req.method === "GET")
          return send(
            res,
            200,
            await literature.search({
              query: url.searchParams.get("query") || undefined,
              source: url.searchParams.get("source") || undefined,
              yearFrom: numberParam("yearFrom"),
              yearTo: numberParam("yearTo"),
              limit: numberParam("limit"),
              sort: url.searchParams.get("sort") || undefined,
            }),
          );
        if (parts[2] === "article" && req.method === "GET")
          return send(
            res,
            200,
            await literature.fetchArticle({
              pmid: url.searchParams.get("pmid") || undefined,
              doi: url.searchParams.get("doi") || undefined,
            }),
          );
        if (parts[2] === "import" && req.method === "POST") {
          const b = await body(req);
          const article = await literature.fetchArticle({
            pmid: b.pmid,
            doi: b.doi,
          });
          const name = article.pmid
            ? `PMID-${article.pmid}.md`
            : `DOI-${String(article.doi)
                .replace(/[^A-Za-z0-9.-]/g, "_")
                .slice(0, 80)}.md`;
          const sessionId = identifier(b.sessionId);
          const materialInput = {
            name,
            text: literature.materialText(article),
          };
          const file = sessionBridge.isSessionWorkspace(sessionId)
            ? sessionBridge.addMaterial(sessionId, materialInput)
            : runtime.addFile(sessionId, materialInput);
          return send(res, 201, { file, article });
        }
      }
      const knowledgeRoutes =
        parts[0] === "api" &&
        (parts[1] === "knowledge" || parts[1] === "guidelines");
      if (knowledgeRoutes) {
        const sub = parts.slice(2);
        if (sub.length === 0 && req.method === "GET")
          return send(res, 200, { documents: guidelines.list({
            kind: url.searchParams.get("kind") || undefined,
            collection: url.searchParams.get("collection") || undefined,
            reviewStatus: url.searchParams.get("reviewStatus") || undefined,
            query: url.searchParams.get("q") || "",
          }) });
        if (sub.length === 0 && req.method === "POST")
          return send(res, 201, await guidelines.addDocument(await body(req)));
        if (sub[0] === "search" && req.method === "GET") {
          const yearRaw = url.searchParams.get("year");
          return send(
            res,
            200,
            await guidelines.search({
              query: url.searchParams.get("q") || undefined,
              kind: url.searchParams.get("kind") || undefined,
              collection: url.searchParams.get("collection") || undefined,
              org: url.searchParams.get("org") || undefined,
              reviewStatus: url.searchParams.get("reviewStatus") || undefined,
              year: yearRaw ? Number(yearRaw) : undefined,
              limit: url.searchParams.get("limit")
                ? Number(url.searchParams.get("limit"))
                : undefined,
            }),
          );
        }
        if (sub[0] === "reindex" && req.method === "POST")
          return send(res, 200, await guidelines.reindex());
        if (sub.length === 1 && sub[0] !== "search") {
          if (req.method === "GET")
            return send(res, 200, guidelines.get(sub[0]));
          if (req.method === "PATCH")
            return send(res, 200, guidelines.updateMetadata(sub[0], await body(req)));
          if (req.method === "DELETE")
            return send(res, 200, guidelines.removeDocument(sub[0]));
        }
      }
      if (parts[0] === "api" && parts[1] === "doctor") {
        if (parts[2] === "profile" && parts.length === 3) {
          if (req.method === "GET") return send(res, 200, runtime.doctor.get());
          if (req.method === "PATCH")
            return send(res, 200, runtime.doctor.update(await body(req)));
        }
        if (parts[2] === "memories") {
          if (parts.length === 3 && req.method === "GET")
            return send(res, 200, {
              memories: runtime.doctor.memories({
                status: url.searchParams.get("status") || undefined,
                kind: url.searchParams.get("kind") || undefined,
              }),
            });
          if (parts.length === 3 && req.method === "POST") {
            const b = await body(req);
            return send(
              res,
              201,
              runtime.doctor.addMemory({ ...b, kind: "explicit" }),
            );
          }
          if (parts.length === 4 && req.method === "DELETE") {
            const id = Number(parts[3]);
            return send(res, 200, runtime.doctor.deleteMemory(id));
          }
          if (parts.length === 5) {
            const id = Number(parts[3]);
            if (req.method === "POST" && parts[4] === "confirm")
              return send(res, 200, runtime.doctor.confirmMemory(id));
            if (req.method === "POST" && parts[4] === "dismiss")
              return send(res, 200, runtime.doctor.dismissMemory(id));
            if (req.method === "POST" && parts[4] === "pin")
              return send(
                res,
                200,
                runtime.doctor.pinMemory(id, (await body(req)).pinned === true),
              );
          }
        }
        if (parts[2] === "consolidate" && req.method === "POST") {
          if (parts.length === 3)
            return send(res, 200, runtime.doctor.consolidate());
          if (parts[3] === "model") {
            const b = await body(req);
            return send(
              res,
              200,
              await runtime.doctor.modelConsolidate(runtime.provider, {
                consent: b.externalConsent === true,
                model: b.model,
              }),
            );
          }
        }
      }
      const match = path.match(/^\/api\/chat\/([A-Za-z0-9_-]+)(\/cancel)?$/);
      if (match && req.method === "POST") {
        const id = identifier(match[1]);
        if (!sessionBridge.isSessionWorkspace(id)) store.get(id);
        if (match[2])
          return send(res, 200, { cancelled: sessionBridge.cancel(id) });
        const prepared = sessionBridge.prepareSend(id, await body(req));
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        let disconnected = false;
        const close = () => {
          if (!res.writableEnded) {
            disconnected = true;
            sessionBridge.cancel(id);
          }
        };
        res.on("close", close);
        const heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(": heartbeat\n\n");
        }, 15000);
        try {
          await track(
            sessionBridge.executeSend(prepared, (event) => {
              if (!disconnected) {
                res.write(
                  `id: ${event.seq}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`,
                );
                if (res.writableLength > 2 * 1024 * 1024)
                  sessionBridge.cancel(id);
              }
            }),
          );
        } finally {
          clearInterval(heartbeat);
          res.removeListener("close", close);
          res.end();
        }
        return;
      }
      // Legacy callers must use the same policy, consent and session boundaries.
      if (path === "/api/agent/run" && req.method === "POST") {
        const b = await body(req);
        const sessionId = identifier(b.sessionId);
        const prepared = sessionBridge.prepareSend(sessionId, b);
        const result = await track(sessionBridge.executeSend(prepared));
        return send(res, result.status === "completed" ? 200 : 422, result);
      }
      if (path.startsWith("/api/"))
        throw new AppError("NOT_FOUND", "接口不存在", 404);
      check(req.method === "GET", "NOT_FOUND", "页面不存在", 404);
      const dist = resolve(ROOT, "../dist");
      let target = resolve(dist, `.${path}`);
      check(
        target === dist || target.startsWith(dist + sep),
        "PATH",
        "路径无效",
        403,
      );
      if (!extname(target)) target = resolve(dist, "index.html");
      try {
        const info = await stat(target);
        check(info.isFile(), "NOT_FOUND", "页面不存在", 404);
        const content = await readFile(target);
        res.writeHead(200, {
          "Content-Type": mime[extname(target)] || "application/octet-stream",
        });
        res.end(content);
      } catch (e) {
        if (e.code === "ENOENT")
          throw new AppError("NOT_BUILT", "请先运行 npm run build", 404);
        throw e;
      }
    } catch (error) {
      if (!res.headersSent) errorResponse(res, error);
      else res.end();
    }
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
  });
  server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      check(url.pathname === "/api/ws", "NOT_FOUND", "网关不存在", 404);
      guard(req, true, url);
    } catch {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      const owned = new Set();
      const write = (data) => {
        if (ws.readyState === 1) ws.send(JSON.stringify(data));
      };
      write({
        jsonrpc: "2.0",
        method: "event",
        params: {
          type: "gateway.ready",
          payload: { engine: "unified-runtime", version: "0.4.0" },
        },
      });
      ws.on("close", () => {
        for (const id of owned) sessionBridge.cancel(id);
      });
      ws.on("message", (raw) => {
        track(
          (async () => {
            let rpc;
            try {
              rpc = JSON.parse(raw.toString());
              check(
                rpc.jsonrpc === "2.0" &&
                  (typeof rpc.id === "string" || typeof rpc.id === "number"),
                "INVALID_RPC",
                "JSON-RPC 请求格式无效",
              );
              const p = rpc.params || {};
              const reply = (result) =>
                write({ jsonrpc: "2.0", id: rpc.id, result });
              if (rpc.method === "session.create")
                return reply({
                  session_id: p.id
                    ? store.create({
                        id: identifier(p.id),
                        title: p.title
                          ? string(p.title, "标题", 100)
                          : undefined,
                      }).id
                    : sessionBridge.createSession(p).id,
                });
              if (rpc.method === "session.get")
                return reply(sessionBridge.get(identifier(p.session_id)));
              if (rpc.method === "prompt.cancel")
                return reply({
                  cancelled: sessionBridge.cancel(identifier(p.session_id)),
                });
              if (rpc.method === "prompt.submit") {
                const id = identifier(p.session_id);
                const prepared = sessionBridge.prepareSend(id, {
                  ...p,
                  message: p.text,
                });
                owned.add(id);
                reply({
                  status: "streaming",
                  run_id: prepared.handle?.run?.id,
                });
                try {
                  await sessionBridge.executeSend(prepared, (event) =>
                    write({ jsonrpc: "2.0", method: "event", params: event }),
                  );
                } finally {
                  owned.delete(id);
                }
                return;
              }
              throw new AppError("METHOD_NOT_FOUND", "未实现的网关方法", 404);
            } catch (error) {
              write({
                jsonrpc: "2.0",
                id: rpc?.id ?? null,
                error: {
                  code: -32602,
                  message:
                    error instanceof AppError ? error.message : "无效请求",
                },
              });
            }
          })(),
        );
      });
    });
  });
  server.store = store;
  server.runtime = runtime;
  // 供测试与诊断日志直接调用；HTTP 入口为
  // GET /api/workspaces/:id/capability-snapshot。
  server.capabilitySnapshot = capabilitySnapshot;
  server.sessionBridge = sessionBridge;
  server.workspaces = workspaces;
  server.materials = materials;
  server.token = secret;
  server.scheduler = scheduler;
  server.patients = patients;
  server.followups = followups;
  server.doctor = runtime.doctor;
  server.literature = literature;
  server.guidelines = guidelines;
  server.risks = risks;
  server.drg = drg;
  server.cases = cases;
  server.wechat = wechat;
  server.once("listening", () => {
    scheduler.start();
    workspaces.scheduler.start();
    workspaces.recovery.start();
    followups.start();
  });
  server.shutdown = async () => {
    workspaces.stopping = true;
    scheduler.stop();
    workspaces.scheduler.stop();
    workspaces.recovery.stop();
    followups.stop();
    for (const id of workspaces.active.keys()) workspaces.interrupt(id);
    for (const id of runtime.active.keys()) runtime.cancel(id);
    for (const id of workspaces.active.keys())
      if (sessionBridge.isSessionWorkspace(id)) workspaces.cancel(id);
    for (const ws of sockets.clients) ws.terminate();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await Promise.allSettled([...tasks]);
    await scheduler.drain();
    await workspaces.scheduler.drain();
    await workspaces.recovery.drain();
    await workspaces.extensions.close();
    if (databasePath === ":memory:")
      rmSync(vectorDir, { recursive: true, force: true });
    await followups.drain();
    sockets.close();
    store.close();
  };
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.loadEnvFile(resolve(ROOT, "../.env"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  // 本地单机工作台：单次任务的意外 rejection 记录后继续服务，
  // 不让整个进程（及其余会话）随之退出。
  process.on("unhandledRejection", (reason) => {
    const message =
      reason instanceof Error
        ? `${reason.message}\n${reason.stack}`
        : String(reason);
    console.error(`[unhandledRejection] ${message}`);
  });
  process.on("uncaughtException", (error) => {
    console.error(`[uncaughtException] ${error?.stack || error}`);
  });
  const server = createServer();
  const port = Number(process.env.PORT || 8787);
  server.listen(port, "127.0.0.1", () =>
    console.log(`Medical workbench: http://127.0.0.1:${port}`),
  );
  const stop = () => server.shutdown().then(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
