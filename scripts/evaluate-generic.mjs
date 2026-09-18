// 通用能力基准：20 个对标 codex / claude code / zcode / hermes 的 agent 用例，
// 覆盖联网检索、编码、数据分析、文档产物、文件管理、编排、MCP、记忆、Git。
// 用法：node scripts/evaluate-generic.mjs --case=all|<name> [--repeat=1..5]
// 参考 GAIA（通用助理）、SWE-bench（代码修复）、terminal-bench（终端作业）、
// tau-bench（工具编排）的任务形态；全部用例程序化验收，fixtures 确定性生成。
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join, basename, extname } from "node:path";
import http from "node:http";
import {
  WorkspaceDatabase,
  WorkspaceService,
  createProvider,
} from "../server/core/index.mjs";
import { providerConfigured } from "../server/core/provider-status.mjs";
import { GitWorkspace } from "../server/core/git-workspace.mjs";
import { sourceFingerprint } from "./source-fingerprint.mjs";
import { startAcceptanceMcp } from "./acceptance-mcp.mjs";

const { values } = parseArgs({
  options: {
    case: { type: "string", default: "all" },
    repeat: { type: "string", default: "1" },
    image: { type: "string", default: "open-medical-runtime:0.8-full" },
    directory: { type: "string" },
  },
});
export const CASE_NAMES = [
  "web-search",
  "web-fetch",
  "web-research-report",
  "code-repair-auto",
  "code-write-tests",
  "bug-hunt",
  "refactor-rename",
  "log-analysis",
  "csv-analysis",
  "documents",
  "json-transform",
  "file-org",
  "search-extract",
  "code-orchestrate",
  "delegate-parallel",
  "mcp",
  "memory",
  "translate-summary",
  "chart-png",
  "git-changelog",
];
const repeats = Number(values.repeat);
const cases =
  values.case === "all" ? CASE_NAMES : [values.case];
if (
  !Number.isInteger(repeats) ||
  repeats < 1 ||
  repeats > 5 ||
  cases.some((c) => !CASE_NAMES.includes(c))
)
  throw new Error(
    `Use --case=all|${CASE_NAMES.join("|")} --repeat=1..5`,
  );

if (existsSync(".env")) process.loadEnvFile(".env");
const provider = createProvider();
const directory = resolve(
  values.directory || `output/generic-benchmark-${Date.now()}`,
);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const report = {
  startedAt: Date.now(),
  provider: provider.provider,
  model: provider.model,
  sourceFingerprint: sourceFingerprint(),
  platform: process.platform,
  arch: process.arch,
  syntheticDataOnly: true,
  modelType: "real-provider",
  status: "running",
  results: [],
};
const save = () =>
  writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });

let db = new WorkspaceDatabase(join(directory, "benchmark.sqlite"));
let service = new WorkspaceService(db.db, provider);
const cleanups = [];

// ---------- 共享工具 ----------
async function terminal(id, command, { snapshot = true } = {}) {
  let result = await service.tool(id, { tool: "terminal_run", arguments: { command, snapshot } });
  while (["running", "finalizing"].includes(result?.status))
    result = await service.tool(id, { tool: "terminal_wait", arguments: { id: result.id, timeoutMs: 30000 } });
  return result;
}
function require(value, message) {
  if (!value) throw new Error(message);
}
function apply(id, allowedPaths) {
  const pending = service
    .get(id)
    .approvals.filter((a) => a.status === "pending");
  require(pending.length > 0, "模型没有产出文件修改提案");
  if (allowedPaths)
    require(
      pending.every((a) => allowedPaths.includes(a.path)),
      `提案超出验收范围：${pending.map((a) => a.path).join(", ")}`,
    );
  for (const approval of pending)
    service.decide(id, approval.id, {
      revision: service.get(id).revision,
      decision: "approve",
    });
}
function events(id) {
  return service.store.events(id, 0, 1000);
}
function toolResults(id, runId, name) {
  const rows = service.store.db
    .prepare(
      "SELECT data FROM agent_trace WHERE workspace_id=? AND run_id=? ORDER BY id",
    )
    .all(id, runId);
  return rows
    .map((r) => JSON.parse(r.data))
    .filter((t) => t.type === "tool.result" && t.call?.function?.name === name)
    .map((t) => {
      let args = null;
      try {
        args = JSON.parse(t.call.function.arguments);
      } catch {
        args = null;
      }
      return { args, output: t.output };
    });
}
function succeeded(output) {
  return output && !output.error && !output.code;
}
// 确定性伪随机（LCG），保证 fixtures 与验收数字跨次运行一致。
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function startLocalPage(rows) {
  const html = `<!doctype html><html><body><h1>零件库存</h1>
<table><tr><th>零件</th><th>数量</th></tr>
${rows.map(([n, q]) => `<tr><td>${n}</td><td>${q}</td></tr>`).join("\n")}
</table><p>库存编码：QX-7788</p></body></html>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}
async function runAgent(id, message, extra = {}) {
  const handle = service.prepare(id, {
    revision: service.get(id).revision,
    message,
    externalConsent: true,
    ...extra,
    limits: { maxRounds: 48, timeoutMs: 600000, maxContextChars: 60000 },
  });
  const execution = await service.execute(handle);
  require(
    execution.status === "completed",
    `任务未完成：${execution.error || execution.status}`,
  );
  return service.get(id).runs.at(-1);
}

// ---------- 各用例 fixture + prompt + 验收 ----------
const buildCases = {
  "web-search"(_root) {
    const prompt =
      "用 web_search 联网搜索：Node.js 当前官方推荐的 LTS 版本号是多少？回答中必须给出版本号、来源标题和来源 URL（来自真实搜索结果，不得编造）。";
    return {
      prompt,
      configure: { browser: true, origins: [] },
      async verify(id, run, _rootDir) {
        const answer = run.partial || "";
        const searches = toolResults(id, run.id, "web_search");
        require(
          searches.some((s) => succeeded(s.output) && (s.output.results?.length || 0) > 0),
          "web_search 没有返回真实结果",
        );
        require(/https?:\/\//.test(answer), "回答中没有引用来源 URL");
        require(/lts|版本|version/i.test(answer), "回答缺少版本表述");
        return ["真实搜索结果", "回答含 URL", "回答含版本"];
      },
    };
  },
  async "web-fetch"(_root) {
    const rows = [
      ["传动轴", 12],
      ["万向节", 9],
      ["联轴器", 13],
    ];
    const server = await startLocalPage(rows);
    cleanups.push(() => server.close());
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/inventory.html`;
    const prompt = `用 web_fetch 读取 ${url} 页面，回答：页面里的库存编码是什么？三种零件的数量总和是多少？`;
    return {
      prompt,
      configure: { browser: true, origins: [`http://127.0.0.1:${port}`] },
      async verify(id, run) {
        const fetches = toolResults(id, run.id, "web_fetch");
        require(fetches.length > 0 && succeeded(fetches[0].output), "web_fetch 没有成功执行");
        const answer = run.partial || "";
        require(answer.includes("QX-7788"), "回答缺少库存编码 QX-7788");
        require(answer.includes("34"), "回答缺少数量总和 34");
        return ["授权来源抓取", "编码正确", "总和正确"];
      },
    };
  },
  "web-research-report"(_root) {
    const prompt =
      "用 web_search 调研「PostgreSQL 18 的主要新特性」，然后基于搜索结果摘要生成 report.md 文件提案：至少 5 个要点，每个要点标注来源标题与 URL，文末「参考链接」列至少 2 条真实搜索结果的 URL。只依据搜索结果，不得编造。";
    return {
      prompt,
      configure: { browser: true, origins: [] },
      async verify(id, run, rootDir) {
        const searches = toolResults(id, run.id, "web_search");
        require(
          searches.some((s) => succeeded(s.output) && (s.output.results?.length || 0) > 0),
          "web_search 没有返回真实结果",
        );
        apply(id, ["report.md"]);
        const text = readFileSync(join(rootDir, "report.md"), "utf8");
        const links = text.match(/https?:\/\/[^\s)\]]+/g) || [];
        require(links.length >= 2, "report.md 参考链接少于 2 条");
        require(/postgres/i.test(text), "report.md 缺少主题内容");
        return ["真实搜索", "报告落盘", `引用 ${links.length} 条链接`];
      },
    };
  },
  "code-repair-auto"(root) {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, "package.json"), '{"type":"module","scripts":{"test":"node --test"}}');
    writeFileSync(
      join(root, "README.md"),
      "A small statistics package. mean computes the arithmetic mean of finite numeric inputs, preserving zeros. Empty input returns null. Run npm test. Do not modify tests.\n",
    );
    writeFileSync(
      join(root, "src/statistics.mjs"),
      "export function mean(values) { const numbers = values.filter(Boolean).filter(Number.isFinite); return numbers.length ? numbers.reduce((a,b)=>a+b,0)/numbers.length : null; }\n",
    );
    writeFileSync(
      join(root, "tests/statistics.test.mjs"),
      "import test from 'node:test'; import assert from 'node:assert/strict'; import {mean} from '../src/statistics.mjs';\n" +
        [
          ["zero", [0, 2], 1],
          ["only zero", [0], 0],
          ["empty", [], null],
          ["ordinary", [2, 4], 3],
          ["negative", [-2, 0, 2], 0],
        ]
          .map(([label, input, expected]) => `test(${JSON.stringify(label)},()=>assert.equal(mean(${JSON.stringify(input)}),${expected}));`)
          .join("\n"),
    );
    const prompt =
      "请定位并修复陌生仓库的失败测试。先运行现有测试确认问题，再阅读相关文件，只修改源码，不要改测试或 package.json。当前工作区已授权自动应用文件修改和本地 Git 提交；实际修复后快照运行完整测试，通过后用 git_commit 提交源码，最后交付修复解释、测试结果和提交信息。";
    return {
      prompt,
      configure: { browser: false, origins: [], terminal: true },
      auto: true,
      async setup(rootDir) {
        const git = new GitWorkspace(rootDir);
        await git.command(["init", "-q"]);
        await git.command(["config", "user.name", "Benchmark Fixture"]);
        await git.command(["config", "user.email", "fixture@example.invalid"]);
        await git.command(["add", "."]);
        await git.command(["commit", "-qm", "fixture baseline"]);
      },
      async verify(id, run, rootDir) {
        // 「先复现再修复」按工具轨迹顺序判断：npm test 必须先于修复提案。
        // 不校验首次测试的退出码——`npm test | tail` 这类管道会吞掉非零码，
        // 但模型实际读到了输出。
        const names = service.store.db
          .prepare(
            "SELECT data FROM agent_trace WHERE workspace_id=? AND run_id=? ORDER BY id",
          )
          .all(id, run.id)
          .map((r) => {
            const d = JSON.parse(r.data);
            return d.type === "tool.result" ? d.call?.function?.name : null;
          });
        const testIdx = names.findIndex((n) => n === "terminal_run");
        const proposeIdx = names.findIndex((n) =>
          n?.startsWith("propose_file"),
        );
        require(
          testIdx >= 0 && proposeIdx > testIdx,
          "agent 没有先运行测试再提交修复提案",
        );
        const checks = service.store.get(id).verifications || [];
        require(checks.some((v) => v.exitCode === 0), "agent 没有验证修复后测试通过");
        const result = await terminal(id, "npm test");
        require(result.exitCode === 0, "修复后 npm test 仍失败");
        const status = await new GitWorkspace(rootDir).status();
        require(!status.entries.length, "自动流程留下了未提交改动");
        require(
          events(id).some((e) => e.type === "git.commit.completed"),
          "agent 没有执行本地 Git 提交",
        );
        return ["先测后修", "修复通过", "测试未被改动", "已提交"];
      },
    };
  },
  "code-write-tests"(root) {
    writeFileSync(join(root, "package.json"), '{"type":"module","scripts":{"test":"node --test"}}');
    const prompt =
      "从零实现一个 LRU 缓存：在 src/lru.mjs 导出类 LRUCache，constructor(capacity)；get(key) 命中返回值并提升为最近使用，未命中返回 null；put(key,value) 写入并提升，超过容量淘汰最久未使用的键。先在 tests/lru.test.mjs 用 node:test 写用例，覆盖：超容量淘汰最旧、get 提升顺序、更新已有 key 不增加长度。然后在隔离终端运行 npm test 直到通过，交付实现说明和测试结果。";
    return {
      prompt,
      configure: { browser: false, origins: [], terminal: true },
      async verify(id, run, rootDir) {
        apply(id, ["src/lru.mjs", "tests/lru.test.mjs"]);
        require(existsSync(join(rootDir, "src/lru.mjs")), "实现文件不存在");
        require(existsSync(join(rootDir, "tests/lru.test.mjs")), "测试文件不存在");
        const result = await terminal(id, "npm test");
        require(result.exitCode === 0, `npm test 失败：${result.output?.slice(0, 200)}`);
        return ["TDD 两文件落盘", "npm test 通过"];
      },
    };
  },
  "bug-hunt"(root) {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(
      join(root, "src/search.js"),
      `// 二分查找：返回 target 的下标，不存在返回 -1。\nfunction binarySearch(arr, target) {\n  let left = 0;\n  let right = arr.length;\n  while (left <= right) {\n    const mid = Math.floor((left + right) / 2);\n    if (arr[mid] === target) return mid;\n    if (arr[mid] < target) left = mid + 1;\n    else right = mid - 1;\n  }\n  return -1;\n}\nmodule.exports = { binarySearch };\n`,
    );
    writeFileSync(
      join(root, "test/search.test.js"),
      `const assert = require('assert');\nconst { binarySearch } = require('../src/search.js');\n// 预期：应返回 4（最后一个元素），当前实现返回 -1。\nconsole.log('bug-report: binarySearch([1,3,5,7,9], 9) =>', binarySearch([1,3,5,7,9], 9));\nassert.ok(true);\n`,
    );
    const prompt =
      "仓库里 src/search.js 的 binarySearch 有 bug：查找数组最后一个元素会错误返回 -1（见 test/search.test.js 里的 bug-report 注释）。本次任务禁止使用任何终端命令，只通过阅读源码定位根因，提交 src/search.js 的修复提案（propose_file_edit 或 propose_file_write），并在回答中解释根因与修复方式。";
    return {
      prompt,
      configure: { browser: false, origins: [], terminal: false },
      async verify(id, run, rootDir) {
        apply(id, ["src/search.js"]);
        const text = readFileSync(join(rootDir, "src/search.js"), "utf8");
        require(/right\s*=\s*arr\.length\s*-\s*1/.test(text), "修复没有把 right 边界改为 length-1");
        require(
          events(id).every((e) => !["terminal_run", "code_execute"].includes(e.payload?.tool)),
          "禁用终端的任务里出现了终端调用",
        );
        require(/边界|bound|length|越界|off.by.one/i.test(run.partial || ""), "回答没有解释根因");
        return ["静态定位", "修复正确", "未越权用终端"];
      },
    };
  },
  "refactor-rename"(root) {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "package.json"), '{"type":"module","scripts":{"test":"node --test"}}');
    writeFileSync(
      join(root, "src/pricing.mjs"),
      "export function calcTotal(items) {\n  return items.reduce((sum, item) => sum + item.price * item.qty, 0);\n}\n",
    );
    writeFileSync(
      join(root, "src/invoice.mjs"),
      "import { calcTotal } from './pricing.mjs';\nexport function invoiceLines(items) {\n  return items.map((item) => `${item.name}: ${item.price * item.qty}`);\n}\nexport function invoiceTotal(items) {\n  return calcTotal(items);\n}\n",
    );
    writeFileSync(
      join(root, "src/report.mjs"),
      "import { calcTotal } from './pricing.mjs';\nexport function reportSummary(items) {\n  return { lines: items.length, total: calcTotal(items) };\n}\n",
    );
    writeFileSync(
      join(root, "tests/pricing.test.mjs"),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { calcTotal } from '../src/pricing.mjs';\ntest('sums items', () => assert.equal(calcTotal([{ price: 2, qty: 3 }, { price: 5, qty: 1 }]), 11));\n",
    );
    const prompt =
      "把 src/pricing.mjs 导出的 calcTotal 重命名为 computeTotal：更新所有 import 与调用（src/invoice.mjs、src/report.mjs、tests/pricing.test.mjs），保持行为不变。先用 search_files 找齐引用，再提交修改提案，批准后用隔离终端 npm test 验证通过。";
    return {
      prompt,
      configure: { browser: false, origins: [], terminal: true },
      async verify(id, _run, _rootDir) {
        apply(id, ["src/pricing.mjs", "src/invoice.mjs", "src/report.mjs", "tests/pricing.test.mjs"]);
        const result = await terminal(id, "grep -rn calcTotal src tests || true");
        require(!/calcTotal/.test(result.output || ""), "旧名称仍残留");
        const test = await terminal(id, "npm test");
        require(test.exitCode === 0, "重命名后 npm test 失败");
        return ["引用找齐", "旧名零残留", "测试通过"];
      },
    };
  },
  "log-analysis"(root) {
    const rand = lcg(42);
    const modules = ["auth", "db", "api", "pay"];
    const lines = [];
    let errorCount = 0;
    let warnCount = 0;
    const moduleErrors = { auth: 0, db: 0, api: 0, pay: 0 };
    for (let i = 0; i < 300; i++) {
      const roll = rand();
      const mod = modules[Math.floor(rand() * 4)];
      let level = "INFO";
      if (roll > 0.85) {
        level = "ERROR";
        errorCount++;
        moduleErrors[mod]++;
      } else if (roll > 0.7) {
        level = "WARN";
        warnCount++;
      }
      const minute = String(Math.floor(rand() * 60)).padStart(2, "0");
      lines.push(`2026-09-01T10:${minute}:${String(Math.floor(rand() * 60)).padStart(2, "0")}Z ${level} ${mod} request id=${i} status=${Math.floor(rand() * 4) + 1}xx`);
    }
    writeFileSync(join(root, "app.log"), lines.join("\n") + "\n");
    const top = Object.entries(moduleErrors).sort((a, b) => b[1] - a[1])[0];
    const prompt =
      "用隔离终端统计 app.log：ERROR 总条数、WARN 总条数、以及 ERROR 条目里出现最多的模块名。把三项结果写入 log-report.md 文件提案，每行一项，格式形如「ERROR: 17」「WARN: 45」「TOP: auth」（数字以你的统计为准）。";
    return {
      prompt,
      configure: { browser: false, origins: [], terminal: true },
      async verify(id, run, rootDir) {
        apply(id, ["log-report.md"]);
        const text = readFileSync(join(rootDir, "log-report.md"), "utf8");
        require(text.includes(String(errorCount)), `报告缺少 ERROR 数 ${errorCount}`);
        require(text.includes(String(warnCount)), `报告缺少 WARN 数 ${warnCount}`);
        require(text.includes(top[0]), `报告缺少 Top 模块 ${top[0]}`);
        return [`ERROR=${errorCount}`, `WARN=${warnCount}`, `TOP=${top[0]}`];
      },
    };
  },
  "csv-analysis"(root) {
    const rand = lcg(2026);
    const regions = ["华东", "华北", "华南", "西南"];
    const rows = [];
    const regionSum = Object.fromEntries(regions.map((r) => [r, 0]));
    const monthSum = {};
    for (let i = 0; i < 120; i++) {
      const month = 1 + Math.floor(i / 20);
      const region = regions[Math.floor(rand() * 4)];
      const amount = 100 + Math.floor(rand() * 900);
      regionSum[region] += amount;
      monthSum[month] = (monthSum[month] || 0) + amount;
      rows.push(`2026-0${month}-15,${region},${amount}`);
    }
    const total = Object.values(regionSum).reduce((a, b) => a + b, 0);
    const topRegion = Object.entries(regionSum).sort((a, b) => b[1] - a[1])[0][0];
    const topMonth = Object.entries(monthSum).sort((a, b) => b[1] - a[1])[0][0];
    writeFileSync(join(root, "sales.csv"), "date,region,amount\n" + rows.join("\n") + "\n");
    const prompt =
      "读取 sales.csv（列：date,region,amount），用终端或计算工具完成分析，生成 analysis.md 文件提案，必须包含：① 全年销售总额（数字）② 销售额最高的地区名称 ③ 销售额最高的月份（格式 2026-0X）。数字要精确，说明你的计算方法。";
    return {
      prompt,
      configure: { browser: false, origins: [], terminal: true },
      async verify(id, run, rootDir) {
        apply(id, ["analysis.md"]);
        const text = readFileSync(join(rootDir, "analysis.md"), "utf8");
        require(text.includes(String(total)), `缺少总额 ${total}`);
        require(text.includes(topRegion), `缺少最高地区 ${topRegion}`);
        require(text.includes(`2026-0${topMonth}`), `缺少最高月份 2026-0${topMonth}`);
        return [`总额=${total}`, `地区=${topRegion}`, `月份=2026-0${topMonth}`];
      },
    };
  },
  documents(root) {
    writeFileSync(join(root, "sales.csv"), "item,quantity\nAlpha,4\nBeta,6\n");
    const prompt =
      "读取 sales.csv，生成 report.pdf、report.xlsx 和 summary.md 三份成果。PDF 用英文列出 Alpha=4、Beta=6 及总数10；Excel 工作表 Summary 含 Item/Quantity 表头、Alpha 4、Beta 6、Total 10 四行，使用数值；Markdown 说明来源、明细和总数10。PDF/Excel 用 document_create 产生可下载成果，Markdown 产生文件提案。生成后读取校验，再交付。";
    return {
      prompt,
      configure: { browser: false, origins: [], terminal: true },
      async verify(id, run, rootDir) {
        apply(id, ["summary.md"]);
        require(/10/.test(readFileSync(join(rootDir, "summary.md"), "utf8")), "Markdown 缺少总数");
        for (const extension of ["pdf", "xlsx"]) {
          const item = (service.store.get(id).artifacts || []).find((a) =>
            basename(a.name).endsWith("report." + extension),
          );
          require(item, `缺少可下载成果 report.${extension}`);
          const result = await service.tool(id, { tool: "document_read", arguments: { artifactId: item.id } });
          require(result.exitCode === 0, `report.${extension} 无法读取`);
          const parsed = JSON.parse(result.output.trim()).result;
          if (extension === "xlsx")
            require(
              JSON.stringify(parsed.sheets?.find((s) => s.name === "Summary")?.rows) ===
                JSON.stringify([["Item", "Quantity"], ["Alpha", 4], ["Beta", 6], ["Total", 10]]),
              "Excel 内容与源数据不一致",
            );
          else
            require(/Alpha/.test(JSON.stringify(parsed)) && /10/.test(JSON.stringify(parsed)), "PDF 内容不完整");
        }
        return ["PDF 可读回", "Excel 单元格精确", "Markdown 落盘"];
      },
    };
  },
  "json-transform"(root) {
    const rand = lcg(7);
    const statuses = ["shipped", "pending", "cancelled"];
    const orders = Array.from({ length: 40 }, (_, i) => ({
      id: `ORD-${String(i + 1).padStart(3, "0")}`,
      customer: `customer_${Math.floor(rand() * 8) + 1}`,
      status: statuses[Math.floor(rand() * 3)],
      total: 50 + Math.floor(rand() * 950),
    }));
    writeFileSync(join(root, "orders.json"), JSON.stringify(orders, null, 2) + "\n");
    const shipped = orders
      .filter((o) => o.status === "shipped")
      .sort((a, b) => b.total - a.total);
    const expected = {
      count: shipped.length,
      orders: shipped,
      grandTotal: shipped.reduce((s, o) => s + o.total, 0),
    };
    const prompt =
      "读取 orders.json，筛选 status 为 shipped 的订单，按 total 从高到低排序，生成 processed.json 文件提案，结构必须是：{ \"count\": 数量, \"orders\": [原始订单对象数组], \"grandTotal\": total 合计 }。不得改动订单对象内容，最后用工具或计算核对你输出的 JSON 与预期一致。";
    return {
      prompt,
      configure: { browser: false, origins: [], terminal: true },
      async verify(id, run, rootDir) {
        apply(id, ["processed.json"]);
        const actual = JSON.parse(readFileSync(join(rootDir, "processed.json"), "utf8"));
        require(
          JSON.stringify(actual) === JSON.stringify(expected),
          `processed.json 与预期不一致（count=${actual.count}，期望 ${expected.count}）`,
        );
        return [`count=${expected.count}`, `grandTotal=${expected.grandTotal}`, "JSON 精确一致"];
      },
    };
  },
  "file-org"(root) {
    const files = [
      "photo1.jpg", "photo2.jpg", "photo3.jpeg", "diagram1.png", "diagram2.png",
      "contract.pdf", "manual.pdf", "invoice.pdf", "users.csv", "orders.csv",
      "metrics.csv", "notes.md", "readme.md", "backup.zip",
    ];
    for (const f of files) writeFileSync(join(root, f), `fixture ${f}\n`);
    const prompt =
      "整理当前目录的 14 个散落文件：images/ 收 jpg、jpeg、png；documents/ 收 pdf、md；data/ 收 csv；archives/ 收 zip。用隔离终端 mkdir + mv 完成，只移动不删除、不重命名，完成后列出最终目录树。";
    return {
      prompt,
      configure: { browser: false, origins: [], terminal: true },
      async verify(id, run, rootDir) {
        // 终端内的 mv/mkdir 同步回宿主时变成「新路径写入 + 旧路径删除」提案。
        // 同一副作用可能被多轮终端重复产出，按路径去重只批准第一份，
        // 避免同路径第二份提案在第一份应用后版本冲突。
        const seen = new Set();
        const pending = service
          .get(id)
          .approvals.filter((a) => a.status === "pending");
        require(pending.length > 0, "模型没有产出文件整理提案");
        for (const approval of pending) {
          if (seen.has(approval.path)) continue;
          seen.add(approval.path);
          service.decide(id, approval.id, {
            revision: service.get(id).revision,
            decision: "approve",
          });
        }
        const expect = {};
        for (const f of files) {
          const ext = extname(f).slice(1);
          const dir = ["jpg", "jpeg", "png"].includes(ext) ? "images" : ["pdf", "md"].includes(ext) ? "documents" : ext === "csv" ? "data" : "archives";
          expect[f] = dir;
        }
        // 产品边界：二进制（jpg/png/pdf/zip）只进成果库不写回宿主，原文件
        // 必须保留；文本文件（csv/md）应完成宿主归类。
        const binaryExt = /\.(jpg|jpeg|png|pdf|zip)$/i;
        let textMoved = 0;
        for (const [f, dir] of Object.entries(expect)) {
          if (binaryExt.test(f)) {
            require(
              existsSync(join(rootDir, f)),
              `二进制原文件 ${f} 被删除（应保留在根目录）`,
            );
            continue;
          }
          require(existsSync(join(rootDir, dir, f)), `${f} 没有移动到 ${dir}/`);
          require(!existsSync(join(rootDir, f)), `${f} 仍留在根目录`);
          textMoved++;
        }
        const artifacts = service.store.get(id).artifacts || [];
        require(
          artifacts.some((a) => /^images\/photo/.test(a.name)),
          "被移动的二进制文件没有生成副本成果",
        );
        require(
          (run.partial || "").includes("成果") || /artifact/i.test(run.partial || ""),
          "回答没有说明二进制副本进入了成果库",
        );
        return [`${textMoved} 个文本文件归类正确`, "二进制原文件保留", "副本入成果库"];
      },
    };
  },
  "search-extract"(root) {
    const withTodo = [2, 5, 9, 12, 16, 19];
    for (let i = 1; i <= 20; i++) {
      const lines = [`# 笔记 ${i}`, "常规内容行。"];
      if (withTodo.includes(i)) lines.push(`TODO: 修复第 ${i} 号笔记里描述的问题`);
      lines.push(i % 3 === 0 ? "完成事项 DONE。" : "普通备注。");
      writeFileSync(join(root, `note-${String(i).padStart(2, "0")}.md`), lines.join("\n") + "\n");
    }
    const prompt =
      "用 search_files 检索所有包含「TODO:」的 Markdown 文件，然后把结果汇总到 todos.md 文件提案：每个命中的文件一行，格式「文件名: 行号: TODO 内容摘录」。只列真实命中的文件，不要遗漏也不要虚构。";
    return {
      prompt,
      configure: { browser: false, origins: [], terminal: false },
      async verify(id, run, rootDir) {
        apply(id, ["todos.md"]);
        const text = readFileSync(join(rootDir, "todos.md"), "utf8");
        for (const i of withTodo)
          require(text.includes(`note-${String(i).padStart(2, "0")}.md`), `缺少 note-${String(i).padStart(2, "0")}.md`);
        const mentioned = (text.match(/note-\d+\.md/g) || []).filter((v, i, a) => a.indexOf(v) === i);
        require(mentioned.length === withTodo.length, `todos.md 列出了 ${mentioned.length} 个文件，期望 ${withTodo.length} 个`);
        return ["6 个 TODO 文件找齐", "无误报"];
      },
    };
  },
  "code-orchestrate"(root) {
    mkdirSync(join(root, "parts"), { recursive: true });
    const rand = lcg(99);
    const sums = [];
    for (let p = 1; p <= 3; p++) {
      const nums = Array.from({ length: 50 }, () => 1 + Math.floor(rand() * 100));
      sums.push(nums.reduce((a, b) => a + b, 0));
      writeFileSync(join(root, `parts/part${p}.txt`), nums.join("\n") + "\n");
    }
    const total = sums.reduce((a, b) => a + b, 0);
    const prompt = `parts/part1.txt、parts/part2.txt、parts/part3.txt 各含 50 个数字。要求用一次 code_execute，在代码里用 Promise.all 并行调用 tools.read_file 读取三个文件，计算所有数字之和并 return。然后把总和告诉我。`;
    return {
      prompt,
      configure: { browser: false, origins: [], terminal: true },
      async verify(id, run) {
        const execs = toolResults(id, run.id, "code_execute");
        require(execs.length >= 1, "没有使用 code_execute 编排");
        const parallel = execs.find(
          (e) =>
            succeeded(e.output) &&
            /Promise\.all/.test(e.args?.code || "") &&
            /tools\.read_file/.test(e.args?.code || ""),
        );
        require(parallel, "没有一次成功且用 Promise.all 并行 tools.read_file 的 code_execute");
        const flat = (run.partial || "").replace(/[,，\s]/g, "");
        require(flat.includes(String(total)), `回答缺少总和 ${total}`);
        return ["code_execute 并行编排", `总和=${total}`];
      },
    };
  },
  "delegate-parallel"(root) {
    mkdirSync(join(root, "chapters"), { recursive: true });
    const counts = [];
    const words = [
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega",
      "north south east west center upper lower inner outer first second third fourth fifth sixth seventh eighth ninth tenth",
      "red orange yellow green blue indigo violet black white gray brown purple golden silver bronze coral crimson magenta",
    ];
    for (let c = 1; c <= 3; c++) {
      const text = Array.from({ length: 5 }, () => words[c - 1]).join(" ");
      counts.push(text.trim().split(/\s+/).length);
      writeFileSync(join(root, `chapters/ch${c}.txt`), text + "\n");
    }
    const total = counts.reduce((a, b) => a + b, 0);
    const prompt = `用 delegate_tasks 并行委派 3 个子任务，分别统计 chapters/ch1.txt、chapters/ch2.txt、chapters/ch3.txt 各自的英文单词数（按空白切分）。收齐后把三个文件的词数与总计告诉我，并生成 word-count.md 文件提案记录四个数字。`;
    return {
      prompt,
      configure: { browser: false, origins: [], terminal: false },
      async verify(id, run, rootDir) {
        const children = run.children || [];
        require(children.length >= 3, `子任务少于 3 个：${children.length}`);
        require(children.every((c) => c.status === "completed"), "有子任务未完成");
        apply(id, ["word-count.md"]);
        const text = readFileSync(join(rootDir, "word-count.md"), "utf8");
        require(text.includes(String(total)), `缺少总计 ${total}`);
        return ["3 子任务并行完成", `总计=${total}`];
      },
    };
  },
  async mcp(_root) {
    const mcp = await startAcceptanceMcp();
    cleanups.push(mcp.close);
    const prompt =
      "查询已授权 MCP 服务器 inventory 中 demo 仓库的库存：先发现它的工具与参数再调用。遇到临时查询失败时分析错误并重试。把返回的 batch、rows 原样保存为 inventory.json 文件提案，并增加 total 字段为 quantity 合计。数据必须来自实际工具结果，不能编造。";
    return {
      prompt,
      configure: { browser: false, origins: [], terminal: true, mcp: true, mcpOrigin: new URL(mcp.url).origin },
      async verify(id, run, rootDir) {
        apply(id, ["inventory.json"]);
        const output = JSON.parse(readFileSync(join(rootDir, "inventory.json"), "utf8"));
        require(mcp.calls() >= 2, "模型没有在临时失败后重试");
        require(
          output.batch === mcp.batch && JSON.stringify(output.rows) === JSON.stringify(mcp.rows) && output.total === 46,
          "保存的 MCP 数据与实际响应不一致",
        );
        return ["工具发现", "失败重试", "数据一致"];
      },
    };
  },
  "memory"(_root) {
    const prompts = [
      "请把这条信息保存到工作区记忆：本项目的应急联络口令是 BAO-4471，仅限值班人员使用。保存后告诉我已保存。",
      "用记忆工具查一下：我们之前保存的应急联络口令是什么？",
    ];
    return {
      prompt: prompts[0],
      configure: { browser: false, origins: [], terminal: false, memoryRead: true, memoryWrite: true },
      async verify(id, run1, _rootDir) {
        const adds = toolResults(id, run1.id, "memory_add");
        require(adds.some((a) => succeeded(a.output)), "memory_add 没有成功");
        const run2 = await runAgent(id, prompts[1]);
        const searches = toolResults(id, run2.id, "memory_search");
        require(searches.length > 0, "第二轮没有调用 memory_search");
        require((run2.partial || "").includes("BAO-4471"), "第二轮回答没有召回口令");
        return ["记忆保存", "跨轮召回"];
      },
    };
  },
  "translate-summary"(root) {
    writeFileSync(
      join(root, "tech-zh.md"),
      [
        "# 高并发订单系统设计notes",
        "",
        "本系统采用多级缓存架构缓解数据库压力：本地缓存负责热点商品目录，分布式缓存存储会话与购物车，命中率长期保持在 96% 以上。",
        "数据层按用户 ID 做水平分片，配合订单时间的冷热分离，单表规模控制在两千万行以内。",
        "在促销高峰，端到端延迟的 P99 控制在 180 毫秒；为此我们引入了请求合并与异步落库，削峰后写入放大下降约 40%。",
        "监控方面，缓存命中率、分片倾斜度和 P99 延迟是三个核心指标，任何一项越界都会触发自动扩容。",
      ].join("\n") + "\n",
    );
    const prompt =
      "阅读 tech-zh.md，写一份不超过 120 个英文单词的英文执行摘要，保存为 summary-en.md 文件提案。摘要必须覆盖三个主题：缓存（cache）、分片（sharding）、延迟（latency）。用完整英文句子，不得包含中文。";
    return {
      prompt,
      configure: { browser: false, origins: [], terminal: false },
      async verify(id, run, rootDir) {
        apply(id, ["summary-en.md"]);
        const text = readFileSync(join(rootDir, "summary-en.md"), "utf8");
        require(!/[\u4e00-\u9fff]/.test(text), "摘要包含中文");
        const words = text.trim().split(/\s+/).length;
        require(words <= 160, `摘要超出长度：${words} 词`);
        require(/cache/i.test(text) && /shard/i.test(text) && /latency/i.test(text), "摘要未覆盖三个主题");
        return ["纯英文", `${words} 词`, "三主题齐全"];
      },
    };
  },
  "chart-png"(root) {
    const rand = lcg(11);
    const rows = ["month,sales"];
    for (let m = 1; m <= 12; m++) rows.push(`2026-${String(m).padStart(2, "0")},${500 + Math.floor(rand() * 500)}`);
    writeFileSync(join(root, "data.csv"), rows.join("\n") + "\n");
    const prompt =
      "用隔离终端的 Python 读取 data.csv（列 month,sales），生成一张 12 个月销售额的柱状图，保存为工作区根目录下的 chart.png。要求图上能看到每月数值差异、有坐标轴标签。完成后确认 chart.png 已生成并报告文件大小。容器 python 环境 /opt/agent-python 可用，如缺库可尝试终端联网安装或用已装库（如 pillow）绘制。";
    return {
      prompt,
      configure: { browser: false, origins: [], terminal: true, terminalNetwork: true },
      async verify(id, _run, _rootDir) {
        // 容器产出的二进制文件按设计进入成果库（不覆盖宿主工作区）。
        const item = (service.store.get(id).artifacts || []).find((a) =>
          /chart\.png$/i.test(a.name),
        );
        require(item, "chart.png 没有生成为可下载成果");
        require(item.size > 5000, `chart.png 太小（${item.size} 字节）`);
        const { data } = service.artifacts.read(id, item.id);
        require(data[0] === 0x89 && data[1] === 0x50, "chart.png 不是 PNG 格式");
        return [`PNG ${(item.size / 1024).toFixed(0)}KB 成果`];
      },
    };
  },
  async "git-changelog"(root) {
    writeFileSync(join(root, "app.js"), "console.log('v1');\n");
    const git = new GitWorkspace(root);
    await git.command(["init", "-q"]);
    await git.command(["config", "user.name", "Benchmark Fixture"]);
    await git.command(["config", "user.email", "fixture@example.invalid"]);
    await git.command(["add", "."]);
    await git.command(["commit", "-qm", "feat: initial order service"]);
    writeFileSync(join(root, "app.js"), "console.log('v2');\n");
    writeFileSync(join(root, "utils.js"), "export const fmt = (n) => n.toFixed(2);\n");
    await git.command(["add", "."]);
    await git.command(["commit", "-qm", "fix: rounding in invoice formatter"]);
    writeFileSync(join(root, "docs.md"), "# docs\nusage notes\n");
    await git.command(["add", "."]);
    await git.command(["commit", "-qm", "docs: add usage notes"]);
    const prompt =
      "用 git_log 查看本仓库最近 3 条提交（工具会返回每条提交变更的文件清单），据此生成 CHANGELOG.md 文件提案：按时间从新到旧列出三条提交主题，每条下注明涉及文件。内容必须来自真实工具结果，不得编造。";
    return {
      prompt,
      configure: { browser: false, origins: [], terminal: true },
      async verify(id, run, rootDir) {
        apply(id, ["CHANGELOG.md"]);
        const text = readFileSync(join(rootDir, "CHANGELOG.md"), "utf8");
        require(text.includes("docs: add usage notes"), "缺少第 1 条提交主题");
        require(text.includes("fix: rounding in invoice formatter"), "缺少第 2 条提交主题");
        require(text.includes("feat: initial order service"), "缺少第 3 条提交主题");
        const gitRuns =
          toolResults(id, run.id, "git_log").filter((t) => succeeded(t.output)) ||
          [];
        require(gitRuns.length > 0, "没有成功调用 git_log 工具");
        require(
          gitRuns[0].output.entries?.length >= 3 &&
            gitRuns[0].output.entries.some((e) => e.files?.length > 0),
          "git_log 没有返回提交的文件清单",
        );
        return ["3 条主题准确", "真实 git log"];
      },
    };
  },
};

// ---------- 执行 ----------
if (!providerConfigured(provider)) {
  report.status = "blocked";
  report.reason = "未配置模型凭据；未发起真实模型请求";
  save();
  console.error(report.reason);
  process.exitCode = 2;
} else {
  try {
    for (const name of cases)
      for (let attempt = 1; attempt <= repeats; attempt++) {
        console.log(`\n=== [${name} ${attempt}/${repeats}] ${provider.model} ===`);
        const start = Date.now();
        const result = { case: name, attempt, status: "running" };
        report.results.push(result);
        save();
        const root = join(directory, `${name}-${attempt}`);
        mkdirSync(root, { recursive: true });
        let workspaceId = null;
        try {
          const builder = buildCases[name];
          const spec = await builder(root);
          if (spec.setup) await spec.setup(root);
          const w = service.create({ root, directoryConsent: true });
          workspaceId = w.id;
          service.update(w.id, {
            revision: w.revision,
            profile: "standard",
            allowWrite: true,
            ...(spec.auto
              ? { approvalPolicy: "workspace-write", autoApplyConsent: true, allowGit: true, gitConsent: true }
              : {}),
          });
          const configure = { terminal: false, browser: false, plugins: false, mcp: false, memoryRead: false, memoryWrite: false, origins: [], ...spec.configure };
          const operation = {
            action: "configure",
            revision: service.get(w.id).revision,
            consent: true,
            origins: configure.origins,
            terminal: configure.terminal,
            image: values.image,
            browser: configure.browser,
            plugins: false,
            mcp: Boolean(configure.mcp),
            memoryRead: configure.memoryRead,
            memoryWrite: configure.memoryWrite,
            memory: { provider: "lsa" },
            ...(configure.terminalNetwork ? { terminalNetwork: true } : {}),
          };
          await service.extensions.operation(w.id, operation);
          if (configure.mcp)
            await service.extensions.operation(w.id, {
              action: "save-mcp",
              revision: service.get(w.id).revision,
              consent: true,
              server: { id: "inventory", transport: "http", url: configure.mcpOrigin, allowedTools: ["inventory"] },
            });
          const run = await runAgent(w.id, spec.prompt);
          const checks = await spec.verify(w.id, run, root);
          const failedTools = events(w.id).filter((e) => e.type === "tool.failed").length;
          Object.assign(result, {
            status: "passed",
            checks,
            tokens: run.usage.total_tokens,
            durationMs: Date.now() - start,
            rounds: run.roundsUsed,
            toolFailures: failedTools,
          });
          console.log(`PASS [${name}] checks: ${checks.join(" | ")} rounds=${run.roundsUsed} tokens=${run.usage.total_tokens}`);
        } catch (error) {
          Object.assign(result, {
            status: "failed",
            error: error.message,
            durationMs: Date.now() - start,
          });
          console.error(`FAIL [${name}] ${error.message}`);
        }
        save();
        if (workspaceId)
          try {
            await service.extensions.close(workspaceId);
          } catch {}
      }
    report.successRate =
      report.results.filter((r) => r.status === "passed").length / report.results.length;
    report.status = report.successRate === 1 ? "passed" : "failed";
    if (report.status !== "passed") process.exitCode = 1;
  } finally {
    await service.extensions.close();
    for (const close of cleanups) await close();
    db.close();
    report.endedAt = Date.now();
    save();
  }
  console.log(`\nReport: ${join(directory, "report.json")}`);
  const passed = report.results.filter((r) => r.status === "passed").length;
  console.log(`Summary: ${passed}/${report.results.length} passed`);
  for (const r of report.results)
    console.log(`  ${r.status === "passed" ? "✓" : "✗"} ${r.case}: ${r.status === "passed" ? (r.checks || []).join(", ") : r.error}`);
}
