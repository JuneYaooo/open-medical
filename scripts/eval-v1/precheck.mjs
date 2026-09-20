// general-agent-v1 数据集预检(README 第 6 条:先预检,再跑开发样例)。
// 独立可运行:node scripts/eval-v1/precheck.mjs
// 也导出 runPrecheck(dataset, protocol) 供测试注入变异数据集。
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { safeRelativePath } from "./lib/fixtures.mjs";

const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9]{20,}/, "OpenAI 风格密钥"],
  [/AKIA[0-9A-Z]{16}/, "AWS AccessKey"],
  [/ghp_[A-Za-z0-9]{30,}/, "GitHub token"],
  [/gh[oars]_[A-Za-z0-9]{30,}/, "GitHub token"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/AIza[0-9A-Za-z_-]{30,}/, "Google API key"],
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, "私钥块"],
  [/(api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9+/_-]{24,}['"]/i, "疑似凭据赋值"],
];

const EXPECTED_CATEGORIES = {
  code: 5, files: 4, sheets: 4, documents: 4, web: 3,
  research: 3, context: 3, mcp: 2, lifecycle: 2,
};

export function runPrecheck(dataset, protocol) {
  const problems = [];
  const notes = [];
  const pass = (cond, message) => {
    if (!cond) problems.push(message);
    return cond;
  };

  // --- 顶层结构 ---
  pass(dataset?.schema_version === 1, "schema_version 必须为 1");
  pass(
    typeof dataset?.dataset_version === "string" && dataset.dataset_version.length > 0,
    "缺少 dataset_version",
  );
  pass(dataset?.synthetic_only === true, "synthetic_only 必须为 true(无真实资料)");
  pass(Array.isArray(dataset?.cases), "cases 必须是数组");
  pass(dataset?.cases?.length === 30, `cases 数量 ${dataset?.cases?.length},期望 30`);

  const ids = dataset?.cases?.map((c) => c.id) || [];
  pass(new Set(ids).size === ids.length, "case id 存在重复");
  pass(protocol?.version === dataset?.dataset_version, "protocol.version 与 dataset_version 不一致");

  // --- 逐项字段完整性 ---
  const categoryCount = {};
  for (const cs of dataset?.cases || []) {
    const label = cs?.id || "(无id)";
    for (const field of ["id", "category", "prompt", "fixtures", "oracle", "split", "repeats", "status", "required"])
      pass(cs?.[field] !== undefined && cs?.[field] !== null, `${label}: 缺少字段 ${field}`);
    pass(typeof cs?.prompt === "string" && cs.prompt.length >= 5, `${label}: prompt 过短`);
    pass(typeof cs?.oracle === "string" && cs.oracle.length >= 5, `${label}: oracle 过短`);
    pass(cs?.repeats === 3, `${label}: repeats=${cs?.repeats},期望3(30项×3=90)`);
    pass(cs?.split === "development", `${label}: split=${cs?.split}(当前应全为 development)`);
    pass(cs?.status === "specified", `${label}: status=${cs?.status}`);
    pass(cs?.required === true, `${label}: required 应为 true`);
    categoryCount[cs?.category] = (categoryCount[cs?.category] || 0) + 1;

    // --- 夹具路径与内容 ---
    const fixtures = cs?.fixtures || {};
    pass(Object.keys(fixtures).length >= 1, `${label}: 没有夹具`);
    for (const [fp, content] of Object.entries(fixtures)) {
      const safe = safeRelativePath(fp);
      pass(safe.ok, `${label}: 夹具路径不安全 ${fp}(${safe.reason})`);
      pass(typeof content === "string", `${label}: 夹具 ${fp} 内容必须是字符串`);
      try {
        // UTF-8/合法码位检查:能 round-trip 即无孤立代理项。
        pass(
          Buffer.from(content, "utf8").toString("utf8") === content,
          `${label}: 夹具 ${fp} 内容不是有效 UTF-8 文本`,
        );
      } catch {
        problems.push(`${label}: 夹具 ${fp} 内容解码失败`);
      }
      for (const [re, name] of SECRET_PATTERNS) {
        if (re.test(content))
          problems.push(`${label}: 夹具 ${fp} 疑似包含真实密钥(${name})`);
      }
    }
    // prompt 里也不允许出现密钥。
    for (const [re, name] of SECRET_PATTERNS)
      if (re.test(cs?.prompt || "")) problems.push(`${label}: prompt 疑似包含真实密钥(${name})`);
  }

  // --- 类别分布(README/路线文档 13.1) ---
  for (const [cat, count] of Object.entries(EXPECTED_CATEGORIES))
    pass(
      (categoryCount[cat] || 0) === count,
      `类别 ${cat} 数量 ${categoryCount[cat] || 0},期望 ${count}`,
    );
  pass(
    Object.keys(categoryCount).every((c) => c in EXPECTED_CATEGORIES),
    `出现规格外类别:${Object.keys(categoryCount).filter((c) => !(c in EXPECTED_CATEGORIES)).join(",")}`,
  );

  // --- 预算与故障矩阵 ---
  const budgets = protocol?.budgets || {};
  for (const key of ["wall_seconds_per_run", "max_model_turns", "max_tool_calls", "max_output_tokens_per_call"])
    pass(Number(budgets[key]) > 0, `budgets.${key} 必须为正数`);
  pass(protocol?.base_runs === 90, `base_runs=${protocol?.base_runs},期望90`);
  const faults = protocol?.fault_cases || [];
  pass(faults.length === 12, `fault_cases 数量 ${faults.length},期望12`);
  for (const f of faults) {
    for (const field of ["id", "base", "trigger", "expected", "required", "repeats"])
      pass(f?.[field] !== undefined, `故障 ${f?.id}: 缺少字段 ${field}`);
    pass(ids.includes(f?.base), `故障 ${f?.id}: base=${f?.base} 不在 30 项中`);
  }
  pass(Array.isArray(protocol?.result_fields) && protocol.result_fields.length >= 10, "result_fields 过少");
  pass((protocol?.holdout?.cases || 0) >= 10, "holdout 至少 10 项");

  // --- 特定任务规格审查(README:C03 接口约定 / D02 PDF 源) ---
  const c03 = dataset?.cases?.find((c) => c.id === "C03");
  if (c03) {
    const blob = c03.prompt + JSON.stringify(c03.fixtures);
    const hasConvention = /页码从\s*1\s*开始/.test(blob) && /正整数/.test(blob) && /抛错|抛出错误/.test(blob);
    if (hasConvention) notes.push("C03: 数据集已含分页接口约定");
    else
      notes.push(
        "C03: 数据集未含分页接口约定 → 控制器注入夹具时附加《接口约定.txt》(页码从1开始、页大小正整数、非法参数抛错);不改 cases.json",
      );
  }
  const d02 = dataset?.cases?.find((c) => c.id === "D02");
  if (d02) {
    const src = d02?.fixtures?.["contract-source.txt"];
    pass(typeof src === "string" && src.length > 20, "D02: 缺少 contract-source.txt 夹具");
    pass(/\[第1页\]/.test(src || "") && /\[第2页\]/.test(src || ""), "D02: 源文本缺少两页标记");
    for (const fact of ["12000", "2月10日", "20元"])
      pass((src || "").includes(fact), `D02: 源文本缺少关键事实 ${fact}`);
    notes.push("D02: 评估侧生成真实两页 PDF(自研 PDF 写入器+pdfjs 读回校验)后冻结哈希;被测方只收 PDF");
  }
  for (const id of ["M01", "M02"]) {
    const cs = dataset?.cases?.find((c) => c.id === id);
    if (cs)
      notes.push(
        `${id}: 底层数据仅经隔离 MCP 服务暴露,夹具不直接注入被测工作区(hideFixtures)`,
      );
  }
  notes.push("R03: 资料站以随机端口启动,动态 URL 附加进任务;localhost 不作固定端口");
  notes.push("T01/T03: 控制器按轮次发送既定补充要求(预设,不计人工救援)");

  return { ok: problems.length === 0, problems, notes, categoryCount };
}

async function main() {
  const root = resolve(process.cwd());
  const casesPath = join(root, "evals", "general-agent-v1", "cases.json");
  const protocolPath = join(root, "evals", "general-agent-v1", "protocol.json");
  const readmePath = join(root, "evals", "general-agent-v1", "README.md");
  for (const p of [casesPath, protocolPath, readmePath])
    if (!existsSync(p)) {
      console.error(`预检失败:缺少 ${p}`);
      process.exit(2);
    }
  const casesBytes = readFileSync(casesPath);
  const protocolBytes = readFileSync(protocolPath);
  let dataset, protocol;
  try {
    dataset = JSON.parse(casesBytes.toString("utf8"));
    protocol = JSON.parse(protocolBytes.toString("utf8"));
  } catch (error) {
    console.error(`数据集不是合法 JSON:${error.message}`);
    process.exit(2);
  }
  const report = runPrecheck(dataset, protocol);
  const summary = {
    stage: "dataset-precheck",
    at: new Date().toISOString(),
    dataset_version: dataset.dataset_version,
    dataset_hash: createHash("sha256").update(casesBytes).digest("hex"),
    protocol_hash: createHash("sha256").update(protocolBytes).digest("hex"),
    status: report.ok ? "pass" : "fail",
    ...report,
  };
  const outDir = join(root, "output", "eval-v1");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "precheck-report.json"), JSON.stringify(summary, null, 2));
  console.log(`数据集预检:${summary.status.toUpperCase()}`);
  console.log(`dataset=${dataset.dataset_version} hash=${summary.dataset_hash.slice(0, 16)}…`);
  for (const problem of report.problems) console.log(`  [问题] ${problem}`);
  for (const note of report.notes) console.log(`  [备注] ${note}`);
  console.log(`报告: ${join(outDir, "precheck-report.json")}`);
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) await main();

function fileURLToPath(url) {
  return new URL(url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
}
