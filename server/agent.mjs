import { providerConfigured } from "./core/provider-status.mjs";
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
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
import { PatientRegistry, composeDigest } from "./patients.mjs";
import { FollowUpManager } from "./followups.mjs";
import { WeChatMacBridge } from "./wechat-bridge.mjs";
import { DoctorProfile } from "./medical/doctor-profile.mjs";
import { LiteratureService, literatureTools } from "./medical/literature.mjs";
import { GuidelineLibrary, guidelineTools } from "./medical/guidelines.mjs";
import { searchIcd10 } from "./medical/icd10.mjs";
import { RiskEngine } from "./medical/risk-rules.mjs";
import { CaseLibrary, caseTools } from "./medical/cases.mjs";
import { ResearchService, researchTools as researchToolPlugins } from "./medical/research.mjs";
import { DrgService, drgTools } from "./medical/drg.mjs";
import { evaluateMedicationSafety } from "./medical/med-safety.mjs";
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
    check(bytes <= 1024 * 1024, "BODY_LIMIT", "请求超过 1MB", 413);
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
  const store =
    options.store ||
    new Store(
      options.database ||
        process.env.MEDICAL_DATABASE ||
        resolve(ROOT, "data", "medical.sqlite"),
    );
  const provider =
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
  const skills =
    options.skills ||
    new SkillRegistry([
      resolve(ROOT, "../skills"),
      ...(process.env.MEDICAL_SKILLS_DIR
        ? process.env.MEDICAL_SKILLS_DIR.split(",")
        : []),
    ]);
  const doctor = options.doctor || new DoctorProfile(store);
  const literature =
    options.literature || new LiteratureService(store);
  const guidelines =
    options.guidelines || new GuidelineLibrary(store);
  const cases = options.cases || new CaseLibrary(store);
  const research = options.research || new ResearchService();
  const drg = options.drg || new DrgService(store);
  drg.load().catch(() => {});
  const runtime = new MedicalRuntime(store, provider, {
    ...options.runtimeOptions,
    skills,
    toolPlugins: options.toolPlugins || [
      ...literatureTools(literature),
      ...guidelineTools(guidelines),
      ...caseTools(cases),
      ...researchToolPlugins(research),
      ...drgTools(drg),
      {
        definition: {
          type: "function",
          function: {
            name: "medication_safety_check",
            description:
              "对用药清单做确定性安全核查（过敏匹配、内置相互作用对、重复用药）。内置规则集非穷尽，结果为提示性草稿。",
            parameters: {
              type: "object",
              properties: {
                medications: { type: "array", items: { type: "string" } },
                allergies: { type: "array", items: { type: "string" } },
              },
              required: ["medications"],
              additionalProperties: false,
            },
          },
        },
        execute: (args) => evaluateMedicationSafety(args),
      },
    ],
    doctor,
  });
  const workspaces = new WorkspaceService(store.db, provider, {
    onNotification: options.onNotification,
    sandbox: runtime.sandbox,
    chooseDirectory: options.chooseDirectory,
    extensions: {
      browserFactory: options.browserFactory,
      ...options.extensions,
    },
  });
  const secret = options.token || randomBytes(32).toString("hex");
  const scheduler = new MedicalScheduler(
    store,
    runtime,
    options.schedulerOptions,
  );
  const patients = new PatientRegistry(store, runtime);
  const followups = new FollowUpManager(
    store,
    runtime,
    options.followupOptions,
  );
  const risks = new RiskEngine(store, followups);
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
    const trimmed = [];
    let budget = 12000;
    for (const message of messages) {
      if (message.text.length > budget) break;
      budget -= message.text.length;
      trimmed.push(message);
    }
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
    const handle = runtime.prepare(patient.sessionId, {
      message: composeDigest(trimmed, patient.name),
      mode: "model",
      externalConsent: true,
      fileIds: [],
      requestId: `digest_${pid}_${Date.now()}`,
      isolatedContext: true,
    });
    const run = await track(runtime.execute(handle));
    if (run.status === "completed") patients.markProcessed(pid, run.runId);
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
          engine: "medical-runtime",
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
          model: provider.model,
          modelConfigured: providerConfigured(provider),
          directoryPicker: typeof options.chooseDirectory === "function",
          provider: provider.provider || "deepseek",
          engine: "medical-runtime",
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
          guidelines: { enabled: true, count: guidelines.list().length },
          riskAlerts: risks.counts(),
          medSafety: { enabled: true },
          drg: { enabled: true, ...drg.settings() },
          cases: cases.counts(),
          wechat: { enabled: wechat.enabled },
        });
      if (path.startsWith("/api/")) guard(req, true);
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
        return send(res, 200, {
          sessions: store.list().map((s) => ({
            id: s.id,
            title: s.title,
            patientId: s.patientId || null,
            updatedAt: s.updatedAt,
            revision: s.revision,
            messageCount: s.messages.length,
            reviewCount: s.artifacts.filter((a) => a.status === "draft").length,
            running: runtime.active.has(s.id),
          })),
        });
      if (path === "/api/sessions" && req.method === "POST") {
        const b = await body(req);
        return send(
          res,
          201,
          publicSession(
            store.create({
              id: b.id ? identifier(b.id) : undefined,
              title: b.title ? string(b.title, "标题", 100) : undefined,
            }),
          ),
        );
      }
      const parts = path.split("/").filter(Boolean);
      if (parts[0] === "api" && parts[1] === "sessions" && parts[2]) {
        const id = identifier(parts[2]);
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
          if (parts.length === 4 && req.method === "POST")
            return send(res, 201, runtime.addFile(id, await body(req)));
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
            runTool(
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
        return send(res, 200, evaluateMedicationSafety(await body(req)));
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
      if (parts[0] === "api" && parts[1] === "research" && req.method === "POST") {
        const b = await body(req);
        const sources = b.sessionId
          ? store.get(identifier(b.sessionId)).files
          : [];
        if (parts[2] === "profile")
          return send(res, 200, research.profile({ ...b, sources }));
        if (parts[2] === "test") return send(res, 200, research.test({ ...b, sources }));
        if (parts[2] === "sample-size")
          return send(res, 200, research.sampleSize(b));
        if (parts[2] === "deidentify")
          return send(res, 200, research.deidentify({ ...b, sources }));
      }
      if (parts[0] === "api" && parts[1] === "cases" && parts[2] === "similar" && req.method === "POST")
        return send(res, 200, cases.similar(await body(req)));
      if (parts[0] === "api" && parts[1] === "cases" && parts.length === 3) {
        if (req.method === "GET") return send(res, 200, cases.get(parts[2]));
        if (req.method === "DELETE") return send(res, 200, cases.removeCase(parts[2]));
      }
      if (path === "/api/icd10" && req.method === "GET")
        return send(res, 200, {
          codes: searchIcd10(url.searchParams.get("q"), {
            limit: url.searchParams.get("limit")
              ? Number(url.searchParams.get("limit"))
              : undefined,
          }),
        });
      if (path === "/api/patients" && req.method === "GET")
        return send(res, 200, {
          patients: patients.list({
            query: url.searchParams.get("q") || undefined,
            group: url.searchParams.get("group") || undefined,
            includeArchived: url.searchParams.get("archived") === "1",
          }),
        });
      if (path === "/api/patients" && req.method === "POST")
        return send(res, 201, patients.create(await body(req)));
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
        return send(res, 200, {
          reminders: followups.reminders({
            status: url.searchParams.get("status") || "pending",
          }),
        });
      if (
        parts[0] === "api" &&
        parts[1] === "reminders" &&
        parts[3] === "ack" &&
        req.method === "POST"
      )
        return send(res, 200, followups.ackReminder(identifier(parts[2])));
      if (parts[0] === "api" && parts[1] === "patients" && parts[2]) {
        const pid = identifier(parts[2]);
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
          if (parts.length === 5 && parts[4] === "apply" && req.method === "POST")
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
            : `DOI-${String(article.doi).replace(/[^A-Za-z0-9.-]/g, "_").slice(0, 80)}.md`;
          const file = runtime.addFile(identifier(b.sessionId), {
            name,
            text: literature.materialText(article),
          });
          return send(res, 201, { file, article });
        }
      }
      if (parts[0] === "api" && parts[1] === "guidelines") {
        if (parts.length === 2 && req.method === "GET")
          return send(res, 200, { documents: guidelines.list() });
        if (parts.length === 2 && req.method === "POST")
          return send(res, 201, guidelines.addDocument(await body(req)));
        if (parts[2] === "search" && req.method === "GET") {
          const yearRaw = url.searchParams.get("year");
          return send(
            res,
            200,
            guidelines.search({
              query: url.searchParams.get("q") || undefined,
              org: url.searchParams.get("org") || undefined,
              year: yearRaw ? Number(yearRaw) : undefined,
              limit: url.searchParams.get("limit")
                ? Number(url.searchParams.get("limit"))
                : undefined,
            }),
          );
        }
        if (parts.length === 3 && parts[2] !== "search") {
          const docId = parts[2];
          if (req.method === "GET") return send(res, 200, guidelines.get(docId));
          if (req.method === "DELETE")
            return send(res, 200, guidelines.removeDocument(docId));
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
            return send(res, 201, runtime.doctor.addMemory({ ...b, kind: "explicit" }));
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
                runtime.doctor.pinMemory(
                  id,
                  (await body(req)).pinned === true,
                ),
              );
          }
        }
        if (parts[2] === "consolidate" && req.method === "POST") {
          if (parts.length === 3) return send(res, 200, runtime.doctor.consolidate());
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
        store.get(id);
        if (match[2]) return send(res, 200, { cancelled: runtime.cancel(id) });
        const handle = runtime.prepare(id, await body(req));
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
            runtime.cancel(id);
          }
        };
        res.on("close", close);
        const heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(": heartbeat\n\n");
        }, 15000);
        try {
          await track(
            runtime.execute(handle, (event) => {
              if (!disconnected) {
                res.write(
                  `id: ${event.seq}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`,
                );
                if (res.writableLength > 2 * 1024 * 1024) runtime.cancel(id);
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
        const handle = runtime.prepare(identifier(b.sessionId), b);
        const result = await track(runtime.execute(handle));
        return send(res, result.status === "completed" ? 200 : 422, result);
      }
      if (path.startsWith("/api/"))
        throw new AppError("NOT_FOUND", "接口不存在", 404);
      check(req.method === "GET", "NOT_FOUND", "页面不存在", 404);
      const dist = resolve(ROOT, "../dist");
      let target = resolve(dist, `.${path}`);
      check(
        target === dist || target.startsWith(dist + "/"),
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
          payload: { engine: "medical-runtime", version: "0.4.0" },
        },
      });
      ws.on("close", () => {
        for (const id of owned) runtime.cancel(id);
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
                  session_id: store.create({
                    title: p.title ? string(p.title, "标题", 100) : undefined,
                  }).id,
                });
              if (rpc.method === "session.get")
                return reply(
                  publicSession(store.get(identifier(p.session_id))),
                );
              if (rpc.method === "prompt.cancel")
                return reply({
                  cancelled: runtime.cancel(identifier(p.session_id)),
                });
              if (rpc.method === "prompt.submit") {
                const id = identifier(p.session_id);
                const handle = runtime.prepare(id, { ...p, message: p.text });
                owned.add(id);
                reply({ status: "streaming", run_id: handle.run.id });
                try {
                  await runtime.execute(handle, (event) =>
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
  server.workspaces = workspaces;
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
    for (const ws of sockets.clients) ws.terminate();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await Promise.allSettled([...tasks]);
    await scheduler.drain();
    await workspaces.scheduler.drain();
    await workspaces.recovery.drain();
    await workspaces.extensions.close();
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
  const server = createServer();
  const port = Number(process.env.PORT || 8787);
  server.listen(port, "127.0.0.1", () =>
    console.log(`Medical workbench: http://127.0.0.1:${port}`),
  );
  const stop = () => server.shutdown().then(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
