import { ChatFollowups } from "./chat-followups.mjs";
import { WecomAibotChannel, chatAibotApi } from "./chat-aibot.mjs";
import { chatFollowupsApi } from "./chat-followups-api.mjs";
import { WechatAutoFollow } from "./chat-autofollow.mjs";
import { chatAutoFollowApi } from "./chat-autofollow-api.mjs";
import { KnowledgeOrganizer } from "./medical/knowledge-organizer.mjs";
import { ModelProfiles } from "./core/model-profiles.mjs";
import { createReadStream } from "node:fs";
import {TrialEligibilityJobs} from './medical/trial-eligibility-jobs.mjs';
import { recognizeImage } from "./core/image-ocr.mjs";
import { TrialRegistry } from "./medical/trial-registry.mjs";
import { TrialScreening } from "./medical/trial-screening.mjs";
import { TrialCandidates } from "./medical/trial-candidates.mjs";
import { IntakeJobs } from "./medical/intake-jobs.mjs";
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
import { FollowUpSurveys } from "./followup-surveys.mjs";
import { WeComConnector } from "./wecom.mjs";
import { CareEngine } from "./care/engine.mjs";
import { careTools } from "./care/tools.mjs";
import { trialTools } from "./medical/trial-tools.mjs";
import { scheduleTools } from "./medical/schedule-tools.mjs";
import { careApi } from "./care/api.mjs";
import { WeChatMacBridge } from "./wechat-bridge.mjs";
import { DoctorProfile } from "./medical/doctor-profile.mjs";
import { LiteratureService, literatureTools } from "./medical/literature.mjs";
import { GuidelineLibrary, knowledgeTools, EDUCATION_COLLECTION } from "./medical/guidelines.mjs";
import { searchIcd10 } from "./medical/icd10.mjs";
import { PatientBrief } from "./medical/patient-brief.mjs";
import { PatientImporter } from "./medical/patient-import.mjs";
import { CareTasks } from "./medical/care-tasks.mjs";
import { PatientSchedule } from "./medical/patient-schedule.mjs";
import { Extensions } from "./medical/extensions.mjs";
import { extensionTools } from "./medical/extension-tools.mjs";
import { DoctorOverview } from "./medical/doctor-overview.mjs";
import { RiskEngine } from "./medical/risk-rules.mjs";
import { onlineCaseTools } from "./medical/online-cases.mjs";
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
import { JevSettings } from "./core/jev-settings.mjs";
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
  const jev = new JevSettings(models.vault);
  let provider = models.provider();
  // The doctor's own skills (extension center) are materialized here.
  const userSkillsDir = options.userSkillsDir ||
    (databasePath === ":memory:" ? mkdtempSync(join(tmpdir(), "omw-my-skills-")) : join(dirname(databasePath), "my-skills"));
  const skills =
    options.skills ||
    new SkillRegistry([
      resolve(ROOT, "../skills"),
      userSkillsDir,
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
    care: () => care,
    trials: () => trialCandidates,
    extensions: () => extensions,
    copySourceMaterials: (sourceId, targetId, fileIds, sourceInput) => {
      const source = sessionBridge.get(sourceId);
      if (sourceInput) sessionBridge.addMaterial(targetId, { name: "建档时的对话输入.txt", text: sourceInput });
      for (const fileId of fileIds) {
        const file = source.files.find((f) => f.id === fileId);
        check(file, "SOURCE_NOT_FOUND", "建档来源材料已移除，请重新整理", 409);
        sessionBridge.copyMaterial(sourceId, targetId, file);
      }
    },
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
  const knowledgeRoot = databasePath === ":memory:" ? mkdtempSync(join(tmpdir(), "omw-knowledge-")) : join(dirname(databasePath), "knowledge-uploads");
  const knowledgeProfiles = new ModelProfiles(models);
  const knowledgeOrganizer = new KnowledgeOrganizer({
    store, library: guidelines, root: knowledgeRoot, getProvider: () => provider,
    getTranscription: () => knowledgeProfiles.all()["knowledge-transcription"],
    ...options.knowledgeOrganizerOptions,
  });
  guidelines.beforeRemoveCollection = name => knowledgeOrganizer.assertRemovable(name);
  guidelines.beforeMoveDocument = id => knowledgeOrganizer.assertRemovable(null, [id]);
  guidelines.afterMoveDocument = (id,collection) => knowledgeOrganizer.moveDocument(id,collection);
  guidelines.beforeRemoveDocument = id => knowledgeOrganizer.assertRemovable(null, [id]);
  guidelines.afterRemoveDocuments = (ids, name) => knowledgeOrganizer.purge(ids, name);
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
    ...onlineCaseTools(literature),
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
      backend: ["literature_search", "literature_fetch", "online_case_search"].includes(
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
  knowledgeToolPlugins.push({
    definition: { type: "function", function: { name: "knowledge_map", description: "读取指定知识库中由原文提取的待核对知识节点、关系及引文。仅用于导航，不能当作已确认指南推荐。", parameters: { type: "object", properties: { collection: { type: "string" }, query: {type:"string"} }, required: ["collection"], additionalProperties: false } } },
    capability: { backend: "local" }, execute: ({ collection, query }) => {
      const graph=knowledgeOrganizer.graph(collection), matched=graph.nodes.filter(n=>!query||n.label.toLowerCase().includes(query.toLowerCase()));
      const nodes=matched.slice(0,30).map(n=>({...n,evidence:n.evidence.slice(0,3)})),ids=new Set(nodes.map(n=>n.id));
      const edges=graph.edges.filter(e=>ids.has(e.from)&&ids.has(e.to)).slice(0,50);
      return {nodes,edges,matchedNodes:matched.length,truncated:matched.length>nodes.length,notice:"知识地图为待核对导航，引用时须 knowledge_read 阅读原文。"};
    },
  });
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
    jev,
    domain: createMedicalWorkspaceDomain({
      trialJobs: {load:id=>trialJobs.get(id),save:(id,checks)=>trialJobs.save(id,checks)},
      saveIntakeNotes: (id, runId, notes) => workspaces.store.update(id, w => { w.runs.find(run => run.id === runId).intakeNotes = notes; }),
      saveDisplayResult: (id, runId, value) => workspaces.store.update(id, w => { const run=w.runs.find(r=>r.id===runId);run.displayResults=[...(run.displayResults||[]).filter(r=>r.key!==value.key),value].slice(-12); }),
      readPatientBrief: (patientId) => patientBrief.read(patientId),
      plugins: [
        ...knowledgeToolPlugins,
        ...localPlugins(pendingActionTools(pending, doctor)),
        ...localPlugins(careTools(() => care, pending)),
      ...localPlugins(trialTools(() => trialCandidates, pending)),
      ...localPlugins(scheduleTools(() => schedule)),
      ...localPlugins(extensionTools(() => extensions, pending)),
      ],
      // 会话叠层：医疗核心工具经 runTool 分发这些插件（材料 sources、
      // readOnly 约定与旧医疗会话一致）。
      sessionPlugins: [
        ...knowledgeToolPlugins,
        ...localPlugins(researchToolPlugins(research)),
        ...localPlugins(pendingActionTools(pending, doctor)),
        ...localPlugins(careTools(() => care, pending)),
      ...localPlugins(trialTools(() => trialCandidates, pending)),
      ...localPlugins(scheduleTools(() => schedule)),
      ...localPlugins(extensionTools(() => extensions, pending)),
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
      ...localPlugins(careTools(() => care, pending)),
      ...localPlugins(trialTools(() => trialCandidates, pending)),
      ...localPlugins(scheduleTools(() => schedule)),
      ...localPlugins(extensionTools(() => extensions, pending)),
    ],
    contextBudget:
      options.runtimeOptions?.maxContextChars ??
      envNumber("MEDICAL_CONTEXT_BUDGET", 80000),
    maxRounds:
      options.runtimeOptions?.maxRounds ?? envNumber("MEDICAL_MAX_ROUNDS", 512),
    onMaterialIngest: (file) => {
      materials.ingest(file).catch(() => {});
    },
    onMaterialReingest: (file) => {
      materials.remove(file.id).catch(() => {});
      materials.ingest(file).catch(() => {});
    },
  });
  const intakeJobs = new IntakeJobs(sessionBridge, pending);
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
  const schedule = new PatientSchedule(store, patients);
  const doctorOverview = new DoctorOverview(store, sessionBridge, {
    schedule,
    extensions: () => extensions,
    // Read lazily: the WeCom connector is created further below.
    contactMatches: () => wecom.client ? wecom.directory.contacts({ status: "suggested", limit: 1 }).counts.suggested : 0,
    trialWork: () => trialScreening.list().map((t) => {
      const { counts } = trialCandidates.candidates(t.id);
      return { id: t.id, title: t.title.slice(0, 40), awaitingReview: counts.awaitingReview };
    }),
  });
  const trialScreening = new TrialScreening(store, patients);
  const trialJobs = new TrialEligibilityJobs({store,patients,trials:trialScreening,bridge:sessionBridge,workspaces});
  const trialCandidates = new TrialCandidates({ store, patients, trials: trialScreening, jobs: trialJobs });
  const trialRegistry = new TrialRegistry(options.trialRegistryOptions);
  const patientBrief = new PatientBrief(store, patients);
  const careTasks = new CareTasks(store, patients, followups);
  const patientImporter = new PatientImporter(store, patients);
  runtime.registerPlugins([...pendingActionTools(pending, doctor), ...careTools(() => care, pending), ...trialTools(() => trialCandidates, pending), ...scheduleTools(() => schedule), ...extensionTools(() => extensions, pending)]);
  const swapProvider = (next) => {
    provider = next;
    runtime.provider = provider;
    runtime.agent.provider = provider;
    runtime.subagents.provider = provider;
    workspaces.provider = provider;
    workspaces.agent.provider = provider;
  };
  const wecom = new WeComConnector(store, patients, { vault: models.vault, ...options.wecom });
  const care = new CareEngine({
    store, patients, followups, wecom, guidelines, patientBrief,
    vault: models.vault,
    provider: () => providerConfigured(workspaces.provider) ? workspaces.provider : null,
    ...options.care,
  });
  const extensions = new Extensions({ store, patients, schedule, skillsDir: userSkillsDir, care: () => care, sessions: sessionBridge });
  sessionBridge.evolution = extensions;
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
  // 企微智能机器人通道:先建实例再交给 ChatFollowups 注册,start 后按配置自动拉起长连接。
  const wecomAibot = options.chatAibot || new WecomAibotChannel({ log: (message) => console.error(`[aibot] ${message}`), provider: () => providerConfigured(workspaces.provider) ? workspaces.provider : null, guidelines, patientBrief });
  const chatFollowups = new ChatFollowups({ store, patients, followups, directory: vaultDir, provider: () => providerConfigured(workspaces.provider) ? workspaces.provider : null, aibot: wecomAibot, ...options.chatFollowups });
  wecomAibot.attach(chatFollowups);
  // 随访问卷:到期随提醒生成,医生经已验证渠道下发,患者按题号回复由确定性解析回收。
  const surveys = new FollowUpSurveys(store, followups, {
    provider: () => providerConfigured(workspaces.provider) ? workspaces.provider : null,
    channels: {
      async sendWechat(patientId, text) {
        const binding = chatFollowups.wechatBindingByPatient(patientId);
        check(binding, "CHAT_CHANNEL", "该患者没有已绑定的微信会话，可改用手动渠道发送", 409);
        await chatFollowups.sendToBinding({ bindingId: binding.id, text, consent: true, autoLocate: true });
      },
      async sendAibot(patientId, text) {
        const channel = chatFollowups.registry.get("wecom-aibot")?.client;
        check(channel?.live, "CHAT_CHANNEL", "企微机器人长连接不在线，可改用手动渠道发送", 409);
        const row = chatFollowups.db.prepare("SELECT data FROM chat_bindings WHERE patient_id=? AND channel='wecom-aibot' AND COALESCE(json_extract(data,'$.disabled'),0)=0 ORDER BY rowid DESC LIMIT 1").get(patientId);
        check(row, "CHAT_CHANNEL", "该患者没有已绑定的企微机器人会话", 409);
        await channel.socket.push(JSON.parse(row.data).conversation, { msgtype: "text", text: { content: text } });
      },
    },
  });
  followups.surveys = surveys;
  risks.surveyAlertsProvider = (patient) => surveys.alerts(patient);
  wecomAibot.surveys = surveys;
  wecomAibot.start();
  const chatAutoFollow = new WechatAutoFollow({ chat: chatFollowups, followups, provider: () => providerConfigured(workspaces.provider) ? workspaces.provider : null, guidelines, patientBrief, store, ...options.chatAutoFollow });
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
      // This single public route authenticates with WeCom signature + encrypted corp ID.
      // All other routes retain the localhost/origin/session-token guards.
      if (path === "/api/wecom/callback" && ["GET", "POST"].includes(req.method)) {
        let raw;
        if (req.method === "POST") {
          const chunks = []; let bytes = 0;
          for await (const chunk of req) {
            bytes += chunk.length;
            check(bytes <= 65536, "BODY_LIMIT", "回调超过 64KB", 413);
            chunks.push(chunk);
          }
          raw = Buffer.concat(chunks).toString("utf8");
        }
        const response = wecom.callback(url.searchParams, raw);
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(response);
      }
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
        const ingested = patients.ingest(b.messages);
        care.discover();
        care.kick();
        return send(res, 201, ingested);
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
          wechat: { enabled: chatFollowups.config("wechat").enabled },
        });
      if (path.startsWith("/api/knowledge/playback/") && ["GET", "HEAD"].includes(req.method)) {
        const file = knowledgeOrganizer.playbackFile(path.split("/").at(-1));
        const info = await stat(file.path), range = req.headers.range;
        let start = 0, end = info.size - 1;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          check(match && (match[1] || match[2]), "RANGE", "不支持的读取范围", 416);
          if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
          else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
          check(Number.isSafeInteger(start) && start >= 0 && start <= end && start < info.size, "RANGE", "读取范围超出文件", 416);
        }
        const mime = ({".mp3":"audio/mpeg",".m4a":"audio/mp4",".wav":"audio/wav",".mp4":"video/mp4",".mov":"video/quicktime",".pdf":"application/pdf",".jpg":"image/jpeg",".jpeg":"image/jpeg",".png":"image/png",".webp":"image/webp"})[extname(file.name).toLowerCase()] || "application/octet-stream";
        res.writeHead(range ? 206 : 200, {"Content-Type":mime, "Accept-Ranges":"bytes", "Content-Length":end-start+1, "Cache-Control":"no-store", "Referrer-Policy":"no-referrer", "Content-Disposition":`inline; filename*=UTF-8''${encodeURIComponent(file.name)}`, ...(range?{"Content-Range":`bytes ${start}-${end}/${info.size}`}:{})});
        if(req.method==="HEAD")return res.end();
        const stream=createReadStream(file.path,{start,end});
        res.on("close",()=>stream.destroy());stream.on("error",()=>res.destroy());stream.pipe(res);return;
      }
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
        // Per-patient trial screening runs are background work shown on the trial page.
        return send(res, 200, { sessions: sessionBridge.list().filter((session) => url.searchParams.get("all") === "1" || !session.background) });
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
          if (parts[3] === "runs" && parts[4] && parts[5] === "archive-drafts" && parts.length === 6 && req.method === "POST")
            return send(res, 200, sessionBridge.archiveRunDrafts(id, identifier(parts[4]), (await body(req)).archived));
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
              check(!intakeJobs.active.has(id), "RUN_ACTIVE", "建档任务正在后台处理，请先停止", 409);
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
          if (parts.length === 4 && parts[3] === "intake-job") {
            if (req.method === "GET") return send(res, 200, { job: intakeJobs.get(id) });
            if (req.method === "POST") return send(res, 202, { job: intakeJobs.start(id, await body(req)) });
            if (req.method === "DELETE") return send(res, 200, { cancelled: intakeJobs.cancel(id) });
          }
          if (parts.length === 4 && parts[3] === "record-refresh" && req.method === "POST") {
            return send(res, 202, sessionBridge.refreshRecord(id, await body(req)));
          }
          if (parts.length === 4 && parts[3] === "intake-issues" && req.method === "PUT") {
            return send(res, 200, sessionBridge.saveIntakeIssues(id, (await body(req)).issues));
          }
          if (parts[3] === "files") {
            if (parts.length === 6 && parts[5] === "prepare" && req.method === "POST") {
              const input = await body(req).catch(() => ({}));
              const controller = new AbortController();
              const abort = () => controller.abort();
              res.once("close", abort);
              try {
                const file = await sessionBridge.prepareMaterial(id, identifier(parts[4]), {
                  signal: controller.signal,
                  force: input.force === true,
                  preferVision: input.preferVision === true,
                });
                // 重识别成功后可顺带发起病历重新整理；发起失败不回退识别结果。
                const outcome = { file, refresh: null, refreshError: null };
                if (input.refreshRecord === true) {
                  try {
                    outcome.refresh = sessionBridge.refreshRecord(id, {
                      fileIds: [file.id],
                      reason: input.preferVision ? "视觉模型重新识别" : "重新识别",
                    });
                  } catch (error) { outcome.refreshError = error.message; }
                }
                return send(res, 200, outcome);
              }
              finally { res.off("close", abort); }
            }
            if (parts.length === 6 && parts[5] === "text" && req.method === "PUT") {
              const input = await body(req);
              const file = sessionBridge.updateMaterialText(id, identifier(parts[4]), input.text);
              const outcome = { file, refresh: null, refreshError: null };
              if (input.refreshRecord === true) {
                try {
                  outcome.refresh = sessionBridge.refreshRecord(id, { fileIds: [file.id], reason: "医生修正识别文本" });
                } catch (error) { outcome.refreshError = error.message; }
              }
              return send(res, 200, outcome);
            }
            if (parts.length === 4 && req.method === "POST") {
              check(!intakeJobs.active.has(id), "RUN_ACTIVE", "建档任务正在后台处理，请先停止后补充资料", 409);
              const file = sessionBridge.addMaterial(id, await body(req));
              return send(res, 201, file);
            }
            if (parts.length === 5 && req.method === "DELETE") {
              check(!intakeJobs.active.has(id), "RUN_ACTIVE", "建档任务正在后台处理，请先停止", 409);
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
      if (path.startsWith("/api/care/") && await track(careApi(care, req, url, { body: () => body(req), send: (status, value) => send(res, status, value), pending }))) return;
      if (path.startsWith("/api/chat-aibot/") && await track(chatAibotApi(chatFollowups, req, url, { body: () => body(req), send: (status, value) => send(res, status, value) }))) return;
      if (path.startsWith("/api/chat-followups/") && await track(chatFollowupsApi(chatFollowups, req, url, { body: () => body(req), send: (status, value) => send(res, status, value) }))) return;
      if (path.startsWith("/api/chat-autofollow/") && await track(chatAutoFollowApi(chatAutoFollow, req, url, { body: () => body(req), send: (status, value) => send(res, status, value) }))) return;
      if (path === "/api/wecom/status" && req.method === "GET") return send(res, 200, wecom.status());
      if (path === "/api/wecom/contacts" && req.method === "GET") return send(res, 200, wecom.directory.contacts({ status: url.searchParams.get("status") || undefined, query: url.searchParams.get("q") || undefined }));
      if (path === "/api/wecom/directory" && req.method === "GET") return send(res, 200, wecom.directory.status());
      if (path === "/api/wecom/directory/sync" && req.method === "POST") return send(res, 200, await track(wecom.directory.sync()));
      if (path === "/api/wecom/groups" && req.method === "GET") return send(res, 200, wecom.directory.groups({ query: url.searchParams.get("q") || undefined }));
      if (parts[0] === "api" && parts[1] === "wecom" && parts[2] === "groups" && parts.length === 4 && req.method === "GET") return send(res, 200, wecom.directory.group(decodeURIComponent(parts[3])));
      if (parts[0] === "api" && parts[1] === "wecom" && parts[2] === "patients" && parts.length === 4 && req.method === "GET") return send(res, 200, wecom.directory.patient(parts[3]));
      if (path === "/api/wecom/group-tasks" && req.method === "POST") return send(res, 201, wecom.directory.groupDraft(await body(req)));
      if (parts[0] === "api" && parts[1] === "wecom" && parts[2] === "group-tasks" && parts.length === 5 && req.method === "POST") {
        if (parts[4] === "submit") return send(res, 200, await track(wecom.directory.groupSubmit(parts[3], await body(req))));
        if (parts[4] === "refresh") return send(res, 200, await track(wecom.directory.groupRefresh(parts[3])));
      }
      if (path === "/api/wecom/sync" && req.method === "POST") return send(res, 200, await track(wecom.sync(await body(req))));
      if (path === "/api/wecom/bindings" && req.method === "GET") return send(res, 200, { bindings: wecom.bindings(url.searchParams.get("patientId")) });
      if (path === "/api/wecom/bindings" && req.method === "POST") return send(res, 201, await track(wecom.directory.link(await body(req))));
      if (parts[0] === "api" && parts[1] === "wecom" && parts[2] === "bindings" && parts.length === 4 && req.method === "DELETE") return send(res, 200, wecom.unbind(parts[3]));
      if (path === "/api/wecom/tasks" && req.method === "GET") return send(res, 200, { tasks: wecom.tasks(url.searchParams.get("patientId")) });
      if (path === "/api/wecom/tasks" && req.method === "POST") return send(res, 201, wecom.draft(await body(req)));
      if (parts[0] === "api" && parts[1] === "wecom" && parts[2] === "tasks" && parts.length === 5 && req.method === "POST") {
        if (parts[4] === "submit") return send(res, 200, await track(wecom.submit(parts[3], await body(req))));
        if (parts[4] === "refresh") return send(res, 200, await track(wecom.refresh(parts[3])));
      }
      if (path === "/api/wechat/status" && req.method === "GET")
        return send(res, 200, { enabled: false, available: false, retired: true, reason: "请使用随访 → 聊天随访中的会话核验与读取" });
      if (["/api/wechat/read", "/api/wechat/send"].includes(path) && req.method === "POST")
        throw new AppError("WECHAT_LEGACY_RETIRED", "旧微信桥接已停用。请在随访 → 聊天随访中核验并关联会话；发送请在微信中完成。", 410);
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
        return send(res, 200, followups.overviewPage({
          limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
          offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : undefined,
        }));
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
      if (path === "/api/pending-actions" && req.method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? 100), offset = Number(url.searchParams.get("offset") ?? 0);
        const actions = pending.list({
          patientId: url.searchParams.get("patientId") || undefined,
          status: url.searchParams.get("status") || undefined,
          type: url.searchParams.get("type") || undefined,
          sourceSessionId: url.searchParams.get("sourceSessionId") ?? undefined,
          limit, offset,
        });
        return send(res, 200, {
          actions,
          nextOffset: actions.length === limit ? offset + limit : null,
          counts: pending.counts({
            patientId: url.searchParams.get("patientId") || undefined,
          }),
        });
      }
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
      if (path === "/api/jev-settings") {
        if (req.method === "GET") return send(res, 200, jev.public());
        if (req.method === "PUT") return send(res, 200, jev.save(await body(req)));
      }
      if (path === "/api/jev-settings/test" && req.method === "POST")
        return send(res, 200, await track(jev.test(await body(req))));
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
            query: url.searchParams.get("q") || "",
            outcome: url.searchParams.get("outcome") || "",
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
      if (parts[0] === "api" && parts[1] === "extensions") {
        if (parts.length === 2 && req.method === "GET") return send(res, 200, extensions.overview());
        if (parts.length === 2 && req.method === "POST") { const b = await body(req); return send(res, 201, extensions.save({ kind: b.kind, spec: b.spec, source: { via: "manual" } })); }
        if (parts.length === 3 && parts[2] === "preview" && req.method === "POST") { const b = await body(req); return send(res, 200, extensions.preview(b.kind, b.spec)); }
        if (parts.length === 3 && parts[2] === "prefs" && req.method === "GET") return send(res, 200, extensions.prefs());
        if (parts.length === 3 && parts[2] === "usage" && req.method === "POST") return send(res, 200, extensions.recordUsage((await body(req)).flowId));
        if (parts.length === 4 && parts[2] === "items" && req.method === "POST") return send(res, 200, extensions.resolveItem(parts[3], (await body(req)).status));
        if (parts.length === 4 && parts[2] === "suggestions" && req.method === "POST") return send(res, 200, extensions.resolveSuggestion(parts[3], (await body(req)).status));
        if (parts.length === 5 && parts[2] === "changes" && parts[4] === "undo" && req.method === "POST") return send(res, 200, extensions.undoChange(parts[3]));
        if (parts.length === 3 && req.method === "GET") return send(res, 200, extensions.detail(parts[2]));
        if (parts.length === 3 && req.method === "PUT") { const b = await body(req); const ext = extensions.row(parts[2]); return send(res, 200, extensions.save({ id: ext.id, kind: ext.kind, spec: b.spec, source: { via: "manual" } })); }
        if (parts.length === 4 && parts[3] === "status" && req.method === "POST") return send(res, 200, extensions.setStatus(parts[2], (await body(req)).status));
        if (parts.length === 4 && parts[3] === "rollback" && req.method === "POST") return send(res, 200, extensions.rollback(parts[2], (await body(req)).version));
      }
      if (parts[0] === "api" && parts[1] === "appointments" && parts.length === 3 && req.method === "PATCH") return send(res, 200, schedule.update(parts[2], await body(req)));
      if (parts[0] === "api" && parts[1] === "patients" && parts[2]) {
        const pid = identifier(parts[2]);
        if (parts[3] === "appointments" && parts.length === 4) {
          if (req.method === "GET") return send(res, 200, schedule.appointments(pid, { status: url.searchParams.get("status") || undefined }));
          if (req.method === "POST") return send(res, 201, schedule.create(pid, await body(req)));
        }
        if (parts[3] === "labs" && parts.length === 5 && parts[4] === "new" && req.method === "GET") return send(res, 200, { labs: schedule.newLabs(pid) });
        if (parts[3] === "labs" && parts.length === 5 && parts[4] === "reviewed" && req.method === "POST") return send(res, 200, schedule.markLabsReviewed(pid, (await body(req)).keys));
        if (parts[3] === "lab-monitors") {
          if (parts.length === 4 && req.method === "GET") return send(res, 200, { monitors: risks.listMonitors(pid) });
          if (parts.length === 4 && req.method === "POST") {
            const monitor = risks.createMonitor(pid, await body(req));
            risks.evaluatePatient(pid);
            return send(res, 201, monitor);
          }
          if (parts.length === 5 && req.method === "PATCH") {
            const monitor = risks.updateMonitor(pid, identifier(parts[4]), await body(req));
            risks.evaluatePatient(pid);
            return send(res, 200, monitor);
          }
          if (parts.length === 5 && req.method === "DELETE") {
            risks.removeMonitor(pid, identifier(parts[4]), (await body(req)).revision);
            risks.evaluatePatient(pid);
            return send(res, 200, { ok: true });
          }
        }
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
        if (parts[3] === "followup-surveys") {
          if (parts.length === 4 && req.method === "GET") return send(res, 200, { surveys: surveys.list(pid) });
          if (parts.length === 6 && req.method === "POST") {
            const surveyId = identifier(parts[4]);
            if (parts[5] === "send") return send(res, 200, await surveys.send(pid, surveyId, await body(req)));
            if (parts[5] === "collect") {
              const row = surveys.collect(pid, surveyId, await body(req));
              risks.evaluatePatient(pid);
              return send(res, 200, row);
            }
            if (parts[5] === "cancel") return send(res, 200, surveys.cancel(pid, surveyId, await body(req)));
            if (parts[5] === "ai-parse") return send(res, 200, await surveys.aiParse(pid, surveyId));
          }
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
      if (parts[0] === "api" && parts[1] === "trials") {
        if(parts.length===6 && parts[3]==='screenings' && parts[5]==='ai') {
          const trialId=identifier(parts[2]),patientId=identifier(parts[4]);
          trialScreening.get(trialId);patients.get(patientId);
          if(req.method==='GET')return send(res,200,{jobs:trialJobs.list(trialId,patientId).map(j=>trialJobs.public(j))});
          if(req.method==='POST')return send(res,202,trialJobs.start(trialId,patientId,await body(req)));
        }
        if(parts.length===7 && parts[3]==='screenings' && parts[5]==='ai' && req.method==='DELETE') {
          const job=trialJobs.get(identifier(parts[6]));
          check(job.trialId===parts[2]&&job.patientId===parts[4],'NOT_FOUND','初筛任务不存在',404);
          return send(res,200,trialJobs.cancel(job.id));
        }
        if (parts.length === 4 && parts[2] === "registry" && req.method === "GET") return send(res,200,await trialRegistry.lookup(parts[3]));
        if (parts.length === 4 && parts[3] === "candidates" && req.method === "GET") return send(res,200,trialCandidates.candidates(parts[2], { stage: url.searchParams.get("stage") || undefined, status: url.searchParams.get("status") || undefined }));
        if (parts.length === 4 && parts[3] === "batches" && req.method === "POST") return send(res,202,trialCandidates.startBatch(parts[2], await body(req)));
        if (parts.length === 6 && parts[3] === "batches" && parts[5] === "cancel" && req.method === "POST") {
          const batch = trialCandidates.getBatch(parts[4]);
          check(batch.trialId === parts[2], "NOT_FOUND", "批量初筛不存在", 404);
          return send(res,200,trialCandidates.cancelBatch(batch.id));
        }
        if (parts.length === 5 && parts[3] === "enrollments") {
          if (req.method === "GET") return send(res,200,trialCandidates.enrollment(identifier(parts[2]), identifier(parts[4])));
          if (req.method === "PUT") return send(res,200,trialCandidates.setEnrollment(parts[2], parts[4], await body(req)));
        }
        if (parts.length === 2 && req.method === "GET") return send(res,200,{trials:trialScreening.list()});
        if (parts.length === 2 && req.method === "POST") return send(res,201,trialScreening.create(await body(req)));
        if (parts.length === 3 && req.method === "GET") return send(res,200,trialScreening.get(identifier(parts[2])));
        if (parts.length === 5 && parts[3] === "screenings") {
          const trialId=identifier(parts[2]),patientId=identifier(parts[4]);
          if(req.method === "GET") return send(res,200,trialScreening.screening(trialId,patientId));
          if(req.method === "PUT") return send(res,200,trialScreening.save(trialId,patientId,await body(req)));
        }
      }
      const knowledgeRoutes =
        parts[0] === "api" &&
        (parts[1] === "knowledge" || parts[1] === "guidelines");
      if (knowledgeRoutes) {
        const sub = parts.slice(2);
        if(sub[0]==="organization") {
          if(sub.length===2 && req.method==="DELETE")return send(res,200,await knowledgeOrganizer.discard(sub[1]));
          if(sub.length===1 && req.method==="GET")return send(res,200,{jobs:knowledgeOrganizer.list(url.searchParams.get("collection")||""),...knowledgeOrganizer.capabilities()});
          if(sub.length===1 && req.method==="POST")return send(res,202,await knowledgeOrganizer.upload(req,{collection:url.searchParams.get("collection"),name:url.searchParams.get("name"),sourceKind:url.searchParams.get("sourceKind")||"资料",externalConsent:req.headers["x-knowledge-consent"]==="true"}));
          if(sub.length===3 && sub[2]==="retry" && req.method==="POST")return send(res,202,knowledgeOrganizer.retry(sub[1],await body(req)));
          if(sub.length===3 && sub[2]==="cancel" && req.method==="POST")return send(res,200,knowledgeOrganizer.cancel(sub[1]));
          if(sub.length===3 && sub[2]==="playback" && req.method==="POST")return send(res,200,knowledgeOrganizer.playback(sub[1]));
        }
        if(sub[0]==="transcription-settings") {
          if(req.method==="PUT") {
            const value=await body(req);
            knowledgeProfiles.save("knowledge-transcription",value);
            return send(res,200,knowledgeOrganizer.capabilities());
          }
          if(req.method==="GET")return send(res,200,knowledgeOrganizer.capabilities());
        }
        if(sub[0]==="map" && req.method==="GET")return send(res,200,knowledgeOrganizer.graph(url.searchParams.get("collection")||undefined));
        if(sub.length===2 && sub[1]==="organization") {
          if(req.method==="GET")return send(res,200,knowledgeOrganizer.detail(sub[0]));
          if(req.method==="POST")return send(res,202,await knowledgeOrganizer.organizeDocument(sub[0],await body(req)));
        }
        if (sub.length === 1 && sub[0] === "ocr" && req.method === "POST") {
          const input=await body(req);
          check(typeof input?.image === "string" && input.image.length>0 && input.image.length<=5400000 && /^[A-Za-z0-9+/=]+$/.test(input.image),"INVALID_INPUT","图片数据无效或超过容量");
          const result=await recognizeImage(Buffer.from(input.image,"base64"));
          check(result.lines?.some(line=>line.text?.trim()),"OCR_EMPTY","未识别到文字，请使用更清晰的资料",422);
          return send(res,200,{text:result.lines.map(line=>line.text+(line.confidence<0.7?" [识别置信度低，请核对原图]":"")).join("\n"),method:"local-ocr"});
        }
        if (sub[0] === "collections") {
          if (sub.length === 2 && req.method === "DELETE") return send(res,200,await guidelines.removeCollection(decodeURIComponent(sub[1]),await body(req)));
          if (sub.length === 1 && req.method === "GET") return send(res,200,{collections:guidelines.collections()});
          if (sub.length === 2 && req.method === "PUT") return send(res,200,guidelines.saveCollection(decodeURIComponent(sub[1]),await body(req)));
        }
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
        if (sub[0] === "education-materials") {
          if (sub.length === 1 && req.method === "GET")
            return send(res, 200, { materials: guidelines.list({ collection: EDUCATION_COLLECTION, reviewStatus: url.searchParams.get("reviewStatus") || undefined, query: url.searchParams.get("q") || "" }) });
          if (sub.length === 1 && req.method === "POST") {
            const b = await body(req);
            return send(res, 201, await guidelines.addDocument({ title: b.title, text: b.body, kind: "患教", collection: EDUCATION_COLLECTION, source: "local", fileName: "" }));
          }
          if (sub.length === 2 && req.method === "PUT")
            return send(res, 200, await guidelines.updateDocumentText(sub[1], await body(req)));
        }
        if (sub.length === 1 && sub[0] !== "search") {
          if (req.method === "GET")
            return send(res, 200, guidelines.get(sub[0]));
          if (req.method === "PATCH")
            return send(res, 200, guidelines.updateMetadata(sub[0], await body(req)));
          if (req.method === "DELETE")
            return send(res, 200, await guidelines.removeDocument(sub[0]));
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
  server.surveys = surveys;
  server.doctor = runtime.doctor;
  server.literature = literature;
  server.guidelines = guidelines;
  server.knowledgeOrganizer = knowledgeOrganizer;
  server.risks = risks;
  server.drg = drg;
  server.cases = cases;
  server.wechat = wechat;
  server.wecom = wecom;
  server.trialCandidates = trialCandidates;
  server.schedule = schedule;
  server.extensions = extensions;
  server.chatFollowups = chatFollowups;
  server.chatAutoFollow = chatAutoFollow;
  server.care = care;
  server.pendingActions = pending;
  server.once("listening", () => {
    scheduler.start();
    workspaces.scheduler.start();
    workspaces.recovery.start();
    followups.start();
    chatFollowups.start();
    care.start();
    extensions.start();
  });
  server.shutdown = async () => {
    workspaces.stopping = true;
    scheduler.stop();
    workspaces.scheduler.stop();
    workspaces.recovery.stop();
    followups.stop();
    await chatFollowups.stop();
    wecomAibot.stop();
    care.stop();
    extensions.stop();
    if (databasePath === ":memory:" && !options.userSkillsDir) rmSync(userSkillsDir, { recursive: true, force: true });
    for (const id of workspaces.active.keys()) workspaces.interrupt(id);
    for (const id of runtime.active.keys()) runtime.cancel(id);
    for (const id of workspaces.active.keys())
      if (sessionBridge.isSessionWorkspace(id)) workspaces.cancel(id);
    await intakeJobs.stop();
    await trialCandidates.stop();
    await trialJobs.stop();
    await knowledgeOrganizer.stop();
    for (const ws of sockets.clients) ws.terminate();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await Promise.allSettled([...tasks]);
    await scheduler.drain();
    await workspaces.scheduler.drain();
    await workspaces.recovery.drain();
    await workspaces.extensions.close();
    if (databasePath === ":memory:")
      { rmSync(vectorDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); rmSync(knowledgeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    await followups.drain();
    await care.drain();
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
