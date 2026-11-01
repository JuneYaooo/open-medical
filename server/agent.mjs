import { ModelChoices } from "./core/model-choices.mjs";
import { labDisplayTools } from "./medical/lab-display-tools.mjs";
import { KnowledgeOrganizer } from "./medical/knowledge-organizer.mjs";
import { graphSlice } from "../shared/knowledge-graph-search.mjs";
import { ModelProfiles } from "./core/model-profiles.mjs";
import { createReadStream } from "node:fs";
import { IntakeJobs } from "./medical/intake-jobs.mjs";
import { providerConfigured } from "./core/provider-status.mjs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { readFile, stat } from "node:fs/promises";
import { resolve, dirname, extname, join, sep, delimiter } from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import { WorkspaceService } from "./core/workspace-service.mjs";
import { workspaceApi } from "./core/workspace-api.mjs";
import { Store } from "./store.mjs";
import { createProvider } from "./provider.mjs";
import { MedicalSandbox } from "./sandbox.mjs";
import { AppError, check, string, identifier } from "./errors.mjs";
import { artifactLines } from "../shared/medical.mjs";
import { SkillRegistry } from "./skills.mjs";
import { MedicalScheduler } from "./scheduler.mjs";
import {
  PatientRegistry,
  composeDigest,
  selectDigestMessages,
} from "./patients.mjs";
import { scheduleTools } from "./medical/schedule-tools.mjs";
import { DoctorProfile } from "./medical/doctor-profile.mjs";
import { createKnowledgeQueryExpander } from "./medical/knowledge-query.mjs";
import { GuidelineLibrary, knowledgeTools, EDUCATION_COLLECTION } from "./medical/guidelines.mjs";
import { scanGroupSuggestions } from "./medical/patient-grouping.mjs";
import { searchIcd10 } from "./medical/icd10.mjs";
import { PatientBrief } from "./medical/patient-brief.mjs";
import { PatientImporter } from "./medical/patient-import.mjs";
import { LabImporter } from "./medical/lab-import.mjs";
import { Backups } from "./medical/backups.mjs";
import { DemoPack } from "./medical/demo-pack.mjs";
import { PatientSchedule } from "./medical/patient-schedule.mjs";
import { lostPatients } from "./medical/lost-followup.mjs";
import { Extensions } from "./medical/extensions.mjs";
import { extensionTools } from "./medical/extension-tools.mjs";
import { DoctorOverview } from "./medical/doctor-overview.mjs";
import { buildShareRecord } from "./medical/deidentify.mjs";
import { onlineCaseTools } from "./medical/online-cases.mjs";
import { CaseLibrary, caseTools } from "./medical/cases.mjs";
import { cohortProfileTool } from "./medical/cohort-profile.mjs";
import {
  evaluateMedicationSafety,
  specialPopulationCautions,
} from "./medical/med-safety.mjs";
import { searchLabKnowledge } from "./medical/lab-knowledge.mjs";
import {
  PendingActions,
  pendingActionTools,
} from "./medical/pending-actions.mjs";
import { doctorMemoryTools } from "./medical/doctor-profile.mjs";
import { knowledgeRunEvidence } from "./medical/knowledge-answer.mjs";
import { createMedicalWorkspaceDomain } from "./medical/medical-workspace-domain.mjs";
import { PluginHost } from "./plugin-host/host.mjs";
import { SessionBridge } from "./session-bridge.mjs";
import { EmbeddingService } from "./medical/embeddings.mjs";
import { LanceVectorStore } from "./medical/vector-store.mjs";
import { MaterialLibrary, materialSearchTools } from "./medical/materials.mjs";
import { ModelSettings } from "./core/model-settings.mjs";
import { JevSettings } from "./core/jev-settings.mjs";
import { OcrSettings, OCR_MODEL_PROFILE_ID } from "./core/ocr-settings.mjs";
import { PaddleLocal } from "./core/paddle-local.mjs";
import { ResearchPython } from "./core/research-python.mjs";
import { DocumentPython } from "./core/document-python.mjs";
import { AGENT_BROWSER_HEADER, registerSelfPort } from "./core/browser-tools.mjs";
import { MaterialPrivacy, PrivacySettings, builtinPrivacyService, deidentifyViaService } from "./medical/privacy.mjs";
import { runCohortQuery } from "./medical/cohort-query.mjs";
import { configureLocalOcrService, imageTextWithFallback, visionTranscriber } from "./core/image-text.mjs";
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
  const probeModel = async (candidate, res) => {
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", cancel);
    try { return await models.test(candidate, { signal: controller.signal }); }
    finally { res.removeListener("close", cancel); }
  };
  const jev = new JevSettings(models.vault);
  let provider = models.provider();
  // 领域插件宿主先加载声明（技能目录、启停状态），固定区服务就绪后再迁移和
  // 初始化；单个插件失败只标记 unavailable，不阻断服务启动。
  const pluginServices = {};
  const pluginHost = new PluginHost({
    db: store.db,
    store,
    services: pluginServices,
    ...(options.pluginDirs !== undefined
      ? { pluginDirs: options.pluginDirs }
      : process.env.MEDICAL_PLUGIN_DIRS
        ? {
            pluginDirs: [
              resolve(ROOT, "../plugins"),
              ...process.env.MEDICAL_PLUGIN_DIRS.split(delimiter)
                .map((dir) => dir.trim())
                .filter(Boolean),
            ],
          }
        : {}),
  });
  pluginHost.load();
  const pluginService = (id) => pluginHost.pluginServices[id] || null;
  const pluginActive = (id) => pluginHost.isActive(id);
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
      ...pluginHost.skillDirs(),
    ]);
  const doctor = options.doctor || new DoctorProfile(store, { ledger: () => pluginActive("learning") ? pluginService("learning")?.ledger || null : null });
  // Literature now lives in the literature plugin. Fixed modules keep a lazy
  // facade so online_case_search can use it when the plugin is active and fail
  // with a normal PLUGIN_SERVICE_UNAVAILABLE error when it is disabled.
  const requireLiterature = () => {
    const service = pluginHost.pluginServices.literature || options.literature;
    check(service, "PLUGIN_SERVICE_UNAVAILABLE", "文献研究插件未启用", 503);
    return service;
  };
  const literature = {
    search: (...args) => requireLiterature().search(...args),
    fetchArticle: (...args) => requireLiterature().fetchArticle(...args),
    materialText: (...args) => requireLiterature().materialText(...args),
  };
  const embedder = options.embedder || new EmbeddingService();
  const pending = new PendingActions(store, {
    patients: () => patients,
    cases: () => cases,
    trials: () =>
      pluginActive("trials")
        ? pluginService("trials")?.candidates || null
        : null,
    extensions: () => extensions,
    learning: () => pluginActive("learning") ? pluginService("learning") : null,
    doctor: () => doctor,
    pluginHost: () => pluginHost,
    intakeSources: (id, fileIds) => id ? sessionBridge.get(id).files.filter(file => !fileIds.length || fileIds.includes(file.id)).map(({ id, name, text }) => ({ id, name, text: text || '' })) : [],
    intakeText: id => id ? sessionBridge.get(id).files.map(f => f.text || "").join("\n") : "",
    copySourceMaterials: (sourceId, targetId, fileIds, sourceInput) => {
      const source = sessionBridge.get(sourceId);
      if (sourceInput) sessionBridge.addMaterial(targetId, { name: "建档时的对话输入.txt", text: sourceInput });
      for (const fileId of fileIds) {
        const file = source.files.find((f) => f.id === fileId);
        check(file, "SOURCE_NOT_FOUND", "建档来源材料已移除，请重新整理", 409);
        sessionBridge.copyMaterial(sourceId, targetId, file);
      }
    },
    flagSuspectMaterials: (sessionId, payload) =>
      sessionBridge.flagSuspectMaterials?.(sessionId, payload),
    onProposed: ({ type, summary }) => {
      const labels = { "patient-create": "建档提案", "patient-update": "档案更新", "followup-create": "随访提醒", "case-save": "病例入库" };
      try {
        options.onNotification?.({
          status: "completed",
          kind: "pending-proposal",
          title: "有待你确认的提案",
          body: `${labels[type] || type}：${summary.slice(0, 80)}。打开工作台顶栏「待确认」核对。`,
        });
      } catch {}
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
    options.guidelines || new GuidelineLibrary(store, embedder, vectorStore, {expandQuery:createKnowledgeQueryExpander(() => provider)});
  const knowledgeRoot = databasePath === ":memory:" ? mkdtempSync(join(tmpdir(), "omw-knowledge-")) : join(dirname(databasePath), "knowledge-uploads");
  const knowledgeProfiles = new ModelProfiles(models);
  const modelChoices = new ModelChoices(models, knowledgeProfiles);
  // OCR 设置：识别策略 + 本机识别服务（PaddleOCR）+ 可选难例兜底视觉模型
  // （存团队模型配置 ocr-vision 条目，任意 OpenAI 兼容服务均可）。材料建档、
  // 知识库导入、inspect_image 统一经这两个访问器取引擎。
  const ocrModelResolver = () => {
    try {
      return knowledgeProfiles.resolve(OCR_MODEL_PROFILE_ID);
    } catch {
      return null;
    }
  };
  const ocrSettings = new OcrSettings(models.vault, knowledgeProfiles);
  const ocrStrategyResolver = () => ocrSettings.strategy();
  // 本机识别层（image-text.localOcrLines）据此优先走 PaddleOCR 服务，
  // 服务不可达时自动落回 macOS/Windows 系统组件。
  configureLocalOcrService(() => ocrSettings.service());
  // 本机 PaddleOCR 引擎（用户在 OCR 设置里点「在本机安装」才会装；装好后
  // 服务配置自动指向它，重启时若配置仍指向本机就拉起/收养残留进程）。
  const paddleLocal =
    options.paddleLocal ||
    new PaddleLocal({
      dataDir: databasePath === ":memory:" ? mkdtempSync(join(tmpdir(), "omw-paddle-")) : dirname(databasePath),
    });
  // 装过本机引擎且服务配置仍指向它时，拉起/收养残留进程；后台兜底动作，
  // 失败不阻塞启动（识别层自动落回系统组件）。
  // 患者资料去隐私：开启后发给模型的资料文本先经 gpu-worker 脱敏（或本地
  // 规则兜底），原图不发给模型。身份只在本机用于建档回填。
  const privacySettings = new PrivacySettings(models.vault, ocrSettings, {
    builtin: options.privacyBuiltinService !== undefined ? options.privacyBuiltinService : builtinPrivacyService(),
  });
  const materialPrivacy =
    options.materialPrivacy ||
    new MaterialPrivacy({
      settings: privacySettings,
      roster: () => (patients ? patients.all().flatMap((p) => [p.name, p.phone, p.patientNumber]) : []),
    });
  // 科研计算环境（独立 Python 虚拟环境 + Seatbelt 沙箱）；用户在设置里点击
  // 安装后 research_analyze 才可用。
  const researchPython =
    options.researchPython ||
    new ResearchPython({
      dataDir: databasePath === ":memory:" ? mkdtempSync(join(tmpdir(), "omw-research-")) : dirname(databasePath),
    });
  // 文档生成环境（独立虚拟环境 + 系统沙箱）：安装后生成 PPT/Word/Excel/PDF
  // 不再需要 Docker。
  const documentPython =
    options.documentPython ||
    new DocumentPython({
      dataDir: databasePath === ":memory:" ? mkdtempSync(join(tmpdir(), "omw-document-")) : dirname(databasePath),
    });
  paddleLocal
    .resume({ wantsService: (url) => ocrSettings.service()?.baseUrl === url })
    .catch(() => {});
  const knowledgeOrganizer = new KnowledgeOrganizer({
    store, library: guidelines, root: knowledgeRoot, getProvider: () => provider,
    getTranscription: () => knowledgeProfiles.all()["knowledge-transcription"],
    getOcrModel: ocrModelResolver,
    getOcrStrategy: ocrStrategyResolver,
    ...options.knowledgeOrganizerOptions,
  });
  guidelines.organizeIngest = doc => knowledgeOrganizer.organizeDocument(doc.id, {externalConsent:true,sourceKind:doc.sourceKind || "资料"});
  guidelines.organizationStatus = collection => knowledgeOrganizer.list(collection).map(job => ({
    id: job.id, docId: job.docId, status: job.status, stage: job.stage,
    batchDone: job.batchDone, batchTotal: job.batchTotal, error: job.error,
  }));
  guidelines.graphEvidence = (query, docIds, collection) => knowledgeOrganizer.searchEvidence(query, docIds, collection);
  guidelines.beforeRemoveCollection = name => knowledgeOrganizer.assertRemovable(name);
  guidelines.beforeMoveDocument = id => knowledgeOrganizer.assertRemovable(null, [id]);
  guidelines.afterMoveDocument = (id,collection) => knowledgeOrganizer.moveDocument(id,collection);
  guidelines.beforeRemoveDocument = id => knowledgeOrganizer.assertRemovable(null, [id]);
  guidelines.afterRemoveDocuments = (ids, name) => knowledgeOrganizer.purge(ids, name);
  guidelines.beforeUpdateDocumentText = id => knowledgeOrganizer.assertTextEditable(id);
  guidelines.afterUpdateDocumentText = id => knowledgeOrganizer.invalidateTextAnalysis(id);
  const cases = options.cases || new CaseLibrary(store);
  const medicationSafetyCheck = (args) => {
    const result = evaluateMedicationSafety(args);
    if (Array.isArray(args?.populations) && args.populations.length)
      result.populationCautions = specialPopulationCautions({
        medications: args.medications,
        populations: args.populations,
      });
    return result;
  };
  const knowledgeIngest = knowledgeTools(guidelines).find(p => p.definition.function.name === "knowledge_ingest");
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
        const advice = rag.embedder.health?.state === "ready"
          ? "嵌入连接已通过最近一次测试；请分别检查每份资料的全文覆盖、索引和来源复核状态。"
          : "嵌入配置不代表服务可用。可在知识库点击检查嵌入连接，失败资料可继续建立索引，无需重新上传。关键词检索仍可用。";
        return { docs, ...rag, advice };
      },
    },
    { ...knowledgeIngest, definition: { ...knowledgeIngest.definition, function: { ...knowledgeIngest.definition.function, name: "guideline_ingest" } } },
    ...doctorMemoryTools(doctor),
    ...knowledgeTools(guidelines),
    ...caseTools(cases),
    cohortProfileTool(),
    ...onlineCaseTools(literature),
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
    definition: { type: "function", function: { name: "knowledge_map", description: "读取指定知识库中由原文提取的知识节点、关系及引文。支持多个实体词和原文别名，返回匹配实体的一跳关系与端点；no_matches仅表示本次查询无匹配，不代表库中没有图谱。仅用于导航，不能当作已确认指南推荐。", parameters: { type: "object", properties: { collection: { type: "string" }, query: {type:"string"} }, required: ["collection"], additionalProperties: false } } },
    capability: { backend: "local" }, execute: ({ collection, query }) => {
      const graph=knowledgeOrganizer.graph(collection);
      const slice=graphSlice(graph,{query,includeNeighbors:true,limit:30,edgeLimit:50});
      const nodes=slice.nodes.map(n=>({...n,evidence:(n.evidence||[]).slice(0,3),evidenceCount:n.evidence?.length||0,evidenceTruncated:(n.evidence?.length||0)>3}));
      const status=!graph.nodes.length ? "empty_graph" : !slice.matchedNodes ? "no_matches" : "matched";
      return {...slice,nodes,status,collection,query:query||"",graphNodes:graph.nodes.length,graphEdges:graph.edges.length,
        returnedNodes:nodes.length,returnedEdges:slice.edges.length,
        truncated:slice.truncated||nodes.some(n=>n.evidenceTruncated),
        notice:(status==="empty_graph"?"此库当前没有可用图谱。":status==="no_matches"?"此库已有图谱，但本次查询未匹配实体；不能据此声称尚未提取图谱。请缩短查询或改用别名。":"已返回匹配实体及一跳相邻关系；匹配实体数与返回节点数不同是因为包含关系端点。")+"知识地图用于检索导航，引用时须 knowledge_read 阅读原文。"};
    },
  });
  // 代码沙箱（手动「运行代码」任务与能力快照共用）。
  const sandbox = new MedicalSandbox();
  const workspaces = new WorkspaceService(store.db, provider, {
    jev,
    modelProfiles: knowledgeProfiles,
    getOcrModel: ocrModelResolver,
    imageShrink: options.imageShrink || null,
    privacy: materialPrivacy,
    documentPython,
    domain: createMedicalWorkspaceDomain({
      readKnowledgeEvidence: context => knowledgeRunEvidence(store.db, context),
      knowledgeDigest: () => guidelines.collectionDigest(),
      personalContext: (run, workspaceId) =>
        pluginActive("learning") ? pluginService("learning")?.personalContext(run, workspaceId) : null,
      saveIntakeNotes: (id, runId, notes) => workspaces.store.update(id, w => { w.runs.find(run => run.id === runId).intakeNotes = notes; }),
      saveDisplayResult: (id, runId, value) => workspaces.store.update(id, w => { const run=w.runs.find(r=>r.id===runId);run.displayResults=[...(run.displayResults||[]).filter(r=>r.key!==value.key),value].slice(-12); }),
      readPatientBrief: (patientId) => patientBrief.read(patientId),
      pluginHost,
      // 全局助手工具面的依赖（访问器延迟解析：注册表在下方才创建）。
      patients: () => patients,
      pending: () => pending,
      research: () => researchPython,
      privacy: () => materialPrivacy,
      plugins: [
        ...knowledgeToolPlugins,
        ...localPlugins(pendingActionTools(pending, doctor)),
      ...localPlugins(scheduleTools(() => schedule)),
      ...localPlugins(labDisplayTools(() => patients)),
      ...localPlugins(extensionTools(() => extensions, pending)),
      ],
      // 会话叠层：医疗核心工具经 runTool 分发这些插件（材料 sources、
      // readOnly 约定与旧医疗会话一致）。
      sessionPlugins: [
        ...knowledgeToolPlugins,
          ...localPlugins(pendingActionTools(pending, doctor)),
      ...localPlugins(scheduleTools(() => schedule)),
      ...localPlugins(labDisplayTools(() => patients)),
      ...localPlugins(extensionTools(() => extensions, pending)),
      ],
      skills,
      doctor,
    }),
    onNotification: options.onNotification,
    sandbox,
    chooseDirectory: options.chooseDirectory,
    extensions: {
      browserFactory: options.browserFactory,
      ...options.extensions,
    },
  });
  // 所有医疗会话都是统一内核里 kind:"session" 的工作区；旧版 sessions
  // 表里的会话在下方一次性迁移过来，只保留这一套引擎。
  const sessionsRoot =
    databasePath === ":memory:"
      ? mkdtempSync(join(tmpdir(), "omw-sessions-"))
      : join(dirname(databasePath), "session-workspaces");
  mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
  const sessionBridge = new SessionBridge(store, workspaces, {
    sessionsRoot,
    patientRecord: id => patients.row(id),
    skills,
    doctor,
    pluginHost,
    learning: () => pluginActive("learning") ? pluginService("learning") : null,
    plugins: [
      ...knowledgeToolPlugins,
      ...localPlugins(pendingActionTools(pending, doctor)),
      ...localPlugins(scheduleTools(() => schedule)),
      ...localPlugins(labDisplayTools(() => patients)),
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
    ocrModel: ocrModelResolver,
    ocrStrategy: ocrStrategyResolver,
    privacy: materialPrivacy,
  });
  sessionBridge.migrateLegacySessions();
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
      const w = sessionBridge.requireSessionWorkspace(sessionId);
      return {
        revision: w.revision,
        files: (w.materials || []).map((f) => ({ id: f.id, hash: f.hash })),
      };
    },
    hasRequest: (sessionId, requestId) =>
      workspaces.store.hasRequest(sessionId, requestId),
  });
  const patients = new PatientRegistry(store, agentRuntime, {
    onIdentityChanged: (patient, previousName) => {
      if (!sessionBridge.isSessionWorkspace(patient.sessionId)) return;
      const session = sessionBridge.get(patient.sessionId);
      if (session.title === `${previousName} · 病例`) sessionBridge.renameSession(patient.sessionId, `${patient.name} · 病例`);
    },
    // schedule 在下方才创建；建档发生在服务就绪后，闭包引用是安全的。
    onCreated: (patient) => schedule.baselinePatient(patient),
    learning: () => pluginActive("learning") ? pluginService("learning") : null,
    // Plugin-owned patient data is reached through the host only. Deletion uses
    // a synchronous transactional hook; list counts use active contributions.
    hooks: (name, payload) => pluginHost.runHooks(name, payload),
    summaries: (patientIds, options) =>
      pluginHost.patientSummaries(patientIds, options),
    createSession: ({ title, patientId }) => {
      const projected = sessionBridge.createSession({ title, patientId });
      return { id: projected.id };
    },
    removeSession: (sessionId) => {
      if (sessionBridge.isSessionWorkspace(sessionId))
        sessionBridge.removeSession(sessionId);
    },
  });
  // The followup plugin owns followup/care/chat services. Fixed
  // modules receive stable proxies that resolve the provided service lazily:
  // setup runs after these constructors, and reads happen after startup.
  const followupService = () => pluginService("followup");
  const currentWecom = () =>
    pluginActive("channel-wecom")
      ? pluginService("channel-wecom")?.connector || null
      : null;
  // Unassigned patient messages only exist once a WeChat/WeCom channel is
  // connected; follow-up reminders themselves never need one.
  const requireFollowupActive = () => {
    if (!pluginActive("followup"))
      throw new AppError("FOLLOWUP_INACTIVE", "随访插件未启用", 409);
    if (!pluginHost.isConnected("followup"))
      throw new AppError(
        "PATIENT_CHANNEL_NOT_CONNECTED",
        "患者消息需要先连接微信或企业微信；随访计划和提醒不受影响",
        409,
      );
  };
  const requireFollowupService = () => {
    const service = followupService();
    check(service, "PLUGIN_SERVICE_UNAVAILABLE", "随访插件未启用", 503);
    return service;
  };
  const followups = new Proxy(
    {},
    {
      get(_target, property) {
        const service = requireFollowupService();
        const value = service.followups[property];
        return typeof value === "function"
          ? value.bind(service.followups)
          : value;
      },
    },
  );
  const careService = () => requireFollowupService().care;
  // Risk rules are plugin-owned. Fixed patient flows still trigger an
  // evaluation when the plugin is active; disabled means a no-op.
  const riskEngine = () =>
    pluginActive("risk-rules") ? pluginService("risk-rules") : null;
  const schedule = new PatientSchedule(store, patients);
  const doctorOverview = new DoctorOverview(store, sessionBridge, {
    schedule,
    // Plugin agenda sources are resolved lazily: setup runs once the fixed
    // services exist (below), while reads only happen after startup.
    agendaSources: () => pluginHost.agendaSources(),
    agendaItems: (opts) => pluginHost.agendaItems(opts),
    // Read lazily: the channel-wecom plugin owns the connector.
    contactMatches: () => {
      const connector = currentWecom();
      return connector?.client
        ? connector.directory.contacts({ status: "suggested", limit: 1 })
            .counts.suggested
        : 0;
    },
    trialWork: () => {
      if (!pluginActive("trials")) return [];
      const service = pluginService("trials");
      if (!service?.screening || !service?.candidates) return [];
      return service.screening.list().map((trial) => {
        const { counts } = service.candidates.candidates(trial.id);
        return {
          id: trial.id,
          title: trial.title.slice(0, 40),
          awaitingReview: counts.awaitingReview,
        };
      });
    },
  });
  const patientBrief = new PatientBrief(store, patients, {
    briefContributions: (patientId) => pluginHost.patientBrief(patientId),
  });
  const patientImporter = new PatientImporter(store, patients);
  const labImporter = new LabImporter(patients, pending);
  const backups = new Backups(databasePath);
  // 测试进程（node --test）不做自动备份，避免在临时数据目录里起后台任务。
  if (options.autoBackup !== false && !process.env.NODE_TEST_CONTEXT) backups.startAuto({ onError: (e) => console.error("自动备份失败", e) });
  const swapProvider = (next) => {
    provider = next;
    workspaces.provider = provider;
    workspaces.agent.provider = provider;
  };
  const extensions = new Extensions({
    store, skillsDir: userSkillsDir,
    automation: () => pluginActive("learning") ? pluginService("learning")?.automation || null : null,
    // Imported skill packs must not shadow existing skills; the shared
    // registry is the authority on what is already installed.
    skillExists: (id) => { try { skills.get(id); return true; } catch { return false; } },
    importer: options.skillImporter,
    proxyResolver: options.skillProxyResolver,
  });
  // channel-wechat owns the WeChat desktop reader, wx-cli client, exporter and
  // retired bridge; the followup plugin constructs its chat service from it.
  const wechatBridgeOptions = {
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
  };
  const channelWechatOptions = options.channelWechat || {};
  // 固定区服务已全部就绪：迁移后依次执行插件 setup。插件只能通过 ctx.services
  // 调用这些对象，不直接改写固定区实现。
  // channel-wecom owns connector start/stop; care follows it through the
  // followup service rather than holding a fixed-region reference.
  const attachWecomCare = (service) => {
    const care = followupService()?.care;
    if (!care) return;
    care.channels.wecom = service.connector;
    care.channels.WecomApi = service.WecomApi;
    care.channels.clients?.clear();
    service.connector.onEvent = (event) => care.track(care.handleWecomEvent(event));
  };
  const detachWecomCare = () => {
    const care = followupService()?.care;
    if (!care) return;
    care.channels.wecom = null;
    care.channels.clients?.clear();
  };
  Object.assign(pluginServices, {
    store,
    patients,
    pending,
    learningHost: {
      bridge: sessionBridge,
      jobs: () => intakeJobs,
      provider: () => provider,
    },
    followups,
    cases,
    extensions,
    doctor,
    schedule,
    workspaces,
    trialHost: {
      patients,
      bridge: sessionBridge,
      workspaces,
      registryOptions: options.trialRegistryOptions,
    },
    careTasksHost: {
      resolvePatientFile: (patientId, fileId) => {
        const { sessionId } = patients.row(patientId);
        const session = sessionBridge.get(sessionId);
        const file = session.files.find((item) => item.id === fileId);
        check(
          file,
          "NOT_FOUND",
          "结果资料不存在或不属于当前患者，请重新选择",
          404,
        );
        return { sessionId, fileId: file.id, name: file.name };
      },
    },
    skills,
    guidelines,
    knowledge: guidelines,
    literatureHost: {
      service: options.literature || null,
      options: options.literatureOptions || {},
      identifier,
      // 文献摘要是公开资料，不走患者资料脱敏。
      addMaterial: (sessionId, input) => sessionBridge.addMaterial(sessionId, input, { publicSource: true }),
    },
    researchHost: {
      sourcesOf: (sessionId) => {
        const id = sessionId ? identifier(sessionId) : null;
        if (!id) return [];
        sessionBridge.requireSessionWorkspace(id);
        return (sessionBridge.materialsOf(id) || []).map(
          ({ id: fid, name, text, hash, extraction }) => ({
            id: fid,
            name,
            text,
            hash,
            extraction,
          }),
        );
      },
    },
    knowledgeOrganizer,
    // Followup plugin inputs. All are fixed-region objects or accessors; the
    // plugin never receives a reference to the server/request layer.
    followupHost: {
      runtime: agentRuntime,
      patients,
      vault: models.vault,
      vaultDir,
      guidelines,
      patientBrief,
      skills,
      getProvider: () =>
        providerConfigured(workspaces.provider) ? workspaces.provider : null,
      options: {
        followup: options.followupOptions,
        chatFollowups: options.chatFollowups,
        chatAutoFollow: options.chatAutoFollow,
        care: options.care,
        chatAibot: options.chatAibot,
      },
      isActive: (id = "followup") => pluginHost.isActive(id),
      syncActivation: () => pluginHost.syncActivation(),
    },
    risks: { evaluatePatient: (patientId) => riskEngine()?.evaluatePatient(patientId) },
    // Dependencies for the generic channel plugin. They are fixed-region
    // objects; the plugin owns the gateway and exposes it back as a service.
    channelHost: {
      vault: models.vault,
      bridge: sessionBridge,
      getProvider: () => provider,
      getKnowledgeBot: () => pluginService("feishu-knowledge-bot"),
      options: options.messageGatewayOptions || {},
    },
    // Knowledge-bot plugin inputs. The bot owns its own tables and routes;
    // the fixed shell only supplies the knowledge library and model access.
    knowledgeBotHost: {
      vault: models.vault,
      library: guidelines,
      getProvider: () => (providerConfigured(provider) ? provider : null),
      options: options.knowledgeBotOptions || {},
    },
    // Doctor-notifications plugin inputs. Follow-up and care rows are read
    // through their plugin services, never from the fixed shell.
    notificationHost: {
      vault: models.vault,
      agenda: (opts) => doctorOverview.read(opts),
      options: options.doctorNotificationOptions || {},
    },
    careTasks: () => (pluginActive("care-tasks") ? pluginService("care-tasks") : null),
    // The plugin constructs the WeCom connector; the followup plugin attaches
    // it to the care service through this callback.
    channelWecomHost: {
      patients,
      vault: models.vault,
      env: process.env,
      options: options.wecom || {},
      directoryTickMs: options.care?.intervalMs,
      fetch: options.wecom?.fetch,
      now: options.wecom?.now,
      onStart: attachWecomCare,
      onStop: detachWecomCare,
      // Keep the old gate: member-task refresh ran only while message
      // processing (and therefore automatic reply handling) was enabled.
      shouldRefreshAwaiting: () =>
        followupService()?.care.settings().processing.enabled === true,
    },
    channelWechatHost: {
      dataDir: vaultDir,
      vault: models.vault,
      getChat: () => followupService()?.chatFollowups || null,
      reader: channelWechatOptions.reader,
      exp: options.wechatExp || channelWechatOptions.exp,
      bridge: channelWechatOptions.bridge,
      wxcli: channelWechatOptions.wxcli,
      createReader: channelWechatOptions.createReader,
      createExp: channelWechatOptions.createExp,
      fetch: channelWechatOptions.fetch,
      now: channelWechatOptions.now,
      log: (message) => console.error(`[wechat-exp] ${message}`),
      options: {
        ...channelWechatOptions,
        bridge: wechatBridgeOptions,
        expPort: options.wechatExp?.port,
      },
    },
  });
  pluginHost.migrate();
  pluginHost.setup();
  const followup = pluginActive("followup") ? followupService() : null;
  if (followup)
    if (riskEngine())
      riskEngine().surveyAlertsProvider = (patient) =>
        followup.surveys.alerts(patient);
  const demoPack = new DemoPack(patients, store, {
    sessions: sessionBridge,
    cases,
    guidelines,
    schedule,
    host: pluginHost,
  });
  // 启动时按医疗会话的真实工具面注册一遍插件工具：注册失败或重名的
  // 插件立刻标为失败，而不是等到第一次对话才发现。
  sessionBridge.toolNames();
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
      providerConfigured(provider),
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
        "本地会话认证失效，请重新加载工作台",
        401,
      );
  }
  let shuttingDown = false, shutdownPromise;
  const server = http.createServer(async (req, res) => {
    if (options.desktopAccessToken) res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src blob:; media-src 'self' blob:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    try {
      check(!shuttingDown, "SERVER_STOPPING", "服务正在关闭，请稍后重新连接", 503);
      // The assistant's own browser must never reach this app's API.
      check(!req.headers[AGENT_BROWSER_HEADER], "AGENT_BROWSER", "助手浏览器不能访问本应用的本机服务", 403);
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
        const wecom = currentWecom();
        check(wecom, "WECOM_UNCONFIGURED", "企业微信回调未配置", 503);
        const response = wecom.callback(url.searchParams, raw);
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(response);
      }
      guard(req, false);
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
        careService().discover();
        careService().kick();
        return send(res, 201, ingested);
      }
      // Only the native window can obtain a UI session. Existing API clients
      // may use a session token explicitly obtained inside that window.
      if (options.desktopAccessToken) {
        const nativeWindow = sameSecret(req.headers["x-omw-desktop"], options.desktopAccessToken);
        const authenticatedApi = path.startsWith("/api/") && path !== "/api/bootstrap" &&
          sameSecret(req.headers["x-medical-token"] || url.searchParams.get("token"), secret);
        check(nativeWindow || authenticatedApi, "DESKTOP_ONLY", "请在 Open Medical 桌面应用中打开工作台。", 403);
      }
      if (path === "/api/agent/health" && req.method === "GET")
        return send(res, 200, {
          ok: true,
          provider: providerConfigured(provider)
            ? provider.provider || "configured"
            : null,
          modelConfigured: providerConfigured(provider),
          model: provider.model,
          engine: "unified-runtime",
          genericWorkspaces: workspaces.domain?.id === "generic",
          modes: [
            {
              id: "model",
              kind: "model",
              tools: true,
              description: "模型与受控医疗工具",
            },
            {
              id: "code",
              kind: "sandbox",
              tools: false,
              sandbox: true,
              description: "医生手动提交的代码，仅在受控沙箱中运行；不调用模型、不生成回答",
            },
          ],
          version: "0.4.0",
          clinicalValidated: false,
        });
      if (path === "/api/skills" && req.method === "GET")
        return send(res, 200, { skills: skills.list() });
      if (path === "/api/bootstrap" && req.method === "GET") {
        const controller = new AbortController();
        const disconnected = () => {
          if (!res.writableEnded) controller.abort(new AppError("REQUEST_ABORTED", "请求已断开", 499));
        };
        res.once("close", disconnected);
        try {
          await pluginHost.syncActivation();
          return send(res, 200, {
          token: secret,
          plugins: pluginHost.list(),
          demoEntryHidden: store.db.prepare("SELECT value FROM meta WHERE key=?").get("ui:demo-entry-hidden")?.value === "true",
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
          contextBudget: sessionBridge.contextBudget,
          maxRounds: sessionBridge.maxRounds,
          thinking: provider.thinking,
          directoryPicker: typeof options.chooseDirectory === "function",
          provider: provider.provider || "deepseek",
          engine: "unified-runtime",
          modes: [
            {
              id: "model",
              kind: "model",
              tools: true,
              description: "模型与受控医疗工具",
            },
            {
              id: "code",
              kind: "sandbox",
              tools: false,
              sandbox: true,
              description: "医生手动提交的代码，仅在受控沙箱中运行；不调用模型、不生成回答",
            },
          ],
          tools: sessionBridge.toolNames(),
          skills: skills.list(),
          sandbox: sandbox.status(),
          scheduler: {
            persistent: true,
            requiresRunningServer: true,
            minimumIntervalMinutes: 1,
          },
          ingestConfigured: Boolean(ingestSecret),
          patientsEnabled: true,
          doctorMemory: doctor.counts(),
          literature: { enabled: pluginActive("literature"), sources: ["pubmed", "europepmc"] },
          knowledge: {
            enabled: true,
            count: guidelines.list().length,
            rag: await guidelines.ragStatus({ signal: controller.signal }),
          },
          materials: {
            enabled: true,
            semantic: embedder.available(),
          },
          riskAlerts: riskEngine()?.counts() || { active: 0, critical: 0 },
          medSafety: { enabled: true },
          scales: {
            enabled: pluginActive("clinical-ref"),
            count: pluginService("clinical-ref")?.scales.list().length || 0,
          },
          labKnowledge: { enabled: true, count: "常见指标内置" },
          drg: pluginActive("drg")
            ? { enabled: true, ...pluginService("drg").settings() }
            : { enabled: false },
          cases: cases.counts(),
          wechat: { enabled: followupService()?.chatFollowups.config("wechat").enabled === true },
        }); } finally { res.removeListener("close", disconnected); }
      }
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
      // 旧版业务路径由插件声明接管。必须在固定业务路由（尤其
      // /api/patients/:id/... 分支）之前匹配，且已在 guard 之后。
      if (
        (await pluginHost.handleLegacyApi(req, url, {
          body: () => body(req),
          send: (status, data) => send(res, status, data),
          error: (error) => errorResponse(res, error),
          res,
        }))
      )
        return;
      // 插件 HTTP 路由只接受 /api/p/<id>/...；鉴权与其它 /api 一致。
      if (
        path.startsWith("/api/p/") &&
        (await pluginHost.handleApi(req, url, {
          body: () => body(req),
          send: (status, data) => send(res, status, data),
          error: (error) => errorResponse(res, error),
          res,
        }))
      )
        return;
      if (path === "/api/plugins" && req.method === "GET")
        return send(res, 200, { plugins: pluginHost.list() });
      const pluginRoute = /^\/api\/plugins\/([^/]+)$/.exec(path);
      if (pluginRoute && req.method === "PUT") {
        const input = await body(req);
        check(
          typeof input.enabled === "boolean",
          "INVALID_INPUT",
          "enabled 必须为布尔值",
        );
        return send(res, 200, {
          plugin: await pluginHost.setEnabled(
            decodeURIComponent(pluginRoute[1]),
            input.enabled,
          ),
        });
      }
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
        // 可选的显式 id 由调用方指定会话编号；会话一律是内核
        // kind:"session" 工作区。
        return send(res, 201, sessionBridge.createSession(await body(req)));
      }
      // 全局助手会话（单例）：幂等查找或创建，前端入口每次点击复用。
      if (path === "/api/assistant/session" && req.method === "POST")
        return send(res, 200, sessionBridge.ensureGlobalSession());
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
            if (parts.length === 6 && parts[5] === "meta" && req.method === "PATCH") {
              return send(res, 200, sessionBridge.setFileMeta(id, identifier(parts[4]), await body(req)));
            }
            if (parts.length === 6 && parts[5] === "text" && req.method === "PUT") {
              const input = await body(req);
              const file = sessionBridge.updateMaterialText(id, identifier(parts[4]), input.text, input.expectedRevision);
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
        throw new AppError("NOT_FOUND", "会话不存在", 404);
      }
      if (path === "/api/doctor/overview" && req.method === "GET")
        return send(res, 200, doctorOverview.read({
          kind: url.searchParams.get("kind") || "all", query: url.searchParams.get("q") || "",
          group: url.searchParams.get("group") || "",
          patientId: url.searchParams.get("patientId") || "",
          excludeRiskAlerts: Boolean(url.searchParams.get("patientId")) && url.searchParams.get("excludeRiskAlerts") === "1",
          offset: Number(url.searchParams.get("offset") || 0), limit: Number(url.searchParams.get("limit") || 12),
        }));
      if (path === "/api/cases" && req.method === "GET")
        return send(
          res,
          200,
          cases.list({
            query: url.searchParams.get("query") || undefined,
            diagnosis: url.searchParams.get("diagnosis") || undefined,
            starredOnly: url.searchParams.get("starred") === "1",
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
      if (parts[1] === 'pending-actions' && parts.length === 4 && parts[3] === 'review-draft' && req.method === 'PATCH') return send(res, 200, pending.saveReview(parts[2], await body(req)));
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
      ) {
        // 请求体可空：托盘普通确认发 {}，带反馈说明时发 { note }。
        const feedback = await body(req).catch(() => ({}));
        const result = parts[3] === 'confirm' ? pending.confirm(parts[2], feedback) : pending.reject(parts[2], feedback);
        if (parts[3] === 'confirm' && result.action.type === 'patient-create') {
          const learning = pluginActive("learning") ? pluginService("learning") : null;
          if (learning?.prefs()?.habits) {
            const sourceId = result.action.payload.sourceSessionId;
            try { const consent = Boolean(sourceId && intakeJobs.get(sourceId)?.startedAt); result.habitSuggestions.push(...await track(learning.consolidateStyle(provider, { consent }))); }
            catch { result.learningNotice = '档案已保存，摘要风格归纳暂未完成，原始修改仍在本机保留。'; }
          }
        }
        return send(res, 200, result);
      }
      if (path === "/api/med-cautions" && req.method === "POST")
        return send(res, 200, specialPopulationCautions(await body(req)));
      if (path === "/api/jev-settings") {
        if (req.method === "GET") return send(res, 200, jev.public());
        if (req.method === "PUT") return send(res, 200, jev.save(await body(req)));
      }
      if (path === "/api/jev-settings/test" && req.method === "POST")
        return send(res, 200, await track(jev.test(await body(req))));
      if (path === "/api/model-profiles") {
        if (req.method === "GET") return send(res, 200, { profiles: knowledgeProfiles.list() });
        check(workspaces.active.size === 0 && workspaces.media.active.size === 0,
          "MODEL_BUSY", "请等待运行结束后修改团队模型", 409);
        const input = await body(req);
        if (req.method === "PUT") return send(res, 200, { profiles: knowledgeProfiles.save(input.id, input) });
        if (req.method === "DELETE") return send(res, 200, { profiles: knowledgeProfiles.remove(input.id) });
      }
      if (path === "/api/model-choices" && req.method === "GET") return send(res, 200, await track(modelChoices.list()));
      if (["/api/model-choices/select", "/api/model-choices/test"].includes(path) && req.method === "POST") {
        const input = await body(req);
        const candidate = modelChoices.resolve(input.id);
        if (path.endsWith('/test')) return send(res, 200, await track(probeModel(candidate, res)));
        check(workspaces.active.size === 0, 'MODEL_BUSY', '有任务正在运行，请等待结束后切换模型', 409);
        check(candidate.provider === 'local' || input.consent === true, 'MODEL_CONSENT', '请确认允许模型处理任务资料');
        swapProvider(models.save(candidate));
        return send(res, 200, models.public());
      }
      if (path === "/api/model-settings") {
        if (req.method === "GET") return send(res, 200, models.public());
        if (req.method === "PUT") {
          const input = await body(req);
          check(
            workspaces.active.size === 0,
            "MODEL_BUSY",
            "有任务正在运行，请等待结束后切换模型",
            409,
          );
          swapProvider(models.save(modelChoices.assertTaskModel(models.candidate(input))));
          return send(res, 200, models.public());
        }
      }
      if (path === "/api/model-settings/test" && req.method === "POST") {
        const input = await body(req);
        return send(
          res,
          200,
          await track(probeModel(modelChoices.assertTaskModel(models.candidate(input)), res)),
        );
      }
      // OCR 设置：识别策略 + 本机识别服务（PaddleOCR）+ 可选专用识别模型；
      // test 用基准样张实测引擎，可用未保存的表单值先测。
      if (path === "/api/ocr-settings") {
        const extra = () => ({
          localAvailable: ocrSettings.localAvailable(),
          imageCapable: Boolean(ocrModelResolver()) || provider?.vision === true,
        });
        if (req.method === "GET")
          return send(res, 200, ocrSettings.public(extra()));
        if (req.method === "PUT") {
          ocrSettings.save(await body(req));
          return send(res, 200, ocrSettings.public(extra()));
        }
      }
      if (path === "/api/ocr-settings/test" && req.method === "POST") {
        const input = await body(req).catch(() => ({}));
        // 带参数时只验证不保存（模型复用主配置校验，服务走独立校验）；
        // 不带参数则实测已保存的配置。
        const result =
          input.scope === "local"
            ? await ocrSettings.testLocal(
                input.service ? ocrSettings.candidateService(input.service) : null,
              )
            : await ocrSettings.testModel(
                input.model
                  ? models.candidate({ ...input.model, vision: true })
                  : ocrSettings.modelConfig(),
              );
        return send(res, 200, result);
      }
      // 本机 PaddleOCR 引擎：状态 / 安装 / 启停。安装只在用户点击后进行，
      // 长任务返回 202 由前端轮询 status；失败原因（缺 Python、pip 网络、
      // 启动超时）都会带可执行的下一步建议。
      // 患者资料去隐私设置。开启或更换服务后，把还没经服务脱敏的资料补处理。
      if (path === "/api/privacy-settings" && req.method === "GET")
        return send(res, 200, privacySettings.public());
      if (path === "/api/privacy-settings" && req.method === "PUT") {
        const result = privacySettings.save(await body(req));
        const reprocess = await sessionBridge.reprocessPrivacy();
        return send(res, 200, { ...result, reprocess });
      }
      if (path === "/api/privacy-settings/test" && req.method === "POST") {
        const input = await body(req).catch(() => ({}));
        const service = input.service ? privacySettings.candidateService(input.service) : privacySettings.service();
        check(service, "PRIVACY_SERVICE_MISSING", "还没有配置脱敏服务；可以填写 gpu-worker 地址，或在文字识别设置里配置后沿用", 400);
        const sample = "姓名：测试患者甲  电话：13900000000  住址：某市某区测试路1号\n主诉：头痛2天。主治医师：李医生";
        const started = Date.now();
        const result = await deidentifyViaService(service, sample);
        return send(res, 200, { ok: true, policy: result.policy, sample: result.text, ms: Date.now() - started, message: "脱敏服务可用" });
      }
      if (path === "/api/privacy-settings/reprocess" && req.method === "POST")
        return send(res, 202, await sessionBridge.reprocessPrivacy({ onlyMissing: true }));
      // 科研计算环境：状态 / 安装。安装只在用户点击后进行，202 后前端轮询。
      if (path === "/api/document-env" && req.method === "GET")
        return send(res, 200, documentPython.status());
      if (path === "/api/document-env/install" && req.method === "POST") {
        documentPython.startInstall().catch(() => {});
        return send(res, 202, documentPython.status());
      }
      if (path === "/api/research-env" && req.method === "GET")
        return send(res, 200, researchPython.status());
      if (path === "/api/research-env/install" && req.method === "POST") {
        researchPython.startInstall().catch(() => {});
        return send(res, 202, researchPython.status());
      }
      if (path === "/api/ocr-settings/local-engine" && req.method === "GET")
        return send(res, 200, paddleLocal.status());
      if (path === "/api/ocr-settings/local-engine/install" && req.method === "POST") {
        paddleLocal.startInstall().then(async () => {
          // 装好即接管本机识别：服务配置指向本机引擎（合并写入，不动策略）。
          ocrSettings.save({ service: { baseUrl: paddleLocal.status().baseUrl } });
        }).catch(() => {});
        return send(res, 202, paddleLocal.status());
      }
      if (path === "/api/ocr-settings/local-engine/start" && req.method === "POST") {
        const manifest = paddleLocal.manifest();
        check(manifest?.ready, "OCR_LOCAL_PYTHON", "本机引擎尚未安装，请先安装", 400);
        const baseUrl = await paddleLocal.startWorker(manifest.port);
        ocrSettings.save({ service: { baseUrl } });
        return send(res, 200, paddleLocal.status());
      }
      if (path === "/api/ocr-settings/local-engine/stop" && req.method === "POST") {
        // 停引擎的同时把服务配置一并清掉，本机识别落回系统组件，不留暗桩。
        paddleLocal.stop();
        if (paddleLocal.ownsBaseUrl(ocrSettings.service()?.baseUrl))
          ocrSettings.save({ clearService: true });
        return send(res, 200, paddleLocal.status());
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
      if (
        parts[0] === "api" &&
        parts[1] === "cases" &&
        parts[2] === "similar" &&
        req.method === "POST"
      )
        return send(res, 200, cases.similar(await body(req)));
      if (parts[0] === "api" && parts[1] === "cases" && parts.length === 3) {
        if (req.method === "GET") return send(res, 200, cases.get(parts[2]));
        if (req.method === "PATCH")
          return send(res, 200, cases.update(parts[2], await body(req)));
        if (req.method === "DELETE")
          return send(res, 200, cases.removeCase(parts[2], await body(req)));
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
      if (path === "/api/patients/lab-import/preview" && req.method === "POST") return send(res, 200, labImporter.preview((await body(req)).text));
      if (path === "/api/patients/lab-import/commit" && req.method === "POST") return send(res, 201, labImporter.commit(await body(req)));
      // 备份：状态可查、手动触发；一致性快照写入数据库旁的 backups/。
      if (path === "/api/backup/status" && req.method === "GET") return send(res, 200, backups.status());
      if (path === "/api/backup/run" && req.method === "POST") return send(res, 201, backups.run());
      if (path === "/api/backup/check" && req.method === "POST") return send(res, 200, backups.verify((await body(req)).name));
      // 示例患者包：一键装载/删除，全部虚构、独立标签，永不触碰真实档案。
      if (path === "/api/demo-entry" && req.method === "PUT") {
        const { hidden } = await body(req);
        check(typeof hidden === "boolean", "INVALID_PREFERENCE", "入口显示状态必须为布尔值");
        store.db.prepare("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run("ui:demo-entry-hidden", String(hidden));
        return send(res, 200, { hidden });
      }
      if (path === "/api/demo-pack" && req.method === "GET") return send(res, 200, demoPack.status());
      if (path === "/api/demo-pack" && req.method === "POST") return send(res, 201, await demoPack.seed());
      if (path === "/api/demo-pack" && req.method === "DELETE") return send(res, 200, await demoPack.clear());
      // 按条件找患者（本机界面用）：与 cohort_query 工具同一判断逻辑，
      // 这里附上姓名和编号供医生打开档案；这些身份信息不进入模型。
      if (path === "/api/cohort/query" && req.method === "POST") {
        const input = await body(req);
        const all = patients.all();
        const result = runCohortQuery(all, input?.spec, { includeMismatch: input?.includeMismatch === true, limit: 500 });
        const byId = new Map(all.map((p) => [p.id, p]));
        return send(res, 200, {
          ...result,
          rows: result.rows.map((row) => {
            const p = byId.get(row.patientId);
            return { ...row, name: p?.name || "", patientNumber: p?.patientNumber || "", gender: p?.gender || "", birthYear: p?.birthYear || null };
          }),
        });
      }
      if (path === "/api/patients" && req.method === "GET")
        return send(res, 200, {
          patients: patients.list({
            query: url.searchParams.get("q") || undefined,
            group: url.searchParams.get("group") || undefined,
            includeArchived: url.searchParams.get("archived") === "1",
            summary: url.searchParams.get("summary") === "1",
            brief: url.searchParams.get("brief") === "1",
          }),
        });
      if (path === "/api/patients" && req.method === "POST") {
        const patient = patients.create(await body(req));
        riskEngine()?.evaluatePatient(patient.id);
        return send(res, 201, patient);
      }
      if (path === "/api/patients/group-suggestions" && req.method === "POST")
        return send(res, 200, { suggestions: scanGroupSuggestions(patients) });
      if (path === "/api/patients/group-suggestions/propose" && req.method === "POST") {
        const b = await body(req);
        const action = pending.propose({
          type: "patient-group-suggest",
          provenance: { kind: "local-rule", entry: "patient-group-suggestions" },
          payload: b,
          summary: `分组建议：为 ${b.assignments?.length || 0} 位患者追加疾病分组（依据诊断 ICD-10/名称）`,
        });
        return send(res, 201, action);
      }
      if (path === "/api/inbox" && req.method === "GET") {
        requireFollowupActive();
        return send(res, 200, { messages: patients.unassigned() });
      }
      if (
        parts[0] === "api" &&
        parts[1] === "inbox" &&
        parts[3] === "assign" &&
        req.method === "POST"
      ) {
        requireFollowupActive();
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
        if (parts.length === 3 && req.method === "DELETE") return send(res, 200, extensions.remove(parts[2]));
        if (parts.length === 3 && req.method === "PUT") { const b = await body(req); const ext = extensions.row(parts[2]); return send(res, 200, extensions.save({ id: ext.id, kind: ext.kind, spec: b.spec, source: { via: "manual" } })); }
        if (parts.length === 4 && parts[3] === "status" && req.method === "POST") return send(res, 200, extensions.setStatus(parts[2], (await body(req)).status));
        if (parts.length === 4 && parts[3] === "rollback" && req.method === "POST") return send(res, 200, extensions.rollback(parts[2], (await body(req)).version));
      }
      if (path === "/api/appointments" && req.method === "GET") return send(res, 200, schedule.range(url.searchParams.get("from"), url.searchParams.get("to"), { includeCancelled: url.searchParams.get("cancelled") === "1" }));
      if (path === "/api/patients-lost" && req.method === "GET") return send(res, 200, lostPatients(schedule, { days: url.searchParams.get("days") || 90, busyPatientIds: () => followupService()?.followups?.activePatientIds?.() || [] }));
      if (parts[0] === "api" && parts[1] === "appointments" && parts.length === 3 && req.method === "PATCH") return send(res, 200, schedule.update(parts[2], await body(req)));
      if (parts[0] === "api" && parts[1] === "patients" && parts[2]) {
        const pid = identifier(parts[2]);
        if (parts[3] === "appointments" && parts.length === 4) {
          if (req.method === "GET") return send(res, 200, schedule.appointments(pid, { status: url.searchParams.get("status") || undefined }));
          if (req.method === "POST") return send(res, 201, schedule.create(pid, await body(req)));
        }
        if (parts[3] === "labs" && parts.length === 5 && parts[4] === "new" && req.method === "GET") return send(res, 200, schedule.newLabsSnapshot(pid));
        if (parts[3] === "labs" && parts.length === 5 && parts[4] === "reviewed" && req.method === "POST") return send(res, 200, schedule.markLabsReviewed(pid, (await body(req)).keys));
        if (parts[3] === "lab-display" && parts.length === 4) {
          if (req.method === "GET") return send(res, 200, patients.labDisplay(pid));
          if (req.method === "PATCH") return send(res, 200, patients.updateLabDisplay(pid, await body(req)));
        }
        if (parts.length === 4 && parts[3] === "brief" && req.method === "GET")
          return send(res, 200, patientBrief.read(pid));
        if (parts[3] === "export" && req.method === "GET")
          return send(res, 200, patients.exportDeidentified(pid));
        if (parts[3] === "share" && req.method === "POST")
          return send(res, 200, buildShareRecord(patients.get(pid), await body(req)));
        if (parts.length === 3) {
          if (req.method === "GET") return send(res, 200, patients.get(pid));
          if (req.method === "PATCH") {
            const updated = patients.update(pid, await body(req));
            riskEngine()?.evaluatePatient(pid);
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
      }
      const knowledgeRoutes =
        parts[0] === "api" &&
        (parts[1] === "knowledge" || parts[1] === "guidelines");
      if (knowledgeRoutes) {
        const sub = parts.slice(2);
        if(sub[0]==="organization") {
          if(sub.length===2 && req.method==="DELETE")return send(res,200,await knowledgeOrganizer.discard(sub[1]));
          if(sub.length===1 && req.method==="GET")return send(res,200,{jobs:knowledgeOrganizer.list(url.searchParams.get("collection")||""),...knowledgeOrganizer.capabilities()});
          if(sub.length===1 && req.method==="POST")return send(res,202,await knowledgeOrganizer.upload(req,{collection:url.searchParams.get("collection"),name:url.searchParams.get("name"),sourceKind:url.searchParams.get("sourceKind")||"资料",indexOnly:url.searchParams.get("indexOnly")==="true",metadata:{...Object.fromEntries(["title","org","edition","sourceUrl"].map(k=>[k,url.searchParams.get(k)||""])),year:url.searchParams.get("year")?Number(url.searchParams.get("year")):undefined},externalConsent:req.headers["x-knowledge-consent"]==="true"}));
          if(sub.length===3 && sub[2]==="retry" && req.method==="POST")return send(res,202,knowledgeOrganizer.retry(sub[1],await body(req)));
          if(sub.length===3 && sub[2]==="transcript" && req.method==="POST")return send(res,202,knowledgeOrganizer.supplyTranscript(sub[1],await body(req)));
          if(sub.length===3 && sub[2]==="cancel" && req.method==="POST")return send(res,200,knowledgeOrganizer.cancel(sub[1]));
          if(sub.length===3 && sub[2]==="playback" && req.method==="POST")return send(res,200,knowledgeOrganizer.playback(sub[1]));
        }
        if(sub[0]==="transcription-settings") {
          if(req.method==="PUT") {
            const value=await body(req);
            check(value.expectedRevision === undefined || value.expectedRevision === knowledgeOrganizer.capabilities().transcriptionRevision, "REVISION_CONFLICT", "转写连接已在其他窗口更新，请重新载入后核对", 409);
            knowledgeProfiles.save("knowledge-transcription",value);
            return send(res,200,knowledgeOrganizer.capabilities());
          }
          if(req.method==="GET")return send(res,200,knowledgeOrganizer.capabilities());
        }
        if(sub.length===2 && sub[1]==="table" && req.method==="GET")return send(res,200,await knowledgeOrganizer.table(sub[0]));
        if(sub.length===2 && sub[0]==="map" && sub[1]==="build" && req.method==="POST")return send(res,202,await knowledgeOrganizer.buildGraph(await body(req)));
        if(sub[0]==="map" && req.method==="GET")return send(res,200,knowledgeOrganizer.graph(url.searchParams.get("collection")||undefined));
        if(sub.length===2 && sub[1]==="organization") {
          if(req.method==="GET")return send(res,200,knowledgeOrganizer.detail(sub[0]));
          if(req.method==="POST")return send(res,202,await knowledgeOrganizer.organizeDocument(sub[0],await body(req)));
        }
        if (sub.length === 1 && sub[0] === "ocr" && req.method === "POST") {
          const input=await body(req);
          check(typeof input?.image === "string" && input.image.length>0 && input.image.length<=5400000 && /^[A-Za-z0-9+/=]+$/.test(input.image),"INVALID_INPUT","图片数据无效或超过容量");
          // 知识库页内 OCR：本机识别优先，读不出时回专用识别模型/主模型视觉
          //（与 OCR 设置一致），不再只依赖本机组件。
          const bytes=Buffer.from(input.image,"base64");
          const analyzeImage=visionTranscriber(ocrModelResolver() || (providerConfigured(provider) && provider.vision === true ? provider : null));
          const result=await imageTextWithFallback(bytes, undefined, analyzeImage);
          check(result.text.trim(),"OCR_EMPTY","未识别到文字，请使用更清晰的资料",422);
          return send(res,200,{text:result.text,method:result.kind === "vision" ? "vision" : "local-ocr"});
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
          return send(res, 201, await guidelines.addDocument({...await body(req), coverage:undefined}));
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
        if (sub[0] === "embedding-health" && req.method === "POST")
          return send(res, 200, await embedder.probe());
        if (sub.length === 2 && sub[1] === "text" && req.method === "PUT")
          return send(res, 200, await guidelines.updateDocumentText(sub[0], await body(req)));
        if (sub.length === 2 && sub[1] === "reindex" && req.method === "POST")
          return send(res, 202, guidelines.queueIndex(sub[0]));
        if (sub[0] === "reindex" && req.method === "POST")
          return send(res, 200, await guidelines.reindex());
        if (sub[0] === "education-materials") {
          if (sub.length === 1 && req.method === "GET")
            return send(res, 200, { materials: guidelines.list({ collection: EDUCATION_COLLECTION, externalOnly: url.searchParams.get("externalOnly") === "true", reviewStatus: url.searchParams.get("reviewStatus") || undefined, query: url.searchParams.get("q") || "" }) });
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
            return send(res, 200, await guidelines.removeDocument(sub[0], await body(req)));
        }
      }
      if (parts[0] === "api" && parts[1] === "doctor") {
        if (parts[2] === "profile" && parts.length === 3) {
          if (req.method === "GET") return send(res, 200, doctor.get());
          if (req.method === "PATCH")
            return send(res, 200, doctor.update(await body(req)));
        }
        if (parts[2] === "memories") {
          if (parts.length === 3 && req.method === "GET")
            return send(res, 200, {
              memories: doctor.memories({
                status: url.searchParams.get("status") || undefined,
                kind: url.searchParams.get("kind") || undefined,
              }),
            });
          if (parts.length === 3 && req.method === "POST") {
            const b = await body(req);
            return send(
              res,
              201,
              doctor.addMemory({ ...b, kind: "explicit" }),
            );
          }
          const mutateMemory = (id, operation, input, execute) =>
            pluginService("learning")?.mutateMemory(id, operation, input, execute) ?? execute();
          if (parts.length === 4 && req.method === "DELETE") {
            const id = Number(parts[3]);
            const input = await body(req);
            return send(res, 200, mutateMemory(id, "memory-delete", input, () => doctor.deleteMemory(id)));
          }
          if (parts.length === 5) {
            const id = Number(parts[3]);
            if (req.method === "POST" && parts[4] === "confirm") {
              const input = await body(req);
              return send(res, 200, mutateMemory(id, "memory-confirm", input, () => doctor.confirmMemory(id)));
            }
            if (req.method === "POST" && parts[4] === "dismiss") {
              const input = await body(req);
              return send(res, 200, mutateMemory(id, "memory-dismiss", input, () => doctor.dismissMemory(id)));
            }
            if (req.method === "POST" && parts[4] === "pin") {
              const input = await body(req);
              return send(res, 200, mutateMemory(id, "memory-pin", input, () => doctor.pinMemory(id, input.pinned === true)));
            }
          }
        }
        if (parts[2] === "consolidate" && req.method === "POST") {
          if (parts.length === 3)
            return send(res, 200, doctor.consolidate());
          if (parts[3] === "model") {
            const b = await body(req);
            return send(
              res,
              200,
              await doctor.modelConsolidate(provider, {
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
        sessionBridge.requireSessionWorkspace(id);
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
          }
        };
        res.on("close", close);
        const heartbeat = setInterval(() => {
          if (!disconnected && !res.writableEnded) res.write(": heartbeat\n\n");
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
  server.on("listening", () => registerSelfPort(server.address()?.port));
  server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      check(url.pathname === "/api/ws", "NOT_FOUND", "网关不存在", 404);
      check(!req.headers[AGENT_BROWSER_HEADER], "AGENT_BROWSER", "助手浏览器不能访问本应用的本机服务", 403);
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
                  session_id: sessionBridge.createSession(p).id,
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
  server.pending = pending;
  server.pluginHost = pluginHost;
  server.store = store;
  // 供测试与诊断日志直接调用；HTTP 入口为
  // GET /api/workspaces/:id/capability-snapshot。
  server.capabilitySnapshot = capabilitySnapshot;
  server.sessionBridge = sessionBridge;
  server.workspaces = workspaces;
  server.materials = materials;
  server.token = secret;
  server.scheduler = scheduler;
  server.patients = patients;
  server.doctor = doctor;
  Object.defineProperty(server, "knowledgeBot", {
    enumerable: true,
    configurable: true,
    get: () => pluginService("feishu-knowledge-bot"),
  });
  Object.defineProperty(server, "doctorNotifications", {
    enumerable: true,
    configurable: true,
    get: () => pluginService("doctor-notifications"),
  });
  Object.defineProperty(server, "literature", {
    enumerable: true,
    configurable: true,
    get: () => pluginService("literature") || options.literature || literature,
  });
  server.guidelines = guidelines;
  server.knowledgeOrganizer = knowledgeOrganizer;
  server.cases = cases;
  server.schedule = schedule;
  server.extensions = extensions;
  server.pendingActions = pending;
  server.labImporter = labImporter;
  // Tests and diagnostics still reach migrated services through these
  // properties. Every value is a live getter over pluginHost, never a second
  // instance or a fixed-region copy.
  const exposePluginService = (name, read) =>
    Object.defineProperty(server, name, {
      enumerable: true,
      configurable: true,
      get: read,
    });
  exposePluginService("followups", () => followups);
  exposePluginService("surveys", () => followupService()?.surveys || null);
  exposePluginService(
    "chatFollowups",
    () => followupService()?.chatFollowups || null,
  );
  exposePluginService(
    "chatAutoFollow",
    () => followupService()?.chatAutoFollow || null,
  );
  exposePluginService("care", () => followupService()?.care || null);
  exposePluginService(
    "trialCandidates",
    () => pluginService("trials")?.candidates || null,
  );
  exposePluginService(
    "messageGateway",
    () => pluginService("channel")?.gateway || null,
  );
  exposePluginService(
    "wechat",
    () => pluginService("channel-wechat")?.bridge || null,
  );
  exposePluginService("wecom", () => currentWecom());
  exposePluginService("channelWecom", () => pluginService("channel-wecom"));
  exposePluginService("channelWechat", () => pluginService("channel-wechat"));
  server.once("listening", () => {
    scheduler.start();
    workspaces.scheduler.start();
    workspaces.recovery.start();
    // 与迁移前 messageGateway.start() 的位置一致：监听开始后、聊天随访前。
    // 插件生命周期统一由 host 按依赖拓扑启动，单个插件失败已隔离。
    pluginHost.startAll().catch((error) => {
      console.error("插件启动失败:", error);
    });
  });
  server.shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    guidelines.stopStatusQueries?.();
    shutdownPromise = (async () => {
    workspaces.stopping = true;
    scheduler.stop();
    backups.stopAuto();
    paddleLocal.stop();
    workspaces.scheduler.stop();
    workspaces.recovery.stop();
    // 对应迁移前 messageGateway.stop() 的位置；先停插件再等待其收尾。
    await pluginHost.stopAll();
    await pluginHost.drainAll();
    if (databasePath === ":memory:" && !options.userSkillsDir) rmSync(userSkillsDir, { recursive: true, force: true });
    for (const id of workspaces.active.keys()) workspaces.interrupt(id);
    for (const id of workspaces.active.keys())
      if (sessionBridge.isSessionWorkspace(id)) workspaces.cancel(id);
    await intakeJobs.stop();
    await knowledgeOrganizer.stop();
    await Promise.allSettled([...guidelines.indexTasks.values()]);
    for (const ws of sockets.clients) ws.terminate();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await Promise.allSettled([...tasks]);
    await scheduler.drain();
    await workspaces.scheduler.drain();
    await workspaces.recovery.drain();
    await workspaces.extensions.close();
    try {
      const vectorClosures = await Promise.allSettled([vectorStore.close(), materialVectors.close()]);
      const failed = vectorClosures.find(result => result.status === "rejected");
      if (databasePath === ":memory:") {
        // A timed-out native initializer can still own this path. Leave it in
        // place rather than race cleanup against an unconfirmed shutdown.
        if (!failed) rmSync(vectorDir, { recursive: true, force: true });
        rmSync(knowledgeRoot, { recursive: true, force: true });
      }
      if (failed) throw failed.reason;
    } finally {
      sockets.close();
      store.close();
    }
    })();
    return shutdownPromise;
  };
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--dev-web")) {
    console.error("请使用 npm start 启动桌面应用。开发调试服务：npm run dev:server。");
    process.exit(1);
  }
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
    console.log(`Medical development server: http://127.0.0.1:${port}`),
  );
  const stop = () => server.shutdown().then(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
