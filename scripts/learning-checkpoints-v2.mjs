import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Fingerprint the model, experiment data and product runtime. Credentials may rotate.
export async function learningFingerprint(
  config,
  matrix,
  concurrency,
  root = resolve("."),
) {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      maxTokens: config.maxTokens,
      contextWindow: config.contextWindow,
      thinking: config.thinking,
      matrix,
      concurrency,
    }),
  );
  async function visit(relative) {
    const entries = await readdir(join(root, relative), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile())
        hash.update(path).update(await readFile(join(root, path)));
    }
  }
  for (const path of ["server", "shared", "evals/learning-loop-v2"])
    await visit(path);
  for (const path of [
    "scripts/learning-metrics-v2.mjs",
    "scripts/learning-probes-v2.mjs",
    "scripts/learning-v2-domain.mjs",
    "scripts/evaluate-learning-v2.mjs",
    "scripts/learning-review-v2.mjs",
    "scripts/learning-gates-v2.mjs",
  ])
    hash.update(path).update(await readFile(join(root, path)));
  return hash.digest("hex");
}

export async function completedLearningCell(
  output,
  { group, personaId, seed },
  expectedPatients,
) {
  let run;
  try {
    run = JSON.parse(
      await readFile(
        join(output, `${group}-${personaId}-${seed}-run.json`),
        "utf8",
      ),
    );
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!run.completed) return null;
  if (
    run.group !== group ||
    run.persona !== personaId ||
    run.seed !== seed ||
    run.files?.length !== expectedPatients
  )
    throw new Error("评测单元检查点与矩阵不一致");
  const rows = await Promise.all(
    run.files.map(async (file, index) => {
      if (
        !new RegExp(`^${group}-${personaId}-${seed}-P[0-9]+\\.json$`).test(file)
      )
        throw new Error("评测检查点文件名不合法");
      const { row } = JSON.parse(await readFile(join(output, file), "utf8"));
      if (
        !row ||
        row.group !== group ||
        row.persona !== personaId ||
        row.seed !== seed ||
        row.sequence !== index + 1
      )
        throw new Error("评测检查点患者顺序不一致");
      return row;
    }),
  );
  if (new Set(rows.map((row) => row.patient)).size !== rows.length)
    throw new Error("评测检查点患者重复");
  return { run, rows };
}
