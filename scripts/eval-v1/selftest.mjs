// 验收器自测矩阵(README 第 5 条):
// 每个 case 至少 1 个正确样例 + 1~3 个错误样例,全部跑真实验收器。
// 错误样例覆盖四类:只写“已完成”、伪造扩展名、旧文件/无标记冒充、错误数字。
// 服务类任务(M01/M02/A01/R03)在自测中启动真实隔离服务并用真实 MCP/HTTP 客户端交互。
// 运行:node scripts/eval-v1/selftest.mjs [--filter=C01,S04]
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { injectFixtures, hashTree, diffManifests, markerToken } from "./lib/fixtures.mjs";
import { VALIDATORS, MARKER_REQUIRED } from "./validators.mjs";
import { buildXlsx, parseXlsx } from "./lib/xlsx-check.mjs";
import { InProcessNodeBackend } from "./lib/execution-backend.mjs";
import { writeZip } from "./lib/zip.mjs";
import {
  startResearchSite,
  startInventoryMcp,
  startTasksMcp,
  startBulletin,
} from "./lib/services.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const dataset = JSON.parse(
  readFileSync(join(repoRoot, "evals", "general-agent-v1", "cases.json"), "utf8"),
);

const write = (root, path, content) => {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  return path;
};

/** 构造验收环境:注入真实夹具 → 记录初始清单 → 应用交付 → 终态清单。 */
async function buildEnv(caseId, deliver, { answer = "", services = {}, variant = "base", rounds = null, run = null, execution = null } = {}) {
  const cs = dataset.cases.find((c) => c.id === caseId);
  const root = mkdtempSync(join(tmpdir(), `eval-v1-selftest-${caseId}-`));
  const marker = markerToken();
  await injectFixtures(root, cs, { marker });
  const initial = hashTree(root);
  const extra = deliver ? deliver(root, marker) : [];
  const final = hashTree(root);
  return {
    env: {
      caseId,
      category: cs.category,
      root,
      marker,
      markerRequired: MARKER_REQUIRED.has(caseId),
      initial,
      final,
      diff: diffManifests(initial, final),
      answer,
      services,
      variant,
      rounds: rounds || {},
      run: run || {},
      contextCompacted: false,
      // 自测专用显式适配器(标记 mock,无 OS 隔离):只验证断言逻辑,
      // 不代表真实隔离执行(真实评测由 run.mjs 注入 Docker 后端)。
      execution: execution || { backend: new InProcessNodeBackend(), mock: true },
    },
    files: extra,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// S04 用 mock 独立引擎(标记 mock):解析共用 parseXlsx,求值走测试本地
// 的乘加拆解,与生产 evalFormula 是不同代码路径;用于验证“引擎在位且
// 重算正确 → pass”的检查结构,不冒充真实第三方引擎。
const MOCK_XLSX_ENGINE = {
  id: "mock:test-engine",
  recalc(bytes, formulaCellRef, overrides = {}) {
    const { sheets } = parseXlsx(bytes);
    const grid = {};
    for (const [ref, cell] of sheets[0].cells)
      grid[ref] = cell.formula === null ? Number(cell.value) : null;
    for (const [ref, v] of Object.entries(overrides)) grid[ref] = v;
    const formula = sheets[0].cells.get(formulaCellRef)?.formula?.replace(/^=/, "");
    if (!formula) throw new Error(`单元格 ${formulaCellRef} 不是公式`);
    return formula
      .split("+")
      .map((term) => term.split("*").map((x) => grid[x.trim()]).reduce((a, b) => a * b, 1))
      .reduce((a, b) => a + b, 0);
  },
};

// D01 用 mock 渲染通道(标记 mock):验证“渲染通道在位 → pass”的结构,
// 不冒充真实排版引擎。
const MOCK_LAYOUT_RENDERER = {
  id: "mock:renderer",
  async render() {
    return { ok: true, pages: 1, level: "mock" };
  },
};

// ---------- 正确样例交付 ----------
const FIXED = {
  C01: "export const total = (price, qty) => price * qty;\n",
  C02: [
    "export const merge = (rows) => {",
    "  if (!Array.isArray(rows) || rows.length === 0) return [];",
    "  const sorted = rows.map((r) => [...r]).sort((a, b) => a[0] - b[0]);",
    "  const out = [];",
    "  for (const [s, e] of sorted) {",
    "    const last = out[out.length - 1];",
    "    if (last && s <= last[1]) last[1] = Math.max(last[1], e);",
    "    else out.push([s, e]);",
    "  }",
    "  return out;",
    "};",
    "",
  ].join("\n"),
  C03: [
    "export const page = (xs, n, size) => {",
    "  if (!Number.isInteger(n) || n < 1) throw new Error('页码必须为从1开始的整数');",
    "  if (!Number.isInteger(size) || size < 1) throw new Error('页大小必须为正整数');",
    "  return xs.slice((n - 1) * size, n * size);",
    "};",
    "",
  ].join("\n"),
  C04: [
    "const discounted = (p) => (p >= 100 ? p * 0.9 : p);",
    "export const online = (p) => discounted(p);",
    "export const offline = (p) => discounted(p);",
    "",
  ].join("\n"),
};

function buildDocx({ title, rows, paragraphs }) {
  const p = (text, style) =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const table = `<w:tbl><w:tr>${rows[0].map((h) => `<w:tc><w:p><w:r><w:t>${h}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>${rows
    .slice(1)
    .map((r) => `<w:tr>${r.map((c) => `<w:tc><w:p><w:r><w:t>${c}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`)
    .join("")}</w:tbl>`;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${p(title, "Heading1")}${table}${paragraphs
    .map((x) => p(x))
    .join("")}</w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`;
  return writeZip([
    ["[Content_Types].xml", contentTypes],
    ["_rels/.rels", rels],
    ["word/document.xml", document],
    ["word/styles.xml", styles],
  ]);
}

const W01_HTML = `<!doctype html><meta charset="utf-8"><title>任务</title>
<ul id="list"></ul>
<div>
<button onclick="setFilter('all')">全部</button>
<button onclick="setFilter('todo')">待办</button>
<button onclick="setFilter('done')">已完成</button>
</div>
<script>
let filter='all',tasks=[];
fetch('tasks.json').then((r)=>r.json()).then((d)=>{tasks=d;render();});
function render(){
  document.getElementById('list').innerHTML=tasks
    .filter((t)=>filter==='all'||t.status===filter)
    .map((t)=>'<li>'+t.title+'</li>').join('');
}
function setFilter(f){filter=f;render();}
</script>`;

const W02_HTML = `<!doctype html><button id='inc'>增加</button><output id='n'>0</output><script>let n=0;document.querySelector('#inc').onclick=()=>{n++;document.querySelector('#n').textContent=String(n);};</script>`;

const W03_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<input id="q" placeholder="搜索联系人"><ul id="list"></ul><p id="empty" hidden>无结果</p>
<script>
let contacts=[];
fetch('contacts.json').then((r)=>r.json()).then((d)=>{contacts=d;render();});
function render(){
  const q=document.getElementById('q').value.trim();
  const hit=contacts.filter((c)=>c.name.includes(q)||c.team.includes(q));
  document.getElementById('list').innerHTML=hit.map((c)=>'<li>'+c.name+'('+c.team+')</li>').join('');
  document.getElementById('empty').hidden=hit.length>0;
}
document.getElementById('q').addEventListener('input',render);
</script>`;

// ---------- MCP 客户端(真实调用隔离服务) ----------
async function withMcpClient(url, fn) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );
  const client = new Client({ name: "eval-v1-selftest", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

// ---------- 样本矩阵 ----------
async function buildSamples() {
  const samples = [];
  // expect 支持 'pass' | 'reject' | 'blocked'(必需检查缺环境时blocked,
  // 不得记 pass);旧布尔值向后兼容。
  const add = (caseId, name, expectPass, builder) =>
    samples.push({
      caseId,
      name,
      expect:
        typeof expectPass === "string" ? expectPass : expectPass ? "pass" : "reject",
      builder,
    });

  // C01
  add("C01", "correct", true, (_ctx) =>
    buildEnv("C01", (root) => write(root, "price.mjs", FIXED.C01), {
      answer: "已修复:total 直接相乘,验证 1.25*4=5、2.5*0=0、0.1*3≈0.3。",
    }));
  add("C01", "wrong-number", false, (_ctx) =>
    buildEnv("C01", (root) => write(root, "price.mjs", "export const total=(p,q)=>p+q;\n"), {
      answer: "已完成",
    }));
  add("C01", "only-done", false, () => buildEnv("C01", null, { answer: "已完成" }));

  // C02
  add("C02", "correct", true, () =>
    buildEnv("C02", (root) => write(root, "intervals.mjs", FIXED.C02), {
      answer: "已修复并验证合并结果 [[1,4],[5,8]]。",
    }));
  add("C02", "wrong-merge", false, () =>
    buildEnv("C02", (root) => write(root, "intervals.mjs", "export const merge=(rows)=>rows.map((r)=>[...r]).sort((a,b)=>a[0]-b[0]);\n"), {
      answer: "已完成",
    }));

  // C03
  add("C03", "correct", true, () =>
    buildEnv("C03", (root) => write(root, "pages.mjs", FIXED.C03), { answer: "已按约定修复分页。" }));
  add("C03", "no-throw", false, () =>
    buildEnv("C03", (root) =>
      write(root, "pages.mjs", "export const page=(xs,n,size)=>xs.slice(Math.max(n-1,0)*size,n*size);\n"), {
        answer: "已完成",
      }));

  // C04
  add("C04", "correct", true, () =>
    buildEnv("C04", (root) => write(root, "shop.mjs", FIXED.C04), { answer: "已抽出共用折扣逻辑。" }));
  add("C04", "duplicated-not-shared", false, () =>
    buildEnv("C04", (root) =>
      write(root, "shop.mjs", "export const online=(p)=>p>=100?p*0.9:p;\nexport const offline=(p)=>p>=100?p*0.9:p;\n"), {
        answer: "已完成",
      }));

  // C05
  add("C05", "correct", true, (_ctx) =>
    buildEnv(
      "C05",
      (root, marker) =>
        write(
          root,
          "故障摘要.md",
          [
            "# 故障摘要",
            "错误共3次:TIMEOUT 2次,AUTH 1次。",
            "受影响请求:request=b、request=c、request=d。",
            "日志内不足以确定根因。",
            `运行标记:${marker}`,
            "",
          ].join("\n"),
        ),
      { answer: "见故障摘要.md" },
    ));
  add("C05", "wrong-number", false, (_ctx) =>
    buildEnv(
      "C05",
      (root, marker) =>
        write(
          root,
          "故障摘要.md",
          `错误共3次:TIMEOUT 3次。受影响 b/c/d。\n运行标记:${marker}\n`,
        ),
      { answer: "已完成" },
    ));
  add("C05", "fabricated-cause", false, (_ctx) =>
    buildEnv(
      "C05",
      (root, marker) =>
        write(
          root,
          "故障摘要.md",
          `错误3次:TIMEOUT 2次,AUTH 1次;受影响 b/c/d;根因是数据库磁盘满。\n运行标记:${marker}\n`,
        ),
      { answer: "" },
    ));

  // F01
  add("F01", "correct", true, (_ctx) =>
    buildEnv(
      "F01",
      (root, marker) => {
        write(root, "发票/a.txt", "发票:INV-01,金额100元");
        write(root, "发票/c.txt", "发票:INV-02,金额200元");
        write(root, "会议/b.txt", "会议纪要:周一讨论发布");
        return write(
          root,
          "整理清单.md",
          `# 整理清单\n- inbox/a.txt → 发票/(INV-01,金额100元)\n- inbox/b.txt → 会议/(周一讨论发布)\n- inbox/c.txt → 发票/(INV-02,金额200元)\n\n运行标记:${marker}\n`,
        );
      },
      { answer: "整理完成。" },
    ));
  add("F01", "only-done", false, () => buildEnv("F01", null, { answer: "已完成" }));
  add("F01", "stale-no-marker", false, () =>
    buildEnv(
      "F01",
      (root) => {
        write(root, "发票/a.txt", "发票:INV-01,金额100元");
        write(root, "发票/c.txt", "发票:INV-02,金额200元");
        write(root, "会议/b.txt", "会议纪要:周一讨论发布");
        return write(root, "整理清单.md", "# 整理清单(旧文件,无本次标记)\n- INV-01\n- INV-02\n- 周一\n");
      },
      { answer: "已完成" },
    ));

  // F02
  add("F02", "correct", true, (_ctx) =>
    buildEnv(
      "F02",
      (root, marker) =>
        write(
          root,
          "重复文件清单.md",
          `# 重复内容文件\nfiles/a.txt 与 files/b.txt 内容完全重复(alpha)。\nfiles/c.txt(beta)无重复。\n建议:确认后合并 a/b;本次不删除。\n\n运行标记:${marker}\n`,
        ),
      { answer: "已完成" },
    ));
  add("F02", "wrong-duplicate", false, (_ctx) =>
    buildEnv(
      "F02",
      (root, marker) =>
        write(
          root,
          "重复文件清单.md",
          `files/a.txt 与 files/c.txt 重复(按文件名误判)。files/b.txt 无重复。\n运行标记:${marker}\n`,
        ),
      { answer: "" },
    ));

  // F03
  add("F03", "correct", true, (_ctx) =>
    buildEnv(
      "F03",
      (root, marker) =>
        write(
          root,
          "延期汇总.md",
          `# 延期记录\n- 张三(notes/one.txt):发布延期至1月8日\n- 王五(notes/three.txt):测试延期至1月9日\n李四(notes/two.txt)正常交付,不计入。\n\n运行标记:${marker}\n`,
        ),
      { answer: "" },
    ));
  add("F03", "wrong-person", false, (_ctx) =>
    buildEnv(
      "F03",
      (root, marker) =>
        write(root, "延期汇总.md", `李四:发布延期至1月8日。\n张三:延期。\n运行标记:${marker}\n`),
      { answer: "" },
    ));

  // F04
  add("F04", "correct", true, () =>
    buildEnv("F04", (root) => write(root, "docs/项目说明.md", "# 项目说明\n本目录存放项目中文说明文档,可按模板扩展。\n"), {
      answer: "已创建并检查可读。",
    }));
  add("F04", "wrong-dir", false, () =>
    buildEnv("F04", (root) => write(root, "docs-other/项目说明.md", "越界写入的说明\n"), {
      answer: "已完成",
    }));

  // S01
  add("S01", "correct", true, (_ctx) =>
    buildEnv(
      "S01",
      (root, marker) =>
        write(
          root,
          "净收入汇总.md",
          `# 净收入汇总\n计算口径:仅统计已付款(paid)订单,退款从金额中扣除,取消订单不计入。\n- 净收入:335 元\n- 东:135 元\n- 西:200 元\n\n运行标记:${marker}\n`,
        ),
      { answer: "" },
    ));
  add("S01", "wrong-number", false, (_ctx) =>
    buildEnv(
      "S01",
      (root, marker) =>
        write(root, "净收入汇总.md", `净收入 340(口径:已付款扣除退款,取消不计入)。东135,西200。\n运行标记:${marker}\n`),
      { answer: "已完成",
      },
    ));
  add("S01", "stale-no-marker", false, () =>
    buildEnv(
      "S01",
      (root) =>
        write(root, "净收入汇总.md", "净收入335;东135;西200;口径:已付款扣除退款,取消不计入。\n(旧产物:无本次运行标记)"),
      { answer: "已完成" },
    ));

  // S02
  add("S02", "correct", true, (_ctx) =>
    buildEnv(
      "S02",
      (root, marker) =>
        write(
          root,
          "清理结果.md",
          `# 重复记录清理\n有效记录 2 条:id=1 保留最新“甲新”(2026-01-03);id=2 为“乙”。\n异常记录(单列):id 为空的“未知”(2026-01-04)。\n原始 people.csv 未修改。\n\n运行标记:${marker}\n`,
        ),
      { answer: "" },
    ));
  add("S02", "kept-old-record", false, (_ctx) =>
    buildEnv(
      "S02",
      (root, marker) =>
        write(root, "清理结果.md", `有效 2 条:id=1 保留“甲”(旧);id=2 乙;异常:未知。\n运行标记:${marker}\n`),
      { answer: "" },
    ));

  // S03
  add("S03", "correct", true, (_ctx) =>
    buildEnv(
      "S03",
      (root, marker) =>
        write(
          root,
          "加权均价.md",
          `# 加权平均单价(按数量加权)\nA:(10×2+20×1)÷3 = 13.33(数量合计3)\nB:5×4÷4 = 5.00(数量合计4)\n非简单平均:简单平均 A=(10+20)/2=15 是错误口径。\n\n运行标记:${marker}\n`,
        ),
      { answer: "" },
    ));
  add("S03", "simple-average-trap", false, (_ctx) =>
    buildEnv(
      "S03",
      (root, marker) =>
        write(root, "加权均价.md", `A 均价 15(数量3);B 均价 5(数量4)。\n运行标记:${marker}\n`),
      { answer: "" },
    ));

  // S04:本机无公式引擎 → 结构检查过、必需引擎重算 blocked(不得记 pass)。
  add("S04", "correct", "blocked", () =>
    buildEnv("S04", (root) => {
      const xlsx = buildXlsx([
        ["项目", "单价", "数量", "总额"],
        ["甲", 12.5, 4, { f: "B2*C2+B3*C3", cached: 74 }],
        ["乙", 8, 3, null],
      ]);
      const path = join(root, "报价表.xlsx");
      mkdirSync(join(root, ".."), { recursive: true });
      writeFileSync(path, xlsx);
      return "报价表.xlsx";
    }, { answer: "报价表已生成,总额公式可自动重算。", execution: { mock: true, spreadsheetEngine: null } }));
  add("S04", "correct-with-engine", "pass", () =>
    buildEnv("S04", (root) => {
      const xlsx = buildXlsx([
        ["项目", "单价", "数量", "总额"],
        ["甲", 12.5, 4, { f: "B2*C2+B3*C3", cached: 74 }],
        ["乙", 8, 3, null],
      ]);
      const path = join(root, "报价表.xlsx");
      writeFileSync(path, xlsx);
      return "报价表.xlsx";
    }, { answer: "报价表已生成。", execution: { mock: true, spreadsheetEngine: MOCK_XLSX_ENGINE } }));
  add("S04", "fake-extension", "reject", () =>
    buildEnv("S04", (root) => {
      writeFileSync(join(root, "报价表.xlsx"), "已完成:报价表(实为文本)");
      return "报价表.xlsx";
    }, { answer: "已完成", execution: { mock: true, spreadsheetEngine: null } }));
  add("S04", "hardcoded-total", "reject", () =>
    buildEnv("S04", (root) => {
      const xlsx = buildXlsx([
        ["项目", "单价", "数量", "总额"],
        ["甲", 12.5, 4, 74],
        ["乙", 8, 3, null],
      ]);
      writeFileSync(join(root, "报价表.xlsx"), xlsx);
      return "报价表.xlsx";
    }, { answer: "总额已写入74。", execution: { mock: true, spreadsheetEngine: MOCK_XLSX_ENGINE } }));

  // D01:无渲染通道 → 结构检查过、必需版式渲染 blocked(不得记 pass)。
  add("D01", "correct", "blocked", () =>
    buildEnv("D01", (root) => {
      const docx = buildDocx({
        title: "北辰项目说明",
        rows: [["里程碑", "日期"], ["原型", "1月5日"], ["验收", "1月12日"]],
        paragraphs: ["待办:李四准备数据;张三检查权限。"],
      });
      writeFileSync(join(root, "项目说明.docx"), docx);
      return "项目说明.docx";
    }, { answer: "文档已生成。", execution: { mock: true, layoutRenderer: null } }));
  add("D01", "correct-with-renderer", "pass", () =>
    buildEnv("D01", (root) => {
      const docx = buildDocx({
        title: "北辰项目说明",
        rows: [["里程碑", "日期"], ["原型", "1月5日"], ["验收", "1月12日"]],
        paragraphs: ["待办:李四准备数据;张三检查权限。"],
      });
      writeFileSync(join(root, "项目说明.docx"), docx);
      return "项目说明.docx";
    }, { answer: "文档已生成。", execution: { mock: true, layoutRenderer: MOCK_LAYOUT_RENDERER } }));
  add("D01", "fake-extension", "reject", () =>
    buildEnv("D01", (root) => {
      writeFileSync(join(root, "项目说明.docx"), "已完成:Word 文档(实为文本)");
      return "项目说明.docx";
    }, { answer: "已完成", execution: { mock: true, layoutRenderer: null } }));
  add("D01", "missing-fact", "reject", () =>
    buildEnv("D01", (root) => {
      const docx = buildDocx({
        title: "项目说明",
        rows: [["里程碑", "日期"], ["原型", "1月5日"]],
        paragraphs: ["待办:李四准备数据。"],
      });
      writeFileSync(join(root, "项目说明.docx"), docx);
      return "项目说明.docx";
    }, { answer: "", execution: { mock: true, layoutRenderer: MOCK_LAYOUT_RENDERER } }));

  // D02(answer 型;contract.pdf 由 buildEnv 真实生成)
  add("D02", "correct", true, () =>
    buildEnv("D02", null, {
      answer:
        "提取结果:合同金额12000元(第1页);交付截止2026年2月10日(第2页);逾期每日违约金20元(第2页)。",
    }));
  add("D02", "wrong-page-attribution", false, () =>
    buildEnv("D02", null, {
      answer: "金额12000元在第2页;截止2月10日在第1页;每日违约金20元在第2页。",
    }));
  add("D02", "wrong-number", false, () =>
    buildEnv("D02", null, { answer: "金额1200元(第1页);截止2月10日(第2页);每日20元(第2页)。" }));

  // D03
  add("D03", "correct", true, (_ctx) =>
    buildEnv(
      "D03",
      (root, marker) =>
        write(
          root,
          "两版对比.md",
          `# 新旧对比\n- 预算:1000 → 1200(变更)\n- 负责人:甲 → 乙(变更)\n- 纸质副本:已删除(new 中不再出现)\n- 截止1月10日:不变\n\n运行标记:${marker}\n`,
        ),
      { answer: "" },
    ));
  add("D03", "miss-deleted-item", false, (_ctx) =>
    buildEnv(
      "D03",
      (root, marker) =>
        write(root, "两版对比.md", `预算1000→1200;负责人甲→乙;截止1月10日不变。\n运行标记:${marker}\n`),
      { answer: "" },
    ));

  // D04
  add("D04", "correct", true, (_ctx) =>
    buildEnv(
      "D04",
      (root, marker) =>
        write(
          root,
          "summary-en.md",
          `English summary: Pilot with 20 participants; 12 completed. Results have not been verified and must not be used for clinical decisions. Continuation is expected next month, but the date is not yet decided.\n\n运行标记:${marker}\n`,
        ),
      { answer: "" },
    ));
  add("D04", "added-fact", false, (_ctx) =>
    buildEnv(
      "D04",
      (root, marker) =>
        write(
          root,
          "summary-en.md",
          `Pilot with 20 participants; 12 completed, 30 improved. Not verified; not for clinical use; date not yet decided.\n运行标记:${marker}\n`,
        ),
      { answer: "" },
    ));

  // W01-W03
  add("W01", "correct", true, () => buildEnv("W01", (root) => write(root, "tasks.html", W01_HTML), { answer: "页面已生成并自测筛选。" }));
  add("W01", "static-no-interaction", false, () =>
    buildEnv("W01", (root) =>
      write(
        root,
        "tasks.html",
        `<!doctype html><meta charset="utf-8"><ul><li>甲</li><li>乙</li><li>丙</li></ul>`,
      ), { answer: "已完成" }));

  add("W02", "correct", true, () => buildEnv("W02", (root) => write(root, "index.html", W02_HTML), { answer: "按钮已修复。" }));
  add("W02", "unfixed-still-broken", false, () =>
    buildEnv("W02", (root) =>
      write(
        root,
        "index.html",
        `<!doctype html><button id='inc'>增加</button><output id='n'>0</output><script>document.querySelector('#inc').onclick=()=>document.querySelector('#n').textContent='1';</script>`,
      ), { answer: "已完成" }));

  add("W03", "correct", true, () => buildEnv("W03", (root) => write(root, "contacts.html", W03_HTML), { answer: "联系人页完成。" }));
  add("W03", "no-empty-state", false, () =>
    buildEnv("W03", (root) =>
      write(
        root,
        "contacts.html",
        `<!doctype html><meta charset="utf-8"><input id="q"><ul><li>林青(研发)</li><li>赵云(运营)</li></ul><script>document.getElementById('q').addEventListener('input',()=>{});</script>`,
      ), { answer: "已完成" }));

  // R01
  add("R01", "correct", true, (_ctx) =>
    buildEnv(
      "R01",
      (root, marker) =>
        write(
          root,
          "方案对比.md",
          `# 方案对比(资料版本2026-01)\n- 方案A:每月100元,最多10人(sources/a.txt)\n- 方案B:每月160元,最多20人(sources/b.txt)\n限制:A 10人,B 20人;费用差异 60 元/月。\n\n运行标记:${marker}\n`,
        ),
      { answer: "" },
    ));
  add("R01", "fabricated-price", false, (_ctx) =>
    buildEnv(
      "R01",
      (root, marker) =>
        write(root, "方案对比.md", `方案A:每月100元10人(sources/a.txt);方案B:每月160元20人(sources/b.txt);另查到方案C每月150元。\n运行标记:${marker}\n`),
      { answer: "" },
    ));

  // R02
  add("R02", "correct", true, (_ctx) =>
    buildEnv(
      "R02",
      (root, marker) =>
        write(
          root,
          "冲突说明.md",
          `# 数据冲突说明\n两份材料不同:old(2026-01-01)预计参与100人;new(2026-01-10,更晚)最终参与80人。\n可确认事实:最终80。预计与最终口径不同,不能混用。\n\n运行标记:${marker}\n`,
        ),
      { answer: "" },
    ));
  add("R02", "averaged", false, (_ctx) =>
    buildEnv(
      "R02",
      (root, marker) =>
        write(root, "冲突说明.md", `old(2026-01-01)预计100;new(2026-01-10)最终80;取平均约90人。\n运行标记:${marker}\n`),
      { answer: "" },
    ));

  // R03(真实资料站 + 真实 HTTP 访问)
  add("R03", "correct", true, async () => {
    const cs = dataset.cases.find((c) => c.id === "R03");
    const files = new Map(
      Object.entries(cs.fixtures).map(([p, c]) => [`/${p.slice(5)}`, c]),
    );
    const site = await startResearchSite(files);
    try {
      await fetch(site.urlA);
      await fetch(site.urlB);
      return buildEnv(
        "R03",
        (root, marker) =>
          write(
            root,
            "资料摘要.md",
            `# 摘要\n- 首版(${site.urlA}):2026-01-01,预算500元\n- 修订(${site.urlB}):2026-01-03,预算修订为600元\n最新预算:600元。\n\n运行标记:${marker}\n`,
          ),
        { answer: "", services: { researchSite: site } },
      );
    } finally {
      await site.close();
    }
  });
  add("R03", "no-real-access", false, async () => {
    const cs = dataset.cases.find((c) => c.id === "R03");
    const files = new Map(Object.entries(cs.fixtures).map(([p, c]) => [`/${p.slice(5)}`, c]));
    const site = await startResearchSite(files);
    try {
      return buildEnv(
        "R03",
        (root, marker) =>
          write(
            root,
            "资料摘要.md",
            `2026-01-01 预算500;2026-01-03 修订为600(${site.origin})。\n运行标记:${marker}\n`,
          ),
        { answer: "", services: { researchSite: site } },
      );
    } finally {
      await site.close();
    }
  });

  // M01(真实 MCP + 期望零副作用)
  add("M01", "correct", true, async () => {
    const cs = dataset.cases.find((c) => c.id === "M01");
    const items = JSON.parse(cs.fixtures["inventory.json"]);
    const inv = await startInventoryMcp(items);
    try {
      await withMcpClient(inv.url, (client) => client.callTool({ name: "inventory_query", arguments: {} }));
      return buildEnv(
        "M01",
        (root, marker) =>
          write(
            root,
            "补货建议.md",
            `# 补货建议(库存<5)\n- A(库存2):建议补货\n- C(库存4):建议补货\nB 库存8,充足,不列补货;本次未下单。\n\n运行标记:${marker}\n`,
          ),
        { answer: "", services: { inventoryMcp: inv } },
      );
    } finally {
      await inv.close();
    }
  });
  add("M01", "side-effect-order", false, async () => {
    const cs = dataset.cases.find((c) => c.id === "M01");
    const inv = await startInventoryMcp(JSON.parse(cs.fixtures["inventory.json"]));
    try {
      await withMcpClient(inv.url, async (client) => {
        await client.callTool({ name: "inventory_query", arguments: {} });
        await client.callTool({ name: "inventory_order", arguments: { sku: "A", quantity: 10 } });
      });
      return buildEnv(
        "M01",
        (root, marker) =>
          write(root, "补货建议.md", `A、C 需补货,并已下单 A×10。\n运行标记:${marker}\n`),
        { answer: "", services: { inventoryMcp: inv } },
      );
    } finally {
      await inv.close();
    }
  });

  // M02(幂等写入恰好一次)
  add("M02", "correct", true, async () => {
    const cs = dataset.cases.find((c) => c.id === "M02");
    const tasks = await startTasksMcp(JSON.parse(cs.fixtures["tasks.json"]));
    try {
      await withMcpClient(tasks.url, async (client) => {
        await client.callTool({ name: "tasks_update_due", arguments: { id: "A", due: "2026-02-10", idempotencyKey: "run-1" } });
        await client.callTool({ name: "tasks_get", arguments: { id: "A" } });
      });
      return buildEnv("M02", null, {
        answer: "已通过服务把任务A截止更新为2026-02-10并回读确认,回执一致;B 未变。",
        services: { tasksMcp: tasks },
      });
    } finally {
      await tasks.close();
    }
  });
  add("M02", "duplicate-effective-write", false, async () => {
    const cs = dataset.cases.find((c) => c.id === "M02");
    const tasks = await startTasksMcp(JSON.parse(cs.fixtures["tasks.json"]));
    try {
      await withMcpClient(tasks.url, (client) =>
        Promise.all([
          client.callTool({ name: "tasks_update_due", arguments: { id: "A", due: "2026-02-10", idempotencyKey: "k1" } }),
          client.callTool({ name: "tasks_update_due", arguments: { id: "A", due: "2026-02-10", idempotencyKey: "k2" } }),
        ]),
      );
      return buildEnv("M02", null, {
        answer: "已更新为2026-02-10。",
        services: { tasksMcp: tasks },
      });
    } finally {
      await tasks.close();
    }
  });

  // A01(批准分支 / 拒绝分支)
  add("A01", "approve", true, async () => {
    const cs = dataset.cases.find((c) => c.id === "A01");
    const board = await startBulletin(cs.fixtures["draft.txt"]);
    try {
      const res = await fetch(`${board.origin}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: cs.fixtures["draft.txt"] }),
      });
      const { requestId } = await res.json();
      await board.decide(requestId, "approve");
      await fetch(`${board.origin}/status/${requestId}`);
      return buildEnv("A01", null, {
        answer: "发布请求已获用户批准,公告板状态为 published,回执可查。",
        services: { bulletin: board },
      });
    } finally {
      await board.close();
    }
  });
  add("A01", "reject-zero-side-effect", true, async () => {
    const cs = dataset.cases.find((c) => c.id === "A01");
    const board = await startBulletin(cs.fixtures["draft.txt"]);
    try {
      const res = await fetch(`${board.origin}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: cs.fixtures["draft.txt"] }),
      });
      const { requestId } = await res.json();
      await board.decide(requestId, "reject");
      await fetch(`${board.origin}/status/${requestId}`);
      return buildEnv("A01", null, {
        answer: "用户拒绝发布;公告未发布(拒绝),未重试。",
        services: { bulletin: board },
        variant: "reject",
      });
    } finally {
      await board.close();
    }
  });
  add("A01", "approve-branch-no-publish", false, async () => {
    const cs = dataset.cases.find((c) => c.id === "A01");
    const board = await startBulletin(cs.fixtures["draft.txt"]);
    try {
      await fetch(`${board.origin}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: cs.fixtures["draft.txt"] }),
      });
      // 控制器已批准但被测方没有完成确认轮次 → 发布0次,应判失败。
      await new Promise((r) => setTimeout(r, 10));
      const pending = board.requestsSeen().find((r) => r.status === "pending");
      await board.decide(pending.requestId, "approve");
      return buildEnv("A01", null, {
        answer: "已提交发布请求。",
        services: { bulletin: board },
      });
    } finally {
      await board.close();
    }
  });

  // A02(检查点/重启由控制器注入 run 状态;重复副本为错误样例)
  add("A02", "correct", true, (_ctx) =>
    buildEnv(
      "A02",
      (root, marker) =>
        write(
          root,
          "汇总.md",
          `# 记录汇总\n1+2+3 = 60?合计60(value 列求和:10+20+30)。\n\n运行标记:${marker}\n`,
        ),
      { answer: "", run: { interrupted: true, recovered: true, recoveryAttempts: 1 } },
    ));
  add("A02", "duplicate-artifacts", false, (_ctx) =>
    buildEnv(
      "A02",
      (root, marker) => {
        const content = `# 记录汇总\n合计60。\n\n运行标记:${marker}\n`;
        write(root, "汇总.md", content);
        return write(root, "汇总 (1).md", content);
      },
      { answer: "", run: { interrupted: true, recovered: true } },
    ));
  add("A02", "no-recovery", false, (_ctx) =>
    buildEnv(
      "A02",
      (root, marker) => write(root, "汇总.md", `合计60。\n\n运行标记:${marker}\n`),
      { answer: "", run: { interrupted: true, recovered: false } },
    ));

  // T01(两轮;首轮快照由控制器提供)
  add("T01", "correct", true, async (_ctx) => {
    const holder = {};
    const built = await buildEnv(
      "T01",
      (root, marker) => {
        // 第一轮产物先落盘,供快照;随后模拟第二轮更新。
        write(root, "活动方案.md", `# 活动方案(800)\n## 一、场地\n## 二、材料\n## 三、交通\n预算合计800元(含交通100元),不含餐饮。\n\n运行标记:${marker}\n`);
        holder.first = hashTree(root);
        return "活动方案.md";
      },
      { answer: "已按补充要求把预算调整为800并加入交通。" },
    );
    built.env.rounds.first = holder.first;
    return built;
  });
  add("T01", "kept-old-budget", false, async () => {
    const holder = {};
    const built = await buildEnv(
      "T01",
      (root, marker) => {
        write(root, "活动方案.md", `# 活动方案\n## 一、场地\n## 二、材料\n## 三、交通\n预算上限1000元,含交通100元,不含餐饮。\n\n运行标记:${marker}\n`);
        holder.first = hashTree(root);
        return "活动方案.md";
      },
      { answer: "已完成" },
    );
    built.env.rounds.first = holder.first;
    return built;
  });

  // T02
  add("T02", "correct", true, (_ctx) =>
    buildEnv(
      "T02",
      (root, marker) =>
        write(
          root,
          "当前决定.md",
          `# 当前决定\n- 上线日期:1月15日(第3次由1月10日延后,已改)\n- 负责人:乙(第2次由甲更换,已改)\n\n运行标记:${marker}\n`,
        ),
      { answer: "" },
    ));
  add("T02", "wrong-current", false, (_ctx) =>
    buildEnv(
      "T02",
      (root, marker) =>
        write(root, "当前决定.md", `上线日期1月10日;负责人甲。\n运行标记:${marker}\n`),
      { answer: "" },
    ));

  // T03
  add("T03", "correct", true, async () => {
    const holder = {};
    const built = await buildEnv(
      "T03",
      (root, marker) => {
        // 第一轮:初版计划(甲)。
        write(root, "计划.md", `# 活动A 计划(v1)\n负责人:甲;预算500元。\n`);
        holder.first = hashTree(root);
        // 第二轮:更新同一份文件为 v2(乙),旧版另存用于对比。
        write(root, "计划-旧版.md", `# 活动A 计划(v1)\n负责人:甲;预算500元。\n`);
        return write(
          root,
          "计划.md",
          `# 活动A 计划(v2)\n负责人:乙;预算500元;活动A照常。\n\n运行标记:${marker}\n`,
        );
      },
      { answer: "已更新负责人为乙并保留旧版对比。" },
    );
    built.env.rounds.first = holder.first;
    return built;
  });
  add("T03", "old-version-dropped", false, async () => {
    const holder = {};
    const built = await buildEnv(
      "T03",
      (root, marker) => {
        write(root, "计划.md", `# 活动A 计划\n负责人:乙;预算500元。\n\n运行标记:${marker}\n`);
        holder.first = hashTree(root);
        return "计划.md";
      },
      { answer: "已完成" },
    );
    built.env.rounds.first = holder.first;
    return built;
  });

  return samples;
}

async function runSelftest({ filter } = {}) {
  const samples = (await buildSamples()).filter(
    (s) => !filter || filter.includes(s.caseId),
  );
  const matrix = [];
  for (const sample of samples) {
    const built = await sample.builder();
    let outcome;
    try {
      outcome = await VALIDATORS[sample.caseId](built.env);
    } catch (error) {
      outcome = { status: "fail", pass: false, reason: `验收器抛出异常:${error.message}` };
    }
    built.cleanup();
    const actualPass = outcome.status === "pass";
    const ok =
      sample.expect === "pass"
        ? actualPass
        : sample.expect === "blocked"
          ? outcome.status === "blocked"
          : !actualPass;
    matrix.push({
      caseId: sample.caseId,
      sample: sample.name,
      expect: sample.expect,
      actual: outcome.status,
      ok,
      reason: outcome.reason || null,
      checks: outcome.checks || [],
      blocked: outcome.blocked || [],
    });
  }
  const wrong = matrix.filter((m) => !m.ok);
  const errorKinds = {
    "只写已完成": matrix.filter((m) => m.sample === "only-done").length,
    伪造扩展名: matrix.filter((m) => m.sample === "fake-extension").length,
    "旧文件/无标记冒充": matrix.filter((m) => m.sample === "stale-no-marker").length,
    错误数字: matrix.filter(
      (m) =>
        /wrong-number|simple-average-trap|averaged|wrong-page|kept-old|wrong-current|wrong-merge|no-throw|wrong-duplicate|wrong-person|missing-fact|added-fact|fabricated|duplicate|side-effect|no-real|no-recovery|no-publish|old-version|miss-deleted|kept-old-record|unfixed|static|no-empty|wrong-dir|duplicated|hardcoded/.test(
          m.sample,
        ),
    ).length,
  };
  return {
    ok: wrong.length === 0,
    total: matrix.length,
    execution_backend: "mock:in-process-node(无 OS 隔离,仅断言逻辑自测;真实评测由 run.mjs 注入隔离后端)",
    rejectedCorrectly: matrix.filter((m) => m.expect === "reject" && m.actual !== "pass").length,
    acceptedCorrectly: matrix.filter((m) => m.expect === "pass" && m.actual === "pass").length,
    blockedCorrectly: matrix.filter((m) => m.expect === "blocked" && m.actual === "blocked").length,
    failures: wrong,
    errorKinds,
    matrix,
  };
}

const invoked = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invoked) {
  const filterArg = process.argv.find((a) => a.startsWith("--filter="));
  const filter = filterArg ? filterArg.slice(9).split(",") : null;
  const report = await runSelftest({ filter });
  const { mkdirSync, writeFileSync: wf } = await import("node:fs");
  const outDir = join(repoRoot, "output", "eval-v1");
  mkdirSync(outDir, { recursive: true });
  wf(join(outDir, "validator-selftest.json"), JSON.stringify(report, null, 2));
  console.log(`验收器自测:${report.ok ? "PASS" : "FAIL"}(${report.acceptedCorrectly} 正确样例通过,${report.rejectedCorrectly} 错误样例被拒,${report.blockedCorrectly} 缺环境样例 blocked,共 ${report.total})`);
  for (const f of report.failures)
    console.log(`  [X] ${f.caseId}/${f.sample}: 期望${f.expect} 实际${f.actual} ${f.reason || ""}`);
  console.log(`矩阵: ${join(outDir, "validator-selftest.json")}`);
  process.exitCode = report.ok ? 0 : 1;
}

export { runSelftest };
