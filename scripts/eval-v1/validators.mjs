// general-agent-v1 独立验收器:每个 case 一个 oracle 判定函数。
// 设计原则(README 第 4 条):优先数值、结构、文件格式、执行结果、真实浏览器
// 交互与服务回执断言;版式/事实完整性类用明确评分项;不依赖关键词存在即通过。
// 验收器只看:工作区终态、初始/最终哈希、模型回答、工具事件、隔离服务回执。
//
// N1(复核 R1):被测代码一律经受控执行后端运行(执行隔离、截止时间、输出
// 上限、结果协议防伪造、产物篡改检测);后端缺失 = 必需检查 blocked,绝不
// 回退宿主 Node。
// N2(复核 R2):检查项为显式结构 {id, required, status, reason, evidence};
// 聚合规则单一(checks.mjs):必需检查全部 pass 才 pass,任一必需 fail 则
// fail,无确定失败但有必需 blocked/timeout 则相应降级——blocked 不进成功分子。
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { parseXlsx, checkQuoteWorkbook, parseRef } from "./lib/xlsx-check.mjs";
import { readZip } from "./lib/zip.mjs";
import { parseXml, findAll } from "./lib/xml.mjs";
import { safeRelativePath, hashTree, TreeBoundaryError } from "./lib/fixtures.mjs";
import {
  buildHarnessScript,
  parseResultLine,
  BackendUnavailableError,
} from "./lib/execution-backend.mjs";
import { CheckList, aggregateChecks } from "./lib/checks.mjs";
import {
  checkTaskFilterPage,
  checkCounterPage,
  checkContactsPage,
} from "./lib/browser-check.mjs";

export class VFail extends Error {}
export function need(condition, message) {
  if (!condition) throw new VFail(message);
}
// 执行基础设施缺口(后端缺失/超时):必需检查 blocked/timeout,不是 fail。
export class ExecutionBlocked extends Error {}
export class ExecutionTimeout extends Error {}
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
function commonGuards(env, checks) {
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
  checks.pass("guard.marker", "运行标记未被改动");
  checks.pass("guard.paths", "产物路径全部在授权工作区内");
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
    checks.pass("guard.no-duplicate", "无重复副本");
  }
}

// 运行标记与交付要求(N2):required/optional 由数据版本静态决定。
function markerAndDeliveryChecks(env, checks) {
  if (!env.markerRequired) return;
  const texts = new Map(
    [...deliverableTexts(env)].filter(([p]) => p !== "EVAL-RUN-MARKER.txt"),
  );
  if (texts.size > 0) {
    need(
      [...texts.values()].some((t) => t.includes(env.marker)),
      `交付文件未包含本次运行标记 ${env.marker}(疑似旧产物冒充)`,
    );
    checks.pass("marker.present", "交付文件含本次运行标记");
  } else if (FILE_REQUIRED.has(env.caseId)) {
    throw new VFail("没有交付任何文件(该任务要求文件交付物)");
  } else {
    checks.optional("marker.present", "pass", "无文件交付,按回答判定");
  }
}

/** 统一收口:运行验证器内部逻辑 → 检查级聚合(单一判定源)。 */
async function finish(env, run) {
  const checks = new CheckList();
  try {
    await run(checks);
    commonGuards(env, checks);
    markerAndDeliveryChecks(env, checks);
  } catch (error) {
    if (error instanceof VFail) {
      checks.fail("assert", error.message);
    } else if (error instanceof ExecutionTimeout) {
      checks.timeout("execution", error.message);
    } else if (error instanceof ExecutionBlocked) {
      checks.blocked("execution-backend", error.message);
    } else if (/无法启动浏览器/.test(error.message)) {
      checks.blocked("browser", error.message);
    } else if (error instanceof TreeBoundaryError) {
      checks.fail("guard.tree-boundary", error.message);
    } else {
      // 验收器自身异常单独记录为 error,不伪装成业务 fail,更不是 pass。
      checks.error("validator", `验收器异常:${error.message}`);
    }
  }
  return aggregateChecks(checks, { violations: env.violations || [] });
}

// ---------- 代码类:受控执行断言(N1) ----------
// 求值在被测进程内完成,判定全部在控制器;结果行带随机 nonce(经 stdin 传
// 递,不出现在 argv/env),只接受恰好一条匹配行;执行前后对整个测试工作区
// 做哈希快照,产物被篡改即 fail。
async function runModule(env, relPath, statements) {
  const absPath = join(env.root, relPath);
  need(existsSync(absPath), `${relPath} 不存在`);
  const before = workspaceSnapshot(env);
  const backend = env.execution?.backend;
  if (!backend)
    throw new ExecutionBlocked(
      "未提供执行后端;按 N1 要求不得回退宿主 Node 直接运行被测代码",
    );
  const nonce = randomBytes(16).toString("hex");
  const script = buildHarnessScript(pathToFileURL(absPath).href, statements);
  let result;
  try {
    result = await backend.run({
      root: env.root,
      script,
      nonce,
      timeoutMs: env.execution?.timeoutMs,
      outputLimitBytes: env.execution?.outputLimitBytes,
    });
  } catch (error) {
    if (error instanceof BackendUnavailableError)
      throw new ExecutionBlocked(error.message);
    throw error;
  }
  if (result.status === "timeout")
    throw new ExecutionTimeout(
      `被测模块执行超过截止时间,已终止且无残留进程(后端 ${backend.id})`,
    );
  if (result.status === "output_limit")
    throw new VFail("被测模块输出超过上限,已被有界终止(疑似失控输出)");
  if (result.status === "error")
    throw new Error(`执行后端错误:${result.spawnError}`);
  const values = parseResultLine(result.stdout, nonce);
  if (values.__importError)
    throw new VFail(`模块导入失败:${values.__importError}`);
  const after = workspaceSnapshot(env);
  if (before !== after)
    throw new VFail(
      "测试工作区在受控执行期间被篡改(执行前后哈希不一致),产物不可信",
    );
  return values;
}

function workspaceSnapshot(env) {
  try {
    return JSON.stringify(hashTree(env.root));
  } catch (error) {
    if (error instanceof TreeBoundaryError) throw new VFail(error.message);
    throw error;
  }
}

const V = {};

V.C01 = (env) =>
  finish(env, async (checks) => {
    need(env.diff.modified.includes("price.mjs"), "price.mjs 未被修改");
    const r = await runModule(env, "price.mjs", [
      ["t1", "m.total(1.25,4)"],
      ["t2", "m.total(2.5,0)"],
      ["t3", "m.total(0.1,3)"],
      ["isFn", "typeof m.total"],
    ]);
    need(r.isFn === "function", "导出 total 被删除");
    need(r.t1 === 5, `total(1.25,4)=${r.t1},期望5`);
    need(r.t2 === 0, `total(2.5,0)=${r.t2},期望0`);
    need(near(r.t3, 0.3, 1e-9), `total(0.1,3)=${r.t3},期望≈0.3`);
    checks.pass("c01.total", "total:1.25×4=5、零数量=0、0.1×3≈0.3(受控执行)");
  });

V.C02 = (env) =>
  finish(env, async (checks) => {
    need(env.diff.modified.includes("intervals.mjs"), "intervals.mjs 未被修改");
    const r = await runModule(env, "intervals.mjs", [
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
    checks.pass("c02.merge", "合并=[[1,4],[5,8]]、空数组=[]、原输入不变(受控执行)");
  });

V.C03 = (env) =>
  finish(env, async (checks) => {
    need(env.initial["接口约定.txt"] !== undefined, "缺少接口约定夹具(控制器应附加分页约定)");
    need(env.diff.modified.includes("pages.mjs"), "pages.mjs 未被修改");
    const r = await runModule(env, "pages.mjs", [
      ["p1", "JSON.stringify(m.page([1,2,3],1,2))"],
      ["p3", "JSON.stringify(m.page([1,2,3],3,2))"],
      ["zeroPage", "(()=>{try{m.page([1,2,3],0,2);return 'no-throw'}catch(e){return 'throw'}})()"],
      ["zeroSize", "(()=>{try{m.page([1,2,3],1,0);return 'no-throw'}catch(e){return 'throw'}})()"],
    ]);
    need(r.p1 === "[1,2]", `page([1,2,3],1,2)=${r.p1},期望 [1,2](页码从1开始)`);
    need(r.p3 === "[]", `第3页=${r.p3},期望 [](超出末页返回空列表)`);
    need(r.zeroPage === "throw", "页码0未抛错");
    need(r.zeroSize === "throw", "页大小0未抛错");
    checks.pass("c03.page", "页码从1开始、末页外=[]、非法参数抛错(受控执行)");
  });

V.C04 = (env) =>
  finish(env, async (checks) => {
    need(env.diff.modified.includes("shop.mjs"), "shop.mjs 未被修改");
    const r = await runModule(env, "shop.mjs", [
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
    checks.pass("c04.behavior", "online/offline 行为不变、导出契约不变(受控执行)");
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
    checks.pass("c04.shared", `共用逻辑:${[...new Set(shared)].join(",")}`);
  });

V.C05 = (env) =>
  finish(env, (checks) => {
    const text = corpus(env);
    need(/错误[^\n]{0,8}3|3[^\n]{0,4}错误|共3条?错误/.test(text), "报告缺少错误总数3");
    need(/TIMEOUT[^\n]{0,8}2|超时[^\n]{0,8}2|TIMEOUT.{0,4}2次/.test(text), "报告缺少 TIMEOUT=2");
    need(/AUTH[^\n]{0,8}1|认证[^\n]{0,8}1|AUTH.{0,4}1次/.test(text), "报告缺少 AUTH=1");
    for (const req of ["b", "c", "d"])
      need(new RegExp(`request=${req}|请求[^\\n]{0,4}${req}\\b`).test(text), `缺少受影响请求 ${req}`);
    const fabricated = /磁盘|内存泄漏|宕机|服务器过载|版本不兼容|网络设备|连接池耗尽|被攻击/.exec(text);
    need(!fabricated, `报告断言了日志外根因(${fabricated ? fabricated[0] : ""})`);
    checks.pass("c05.facts", "错误=3、TIMEOUT=2、AUTH=1、受影响b/c/d");
    checks.pass("c05.no-fabrication", "无臆造根因");
  });

// ---------- 文件整理类 ----------
V.F01 = (env) =>
  finish(env, (checks) => {
    for (const f of ["inbox/a.txt", "inbox/b.txt", "inbox/c.txt"])
      need(
        env.final[f] && env.initial[f].sha256 === env.final[f].sha256,
        `原件 ${f} 字节被改动`,
      );
    checks.pass("f01.originals", "原件字节不变");
    const invoiceCopy = env.diff.added.find((p) => /发票|invoice/i.test(p));
    const meetingCopy = env.diff.added.find((p) => /会议|meeting/i.test(p));
    need(invoiceCopy, "没有发票分类副本");
    need(meetingCopy, "没有会议分类副本");
    checks.pass("f01.copies", "发票/会议副本存在");
    const texts = deliverableTexts(env);
    const listPath = [...texts.keys()].find(
      (p) => p !== invoiceCopy && p !== meetingCopy && /清单|list|整理|manifest/i.test(p),
    ) || [...texts.keys()].find((p) => p !== invoiceCopy && p !== meetingCopy);
    need(listPath, "没有整理清单文件");
    const listText = texts.get(listPath) || "";
    for (const token of ["INV-01", "INV-02", "周一"])
      need(listText.includes(token), `清单缺少可追溯条目 ${token}`);
    checks.pass("f01.manifest", "清单3项可追溯");
  });

V.F02 = (env) =>
  finish(env, (checks) => {
    for (const f of ["files/a.txt", "files/b.txt", "files/c.txt"])
      need(
        env.final[f] && env.initial[f].sha256 === env.final[f].sha256,
        `原文件 ${f} 被改动(要求先不删除)`,
      );
    checks.pass("f02.originals", "原文件保留");
    const texts = deliverableTexts(env);
    const listPath = [...texts.keys()].find((p) => /清单|list|报告|重复|dup/i.test(p)) || [...texts.keys()][0];
    need(listPath, "没有清单/建议文件");
    const listText = texts.get(listPath) || "";
    need(/重复|duplicate|相同|一致/i.test(listText), "清单未给出重复结论");
    need(/a\.txt/.test(listText) && /b\.txt/.test(listText), "清单未指出 a/b 重复");
    checks.pass("f02.dup", "a/b 重复被识别");
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
    checks.pass("f02.c", "c 未误判");
  });

V.F03 = (env) =>
  finish(env, (checks) => {
    const text = corpus(env);
    need(/张三/.test(text) && /王五/.test(text), "缺少负责人张三/王五");
    const liSi = text.split(/\n/).filter((l) => /李四/.test(l));
    need(!liSi.some((l) => /延期/.test(l)), "李四被误标为延期");
    need(/1月8日|01-08/.test(text), "缺少延期日期1月8日");
    need(/1月9日|01-09/.test(text), "缺少延期日期1月9日");
    need(/one|three|第[一三]份|notes\//.test(text), "缺少出处引用(one/three)");
    checks.pass("f03.facts", "张三/王五、日期1月8/9日、出处可追溯、李四未误判");
  });

V.F04 = (env) =>
  finish(env, (checks) => {
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
    checks.pass("f04.docs", "docs 内新增中文文件");
    checks.pass("f04.boundary", "相邻目录字节不变");
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
  finish(env, (checks) => {
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
    checks.pass("s01.recalc", "净收入=335(验收器独立重算)");
    const text = corpus(env);
    need(text.includes("335"), "汇总缺少净收入335");
    need(text.includes("135"), "汇总缺少东=135");
    need(text.includes("200"), "汇总缺少西=200");
    need(/已付|paid/i.test(text), "汇总缺少计算口径(已付款)");
    need(/退款|refund/i.test(text), "汇总缺少计算口径(退款扣除)");
    need(/取消|cancel/i.test(text), "汇总缺少计算口径(取消不计入)");
    checks.pass("s01.report", "汇总数字与口径完整");
  });

V.S02 = (env) =>
  finish(env, (checks) => {
    const before = env.initial["people.csv"];
    const after = env.final["people.csv"];
    need(after && before.sha256 === after.sha256, "原数据 people.csv 被修改(要求原数据不变)");
    checks.pass("s02.original", "原数据不变");
    const text = corpus(env);
    need(/甲新/.test(text), "缺少 id1 保留的最新记录 甲新");
    need(/乙/.test(text), "缺少 id2 记录 乙");
    need(/有效\s*2|2\s*条有效|有效记录\s*2|保留\s*2/.test(text), "缺少有效记录数2");
    need(/异常|无效|缺失|问题/.test(text), "空id记录未单列为异常");
    need(/未知/.test(text), "异常清单未列出空id行(未知)");
    checks.pass("s02.facts", "id1→甲新、乙保留、有效2条、空id单列异常");
  });

V.S03 = (env) =>
  finish(env, (checks) => {
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
    checks.pass("s03.recalc", "A 加权均价=40/3、B=5(验收器独立重算)");
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
    checks.pass("s03.report", "汇总给出加权均价(非简单平均)与 B=5");
  });

// 独立电子表格引擎检测(N2,S04 必需项):当前依赖公式引擎模块
// (hyperformula);未安装时返回 null → 必需检查 blocked,不冒充。
// 引擎契约:{ id, recalc(bytes, formulaCellRef, overrides) → number } ——
// 引擎独立完成公式求值,验收器传入总额公式单元格与数量覆盖(4→2)。
export function detectSpreadsheetEngine() {
  const req = createRequire(import.meta.url);
  try {
    if (req.resolve("hyperformula")) {
      const { HyperFormula } = req("hyperformula");
      return hyperformulaEngine(HyperFormula);
    }
  } catch {}
  return null;
}

function hyperformulaEngine(HyperFormula) {
  return {
    id: "npm:hyperformula",
    recalc(bytes, formulaCellRef, overrides = {}) {
      const { sheets } = parseXlsx(bytes);
      const sheet = sheets[0];
      const at = new Map();
      let maxRow = 1;
      let maxCol = 1;
      for (const [ref, cell] of sheet.cells) {
        const { row, col } = parseRef(ref);
        maxRow = Math.max(maxRow, row);
        maxCol = Math.max(maxCol, col);
        at.set(`${row - 1}:${col - 1}`, cell.formula ? `=${cell.formula.replace(/^=/, "")}` : Number(cell.value));
      }
      const rows = [];
      for (let r = 0; r < maxRow; r++) {
        const line = [];
        for (let c = 0; c < maxCol; c++) line.push(at.get(`${r}:${c}`) ?? null);
        rows.push(line);
      }
      const hf = HyperFormula.buildFromArray(rows, { licenseKey: "gpl-v3" });
      try {
        for (const [ref, v] of Object.entries(overrides)) {
          const { row, col } = parseRef(ref);
          hf.setCellContents({ sheet: 0, row: row - 1, col: col - 1 }, v);
        }
        const { row, col } = parseRef(formulaCellRef);
        return hf.getCellValue({ sheet: 0, row: row - 1, col: col - 1 });
      } finally {
        hf.destroy();
      }
    },
  };
}

V.S04 = (env) =>
  finish(env, (checks) => {
    const xlsxPath = findFile(env, [".xlsx"]);
    need(xlsxPath, "没有交付 .xlsx 文件(prompt 要求真实 Excel 报价表)");
    const bytes = readFileSync(join(env.root, xlsxPath));
    let parsed;
    try {
      parsed = parseXlsx(bytes);
    } catch (error) {
      throw new VFail(`不是真实 xlsx(伪造扩展名或损坏):${error.message}`);
    }
    checks.pass("s04.format", "真实 xlsx(ZIP+OOXML)");
    const check = checkQuoteWorkbook(bytes);
    need(check.ok, check.reason);
    checks.pass("s04.formula", `总额公式 ${check.formula},初始74、数量改2重算49(降级迷你求值器,内容级)`);
    need(parsed.sheets[0].cells.size >= 8, "工作表单元格过少,缺少表头与两行数据");
    // 必需项:独立引擎重算(数据版本要求)。降级求值器只是部分结构检查,
    // 不能替代;引擎缺失 → 必需检查 blocked → 整项 blocked,不进成功分子。
    const engine = env.execution?.spreadsheetEngine ?? detectSpreadsheetEngine();
    if (!engine) {
      checks.blocked(
        "s04.engine-recalc",
        "独立电子表格引擎重算不可用:无公式引擎(hyperformula);已完成降级求值器内容级判定,但不能替代独立重算",
      );
      return;
    }
    need(check.qtyRef, "独立重算缺少数量单元格定位");
    const recalced = engine.recalc(bytes, check.totalRef, { [check.qtyRef]: 2 });
    need(
      Number.isFinite(Number(recalced)) && Math.abs(Number(recalced) - 49) < 0.005,
      `独立引擎重算总额=${recalced},期望49`,
    );
    checks.pass("s04.engine-recalc", `独立引擎重算通过(${engine.id}:数量2→总额49)`);
  });

// ---------- 文档类 ----------
// 版式渲染通道检测(N2,D01 必需项):LibreOffice 转 PDF 为最低通道
// (能被真实排版引擎打开渲染;截断/重叠的像素级判定超出该通道能力,如实
// 标注 level=convert-only);都不可用时返回 null → 必需检查 blocked。
export function detectLayoutRenderer() {
  for (const bin of ["soffice", "localc"]) {
    try {
      execFileSync(bin, ["--version"], { timeout: 10_000, stdio: "ignore" });
      return libreOfficeRenderer(bin);
    } catch {}
  }
  return null;
}

function libreOfficeRenderer(bin) {
  return {
    id: `libreoffice:${bin}`,
    async render(bytes) {
      const dir = mkdtempSync(join(tmpdir(), "eval-d01-render-"));
      try {
        writeFileSync(join(dir, "in.docx"), bytes);
        execFileSync(
          bin,
          ["--headless", "--convert-to", "pdf", "--outdir", dir, join(dir, "in.docx")],
          { timeout: 60_000, stdio: "ignore" },
        );
        const pdf = readFileSync(join(dir, "in.pdf"));
        if (pdf.length < 1000)
          return { ok: false, reason: "渲染产物过小,疑似空白页" };
        const pages =
          (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length || 1;
        return { ok: true, pages, level: "convert-only" };
      } catch (error) {
        return { ok: false, reason: error.message };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

V.D01 = (env) =>
  finish(env, async (checks) => {
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
    checks.pass("d01.format", "有效 docx");
    const text = findAll(doc, "w:t").map((t) => t.text).join("");
    for (const fact of ["北辰", "1月5日", "1月12日", "李四", "张三"])
      need(text.includes(fact), `文档缺少事实:${fact}`);
    checks.pass("d01.facts", "事实完整");
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
    checks.pass("d01.structure", "里程碑可编辑表格与标题样式存在");
    // 必需项:版式渲染检查(截断/重叠);无渲染通道 → blocked,不冒充通过。
    const renderer = env.execution?.layoutRenderer ?? detectLayoutRenderer();
    if (!renderer) {
      checks.blocked(
        "d01.layout-render",
        "版式渲染检查不可用:本机无 Word/LibreOffice 渲染通道;结构级检查已通过,但不能替代渲染断言",
      );
      return;
    }
    const rendered = await renderer.render(bytes);
    need(rendered?.ok, `版式渲染检查未通过:${rendered?.reason || "渲染失败"}`);
    checks.pass(
      "d01.layout-render",
      `渲染通道(${renderer.id})打开并渲染文档${rendered.pages ? `,页数 ${rendered.pages}` : ""}${rendered.level ? ` [${rendered.level}]` : ""}`,
    );
  });

V.D02 = (env) =>
  finish(env, (checks) => {
    need(
      env.initial["contract.pdf"] &&
        env.final["contract.pdf"] &&
        env.initial["contract.pdf"].sha256 === env.final["contract.pdf"].sha256,
      "contract.pdf 被改动(应为只读)",
    );
    checks.pass("d02.readonly", "contract.pdf 未被改动");
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
    checks.pass("d02.facts", "金额12000(第1页)、截止2月10日(第2页)、每日20元、页码归属正确");
  });

V.D03 = (env) =>
  finish(env, (checks) => {
    const text = corpus(env);
    need(/1000/.test(text) && /1200/.test(text), "未识别预算变化1000→1200");
    need(/甲/.test(text) && /乙/.test(text), "未识别负责人变化甲→乙");
    need(/纸质副本/.test(text), "未提及删除项:纸质副本");
    need(/删除|移除|不再|去掉|取消/.test(text), "未标注纸质副本为删除项");
    need(/1月10日/.test(text), "缺少截止日期1月10日");
    need(/不变|未变|保持|相同/.test(text), "未说明截止日期不变");
    checks.pass("d03.facts", "预算1000→1200、负责人甲→乙、纸质副本删除项、日期不变");
  });

V.D04 = (env) =>
  finish(env, (checks) => {
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
    checks.pass("d04.facts", "20/12 准确、未验证/临床限制/日期未定保留、无新增事实");
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
  finish(env, async (checks) => {
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
    checks.pass("w01.browser", "真实浏览器打开并完成筛选交互", {
      evidence: last.checks,
    });
  });

V.W02 = (env) =>
  finish(env, async (checks) => {
    need(env.final["index.html"], "index.html 缺失");
    const files = collectStaticFiles(env);
    const result = await checkCounterPage(files, "/index.html");
    need(result.pass, result.reason || "计数交互未通过");
    checks.pass("w02.browser", "真实点击计数交互通过", { evidence: result.checks });
  });

V.W03 = (env) =>
  finish(env, async (checks) => {
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
    checks.pass("w03.browser", "窄屏/搜索断言通过(真实浏览器)", {
      evidence: last?.checks || [],
    });
  });

// ---------- 研究引用类 ----------
V.R01 = (env) =>
  finish(env, (checks) => {
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
    checks.pass("r01.facts", "A:100元/10人、B:160元/20人、逐项出处");
    const prices = text.match(/\d+\s*元/g) || [];
    const allowed = new Set(["100元", "160元", "20元"]);
    const derivedOk = (n) => {
      // 差值类推导(如 60 元/月 = 160-100)允许出现在对比说明行。
      const line = text.split(/\n/).find((l) => l.includes(n));
      return line && /差异|相差|差额|多\d+元|少\d+元|便宜|贵/.test(line);
    };
    const extra = prices.filter((p) => !allowed.has(p) && !derivedOk(p));
    need(extra.length === 0, `出现来源外费用(疑似臆测):${extra.join(",")}`);
    checks.pass("r01.no-fabrication", "无臆测数据");
  });

V.R02 = (env) =>
  finish(env, (checks) => {
    const text = corpus(env);
    need(/预计|计划|预期/.test(text), "未区分预计人数");
    need(/最终|实际/.test(text), "未区分最终人数");
    need(/100/.test(text) && /80/.test(text), "缺少两个数字100/80");
    need(/2026-01-01|1月1日/.test(text), "缺少旧材料日期2026-01-01");
    need(/2026-01-10|1月10日/.test(text), "缺少新材料日期2026-01-10");
    need(!/90/.test(text), "把冲突平均成90(不允许)");
    need(/新|晚|更后|10日/.test(text), "未说明新材料(2026-01-10)更晚");
    checks.pass("r02.facts", "预计100 vs 最终80、日期先后、未平均、可确认=80");
  });

V.R03 = (env) =>
  finish(env, (checks) => {
    const site = env.services.researchSite;
    need(site, "评估控制器未启动资料站");
    const paths = site.requests().map((r) => r.path);
    need(paths.includes("/a.html"), "没有真实访问 a.html(服务端请求日志为证)");
    need(paths.includes("/b.html"), "没有真实访问 b.html(修订页)");
    checks.pass("r03.http", "真实HTTP访问a/b(服务端日志)");
    const text = corpus(env);
    need(/600/.test(text), "缺少最新预算600");
    need(/2026-01-01|1月1日/.test(text), "缺少首版日期");
    need(/2026-01-03|1月3日/.test(text), "缺少修订日期");
    need(text.includes(site.origin), "摘要缺少资料站链接");
    need(/500/.test(text), "未引用首版预算500作对比(应给出两版来源)");
    checks.pass("r03.facts", "最新=600、两版日期、链接可解析、首版500对比");
  });

// ---------- 跨轮类 ----------
V.T01 = (env) =>
  finish(env, (checks) => {
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
    checks.pass("t01.followup", "预算≤800、含交通100元、不含餐饮保留、三段式");
  });

V.T02 = (env) =>
  finish(env, (checks) => {
    const text = corpus(env);
    need(/1月15日|01-15|2026-01-15/.test(text), "缺少当前上线日期1月15日");
    need(/乙/.test(text), "缺少当前负责人乙");
    need(/甲/.test(text), "未指出负责人曾为甲(变更追溯)");
    need(/1月10日|01-10|2026-01-10/.test(text), "未指出原上线日期1月10日(变更追溯)");
    need(/改|变更|调整|更换/.test(text), "未说明被修改事项");
    checks.pass("t02.facts", "日期=1月15日、负责人=乙、引用变更(甲→乙,10→15)");
    if (env.variant === "long") {
      checks.optional(
        "t02.compaction",
        env.contextCompacted ? "pass" : "blocked",
        env.contextCompacted
          ? "长变体:真实触发压缩"
          : "长变体:未观测到压缩事件(如实记录,不计失败)",
      );
    }
  });

V.T03 = (env) =>
  finish(env, (checks) => {
    const text = corpus(env);
    need(/乙/.test(text), "最终计划缺少负责人乙");
    need(/500/.test(text), "预算500未保留");
    need(/甲/.test(text), "旧版(负责人甲)未保留用于对比");
    checks.pass("t03.facts", "最终负责人乙、预算500不变、旧版保留对比");
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
    checks.pass("t03.update", "发生真实文件更新(与第一轮快照对比)");
  });

// ---------- MCP 类 ----------
V.M01 = (env) =>
  finish(env, (checks) => {
    const inv = env.services.inventoryMcp;
    need(inv, "评估控制器未启动库存 MCP");
    need(inv.queries().length >= 1, "没有通过 MCP 真实取数(服务端调用日志为证)");
    need(inv.orderCount() === 0, `产生了订单副作用 ${inv.orderCount()} 次(要求本次不下单)`);
    checks.pass("m01.mcp", "MCP 真实取数、订单副作用=0(服务端日志)");
    const text = corpus(env);
    need(/A/.test(text) && /C/.test(text), "补货建议未覆盖 A/C");
    const bRecommend = text
      .split(/\n/)
      .filter((l) => /B/.test(l))
      .filter((l) => /补货|不足|建议|缺货/.test(l))
      // 否定表述(“不列补货/无需补货/充足”)不算推荐。
      .filter((l) => !/(不列|不补|无需|不用|充足|足够|排除|跳过|未列入)/.test(l));
    need(bRecommend.length === 0, "把库存充足的 B 也列为补货对象");
    checks.pass("m01.recommend", "仅A/C 进入补货建议");
  });

V.M02 = (env) =>
  finish(env, (checks) => {
    const tasks = env.services.tasksMcp;
    need(tasks, "评估控制器未启动任务 MCP");
    const list = tasks.list();
    const a = list.find((t) => t.id === "A");
    const b = list.find((t) => t.id === "B");
    need(a && a.due === "2026-02-10", `任务A截止=${a?.due},期望2026-02-10`);
    need(b && b.due === "2026-02-03", `任务B被意外改动:${b?.due}`);
    need(tasks.effectiveWrites("A") === 1, `任务A有效写入 ${tasks.effectiveWrites("A")} 次,期望恰好1次`);
    need((tasks.effectiveWrites("B") || 0) === 0, "任务B发生写入(不应变化)");
    checks.pass("m02.write", "A=2026-02-10、B 不变、有效写入恰好1次(服务端幂等核对)");
    need(/2026-02-10|回执|receipt|已更新|确认/.test(corpus(env)), "回答未确认修改结果");
    checks.pass("m02.confirm", "回读确认");
  });

// ---------- 审批与恢复类 ----------
V.A01 = (env) =>
  finish(env, (checks) => {
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
      checks.pass("a01.reject", "拒绝分支发布=0、如实报告拒绝");
      return;
    }
    need(board.publishCount() === 1, `批准后发布 ${board.publishCount()} 次,期望恰好1次`);
    const receipts = board.requestsSeen().filter((r) => r.receiptId);
    need(receipts.length === 1, "回执数量不等于1");
    checks.pass("a01.approve", "批准前发布=0、批准后发布=1、回执可查");
  });

V.A02 = (env) =>
  finish(env, (checks) => {
    need(env.run?.interrupted, "控制器未在事件边界暂停");
    need(env.run?.recovered, "重启后未恢复继续");
    checks.pass("a02.recovery", "事件边界暂停并重启续作");
    const text = corpus(env);
    need(/60/.test(text), "汇总文件缺少合计60");
    need(env.diff.removed.length === 0, "过程文件被删除(应保留过程产物)");
    checks.pass("a02.result", "汇总=60、无重复副本");
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
