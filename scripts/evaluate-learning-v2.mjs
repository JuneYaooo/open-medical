import {
  learningFingerprint,
  completedLearningCell,
} from "./learning-checkpoints-v2.mjs";
import { runLearningCells, retryLearningRead } from "./learning-workers.mjs";
import { createHash } from "node:crypto";

import { selfHealingProbe } from "./learning-probes-v2.mjs";

import { TERMS as TERM_GROUPS } from "./learning-v2-domain.mjs";
import {
  materialUpload,
  submitReviewEdits,
  habitEvidence,
} from "./learning-review-v2.mjs";
import { evaluateGates } from "./learning-gates-v2.mjs";
import { checkFixtures } from "./check-learning-fixtures-v2.mjs";
import { scoreStated } from "./learning-metrics-v2.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "../server/agent.mjs";
import { createProvider } from "../server/provider.mjs";
import {
  learningMetrics,
  renderLearningGold,
  shuffle,
  summarizeLearning,
  evaluateHabit,
  learningCurveSvg,
} from "./learning-metrics-v2.mjs";
import {
  localModel,
  saveLearningPrefs,
} from "../server/medical/personal-context.mjs";
const args = process.argv.slice(2),
  arg = (name, fallback) => {
    const i = args.indexOf(name);
    return i < 0 ? fallback : args[i + 1];
  };
const root = resolve("evals/learning-loop-v2"),
  output = resolve(arg("--output", `output/learning-loop/${Date.now()}`));
const release = args.includes("--release"),
  configPath = arg("--model-config"),
  maxCalls = Number(arg("--max-calls", release ? "12000" : "300")),
  concurrency = Number(arg("--concurrency", "1"));
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12)
  throw new Error("--concurrency 须为 1–12 的整数");
const protocol = JSON.parse(await readFile(join(root, "protocol.json"))),
  manifest = JSON.parse(await readFile(join(root, "manifest.json")));
if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 20000)
  throw new Error("--max-calls 须为 1–20000 的整数");
for (const patient of manifest.patients) {
  const bytes = await readFile(join(root, "patients", patient.id, "gold.json"));
  if (createHash("sha256").update(bytes).digest("hex") !== patient.goldHash)
    throw new Error(`金标准校验值不匹配：${patient.id}`);
}
await mkdir(output, { recursive: true });
if (args.includes("--dry-run")) {
  const checks = await checkFixtures();
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      {
        protocol: 2,
        status: "dry-run",
        calls: 0,
        checks,
        gates: Object.fromEntries(
          Object.keys(protocol.gates).map((k) => [k, { status: "not-run" }]),
        ),
      },
      null,
      2,
    ),
  );
  console.log(
    "v2 fixture and renderer checks passed; zero model calls; gates not run.",
  );
} else if (!configPath) {
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      {
        status: "blocked",
        reason:
          "需要 --model-config 指定获授权模型配置；不会把模拟响应当作真实效果验收。",
        gates: Object.fromEntries(
          Object.keys(protocol.gates).map((g) => [g, "not-run"]),
        ),
      },
      null,
      2,
    ),
  );
  console.error(
    "未运行：请提供 --model-config <private-json>；发版档加 --release，并明确 --max-calls。",
  );
  process.exitCode = 2;
} else {
  const config = JSON.parse(await readFile(resolve(configPath), "utf8"));
  const provider = createProvider(config),
    matrix = structuredClone(release ? protocol : protocol.development);
  if (!release && arg("--patients")) {
    const n = Number(arg("--patients"));
    if (!Number.isInteger(n) || n < 1 || n > 10)
      throw new Error("--patients 须在 1–10 之间");
    matrix.learningPatients = n;
  }
  const fingerprint = await learningFingerprint(
    config,
    {
      ...matrix,
      protocol: 2,
    },
    concurrency,
  );
  const contextPath = join(output, "matrix-context.json");
  const resume = args.includes("--resume");
  if (resume) {
    const saved = JSON.parse(await readFile(contextPath, "utf8"));
    if (saved.fingerprint !== fingerprint)
      throw new Error(
        "模型、运行时代码、数据集或并发配置已改变，不能复用旧矩阵；请使用新的输出目录",
      );
  } else {
    await writeFile(
      contextPath,
      JSON.stringify(
        {
          fingerprint,
          model: config.model,
          provider: config.provider,
          concurrency,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
  }
  let calls = 0,
    reusedIntakes = 0;
  const rows = [];
  function trackedProvider() {
    const provider = createProvider(config),
      requests = [],
      tracking = {
        activePatient: "",
        inputChars: 0,
        inputTokens: 0,
        missingUsage: 0,
      };
    const complete = provider.complete.bind(provider);
    provider.complete = async (messages, tools, options) => {
      if (calls >= maxCalls) throw new Error("评测达到模型调用预算，已停止");
      calls++;
      tracking.inputChars += JSON.stringify(messages).length;
      requests.push({
        patient: tracking.activePatient,
        messages: structuredClone(messages),
      });
      let result;
      try {
        result = await complete(messages, tools, options);
      } catch (error) {
        console.error(
          JSON.stringify({
            call: calls,
            code: error.code,
            message: String(error.message).replaceAll(
              config.apiKey || "\u0000",
              "[redacted]",
            ),
          }),
        );
        throw error;
      }
      const tokens = result.usage?.prompt_tokens ?? result.usage?.input_tokens;
      if (Number.isFinite(tokens)) tracking.inputTokens += tokens;
      else tracking.missingUsage++;
      return result;
    };
    return { provider, requests, tracking };
  }
  const runs = [],
    canaries = await Promise.all(
      manifest.patients.map(async (p) => ({
        id: p.id,
        text: (
          await readFile(join(root, "patients", p.id, "canary.txt"), "utf8")
        ).trim(),
      })),
    );
  try {
    const cells = matrix.personas.flatMap((personaId) =>
      matrix.seeds.flatMap((seed) =>
        matrix.groups.map((group) => ({ personaId, seed, group })),
      ),
    );
    const results = await runLearningCells(
      cells,
      concurrency,
      async ({ personaId, seed, group }) => {
        if (resume) {
          const saved = await completedLearningCell(
            output,
            { personaId, seed, group },
            matrix.learningPatients + (release ? matrix.holdoutPatients : 0),
          );
          if (saved) {
            rows.push(...saved.rows);
            runs.push(saved.run);
            reusedIntakes += saved.rows.length;
            console.log(
              `${group} ${personaId}/${seed}: reused ${saved.rows.length} completed intakes`,
            );
            return;
          }
        }
        const { provider, requests, tracking } = trackedProvider();
        const persona = JSON.parse(
          await readFile(join(root, "personas", `${personaId}.json`)),
        );
        const server = createServer({ database: ":memory:", provider });
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        const origin = `http://127.0.0.1:${server.address().port}`;
        const requestOnce = async (path, method = "GET", data) => {
          const response = await fetch(origin + path, {
            method,
            headers: {
              "content-type": "application/json",
              "x-medical-token": server.token,
            },
            ...(data ? { body: JSON.stringify(data) } : {}),
          });
          const value = await response.json();
          if (!response.ok)
            throw new Error(`${path}: ${JSON.stringify(value)}`);
          return value;
        };
        const request = (path, method = "GET", data) =>
          method === "GET"
            ? retryLearningRead(() => requestOnce(path, method, data))
            : requestOnce(path, method, data);
        let replaySample, activeSessionId;
        const run = {
          persona: personaId,
          seed,
          group,
          habits: [],
          unsafeLearned: 0,
          statedChecks: [],
          ruleEvidence: [],
          privacyLeaks: 0,
          freshStoreEmpty: false,
          predictionErrors: [],
          files: [],
        };
        runs.push(run);
        try {
          saveLearningPrefs(server.store.db, {
            personalContext: group !== "A",
            habits: group.startsWith("C"),
            postprocess: group !== "C-no-postprocess",
            examples:
              group === "C-no-examples"
                ? localModel(provider)
                  ? "never"
                  : "local"
                : "always",
          });
          run.freshStoreEmpty = server.doctor.memories().length === 0;
          if (group !== "A") {
            for (const file of [
              "资料可信度.txt",
              "检验整理.txt",
              "随访摘要.txt",
            ])
              await server.guidelines.addDocument({
                title: file,
                text: await readFile(join(root, "kb", file), "utf8"),
              });
            server.extensions.save({
              kind: "skill",
              spec: {
                name: "评测建档整理",
                description: "整理建档事实与出处",
                appliesTo: ["建档", "病史摘要"],
                body: "只依据本次资料整理临床事实，保留疑似限定词与原始出处。预约清单不建检验条目。",
              },
            });
          }
          const learning = shuffle(
              manifest.patients.filter((p) => p.split === "learning"),
              seed,
            ).slice(0, matrix.learningPatients),
            heldout = release
              ? manifest.patients.filter((p) => p.split === "holdout")
              : [];
          for (const [index, item] of [...learning, ...heldout].entries()) {
            tracking.activePatient = item.id;
            const beforeRequests = requests.length,
              beforeChars = tracking.inputChars,
              beforeTokens = tracking.inputTokens,
              beforeMissingUsage = tracking.missingUsage,
              start = Date.now();
            const gold = JSON.parse(
                await readFile(join(root, "patients", item.id, "gold.json")),
              ),
              final = renderLearningGold(gold, persona);
            const session = await request("/api/sessions", "POST", {
              title: "上传资料建档",
            });
            activeSessionId = session.id;
            for (const filename of item.materials) {
              await request(
                `/api/sessions/${session.id}/files`,
                "POST",
                await materialUpload(
                  join(root, "patients", item.id, "materials", filename),
                  filename,
                ),
              );
            }
            const memoriesBefore = new Set(
              server.doctor.memories().map((m) => m.id),
            );
            const correction =
              group.startsWith("C") && [4, 14].includes(index)
                ? `${persona.stated[index === 4 ? 0 : 1].text}；${persona.patientOnly}`
                : "";
            const started = await request(
              `/api/sessions/${session.id}/intake-job`,
              "POST",
              { correction, externalConsent: true },
            );
            if (correction)
              run.statedChecks.push(
                scoreStated(
                  server.doctor
                    .memories()
                    .filter((m) => m.status === "confirmed"),
                  persona.stated[index === 4 ? 0 : 1],
                  persona,
                  {
                    newMemories: server.doctor
                      .memories()
                      .filter((m) => !memoriesBefore.has(m.id)),
                  },
                ),
              );
            let job = started.job;
            const deadline = Date.now() + 600000;
            while (job.status === "running") {
              if (Date.now() > deadline) throw new Error("建档超时");
              await new Promise((r) => setTimeout(r, 500));
              job = (await request(`/api/sessions/${session.id}/intake-job`))
                .job;
            }
            if (job.status === "failed" || job.status === "interrupted")
              throw new Error(job.error || job.progress);
            const actions = (
              await request(
                `/api/pending-actions?type=patient-create&sourceSessionId=${session.id}`,
              )
            ).actions;
            if (actions.length !== 1) throw new Error("模型未生成唯一草稿");
            const action = actions[0],
              metrics = learningMetrics(action.payload, final, gold, persona);
            const row = {
              group,
              persona: personaId,
              seed,
              patient: item.id,
              sequence: index + 1,
              split: item.split,
              ...metrics,
              durationMs: Date.now() - start,
              inputChars: tracking.inputChars - beforeChars,
              inputTokens:
                tracking.missingUsage === beforeMissingUsage
                  ? tracking.inputTokens - beforeTokens
                  : null,
              contextChars: action.payload.learningContext?.chars || 0,
            };
            rows.push(row);
            if (
              !replaySample &&
              action.payload.diagnoses?.some((d) =>
                TERM_GROUPS.some((g) => g.includes(d.name)),
              )
            )
              replaySample = action.payload;
            for (const id of new Set(
              (action.payload.habitChanges || []).map((c) => c.habitId),
            )) {
              const habit = server.doctor.memoryRow(id);
              if (habit.origin !== "learned") continue;
              const evidence = habitEvidence(
                habit,
                action.payload,
                gold,
                persona,
              );
              if (item.split === "learning") run.ruleEvidence.push(...evidence);
              if (!habit.dryrun) continue;
              const actualSavings = evidence.filter((e) => e.correct).length;
              const appliedChanges = action.payload.habitChanges.filter(
                (c) => c.habitId === id,
              ).length;
              const precision =
                habit.dryrun.correct /
                Math.max(1, habit.dryrun.correct + habit.dryrun.wrong);
              run.predictionErrors.push({
                habitId: id,
                predicted: appliedChanges * precision,
                actual: actualSavings,
              });
            }
            if (!localModel(provider) && group === "C-no-examples")
              for (const req of requests.slice(beforeRequests)) {
                const text = JSON.stringify(req.messages);
                run.privacyLeaks += canaries.filter(
                  (c) => c.id !== item.id && text.includes(c.text),
                ).length;
              }
            // Replay each trial's own evidence with its frozen rule: the audit records
            // both prediction and actual item savings, without using the model as judge.

            // Holdout records never enter learning or reference history.
            let confirmed = null,
              reviewEdits = [];
            if (item.split === "learning") {
              const saved = await submitReviewEdits(
                request,
                action,
                final,
                persona,
              );
              reviewEdits = saved.edits;
              confirmed = await request(
                `/api/pending-actions/${action.id}/confirm`,
                "POST",
                {
                  payload: final,
                  reviewMs: 60000,
                  expectedRevision: saved.reviewRevision,
                },
              );
              for (const m of server.doctor
                .memories()
                .filter(
                  (m) =>
                    m.status === "confirmed" &&
                    !run.habits.some((h) => h.id === m.id),
                )) {
                const judgment = evaluateHabit(m, persona);
                const { unsafe } = judgment;
                if (unsafe) run.unsafeLearned++;
                if (judgment.correct === false) {
                  await request(
                    `/api/learning/habits/${m.id}/decision`,
                    "POST",
                    { decision: "undo" },
                  );
                }
                run.habits.push({
                  id: m.id,
                  rule: m.rule,
                  origin: m.origin,
                  content: m.content,
                  ...judgment,
                  dryrun: m.dryrun,
                });
              }
            } else
              await request(
                `/api/pending-actions/${action.id}/reject`,
                "POST",
                {},
              );
            const filename = `${group}-${personaId}-${seed}-${item.id}.json`;
            run.files.push(filename);
            await writeFile(
              join(output, filename),
              JSON.stringify(
                {
                  row,
                  draft: action.payload,
                  final,
                  confirmed,
                  reviewEdits,
                  requests: requests.slice(beforeRequests),
                },
                null,
                2,
              ),
            );
            console.log(
              `${group} ${personaId}/${seed} ${index + 1}/${learning.length + heldout.length} ${item.id}: SER=${row.ser.toFixed(3)} F1=${row.f1.toFixed(3)}`,
            );
          }
          if (release && group === "C")
            run.selfHealing = await selfHealingProbe(replaySample, persona);
          run.completed = true;
        } catch (error) {
          run.error = String(error.message).replaceAll(
            config.apiKey || "\u0000",
            "[redacted]",
          );
          // Preserve failed real-model evidence before the isolated store closes.
          // These raw synthetic-case traces stay in the local output directory.
          const failureTrace = `${group}-${personaId}-${seed}-failure.json`;
          try {
            const session = activeSessionId
              ? await request(`/api/sessions/${activeSessionId}`).catch(() => ({
                  unavailable: true,
                }))
              : null;
            await writeFile(
              join(output, failureTrace),
              JSON.stringify(
                {
                  patient: tracking.activePatient,
                  error: run.error,
                  requests: requests.filter(
                    (r) => r.patient === tracking.activePatient,
                  ),
                  session,
                },
                null,
                2,
              ),
            );
            run.failureTrace = failureTrace;
          } catch {
            run.failureTraceUnavailable = true;
          }
          throw error;
        } finally {
          await writeFile(
            join(output, `${group}-${personaId}-${seed}-run.json`),
            JSON.stringify(run, null, 2),
          );
          await server.shutdown();
        }
      },
    );
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((r) => r.reason),
        `${failures.length} 个矩阵单元运行失败；已保留各单元结果`,
      );
    const personas = await Promise.all(
      protocol.personas.map(async (id) =>
        JSON.parse(await readFile(join(root, "personas", `${id}.json`))),
      ),
    );
    const summary = summarizeLearning(rows);
    const { gates, perPersona } = evaluateGates(rows, runs, personas, {
      release,
      cloud: !localModel(provider),
    });
    await writeFile(
      join(output, "learning-curves.svg"),
      learningCurveSvg(rows),
    );
    const report = {
      status:
        Object.values(gates).every((g) =>
          ["passed", "not-applicable"].includes(g.status),
        ) && manifest.patients.every((p) => p.humanReviewed)
          ? "model-matrix-passed"
          : "incomplete",
      model: { provider: config.provider, model: config.model },
      mode: release ? "release" : "development",
      calls,
      concurrency,
      reusedIntakes,
      callsScope: "current-invocation",
      rows: rows.length,
      summary,
      protocol: 2,
      gates,
      perPersona,
      runs,
      limitations: [
        ...(!manifest.patients.every((p) => p.humanReviewed)
          ? ["金标准尚待独立逐份核对"]
          : []),
        "Unstructured style memories receive no correctness credit without a structured matching rule and observed application.",
        "发版需另一个模型档结果及全部门槛证据",
        "Q3 需要真实医生试点",
      ],
    };
    await writeFile(
      join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
    await writeFile(join(output, "rows.json"), JSON.stringify(rows, null, 2));
    process.exitCode = report.status === "model-matrix-passed" ? 0 : 2;
  } catch (error) {
    await writeFile(join(output, "rows.json"), JSON.stringify(rows, null, 2));
    await writeFile(
      join(output, "report.json"),
      JSON.stringify(
        {
          status: "failed",
          error: error.message,
          model: { provider: config.provider, model: config.model },
          mode: release ? "release" : "development",
          concurrency,
          calls,
          callsScope: "current-invocation",
          reusedIntakes,
          completed: rows.length,
          summary: summarizeLearning(rows),
          runs,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}
