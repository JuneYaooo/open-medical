// W01—W03 真实浏览器断言(评估侧独立执行,复用仓库 playwright-core)。
// 不读取页面源码下结论:全部通过真实导航、点击、输入、可见性判定。
// 浏览器解析顺序:ms-playwright 缓存 chromium → Edge 通道 → playwright 默认。
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

function findCachedChromium() {
  const cache = join(homedir(), "AppData", "Local", "ms-playwright");
  if (!existsSync(cache)) return null;
  try {
    for (const dir of readdirSync(cache)) {
      if (!dir.startsWith("chromium-") || dir.includes("headless")) continue;
      for (const sub of ["chrome-win/chrome.exe", "chrome-win64/chrome.exe"])
        {
          const candidate = join(cache, dir, sub);
          if (existsSync(candidate)) return candidate;
        }
    }
  } catch {
    return null;
  }
  return null;
}

export async function launchBrowser() {
  const { chromium } = await import("playwright-core");
  const errors = [];
  const attempts = [];
  const cached = findCachedChromium();
  if (cached) attempts.push({ executablePath: cached });
  attempts.push({ channel: "msedge" }, {});
  for (const options of attempts) {
    try {
      return await chromium.launch({ headless: true, ...options });
    } catch (error) {
      errors.push(`${JSON.stringify(options)}: ${error.message.split("\n")[0]}`);
    }
  }
  throw new Error(`无法启动浏览器(真实交互断言 blocked):${errors.join(" | ")}`);
}

/** 把目录以随机端口本地 HTTP 静态服务(相对资源引用可正常加载)。 */
export async function serveDirectory(root, files) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path === "/favicon.ico") {
      // 浏览器会自动请求 favicon;404 会污染控制台错误判定。
      res.writeHead(204);
      res.end();
      return;
    }
    const target = files.get(path) || files.get(path + "/index.html");
    if (!target) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": path.endsWith(".html")
        ? "text/html; charset=utf-8"
        : path.endsWith(".json")
          ? "application/json; charset=utf-8"
          : "text/plain; charset=utf-8",
    });
    res.end(target);
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((ok) => server.closeAllConnections?.() || server.close(ok)),
  };
}

async function withPage(server, relativePath, fn) {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(`${server.origin}/${relativePath.replace(/^\//, "")}`, {
      waitUntil: "load",
      timeout: 15000,
    });
    return await fn(page);
  } finally {
    await browser.close();
  }
}

/** 页面内判断一组标题当前是否可见(存在元素、有布局盒、非隐藏)。 */
async function visibleTitles(page, titles) {
  return page.evaluate((names) => {
    const visible = (el) => {
      if (!el) return false;
      const rects = el.getClientRects();
      if (!rects.length) return false;
      const style = getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none";
    };
    const out = {};
    for (const name of names) {
      // 精确匹配文本的任务条目优先,退而求其次取包含匹配里最短文本的元素。
      const exact = [...document.querySelectorAll("body *")].filter(
        (el) => el.childElementCount === 0 && el.textContent.trim() === name,
      );
      const loose = [...document.querySelectorAll("body *")].filter(
        (el) => el.childElementCount === 0 && el.textContent.includes(name),
      );
      const el = exact[0] || loose.sort((a, b) => a.textContent.length - b.textContent.length)[0];
      out[name] = visible(el || null);
    }
    return out;
  }, titles);
}

/** 找到可点击的筛选控件(按钮/链接/单选,文本匹配)。 */
async function clickFilterControl(page, patterns) {
  for (const pattern of patterns) {
    const candidates = page.locator(
      `button:visible, a:visible, [role=button]:visible, [role=tab]:visible, label:visible, input[type=radio]:visible, select:visible option`,
    );
    const count = await candidates.count();
    for (let i = 0; i < count; i++) {
      const el = candidates.nth(i);
      const text = (await el.textContent().catch(() => "")).trim();
      if (pattern.test(text)) {
        await el.click({ timeout: 5000 }).catch(() => {});
        return true;
      }
    }
  }
  return false;
}

/** 等待标题渲染(页面常异步 fetch 数据后再渲染)。 */
async function waitTitles(page, titles, expectVisible, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let last = {};
  while (Date.now() < deadline) {
    last = await visibleTitles(page, titles);
    const done = titles.every((t) => Boolean(last[t]) === expectVisible);
    if (done) return last;
    await page.waitForTimeout(150);
  }
  return last;
}

/**
 * W01:任务筛选页。返回 { pass, checks, reason }。
 * files: Map<"/tasks.html", body> 由调用方从交付产物中收集。
 */
export async function checkTaskFilterPage(files, htmlPath) {
  const server = await serveDirectory(null, files);
  try {
    return await withPage(server, htmlPath, async (page) => {
      const titles = ["甲", "乙", "丙"];
      const initial = await waitTitles(page, titles, true);
      const initialVisible = titles.filter((t) => initial[t]).length;
      if (initialVisible !== 3)
        return { pass: false, reason: `初始可见任务 ${initialVisible}/3`, checks: [] };
      const checks = ["浏览器真实打开", "全部3项可见"];
      // todo 筛选 → 只剩乙丙。
      const todoOk = await clickFilterControl(page, [/todo/i, /待办/i, /未完/i]);
      if (!todoOk) return { pass: false, reason: "页面没有可交互的筛选控件", checks };
      let after = await waitTitles(page, ["乙", "丙"], true, 2000);
      if (!(after["乙"] && after["丙"] && !after["甲"]))
        return { pass: false, reason: "todo 筛选后未恰好显示乙丙", checks };
      checks.push("todo=2 筛选真实生效");
      const doneOk = await clickFilterControl(page, [/done/i, /已完成/i, /完成/i]);
      if (!doneOk) return { pass: false, reason: "没有 done 筛选控件", checks };
      after = await waitTitles(page, ["甲"], true, 2000);
      if (!(after["甲"] && !after["乙"] && !after["丙"]))
        return { pass: false, reason: "done 筛选后未恰好显示甲", checks };
      checks.push("done=1 筛选真实生效");
      return { pass: true, checks };
    });
  } finally {
    await server.close();
  }
}

/** W02:计数按钮。 */
export async function checkCounterPage(files, htmlPath) {
  const server = await serveDirectory(null, files);
  try {
    return await withPage(server, htmlPath, async (page) => {
      const button = page.locator("#inc");
      if (!(await button.count())) return { pass: false, reason: "缺少 #inc 按钮", checks: [] };
      await button.click({ timeout: 5000 });
      await button.click();
      await button.click();
      const value = await page.locator("#n").textContent();
      if (Number(value) !== 3)
        return { pass: false, reason: `点击3次后显示 ${value},期望3`, checks: ["按钮存在"] };
      await page.reload({ waitUntil: "load" });
      const afterReload = await page.locator("#n").textContent();
      if (Number(afterReload) !== 0)
        return { pass: false, reason: `刷新后 ${afterReload},期望回到0`, checks: ["点击3次=3"] };
      return { pass: true, checks: ["点击3次显示3", "刷新回0"] };
    });
  } finally {
    await server.close();
  }
}

/** W03:窄屏联系人页(搜索/无结果/恢复)。 */
export async function checkContactsPage(files, htmlPath) {
  const server = await serveDirectory(null, files);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
    const consoleErrors = [];
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    await page.goto(`${server.origin}/${htmlPath.replace(/^\//, "")}`, {
      waitUntil: "load",
      timeout: 15000,
    });
    const checks = [];
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 1)
      return { pass: false, reason: `375px 下水平溢出 ${overflow}px`, checks: [] };
    checks.push("375px 无水平溢出");
    const search = page.locator(
      "input[type=text]:visible, input[type=search]:visible, input:not([type]):visible",
    );
    if (!(await search.count()))
      return { pass: false, reason: "没有可见的搜索输入框", checks };
    await search.first().fill("林青");
    let vis = await waitTitles(page, ["林青"], true);
    vis = { ...(await visibleTitles(page, ["赵云"])) , ...vis };
    if (!(vis["林青"] && !vis["赵云"]))
      return { pass: false, reason: "搜索林青后未恰好显示1项", checks };
    checks.push("搜索林青=1项");
    await search.first().fill("不存在的联系人XYZQ");
    await page.waitForTimeout(300);
    const emptyNotice = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll("body *")].filter(
        (el) => el.childElementCount === 0 && el.getClientRects().length,
      );
      return nodes.some((el) => /无结果|没有找到|未找到|暂无|no\s*result/i.test(el.textContent));
    });
    if (!emptyNotice)
      return { pass: false, reason: "无结果时没有显示空态提示", checks };
    checks.push("无结果提示可见");
    await search.first().fill("");
    vis = await waitTitles(page, ["林青", "赵云"], true);
    if (!(vis["林青"] && vis["赵云"]))
      return { pass: false, reason: "清空搜索后未恢复2项", checks };
    checks.push("清空恢复2项");
    if (consoleErrors.length)
      return { pass: false, reason: `控制台错误:${consoleErrors[0]}`, checks };
    return { pass: true, checks };
  } finally {
    await browser.close();
    await server.close();
  }
}
