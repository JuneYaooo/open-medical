// 网页正文与搜索结果页的共享解析辅助：只处理静态 HTML/RSS/JSON 文本，不执行
// 脚本、不加载资源；动态渲染页面与 PDF 的完整支持不在承诺范围内。供
// web-tools.mjs（fetchWeb 正文抓取与 searchWeb 免费搜索链路）使用。

const NAMED_ENTITIES = new Map(
  Object.entries({
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    copy: "©",
    reg: "®",
    trade: "™",
    mdash: "—",
    ndash: "–",
    hellip: "…",
    middot: "·",
    ldquo: "“",
    rdquo: "”",
    lsquo: "‘",
    rsquo: "’",
    laquo: "«",
    raquo: "»",
    deg: "°",
    plusmn: "±",
    times: "×",
    divide: "÷",
    bull: "•",
    euro: "€",
    pound: "£",
    yen: "¥",
    cent: "¢",
    sect: "§",
    para: "¶",
    larr: "←",
    uarr: "↑",
    rarr: "→",
    darr: "↓",
    harr: "↔",
    minus: "−",
    sup2: "²",
    sup3: "³",
    frac12: "½",
    frac14: "¼",
    frac34: "¾",
  }),
);

// 实体解码：常用命名实体 + 十进制/十六进制数字实体。数字实体中的控制字符
// （除 \t\n\r）一律丢弃，避免把注入内容带进正文。
export function decodeEntities(text) {
  if (!text || !text.includes("&")) return text;
  return text.replace(
    /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]{0,31});?/g,
    (match, body) => {
      if (body[0] === "#") {
        const hex = body[1] === "x" || body[1] === "X";
        const cp = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
        if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return "";
        if (
          (cp >= 0xd800 && cp <= 0xdfff) ||
          (cp < 32 && cp !== 9 && cp !== 10 && cp !== 13) ||
          cp === 127
        )
          return "";
        return String.fromCodePoint(cp);
      }
      return (
        NAMED_ENTITIES.get(body) ??
        NAMED_ENTITIES.get(body.toLowerCase()) ??
        match
      );
    },
  );
}

// 富文本片段（RSS 字段、<title>、锚文本）→ 纯文本：
// CDATA → 去标签 → 实体解码 → 空白折叠。
export function textFromHtml(html) {
  return decodeEntities(
    html.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

// 按响应头或 HTML meta 声明的字符集解码响应体；中文站点常见 GBK/GB2312。
export function decodeBody(buf, contentType, head = "") {
  const metaCharset = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[0] || "";
  const declared = /charset=["']?([\w-]+)/i
    .exec(`${contentType || ""} ${metaCharset}`)?.[1]
    ?.toLowerCase();
  const attempt = (label) => {
    try {
      return new TextDecoder(label).decode(buf);
    } catch {
      return null;
    }
  };
  if (declared && declared !== "utf-8" && declared !== "utf8") {
    return attempt(declared) ?? buf.toString();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    // 未声明却实际 GBK 的中文站点不少：严格 utf-8 失败后先按 GBK 兜底。
    return attempt("gbk") ?? buf.toString();
  }
}

// ---- 正文抽取 ----
// 块级边界统一为最多两个换行，<br> 为单换行；块边界先用哨兵字符占位，正文
// 坐标（links[].offset，全文下标）随构建过程同步产生，之后不再全局改写文本。
// 只处理静态 HTML；不承诺动态渲染页面与 PDF。

const PARA = "\u0001";
const LINE = "\u0002";
const BLOCK_OPEN = /<(p|h[1-6]|li|tr|blockquote|section|article)\b[^>]*>/gi;
const BLOCK_CLOSE =
  /<\/(p|div|li|h[1-6]|tr|section|article|blockquote|table|ul|ol|dl|dd|dt|pre|header|footer|main|nav|aside|figcaption|figure|form|details|summary|caption)>/gi;
const STRIP_BLOCK =
  /<(script|style|noscript|template|svg|iframe|object|embed|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi;

export function htmlToArticle(html, baseURL) {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? textFromHtml(titleMatch[1]).slice(0, 500) : "";
  const work = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(STRIP_BLOCK, "")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, "")
    .replaceAll(PARA, "")
    .replaceAll(LINE, "")
    .replace(/<br\b[^>]*\/?>/gi, LINE)
    .replace(BLOCK_CLOSE, PARA)
    .replace(BLOCK_OPEN, PARA);

  const links = [];
  const seenLinks = new Set();
  let out = "";
  let pendingBoundary = 0; // 待应用的块边界（1=单换行 2=双换行）
  let pendingSpace = false; // 行内悬挂空格：下一文本前补一个空格，遇块边界丢弃
  const pushText = (text, alreadyDecoded = false) => {
    const stripped = text.replace(
      // eslint-disable-next-line no-control-regex -- 清除源文档中的控制字符
      /[\u0000-\u0008\u000e-\u001f\u007f]/g,
      "",
    );
    const decoded = (
      alreadyDecoded ? stripped : decodeEntities(stripped)
    ).replace(/[\t \r\n\f\v]+/g, " ");
    if (!decoded) return;
    if (decoded === " ") {
      if (out) pendingSpace = true;
      return;
    }
    const leadSpace = decoded.startsWith(" ");
    const trailSpace = decoded.endsWith(" ");
    const body = decoded.replace(/^ +/, "").replace(/ +$/, "");
    if (!body) {
      if (out) pendingSpace = true;
      return;
    }
    if (!out) {
      // 全文起点：丢弃前导空格。
    } else if (pendingBoundary) {
      out += "\n".repeat(Math.min(pendingBoundary, 2));
    } else if (pendingSpace || leadSpace) {
      out += " ";
    }
    pendingSpace = trailSpace;
    pendingBoundary = 0;
    out += body;
  };
  const pushRun = (run) => {
    // eslint-disable-next-line no-control-regex -- 按哨兵字符切分块边界
    for (const part of run.split(/([\u0001\u0002]+)/)) {
      if (!part) continue;
      if (part.includes(PARA) || part.includes(LINE)) {
        pendingBoundary = Math.max(
          pendingBoundary,
          part.includes(PARA) ? 2 : 1,
        );
      } else {
        pushText(part);
      }
    }
  };

  const scanner = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>|<[^>]+>|[^<]+/gi;
  let match;
  while ((match = scanner.exec(work))) {
    if (match[1] !== undefined) {
      const href =
        /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1]) ||
        null;
      const target = href
        ? decodeEntities(href[1] ?? href[2] ?? href[3] ?? "").trim()
        : "";
      const text = decodeEntities(match[2].replace(/<[^>]+>/g, " "))
        .replaceAll(PARA, " ")
        .replaceAll(LINE, " ")
        .replace(/[\t \r\n\f\v]+/g, " ")
        .trim();
      const offset =
        out.length +
        (out && pendingBoundary ? Math.min(pendingBoundary, 2) : 0) +
        (out && !pendingBoundary && pendingSpace ? 1 : 0);
      pushText(text, true);
      if (
        !target ||
        !text ||
        /^(?:javascript:|mailto:|tel:|data:|#)/i.test(target)
      )
        continue;
      let absolute = null;
      try {
        const resolved = new URL(target, baseURL);
        if (resolved.protocol === "http:" || resolved.protocol === "https:")
          absolute = resolved.href;
      } catch {}
      if (absolute && !seenLinks.has(absolute) && links.length < 100) {
        seenLinks.add(absolute);
        links.push({ url: absolute, text: text.slice(0, 300), offset });
      }
    } else if (match[0].startsWith("<")) {
      // 其余内联标签直接丢弃；块级边界已在预处理阶段布哨兵。
    } else {
      pushRun(match[0]);
    }
  }
  return { title, text: out, links };
}

// ---- 免费搜索引擎结果页解析 ----

export function parseRssItems(xml) {
  const items = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of blocks) {
    if (items.length >= 10) break;
    const tag = (name) => {
      const found = block.match(
        new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`),
      );
      return found ? textFromHtml(found[1]) : "";
    };
    const url = tag("link");
    if (/^https?:\/\//.test(url))
      items.push({
        title: tag("title").slice(0, 300),
        url: url.slice(0, 2000),
        snippet: tag("description").slice(0, 500),
      });
  }
  return items;
}

export function parseDuckLite(html) {
  const resolve = (href) => {
    try {
      const u = new URL(href, "https://duckduckgo.com");
      if (u.pathname === "/l/" && u.searchParams.get("uddg"))
        return u.searchParams.get("uddg");
    } catch {}
    return href;
  };
  const items = [];
  const pattern =
    /<a\s([^>]*rel="nofollow"[^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\s|$)/gi;
  for (const match of html.matchAll(pattern)) {
    if (items.length >= 10) break;
    const href = /href\s*=\s*"([^"]+)"/i.exec(match[1])?.[1] || "";
    const title = textFromHtml(match[2]);
    const url = href ? resolve(href) : "";
    const snippet =
      /class="result-snippet"[^>]*>([\s\S]*?)<\/td>/i.exec(match[3])?.[1] || "";
    if (/^https?:\/\//.test(url) && title)
      items.push({
        title: title.slice(0, 300),
        url: url.slice(0, 2000),
        snippet: textFromHtml(snippet).slice(0, 500),
      });
  }
  return items;
}

// 360 搜索对中文多词查询质量最好且国内可达；结果锚点带 data-mdurl 真实
// 地址（href 是 so.com 跳转包装），只收带真实地址的结果——广告位与
// “探索更多”类站内导航因此自然被过滤。
export function parseSo360(html) {
  const items = [];
  const chunks = html.split(/<h3/).slice(1);
  for (const chunk of chunks) {
    if (items.length >= 10) break;
    const anchor = chunk.match(/<a\s([^>]*)>([\s\S]*?)<\/a>/);
    if (!anchor) continue;
    const url = anchor[1].match(/data-mdurl="(https?:\/\/[^"]+)"/)?.[1] || "";
    // 无真实地址（广告/站内导航）或 360 自有域的结果一律跳过。
    if (
      !url ||
      /so\.com$|360\.com$|360\.cn$/.test(new URL(url, "https://x").host)
    )
      continue;
    const title = textFromHtml(anchor[2]);
    if (!title) continue;
    const snippet = chunk.match(
      /<p[^>]*class="[^"]*desc[^"]*"[^>]*>([\s\S]*?)<\/p>/,
    )?.[1];
    items.push({
      title: title.slice(0, 300),
      url: url.slice(0, 2000),
      snippet: (snippet ? textFromHtml(snippet) : "").slice(0, 500),
    });
  }
  return items;
}
