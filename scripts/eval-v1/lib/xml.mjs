// 极简 XML 解析器:供 xlsx/docx 验收使用。
// 只需元素/属性/文本,忽略注释/CDATA/DOCTYPE/处理指令(CDATA 按文本收集)。
// 对畸形 XML 抛错——伪造扩展名的文本文件应在这里被拒绝。
export function parseXml(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("空 XML");
  const src = text.replace(/^\uFEFF/, "");
  let i = 0;
  // 跳过 BOM/前置杂项。
  const stack = [{ name: "#root", attrs: {}, children: [], text: "" }];
  const append = (node) => {
    const parent = stack[stack.length - 1];
    parent.children.push(node);
    return node;
  };
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i) stack[stack.length - 1].text += decodeEntities(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt);
      if (end < 0) throw new Error("未闭合的注释");
      i = end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt);
      if (end < 0) throw new Error("未闭合的 CDATA");
      stack[stack.length - 1].text += src.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (src.startsWith("<?", lt) || src.startsWith("<!", lt)) {
      const end = src.indexOf(">", lt);
      if (end < 0) throw new Error("未闭合的声明");
      i = end + 1;
      continue;
    }
    const gt = src.indexOf(">", lt);
    if (gt < 0) throw new Error("未闭合的标签");
    const selfClose = src[gt - 1] === "/";
    const raw = src.slice(lt + 1, selfClose ? gt - 1 : gt);
    const isClosing = src[lt + 1] === "/";
    const spaceMatch = raw.match(/^\/?([^\s/]+)\s*([\s\S]*)$/);
    if (!spaceMatch) throw new Error(`无效标签:<${raw}>`);
    const name = spaceMatch[1];
    if (name.includes("<")) throw new Error("标签内出现非法字符");
    const attrs = {};
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let am;
    while ((am = attrRe.exec(spaceMatch[2] || "")))
      attrs[am[1]] = decodeEntities(am[3] ?? am[4] ?? "");
    if (isClosing) {
      i = gt + 1;
      const open = stack.pop();
      if (!open || open.name !== name)
        throw new Error(`标签不匹配:期望 </${open?.name}> 实际 </${name}>`);
      continue;
    }
    const node = { name, attrs, children: [], text: "" };
    append(node);
    if (!selfClose) stack.push(node);
    i = gt + 1;
  }
  if (stack.length !== 1) throw new Error(`存在未闭合标签:<${stack[stack.length - 1]?.name}>`);
  const root = stack[0].children.find((c) => c.name);
  if (!root) throw new Error("没有根元素");
  return root;
}

export function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 在节点树中按名字查找所有后代。 */
export function findAll(node, name, out = []) {
  for (const child of node.children || []) {
    if (child.name === name) out.push(child);
    findAll(child, name, out);
  }
  return out;
}

/** XPath 风格的窄查询:findPath(node, "w:body", "w:tbl") 返回第一个匹配链。 */
export function findPath(node, ...names) {
  let current = [node];
  for (const name of names) {
    const next = [];
    for (const n of current)
      for (const child of n.children || []) if (child.name === name) next.push(child);
    current = next;
    if (!current.length) return [];
  }
  return current;
}
