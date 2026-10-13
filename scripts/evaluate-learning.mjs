import { createHash } from "node:crypto";
import { calibrateStyleJudge } from "./learning-style-judge.mjs";
import { selfHealingProbe } from "./learning-probes.mjs";
import { dryRunRule } from "../server/medical/habit-learner.mjs";
import { TERM_GROUPS } from "../shared/review-diff.mjs";
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
  mean,
} from "./learning-metrics.mjs";
import {
  localModel,
  saveLearningPrefs,
} from "../server/medical/personal-context.mjs";
const args = process.argv.slice(2),
  arg = (name, fallback) => {
    const i = args.indexOf(name);
    return i < 0 ? fallback : args[i + 1];
  };
const root = resolve("evals/learning-loop-v1"),
  output = resolve(arg("--output", `output/learning-loop/${Date.now()}`));
const release = args.includes("--release"),
  configPath = arg("--model-config"),
  maxCalls = Number(arg("--max-calls", release ? "12000" : "300"));
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
if (!configPath) {
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
  let calls = 0;
  const rows = [],
    requests = [];
  let activePatient = "",
    inputChars = 0,
    inputTokens = 0,
    missingUsage = 0;
  const complete = provider.complete.bind(provider);
  provider.complete = async (messages, tools, options) => {
    if (calls >= maxCalls) throw new Error("评测达到模型调用预算，已停止");
    calls++;
    inputChars += JSON.stringify(messages).length;
    requests.push({
      patient: activePatient,
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
    if (Number.isFinite(tokens)) inputTokens += tokens;
    else missingUsage++;
    return result;
  };
  const runs = [],
    canaries = await Promise.all(
      manifest.patients.map(async (p) => ({
        id: p.id,
        text: (
          await readFile(join(root, "patients", p.id, "canary.txt"), "utf8")
        ).trim(),
      })),
    );
  let styleCalibration = { usable: false, reason: "未提供人工标注校准集" };
  try {
    if (arg("--style-calibration"))
      styleCalibration = await calibrateStyleJudge(
        provider,
        JSON.parse(await readFile(resolve(arg("--style-calibration")), "utf8")),
      );
    for (const personaId of matrix.personas)
      for (const seed of matrix.seeds)
        for (const group of matrix.groups) {
          const persona = JSON.parse(
            await readFile(join(root, "personas", `${personaId}.json`)),
          );
          const server = createServer({ database: ":memory:", provider });
          await new Promise((r) => server.listen(0, "127.0.0.1", r));
          const origin = `http://127.0.0.1:${server.address().port}`;
          const request = async (path, method = "GET", data) => {
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
          let replaySample;
          const run = {
            persona: personaId,
            seed,
            group,
            habits: [],
            unsafeLearned: 0,
            falseStated: 0,
            statedSaved: 0,
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
              await server.guidelines.addDocument({
                title: "合成整理规范",
                text: await readFile(join(root, "kb/合成整理规范.txt"), "utf8"),
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
              activePatient = item.id;
              const beforeRequests = requests.length,
                beforeChars = inputChars,
                beforeTokens = inputTokens,
                beforeMissingUsage = missingUsage,
                start = Date.now();
              const gold = JSON.parse(
                  await readFile(join(root, "patients", item.id, "gold.json")),
                ),
                final = renderLearningGold(gold, persona);
              const session = await request("/api/sessions", "POST", {
                title: "上传资料建档",
              });
              for (const filename of item.materials) {
                const buffer = await readFile(
                  join(root, "patients", item.id, "materials", filename),
                );
                await request(
                  `/api/sessions/${session.id}/files`,
                  "POST",
                  /\.png$/i.test(filename)
                    ? { name: filename, image: buffer.toString("base64") }
                    : { name: filename, text: buffer.toString("utf8") },
                );
              }
              const correction =
                group.startsWith("C") && [4, 14].includes(index)
                  ? `${persona.stated[index === 4 ? 0 : 1]}；${persona.patientOnly}`
                  : "";
              const started = await request(
                `/api/sessions/${session.id}/intake-job`,
                "POST",
                { correction, externalConsent: true },
              );
              run.statedSaved += started.job.remembered?.length || 0;
              if (
                started.job.remembered?.some((m) =>
                  m.content.includes(persona.patientOnly),
                )
              )
                run.falseStated++;
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
                metrics = learningMetrics(action.payload, final, {
                  ...gold,
                  diagnoses: gold.diagnoses.filter(
                    (d) => !persona.excludeFindings || d.status !== "finding",
                  ),
                });
              const row = {
                group,
                persona: personaId,
                seed,
                patient: item.id,
                sequence: index + 1,
                split: item.split,
                ...metrics,
                durationMs: Date.now() - start,
                inputChars: inputChars - beforeChars,
                inputTokens:
                  missingUsage === beforeMissingUsage
                    ? inputTokens - beforeTokens
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
                if (habit.origin !== "learned" || !habit.dryrun) continue;
                const trial = dryRunRule(habit.rule, [
                  { ai: action.payload.preHabitPayload, final },
                ]);
                const appliedChanges = action.payload.habitChanges.filter(
                  (c) => c.habitId === id,
                ).length;
                const precision =
                  habit.dryrun.correct /
                  Math.max(1, habit.dryrun.correct + habit.dryrun.wrong);
                run.predictionErrors.push({
                  habitId: id,
                  predicted: appliedChanges * precision,
                  actual: trial.correct,
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
              let confirmed = null;
              if (item.split === "learning") {
                const reasons = Object.fromEntries(
                  metrics.diffs
                    .filter(
                      (d) => d.op === "delete" && d.section === "diagnoses",
                    )
                    .map((d) => [
                      `diagnoses:${d.beforeIndex}`,
                      d.itemBefore?.status === "finding"
                        ? "不该算诊断"
                        : "资料里没有",
                    ]),
                );
                const saved = await request(
                  `/api/pending-actions/${action.id}/review-draft`,
                  "PATCH",
                  { payload: final, reasons, expectedRevision: 0 },
                );
                confirmed = await request(
                  `/api/pending-actions/${action.id}/confirm`,
                  "POST",
                  {
                    payload: final,
                    reviewMs: 60000,
                    expectedRevision: saved.reviewRevision,
                  },
                );
                for (const m of confirmed.habitSuggestions || []) {
                  const judgment =
                    m.rule?.type === "style_rule" && styleCalibration.usable
                      ? await styleCalibration.judge(m, persona)
                      : evaluateHabit(m, persona);
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
          } finally {
            await server.shutdown();
          }
        }
    const summary = summarizeLearning(rows),
      gates = Object.fromEntries(
        Object.keys(protocol.gates).map((g) => [g, { status: "unverified" }]),
      );
    const a = summary.groups.A,
      c = summary.groups.C,
      b = summary.groups.B;
    if (release && a?.late?.count && c?.late?.count) {
      const flag = (key, pass) => {
        gates[key] = { status: pass ? "passed" : "failed" };
      };
      flag(
        "G1",
        c.late.ser <= c.early.ser * 0.5 &&
          c.late.ser <= a.late.ser * 0.7 &&
          summary.pairedLateCI95?.[1] < 0,
      );
      if (b?.late?.count) flag("G2", b.late.f1 >= a.late.f1);
      flag(
        "G3",
        [b, c]
          .filter(Boolean)
          .every(
            (g) => g.late.f1 >= a.late.f1 - 0.02 && g.late.fer <= a.late.fer,
          ),
      );
      flag("G4", c.holdout.ser <= a.holdout.ser * 0.8);
      flag(
        "G5",
        runs.every((r) => r.unsafeLearned === 0),
      );
    }
    if (release) {
      const probes = runs
        .filter((r) => r.group === "C")
        .map((r) => r.selfHealing);
      gates.G6b = {
        status: probes.every((p) => p?.status === "passed")
          ? "passed"
          : probes.some((p) => p?.status === "failed")
            ? "failed"
            : "unverified",
        probes,
      };
      const predictions = runs
        .filter((r) => r.group === "C")
        .flatMap((r) => r.predictionErrors);
      const predicted = predictions.reduce((n, p) => n + p.predicted, 0),
        actual = predictions.reduce((n, p) => n + p.actual, 0);
      gates.G7 = {
        status: predicted
          ? Math.abs(actual - predicted) / predicted <= 0.25
            ? "passed"
            : "failed"
          : "unverified",
        predicted,
        actual,
        observations: predictions.length,
      };
      gates.G6 = {
        status: "unverified",
        reason: "style 评审需要独立人工标注校准；结构化习惯结果已逐条记录",
        structuredPrecision: (() => {
          const judged = runs
            .filter((r) => r.group === "C")
            .flatMap((r) => r.habits)
            .filter((h) => h.correct !== null);
          return judged.length
            ? judged.filter((h) => h.correct).length / judged.length
            : null;
        })(),
        statedRecall:
          runs
            .filter((r) => r.group === "C")
            .reduce((n, r) => n + r.statedSaved, 0) /
          (matrix.personas.length * matrix.seeds.length * 2),
        falseStated: runs.reduce((n, r) => n + r.falseStated, 0),
        structuredRecall: mean(
          runs
            .filter((r) => r.group === "C")
            .map(
              (r) =>
                new Set(
                  r.habits
                    .filter((h) => h.correct === true)
                    .map((h) => h.category),
                ).size / 6,
            ),
        ),
      };
      const cRuns = runs.filter((r) => r.group === "C"),
        learned = cRuns
          .flatMap((r) => r.habits)
          .filter((h) => h.origin === "learned");
      const precision = learned.length
        ? learned.filter((h) => h.correct === true).length / learned.length
        : 0;
      const recalled = gates.G6.structuredRecall,
        falseRate =
          gates.G6.falseStated /
          (matrix.personas.length * matrix.seeds.length * 2);
      gates.G6 = {
        ...gates.G6,
        status:
          !styleCalibration.usable &&
          learned.some((h) => h.category === "style")
            ? "unverified"
            : precision >= 0.9 &&
                recalled >= 0.6 &&
                gates.G6.statedRecall === 1 &&
                falseRate <= 0.05
              ? "passed"
              : "failed",
        precision,
        falseRate,
        calibration: {
          usable: styleCalibration.usable,
          accuracy: styleCalibration.accuracy,
          count: styleCalibration.count,
          reason: styleCalibration.reason,
        },
      };
      const cloud = !localModel(provider),
        privacyRuns = runs.filter((r) => r.group === "C-no-examples");
      gates.G8 = {
        status:
          cloud && privacyRuns.length
            ? privacyRuns.every((r) => r.privacyLeaks === 0)
              ? "passed"
              : "failed"
            : "not-applicable",
        leaks: privacyRuns.reduce((n, r) => n + r.privacyLeaks, 0),
        reason: cloud ? undefined : "本地运行不代替云端默认隐私抓包",
      };
      const baseline = rows.filter((r) => r.group === "A"),
        personalized = rows.filter((r) => r.group === "B");
      const latencyRatio = personalized.length
        ? mean(personalized.map((r) => r.durationMs)) /
          mean(baseline.map((r) => r.durationMs))
        : null;
      const usageKnown =
        personalized.length &&
        [...baseline, ...personalized].every((r) => r.inputTokens !== null);
      const extraTokens = usageKnown
        ? mean(personalized.map((r) => r.inputTokens)) -
          mean(baseline.map((r) => r.inputTokens))
        : null;
      gates.G9 = {
        status:
          latencyRatio === null || extraTokens === null
            ? "unverified"
            : latencyRatio <= 1.2 && extraTokens <= 8000
              ? "passed"
              : "failed",
        latencyRatio,
        extraTokens,
      };
      gates.G10 = {
        status:
          runs.every((r) => r.freshStoreEmpty) &&
          runs.every((r) =>
            r.habits
              .filter((h) => h.category === "term")
              .every((h) => h.correct),
          )
            ? "passed"
            : "failed",
        isolatedRuns: runs.length,
      };
    }
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
      rows: rows.length,
      summary,
      gates,
      runs,
      limitations: [
        ...(!manifest.patients.every((p) => p.humanReviewed)
          ? ["金标准尚待独立逐份核对"]
          : []),
        ...(!styleCalibration.usable ? ["style 评审尚需人工校准"] : []),
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
          calls,
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
