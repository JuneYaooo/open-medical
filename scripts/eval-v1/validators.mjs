// general-agent-v1 独立验收器:每个 case 一个 oracle 判定函数。
// 设计原则(README 第 4 条):优先数值、结构、文件格式、执行结果、真实浏览器
// 交互与服务回执断言;版式/事实完整性类用明确评分项;不依赖关键词存在即通过。
// 验收器只看:工作区终态、初始/最终哈希、模型回答、工具事件、隔离服务回执。
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { parseXlsx, checkQuoteWorkbook } from "./lib/xlsx-check.mjs";
import { readZip } from "./lib/zip.mjs";
import { parseXml, findAll } from "./lib/xml.mjs";
import { safeRelativePath } from "./lib/fixtures.mjs";
import {
  checkTaskFilterPage,
  checkCounterPage,
  checkContactsPage,
} from "./lib/browser-check.mjs";

export class VFail extends Error {}
export function need(condition, message) {
  if (!condition) throw new VFail(message);
}
function near(actual, expected, tol) {
  return Math.abs(Number(actual) - Number(expected)) <= tol;
}

function textContent(env, relPath) {
  const full = join(env.root, relPath);
  if (!existsSync(full)) return null;
  const buf = readFileSync(full);
  if (buf.includes(0)) return null; // 二进制不进文本通道
  return buf.toString("utf8");
}

/** 新增/修改的文本交付文件:Map<path, text>。 */
function deliverableTexts(env) {
  const out = new Map();
  for (const path of [...env.diff.added, ...env.diff.modified]) {
    const safe = safeRelativePath(path);
    if (!safe.ok) continue;
    const text = textContent(env, path);
    if (text !== null) out.set(path, text);
  }
  return out;
}

/** 全部交付文本 + 模型回答合并语料。 */
function corpus(env) {
  return [...deliverableTexts(env).values()].join("\n---\n") + "\n" + (env.answer || "");
}

function findFile(env, suffixes) {
  for (const path of [...env.diff.added, ...env.diff.modified]) {
    const lower = path.toLowerCase();
    if (suffixes.some((s) => lower.endsWith(s))) return path;
  }
  return null;
}

// ---------- 通用硬检查(所有 case) ----------
function commonGuards(env) {
  const markerInfo = env.final["EVAL-RUN-MARKER.txt"];
  need(markerInfo, "运行标记文件被删除");
  need(
    env.initial["EVAL-RUN-MARKER.txt"]?.sha256 === markerInfo.sha256,
    "运行标记文件被修改",
  );
  for (const path of [...env.diff.added, ...env.diff.modified, ...env.diff.removed]) {
    const safe = safeRelativePath(path);
    if (!safe.ok) throw new VFail(`产物路径越界或非法:${path}(${safe.reason})`);
  }
  if (env.caseId === "A02") {
    // A02:产物无重复副本(同内容文件只允许一份)。
    const seen = new Map();
    for (const path of env.diff.added) {
      if (path === "EVAL-RUN-MARKER.txt") continue;
      const hash = env.final[path]?.sha256;
      if (seen.has(hash))
        throw new VFail(`存在重复副本:${path} 与 ${seen.get(hash)} 内容完全相同`);
      seen.set(hash, path);
    }
  }
}

async function finish(env, run) {
  try {
    const inner = await run();
    commonGuards(env);
    if (env.markerRequired) {
      const texts = new Map(
        [...deliverableTexts(env)].filter(([p]) => p !== "EVAL-RUN-MARKER.txt"),
      );
      if (texts.size > 0) {
        need(
          [...texts.values()].some((t) => t.includes(env.marker)),
          `交付文件未包含本次运行标记 ${env.marker}(疑似旧产物冒充)`,
        );
      } else if (FILE_REQUIRED.has(env.caseId)) {
        throw new VFail("没有交付任何文件(该任务要求文件交付物)");
      }
      inner.checks.push(texts.size ? "含运行标记" : "无文件交付,按回答判定");
    }
    return { status: "pass", pass: true, ...inner };
  } catch (error) {
    if (error instanceof VFail)
      return { status: "fail", pass: false, reason: error.message, checks: [] };
    const blocked = /无法启动浏览器/.test(error.message);
    return {
      status: blocked ? "blocked" : "fail",
      pass: false,
      reason: (blocked ? "[blocked] " : "验收器异常:") + error.message,
      checks: [],
    };
  }
}

// ---------- 代码类:真实执行断言 ----------
function runNode(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script]);
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`模块执行失败(exit ${code}):${err.slice(0, 400)}`)),
    );
    child.on("error", reject);
  });
}

/** 在子进程导入工作区模块并按表达式取值(执行级断言)。 */
async function importRunner(absPath, statements) {
  const url = pathToFileURL(absPath).href + `?t=${Date.now()}-${Math.random()}`;
  const script =
    `import(${JSON.stringify(url)}).then((m)=>{const out={};` +
    statements
      .map(
        ([key, expr]) =>
          `try{out[${JSON.stringify(key)}]=${expr}}catch(e){out[${JSON.stringify(key)}]={__throw:String(e.message)}}`,
      )
      .join(";") +
    `;console.log("__RESULT__"+JSON.stringify(out));})`;
  const out = await runNode(script);
  const marker = "__RESULT__";
  return JSON.parse(out.slice(out.indexOf(marker) + marker.length));
}

const V = {};

V.C01 = (env) =>
  finish(env, async () => {
    need(env.diff.modified.includes("price.mjs"), "price.mjs 未被修改");
    const r = await importRunner(join(env.root, "price.mjs"), [
      ["t1", "m.total(1.25,4)"],
      ["t2", "m.total(2.5,0)"],
      ["t3", "m.total(0.1,3)"],
      ["isFn", "typeof m.total"],
    ]);
    need(r.isFn === "function", "导出 total 被删除");
    need(r.t1 === 5, `total(1.25,4)=${r.t1},期望5`);
    need(r.t2 === 0, `total(2.5,0)=${r.t2},期望0`);
    need(near(r.t3, 0.3, 1e-9), `total(0.1,3)=${r.t3},期望≈0.3`);
    return { checks: ["导出保留", "1.25×4=5", "零数量=0", "0.1×3≈0.3"] };
  });

V.C02 = (env) =>
  finish(env, async () => {
    need(env.diff.modified.includes("intervals.mjs"), "intervals.mjs 未被修改");
    const r = await importRunner(join(env.root, "intervals.mjs"), [
      ["merged", "JSON.stringify(m.merge([[5,7],[1,3],[2,4],[7,8]]))"],
      ["empty", "JSON.stringify(m.merge([]))"],
      [
        "inputUnchanged",
        "(()=>{const input=[[5,7],[1,3],[2,4],[7,8]];const snapshot=JSON.stringify(input);m.merge(input);return JSON.stringify(input)===snapshot})()",
      ],
    ]);
    need(r.merged === "[[1,4],[5,8]]", `合并结果 ${r.merged},期望 [[1,4],[5,8]]`);
    need(r.empty === "[]", `空数组结果 ${r.empty},期望 []`);
    need(r.inputUnchanged === true, "原输入被修改(要求保留原输入不变)");
    return { checks: ["合并=[[1,4],[5,8]]", "空数组=[]", "原输入不变"] };
  });

V.C03 = (env) =>
  finish(env, async () => {
    need(env.initial["接口约定.txt"] !== undefined, "缺少接口约定夹具(控制器应附加分页约定)");
    need(env.diff.modified.includes("pages.mjs"), "pages.mjs 未被修改");
    const r = await importRunner(join(env.root, "pages.mjs"), [
      ["p1", "JSON.stringify(m.page([1,2,3],1,2))"],
      ["p3", "JSON.stringify(m.page([1,2,3],3,2))"],
      ["zeroPage", "(()=>{try{m.page([1,2,3],0,2);return 'no-throw'}catch(e){return 'throw'}})()"],
      ["zeroSize", "(()=>{try{m.page([1,2,3],1,0);return 'no-throw'}catch(e){return 'throw'}})()"],
    ]);
    need(r.p1 === "[1,2]", `page([1,2,3],1,2)=${r.p1},期望 [1,2](页码从1开始)`);
    need(r.p3 === "[]", `第3页=${r.p3},期望 [](超出末页返回空列表)`);
    need(r.zeroPage === "throw", "页码0未抛错");
    need(r.zeroSize === "throw", "页大小0未抛错");
    return { checks: ["页码从1开始", "末页外=[]", "非法页码抛错", "非法页大小抛错"] };
  });

V.C04 = (env) =>
  finish(env, async () => {
    need(env.diff.modified.includes("shop.mjs"), "shop.mjs 未被修改");
    const r = await importRunner(join(env.root, "shop.mjs"), [
      ["online", "JSON.stringify([0,99,100,150].map((p)=>m.online(p)))"],
      ["offline", "JSON.stringify([0,99,100,150].map((p)=>m.offline(p)))"],
      ["exports", "JSON.stringify(Object.keys(m).sort())"],
    ]);
    need(r.online === JSON.stringify([0, 99, 90, 135]), `online 行为变化:${r.online}`);
    need(r.offline === JSON.stringify([0, 99, 90, 135]), `offline 行为变化:${r.offline}`);
    need(
      r.exports.includes("online") && r.exports.includes("offline"),
      `导出契约被修改:${r.exports}`,
    );
    // 结构断言:两个入口必须共用同一段实现。
    // 按 export 边界分段,找到 online/offline 各自的源段,取两段共同调用的
    // 非保留标识符(兼容单行箭头函数与多行 function 两种风格)。
    const src = readFileSync(join(env.root, "shop.mjs"), "utf8");
    const exclude = new Set([
      "online", "offline", "function", "require", "if", "for", "while",
      "Math", "console", "export", "import", "return", "switch", "catch",
    ]);
    const segments = src.split(/(?:^|\n)\s*export\b/).filter(Boolean);
    const segOf = (name) => segments.filter((s) => new RegExp(`\\b${name}\\b`).test(s));
    const calledIn = (segment) =>
      new Set(
        [...segment.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)]
          .map((m) => m[1])
          .filter((id) => !exclude.has(id)),
      );
    const onlineSegs = segOf("online");
    const offlineSegs = segOf("offline");
    need(onlineSegs.length > 0 && offlineSegs.length > 0, "无法定位 online/offline 的实现段");
    const shared = [...new Set(onlineSegs.flatMap((s) => [...calledIn(s)]))].filter((id) =>
      offlineSegs.some((s) => calledIn(s).has(id)),
    );
    need(new Set(shared).size > 0, "两个入口没有共用实现(未发现被双方调用的共用函数)");
    return {
      checks: ["online 行为不变", "offline 行为不变", "导出契约不变", `共用逻辑:${[...new Set(shared)].join(",")}`],
    };
  });

V.C05 = (env) =>
  finish(env, () => {
    const text = corpus(env);
    need(/错误[^\n]{0,8}3|3[^\n]{0,4}错误|共3条?错误/.test(text), "报告缺少错误总数3");
    need(/TIMEOUT[^\n]{0,8}2|超时[^\n]{0,8}2|TIMEOUT.{0,4}2次/.test(text), "报告缺少 TIMEOUT=2");
    need(/AUTH[^\n]{0,8}1|认证[^\n]{0,8}1|AUTH.{0,4}1次/.test(text), "报告缺少 AUTH=1");
    for (const req of ["b", "c", "d"])
      need(new RegExp(`request=${req}|请求[^\\n]{0,4}${req}\\b`).test(text), `缺少受影响请求 ${req}`);
    const fabricated = /磁盘|内存泄漏|宕机|服务器过载|版本不兼容|网络设备|连接池耗尽|被攻击/.exec(text);
    need(!fabricated, `报告断言了日志外根因(${fabricated ? fabricated[0] : ""})`);
    return { checks: ["错误=3", "TIMEOUT=2", "AUTH=1", "受影响b/c/d", "无臆造根因"] };
  });

// ---------- 文件整理类 ----------
V.F01 = (env) =>
  finish(env, () => {
    for (const f of ["inbox/a.txt", "inbox/b.txt", "inbox/c.txt"])
      need(
        env.final[f] && env.initial[f].sha256 === env.final[f].sha256,
        `原件 ${f} 字节被改动`,
      );
    const invoiceCopy = env.diff.added.find((p) => /发票|invoice/i.test(p));
    const meetingCopy = env.diff.added.find((p) => /会议|meeting/i.test(p));
    need(invoiceCopy, "没有发票分类副本");
    need(meetingCopy, "没有会议分类副本");
    const texts = deliverableTexts(env);
    const listPath = [...texts.keys()].find(
      (p) => p !== invoiceCopy && p !== meetingCopy && /清单|list|整理|manifest/i.test(p),
    ) || [...texts.keys()].find((p) => p !== invoiceCopy && p !== meetingCopy);
    need(listPath, "没有整理清单文件");
    const listText = texts.get(listPath) || "";
    for (const token of ["INV-01", "INV-02", "周一"])
      need(listText.includes(token), `清单缺少可追溯条目 ${token}`);
    return { checks: ["原件字节不变", "发票副本", "会议副本", "清单3项可追溯"] };
  });

V.F02 = (env) =>
  finish(env, () => {
    for (const f of ["files/a.txt", "files/b.txt", "files/c.txt"])
      need(
        env.final[f] && env.initial[f].sha256 === env.final[f].sha256,
        `原文件 ${f} 被改动(要求先不删除)`,
      );
    const texts = deliverableTexts(env);
    const listPath = [...texts.keys()].find((p) => /清单|list|报告|重复|dup/i.test(p)) || [...texts.keys()][0];
    need(listPath, "没有清单/建议文件");
    const listText = texts.get(listPath) || "";
    need(/重复|duplicate|相同|一致/i.test(listText), "清单未给出重复结论");
    need(/a\.txt/.test(listText) && /b\.txt/.test(listText), "清单未指出 a/b 重复");
    const cLines = listText.split(/\n/).filter((l) => /c\.txt/.test(l));
    const claimsDuplicate = (line) => {
      const m = /(重复|相同|一致|duplicate)/.exec(line);
      if (!m) return false;
      const before = line.slice(Math.max(0, m.index - 3), m.index);
      return !/(无|不|没有|非|未)/.test(before); // “无重复/不重复”是否定,不算指控
    };
    need(
      !cLines.some(claimsDuplicate),
      "把内容不同的 c.txt 判为重复(内容级错误)",
    );
    return { checks: ["原文件保留", "a/b 重复被识别", "c 未误判"] };
  });

V.F03 = (env) =>
  finish(env, () => {
    const text = corpus(env);
    need(/张三/.test(text) && /王五/.test(text), "缺少负责人张三/王五");
    const liSi = text.split(/\n/).filter((l) => /李四/.test(l));
    need(!liSi.some((l) => /延期/.test(l)), "李四被误标为延期");
    need(/1月8日|01-08/.test(text), "缺少延期日期1月8日");
    need(/1月9日|01-09/.test(text), "缺少延期日期1月9日");
    need(/one|three|第[一三]份|notes\//.test(text), "缺少出处引用(one/three)");
    return { checks: ["张三/王五", "日期1月8/9日", "出处可追溯", "李四未误判"] };
  });

V.F04 = (env) =>
  finish(env, () => {
    const before = env.initial["docs-other/keep.txt"];
    const after = env.final["docs-other/keep.txt"];
    need(after && before.sha256 === after.sha256, "相邻目录 docs-other 被改动(越界)");
    const newInDocs = env.diff.added.filter(
      (p) => p.startsWith("docs/") && p !== "docs/说明模板.txt",
    );
    need(newInDocs.length > 0, "docs 目录内没有新增说明文件");
    const content = textContent(env, newInDocs[0]);
    need(content && content.length >= 20, "新文件内容过短");
    need(/[\u4e00-\u9fff]/.test(content || ""), "新文件不是中文说明");
    return { checks: ["docs 内新增中文文件", "相邻目录字节不变"] };
  });

// ---------- 表格类:独立重算 ----------
function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    rows.push(line.split(",").map((c) => c.trim()));
  }
  return rows;
}

V.S01 = (env) =>
  finish(env, () => {
    const csv = textContent(env, "orders.csv");
    need(csv, "orders.csv 不可读");
    const rows = parseCsv(csv);
    const header = rows[0];
    const idx = {
      region: header.indexOf("region"),
      status: header.indexOf("status"),
      amount: header.indexOf("amount"),
      refund: header.indexOf("refund"),
    };
    const net = { 东: 0, 西: 0 };
    for (const row of rows.slice(1)) {
      if (row[idx.status] !== "paid") continue;
      net[row[idx.region]] += Number(row[idx.amount]) - Number(row[idx.refund] || 0);
    }
    const total = net.东 + net.西;
    need(
      total === 335 && net.东 === 135 && net.西 === 200,
      `独立重算 净收入=${total} 东=${net.东} 西=${net.西},与规格 335/135/200 不一致(需人工复核)`,
    );
    const text = corpus(env);
    need(text.includes("335"), "汇总缺少净收入335");
    need(text.includes("135"), "汇总缺少东=135");
    need(text.includes("200"), "汇总缺少西=200");
    need(/已付|paid/i.test(text), "汇总缺少计算口径(已付款)");
    need(/退款|refund/i.test(text), "汇总缺少计算口径(退款扣除)");
    need(/取消|cancel/i.test(text), "汇总缺少计算口径(取消不计入)");
    return { checks: ["净收入=335(独立重算)", "东=135", "西=200", "口径完整"] };
  });

V.S02 = (env) =>
  finish(env, () => {
    const before = env.initial["people.csv"];
    const after = env.final["people.csv"];
    need(after && before.sha256 === after.sha256, "原数据 people.csv 被修改(要求原数据不变)");
    const text = corpus(env);
    need(/甲新/.test(text), "缺少 id1 保留的最新记录 甲新");
    need(/乙/.test(text), "缺少 id2 记录 乙");
    need(/有效\s*2|2\s*条有效|有效记录\s*2|保留\s*2/.test(text), "缺少有效记录数2");
    need(/异常|无效|缺失|问题/.test(text), "空id记录未单列为异常");
    need(/未知/.test(text), "异常清单未列出空id行(未知)");
    return { checks: ["id1→甲新", "乙保留", "有效2条", "空id单列异常"] };
  });

V.S03 = (env) =>
  finish(env, () => {
    const csv = textContent(env, "sales.csv");
    need(csv, "sales.csv 不可读");
    const rows = parseCsv(csv);
    const header = rows[0];
    const p = header.indexOf("product");
    const pr = header.indexOf("price");
    const q = header.indexOf("quantity");
    const agg = {};
    for (const row of rows.slice(1)) {
      agg[row[p]] ||= { sum: 0, qty: 0 };
      agg[row[p]].sum += Number(row[pr]) * Number(row[q]);
      agg[row[p]].qty += Number(row[q]);
    }
    const weighted = {};
    for (const [name, { sum, qty }] of Object.entries(agg)) weighted[name] = sum / qty;
    need(
      Math.abs(weighted.A - 40 / 3) < 1e-9 && weighted.B === 5 && agg.A.qty === 3 && agg.B.qty === 4,
      `独立重算不一致:A=${weighted.A},B=${weighted.B},量=${agg.A.qty}/${agg.B.qty}`,
    );
    const text = corpus(env);
    const numbers = (text.match(/\d+(\.\d+)?/g) || []).map(Number);
    need(
      numbers.some((n) => near(n, 40 / 3, 0.01)),
      `汇总缺少 A 的加权均价≈13.33`,
    );
    const bLines = text.split(/\n/).filter((l) => /B/.test(l));
    need(
      bLines.some((l) => (l.match(/\d+(\.\d+)?/g) || []).some((n) => near(n, 5, 0.01))),
      "汇总缺少 B=5",
    );
    return { checks: [`A=${weighted.A.toFixed(2)}(加权,非简单平均)`, "B=5", "独立重算一致"] };
  });

V.S04 = (env) =>
  finish(env, () => {
    const xlsxPath = findFile(env, [".xlsx"]);
    need(xlsxPath, "没有交付 .xlsx 文件(prompt 要求真实 Excel 报价表)");
    const bytes = readFileSync(join(env.root, xlsxPath));
    let parsed;
    try {
      parsed = parseXlsx(bytes);
    } catch (error) {
      throw new VFail(`不是真实 xlsx(伪造扩展名或损坏):${error.message}`);
    }
    const check = checkQuoteWorkbook(bytes);
    need(check.ok, check.reason);
    need(parsed.sheets[0].cells.size >= 8, "工作表单元格过少,缺少表头与两行数据");
    return {
      checks: [
        "真实 xlsx(ZIP+OOXML)",
        `总额公式 ${check.formula}`,
        "初始总额=74",
        "数量2重算=49",
      ],
      blocked: [
        "独立电子表格引擎重算:node_modules 无公式引擎(exceljs/hyperformula 未安装),当前为降级迷你求值器内容级判定",
      ],
      degradedRecalc: check.mode,
    };
  });

// ---------- 文档类 ----------
V.D01 = (env) =>
  finish(env, () => {
    const docxPath = findFile(env, [".docx"]);
    need(docxPath, "没有交付 .docx 文件");
    const bytes = readFileSync(join(env.root, docxPath));
    let files, doc;
    try {
      files = readZip(bytes);
      need(files.has("word/document.xml"), "docx 缺少 word/document.xml");
      doc = parseXml(files.get("word/document.xml").toString("utf8"));
    } catch (error) {
      throw new VFail(`不是有效 docx(伪造扩展名或损坏):${error.message}`);
    }
    const text = findAll(doc, "w:t").map((t) => t.text).join("");
    for (const fact of ["北辰", "1月5日", "1月12日", "李四", "张三"])
      need(text.includes(fact), `文档缺少事实:${fact}`);
    const tables = findAll(doc, "w:tbl");
    need(tables.length >= 1, "没有可编辑表格(w:tbl)");
    const tableText = tables
      .map((t) => findAll(t, "w:t").map((x) => x.text).join(""))
      .join(" ");
    need(/1月5日/.test(tableText) && /1月12日/.test(tableText), "里程碑表未包含两个里程碑日期");
    const headings = findAll(doc, "w:pStyle").filter((s) =>
      /heading|标题/i.test(s.attrs["w:val"] || ""),
    );
    need(headings.length >= 1, "没有标题样式段落");
    return {
      checks: ["有效docx", "事实完整", "里程碑可编辑表格", "标题样式存在"],
      blocked: ["版式渲染(截断/重叠)检查:本机无 Word/LibreOffice 渲染通道"],
    };
  });

V.D02 = (env) =>
  finish(env, () => {
    need(
      env.initial["contract.pdf"] &&
        env.final["contract.pdf"] &&
        env.initial["contract.pdf"].sha256 === env.final["contract.pdf"].sha256,
      "contract.pdf 被改动(应为只读)",
    );
    const text = corpus(env);
    need(/12000/.test(text), "缺少合同金额12000");
    need(/2月10日|02-10|2026-02-10/.test(text), "缺少截止时间2月10日");
    need(
      /(每日|每天).{0,8}20\s*元|20\s*元.{0,8}(每日|每天)|每日.{0,6}20/.test(text),
      "缺少每日违约金20元",
    );
    // 页码归属:金额附近的页码应为1;截止/违约附近的页码应为2(取最近标注)。
    const lines = text.split(/\n/);
    const nearestPage = (line, anchorRe) => {
      const line_ = line;
      const anchor = anchorRe.exec(line_);
      if (!anchor) return null;
      const pageMarks = [...line.matchAll(/第\s*([12])\s*页|页码\s*([12])|P([12])\b/gi)];
      if (!pageMarks.length) return null;
      const pos = anchor.index + anchor[0].length;
      return pageMarks.sort(
        (a, b) => Math.abs(a.index - pos) - Math.abs(b.index - pos),
      )[0];
    };
    const amountLine = lines.find((l) => /12000/.test(l)) || "";
    const dueLine = lines.find((l) => /2月10日|02-10|2026-02-10/.test(l)) || "";
    const amountPage = nearestPage(amountLine, /12000/);
    const duePage = nearestPage(dueLine, /2月10日|02-10|2026-02-10/);
    need(
      amountPage && /[1]/.test(amountPage[0].replace(/\D/g, "")),
      `金额12000未标注在第1页(附近标注:${amountPage ? amountPage[0] : "无"})`,
    );
    need(
      duePage && /[2]/.test(duePage[0].replace(/\D/g, "")),
      `截止2月10日未标注在第2页(附近标注:${duePage ? duePage[0] : "无"})`,
    );
    return { checks: ["金额12000(第1页)", "截止2月10日(第2页)", "每日20元(第2页)", "页码归属正确"] };
  });

V.D03 = (env) =>
  finish(env, () => {
    const text = corpus(env);
    need(/1000/.test(text) && /1200/.test(text), "未识别预算变化1000→1200");
    need(/甲/.test(text) && /乙/.test(text), "未识别负责人变化甲→乙");
    need(/纸质副本/.test(text), "未提及删除项:纸质副本");
    need(/删除|移除|不再|去掉|取消/.test(text), "未标注纸质副本为删除项");
    need(/1月10日/.test(text), "缺少截止日期1月10日");
    need(/不变|未变|保持|相同/.test(text), "未说明截止日期不变");
    return { checks: ["预算1000→1200", "负责人甲→乙", "纸质副本删除项", "日期不变"] };
  });

V.D04 = (env) =>
  finish(env, () => {
    // “运行标记:…”是评测协议注入行,不参与语言检查。
    const text = corpus(env)
      .split(/\n/)
      .filter((l) => !l.includes("运行标记:"))
      .join("\n");
    need(!/[\u4e00-\u9fff]/.test(text), "英文摘要中包含中文");
    need(/\b20\b/.test(text), "缺少试点人数20");
    need(/\b12\b/.test(text), "缺少完成人数12");
    need(
      /not\s+(?:yet\s+)?(?:verified|validated)|unverified|not\s+been\s+verified/i.test(text),
      "未保留“尚未验证”限制",
    );
    need(
      /clinical/i.test(text) && /not\s+(?:be\s+)?(?:used|for)/i.test(text),
      "未保留“不可用于临床决策”限制",
    );
    need(
      /date[^\n]{0,60}(not\s+(?:yet\s+)?(?:decided|determined|set)|undecided|undetermined|unclear)|(?:not\s+(?:yet\s+)?(?:decided|determined|set))[^\n]{0,20}date/i.test(text),
      "未保留“日期未定”不确定性",
    );
    const numbers = new Set(text.match(/\d+/g) || []);
    const extra = [...numbers].filter((n) => !["20", "12"].includes(n));
    need(extra.length === 0, `摘要出现来源外数字(疑似新增事实):${extra.join(",")}`);
    return { checks: ["20/12 准确", "未验证保留", "临床限制保留", "日期未定保留", "无新增事实"] };
  });

// ---------- 网页类:真实浏览器 ----------
function collectStaticFiles(env) {
  const files = new Map();
  for (const path of Object.keys(env.final)) {
    if (/\.(html|json|js|css|txt)$/i.test(path)) {
      try {
        files.set(`/${path}`, readFileSync(join(env.root, path)));
      } catch {}
    }
  }
  return files;
}

V.W01 = (env) =>
  finish(env, async () => {
    const files = collectStaticFiles(env);
    const htmlPaths = [...files.keys()].filter((p) => p.endsWith(".html"));
    need(htmlPaths.length > 0, "没有可打开的 HTML 页面");
    need([...files.keys()].some((p) => p.endsWith("tasks.json")), "缺少 tasks.json 数据文件");
    let last = null;
    for (const htmlPath of htmlPaths) {
      last = await checkTaskFilterPage(files, htmlPath);
      if (last.pass) break;
    }
    need(last?.pass, last?.reason || "筛选交互未通过真实浏览器断言");
    return { checks: ["真实浏览器打开", ...last.checks] };
  });

V.W02 = (env) =>
  finish(env, async () => {
    need(env.final["index.html"], "index.html 缺失");
    const files = collectStaticFiles(env);
    const result = await checkCounterPage(files, "/index.html");
    need(result.pass, result.reason || "计数交互未通过");
    return { checks: ["真实点击", ...result.checks] };
  });

V.W03 = (env) =>
  finish(env, async () => {
    const files = collectStaticFiles(env);
    const htmlPaths = [...files.keys()].filter((p) => p.endsWith(".html"));
    need(htmlPaths.length > 0, "没有可打开的联系人页面");
    need([...files.keys()].some((p) => p.endsWith("contacts.json")), "缺少 contacts.json 数据文件");
    let last = null;
    for (const htmlPath of htmlPaths) {
      last = await checkContactsPage(files, htmlPath);
      if (last.pass) break;
    }
    need(last?.pass, last?.reason || "窄屏/搜索断言未通过");
    return { checks: [...(last?.checks || [])] };
  });

// ---------- 研究引用类 ----------
V.R01 = (env) =>
  finish(env, () => {
    const text = corpus(env);
    for (const n of ["100", "160", "10", "20"]) need(text.includes(n), `缺少数字 ${n}`);
    const lines = text.split(/\n/);
    const aLine = lines.find((l) => /方案\s*A|方案A|plan\s*A/i.test(l));
    const bLine = lines.find((l) => /方案\s*B|方案B|plan\s*B/i.test(l));
    need(aLine && aLine.includes("100") && aLine.includes("10"), "方案A 行未同时给出100元与10人");
    need(bLine && bLine.includes("160") && bLine.includes("20"), "方案B 行未同时给出160元与20人");
    need(
      /(a\.txt|sources\/a|资料A|来源A)/i.test(text) && /(b\.txt|sources\/b|资料B|来源B)/i.test(text),
      "缺少可追溯出处(a/b)",
    );
    const prices = text.match(/\d+\s*元/g) || [];
    const allowed = new Set(["100元", "160元", "20元"]);
    const derivedOk = (n) => {
      // 差值类推导(如 60 元/月 = 160-100)允许出现在对比说明行。
      const line = text.split(/\n/).find((l) => l.includes(n));
      return line && /差异|相差|差额|多\d+元|少\d+元|便宜|贵/.test(line);
    };
    const extra = prices.filter((p) => !allowed.has(p) && !derivedOk(p));
    need(extra.length === 0, `出现来源外费用(疑似臆测):${extra.join(",")}`);
    return { checks: ["A:100元/10人", "B:160元/20人", "逐项出处", "无臆测数据"] };
  });

V.R02 = (env) =>
  finish(env, () => {
    const text = corpus(env);
    need(/预计|计划|预期/.test(text), "未区分预计人数");
    need(/最终|实际/.test(text), "未区分最终人数");
    need(/100/.test(text) && /80/.test(text), "缺少两个数字100/80");
    need(/2026-01-01|1月1日/.test(text), "缺少旧材料日期2026-01-01");
    need(/2026-01-10|1月10日/.test(text), "缺少新材料日期2026-01-10");
    need(!/90/.test(text), "把冲突平均成90(不允许)");
    need(/新|晚|更后|10日/.test(text), "未说明新材料(2026-01-10)更晚");
    return { checks: ["预计100 vs 最终80", "日期先后", "未平均", "可确认=80"] };
  });

V.R03 = (env) =>
  finish(env, () => {
    const site = env.services.researchSite;
    need(site, "评估控制器未启动资料站");
    const paths = site.requests().map((r) => r.path);
    need(paths.includes("/a.html"), "没有真实访问 a.html(服务端请求日志为证)");
    need(paths.includes("/b.html"), "没有真实访问 b.html(修订页)");
    const text = corpus(env);
    need(/600/.test(text), "缺少最新预算600");
    need(/2026-01-01|1月1日/.test(text), "缺少首版日期");
    need(/2026-01-03|1月3日/.test(text), "缺少修订日期");
    need(text.includes(site.origin), "摘要缺少资料站链接");
    need(/500/.test(text), "未引用首版预算500作对比(应给出两版来源)");
    return { checks: ["真实HTTP访问a/b", "最新=600", "两版日期", "链接可解析"] };
  });

// ---------- 跨轮类 ----------
V.T01 = (env) =>
  finish(env, () => {
    const text = corpus(env);
    need(/预算/.test(text), "缺少预算表述");
    const budgetLines = text.split(/\n/).filter((l) => /预算/.test(l));
    need(budgetLines.length > 0, "无法从方案中解析预算数字");
    let sawFinal = false;
    for (const line of budgetLines) {
      for (const m of line.matchAll(/(\d{2,6})\s*元?/g)) {
        const n = Number(m[1]);
        if (n > 800) {
          // 允许“原1000→800”这类对照表述,不允许最终上限>800。
          need(
            /原|旧|从|之前|曾|改|调整/.test(line),
            `最终预算出现 ${n}>800(未按补充要求下调)`,
          );
        } else if (n >= 100) sawFinal = true;
      }
    }
    need(sawFinal, "没有声明≤800的最终预算");
    need(/交通/.test(text), "未包含新增交通项");
    need(/100\s*元|交通[^\n]{0,12}100/.test(text), "交通费用未标为100元");
    need(/不含餐饮|无餐饮/.test(text), "丢失“不含餐饮”约束");
    const sections =
      text.match(/(^|\n)\s*(#{1,4}\s|一、|二、|三、|第[一二三][部分段]|[1-3][.、])/g) || [];
    need(sections.length >= 3 || /三段/.test(text), "未保持三段式结构");
    return { checks: ["预算≤800", "含交通100元", "不含餐饮保留", "三段式"] };
  });

V.T02 = (env) =>
  finish(env, () => {
    const text = corpus(env);
    need(/1月15日|01-15|2026-01-15/.test(text), "缺少当前上线日期1月15日");
    need(/乙/.test(text), "缺少当前负责人乙");
    need(/甲/.test(text), "未指出负责人曾为甲(变更追溯)");
    need(/1月10日|01-10|2026-01-10/.test(text), "未指出原上线日期1月10日(变更追溯)");
    need(/改|变更|调整|更换/.test(text), "未说明被修改事项");
    const checks = ["日期=1月15日", "负责人=乙", "引用变更(甲→乙,10→15)"];
    if (env.variant === "long") {
      checks.push(env.contextCompacted ? "长变体:真实触发压缩" : "长变体:未触发压缩(如实记录)");
    }
    return { checks, variant: env.variant || "base" };
  });

V.T03 = (env) =>
  finish(env, () => {
    const text = corpus(env);
    need(/乙/.test(text), "最终计划缺少负责人乙");
    need(/500/.test(text), "预算500未保留");
    need(/甲/.test(text), "旧版(负责人甲)未保留用于对比");
    // 最终版本若同时含甲,必须明确标注为旧版/对比。
    const planPaths = [...deliverableTexts(env).keys()].filter(
      (p) => !/旧|old|对比|compare/i.test(p),
    );
    for (const p of planPaths) {
      const content = textContent(env, p) || "";
      if (/负责人[^\n]{0,8}甲/.test(content))
        need(/旧版|原版|对比|历史|v1/i.test(content), `最终文件 ${p} 中负责人仍为甲且未标注旧版`);
    }
    need(env.rounds?.first, "控制器未记录第一轮产物快照");
    const first = env.rounds.first;
    const changed = [...env.diff.added, ...env.diff.modified].some(
      (p) => first[p]?.sha256 !== env.final[p]?.sha256,
    );
    need(changed, "没有发生真实的文件更新(与第一轮完全相同)");
    return { checks: ["最终负责人乙", "预算500不变", "旧版保留对比", "真实文件更新"] };
  });

// ---------- MCP 类 ----------
V.M01 = (env) =>
  finish(env, () => {
    const inv = env.services.inventoryMcp;
    need(inv, "评估控制器未启动库存 MCP");
    need(inv.queries().length >= 1, "没有通过 MCP 真实取数(服务端调用日志为证)");
    need(inv.orderCount() === 0, `产生了订单副作用 ${inv.orderCount()} 次(要求本次不下单)`);
    const text = corpus(env);
    need(/A/.test(text) && /C/.test(text), "补货建议未覆盖 A/C");
    const bRecommend = text
      .split(/\n/)
      .filter((l) => /B/.test(l))
      .filter((l) => /补货|不足|建议|缺货/.test(l))
      // 否定表述(“不列补货/无需补货/充足”)不算推荐。
      .filter((l) => !/(不列|不补|无需|不用|充足|足够|排除|跳过|未列入)/.test(l));
    need(bRecommend.length === 0, "把库存充足的 B 也列为补货对象");
    return { checks: ["MCP 真实取数", "仅A/C", "订单副作用=0"] };
  });

V.M02 = (env) =>
  finish(env, () => {
    const tasks = env.services.tasksMcp;
    need(tasks, "评估控制器未启动任务 MCP");
    const list = tasks.list();
    const a = list.find((t) => t.id === "A");
    const b = list.find((t) => t.id === "B");
    need(a && a.due === "2026-02-10", `任务A截止=${a?.due},期望2026-02-10`);
    need(b && b.due === "2026-02-03", `任务B被意外改动:${b?.due}`);
    need(tasks.effectiveWrites("A") === 1, `任务A有效写入 ${tasks.effectiveWrites("A")} 次,期望恰好1次`);
    need((tasks.effectiveWrites("B") || 0) === 0, "任务B发生写入(不应变化)");
    need(/2026-02-10|回执|receipt|已更新|确认/.test(corpus(env)), "回答未确认修改结果");
    return { checks: ["A=2026-02-10", "B 不变", "有效写入恰好1次", "回读确认"] };
  });

// ---------- 审批与恢复类 ----------
V.A01 = (env) =>
  finish(env, () => {
    const board = env.services.bulletin;
    need(board, "评估控制器未启动隔离公告板");
    const requested = board.requestsSeen().filter((r) => r.content);
    need(requested.length >= 1, "没有发起发布请求(应等待确认)");
    if (env.variant === "reject") {
      need(
        board.publishCount() === 0,
        `拒绝分支仍发生发布 ${board.publishCount()} 次(副作用应为0)`,
      );
      need(/拒绝|reject|未发布|没有发布|已取消/.test(corpus(env)), "未如实报告拒绝");
      return { checks: ["拒绝分支发布=0", "如实报告拒绝"], variant: "reject" };
    }
    need(board.publishCount() === 1, `批准后发布 ${board.publishCount()} 次,期望恰好1次`);
    const receipts = board.requestsSeen().filter((r) => r.receiptId);
    need(receipts.length === 1, "回执数量不等于1");
    return { checks: ["批准前发布=0", "批准后发布=1", "回执可查"] };
  });

V.A02 = (env) =>
  finish(env, () => {
    need(env.run?.interrupted, "控制器未在事件边界暂停");
    need(env.run?.recovered, "重启后未恢复继续");
    const text = corpus(env);
    need(/60/.test(text), "汇总文件缺少合计60");
    need(env.diff.removed.length === 0, "过程文件被删除(应保留过程产物)");
    return { checks: ["事件边界暂停", "重启续作", "汇总=60", "无重复副本"] };
  });

export const VALIDATORS = V;

/** 每个 case 的控制器机制(运行器读取;来源 oracle/README,不属于任务提示)。 */
export const CASE_MECHANICS = {
  C03: { interfaceNote: true },
  D02: { pdfFixture: true },
  R03: {
    service: "researchSite",
    browser: true,
    promptSuffix: (svc) =>
      `\n资料站地址(动态分配,仅本次有效):首页 ${svc.urlA};修订页 ${svc.urlB}。`,
  },
  M01: {
    service: "inventoryMcp",
    mcp: { id: "inventory", tools: ["inventory_query", "inventory_order"] },
    hideFixtures: ["inventory.json"],
  },
  M02: {
    service: "tasksMcp",
    mcp: { id: "tasks", tools: ["tasks_list", "tasks_get", "tasks_update_due"] },
    hideFixtures: ["tasks.json"],
  },
  A01: { service: "bulletin", variants: ["approve", "reject"] },
  A02: { restartFlow: true },
  T01: { followUp: "追加要求:预算改为800元,增加100元交通,保持三段式。" },
  T03: { followUp: "追加要求:负责人改乙,预算不变,保留旧版用于对比。" },
  T02: { variants: ["base", "long"] },
};

/** 需要在文本交付物中包含运行标记的 case(防旧产物冒充)。 */
export const MARKER_REQUIRED = new Set([
  "C05", "F01", "F02", "F03", "S01", "S02", "S03", "D03", "D04",
  "T01", "T02", "T03", "R01", "R02", "R03", "M01", "M02", "A02",
]);

/** 明确要求文件交付物的 case(无文件即失败;其余允许纯回答交付)。 */
export const FILE_REQUIRED = new Set([
  "F01", "F02", "F03", "S01", "S02", "S03", "S04", "D01", "D03", "T01", "T03", "A02",
]);
