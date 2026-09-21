import { createHash } from "node:crypto";
import { stat, readFile } from "node:fs/promises";

// 交付证据（路线文档 §4.2/§12 DeliveryEvidence）的最小通用件：
// - normalizeDelivery：把域/服务层交付钩子的返回值归一为
//   { delivered, evidence[], gaps[], unverified?, retryMessage? }；钩子未
//   提供或形状无效时返回 null，调用方保持现状（兼容）。
//   N3 加固：normalizeDelivery 只做契约校验,语义验证由对应验证器承担——
//   自相矛盾(declared delivered:true 但带必需缺口或零证据)的返回值不被
//   采信为交付,降级为 delivered:false 并记录矛盾缺口;失败回执或任意
//   object 不能当充分证据(证据条目必须带 kind)。
// - fileDeliveryEvidence / missingFileEvidence：文件类证据——存在且可读，
//   记录路径、字节长度与 sha256；证据必须来自运行时事实，不做 AI 自评。
// - receiptEvidence：外部操作回执引用（沙箱后端、审批应用结果、子任务
//   完成记录等），只引用运行时已发生的回执，不伪造。
export function normalizeDelivery(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const evidence = Array.isArray(value.evidence)
    ? value.evidence.filter((e) => {
        if (!e || typeof e !== "object" || Array.isArray(e) || e.gap) return false;
        if (e.kind === "file")
          return typeof e.path === "string" && e.path.length > 0 &&
            e.readable === true && typeof e.hash === "string" && /^[a-f0-9]{64}$/i.test(e.hash);
        return e.kind === "receipt" && typeof e.source === "string" && e.source.length > 0 &&
          (!Object.hasOwn(e, "exitCode") || e.exitCode === 0) &&
          e.ok !== false && e.success !== false &&
          !["pending", "running", "failed", "cancelled", "interrupted", "rejected"].includes(e.status);
      })
    : [];
  const gaps = Array.isArray(value.gaps)
    ? value.gaps
        .map((g) =>
          typeof g === "string" ? { reason: "gap", detail: g } : g,
        )
        .filter((g) => g && typeof g === "object" && !Array.isArray(g))
    : [];
  if (Array.isArray(value.evidence) && evidence.length !== value.evidence.length)
    gaps.push({ reason: "invalid_delivery_evidence",
      detail: "交付证据包含缺失、不可读或不符合契约的条目，尚未完整核实。" });
  if (value.gaps !== undefined && (!Array.isArray(value.gaps) ||
      value.gaps.some((g) => typeof g !== "string" && (!g || typeof g !== "object" || Array.isArray(g)))))
    gaps.push({ reason: "invalid_delivery_gaps", detail: "交付缺口格式无效，无法确认已经全部解决。" });
  // The producer verifies the facts; normalization only enforces the evidence
  // contract. A claimed success with no usable evidence or unresolved gaps is
  // never a verified delivery. A readable file alone does not prove task quality.
  let delivered = value.delivered === true;
  // 契约校验:声明已交付但带缺口/零证据 = 自相矛盾,不采信(N3-9)。
  if (delivered && gaps.length) {
    gaps.unshift({
      reason: "self_contradictory_delivery",
      detail: "验证器同时声明 delivered=true 与缺口;按契约不采信为已交付。",
    });
    delivered = false;
  }
  if (delivered && evidence.length === 0) {
    gaps.push({
      reason: "delivery_without_evidence",
      detail: "声明已交付但没有任何可核对证据。",
    });
    delivered = false;
  }
  if (!delivered && !gaps.length)
    gaps.push({
      reason: "no_verifiable_output",
      detail: "交付检查未通过但没有说明缺口。",
    });
  return {
    delivered,
    evidence,
    gaps,
    ...(Array.isArray(value.warnings) && value.warnings.length ? {
      warnings: value.warnings.filter((item) => item && typeof item === "object" &&
        !Array.isArray(item) && typeof item.reason === "string" && typeof item.detail === "string"),
    } : {}),
    ...(value.unverified === true ? { unverified: true } : {}),
    ...(typeof value.note === "string" ? { note: value.note } : {}),
    ...(typeof value.retryMessage === "string"
      ? { retryMessage: value.retryMessage }
      : {}),
    ...(typeof value.method === "string" ? { method: value.method } : {}),
    verifiedAt: typeof value.verifiedAt === "string" ? value.verifiedAt : new Date().toISOString(),
  };
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// N3:从最终回答里扫描“文件交付声明”(已创建/写入了 X.ext)。这只是
// 待核对目标列表——证据必须来自运行时写入回执;未兑现的声明会成为缺口。
// 按句(句号/分号/叹问号/逗号/换行)切分:句内出现完成时态动词(已创建/
// 写入了/成功保存)即把句内全部文件 token 记为声明——覆盖“已创建 A.txt
// 和 B.txt”式列表;解释性“可以创建 X”与否定“未创建 X”不算。
const FILE_TOKEN =
  /([A-Za-z0-9_\-\u4e00-\u9fff]+\.(?:txt|md|csv|xlsx|docx|pdf|html?|json|js|mjs|css))/g;
const sentencesOf = (text) => text.split(/(?<=[。;；!?!?\n,，])/);

export function scanFileClaims(text) {
  const claims = [];
  if (typeof text !== "string" || !text) return claims;
  const COMPLETED =
    /((已|已经|成功|顺利)?(创建|写入|保存|更新|生成|修改)(了|完成|完毕)?)/;
  for (const sentence of sentencesOf(text)) {
    if (!COMPLETED.test(sentence)) continue;
    // 完成时态必须显式:前缀(已/成功…)或后缀(…了/完成)至少其一。
    const hasPrefix = /(已|已经|成功|顺利)\s*(创建|写入|保存|更新|生成|修改)/.test(
      sentence,
    );
    const hasSuffix = /(创建|写入|保存|更新|生成|修改)(了|完成|完毕)/.test(sentence);
    if (!hasPrefix && !hasSuffix) continue;
    if (/(未|没有|不|别|尚未|无)\s*(创建|写入|保存|更新|生成|修改)/.test(sentence))
      continue;
    for (const m of sentence.matchAll(FILE_TOKEN))
      claims.push({ verb: "创建", file: m[1] });
  }
  return claims;
}

// N3:从任务消息提取文件类交付目标(可核对的“要求与目标版本”素材)。
// 句内出现创建类动词即把句内全部文件 token 记为目标;引用现有文件的问答
// (无创建动词)不产生目标。目标是否兑现以运行时写入回执为准。
export function scanFileTargets(text) {
  const targets = [];
  if (typeof text !== "string" || !text) return targets;
  const VERB =
    /(创建|新建|生成|写入|保存|输出|整理成|汇总成|更新|修改)/;
  const seen = new Set();
  for (const sentence of sentencesOf(text)) {
    const verbMatch = VERB.exec(sentence);
    if (!verbMatch) continue;
    for (const m of sentence.matchAll(FILE_TOKEN)) {
      const file = m[1];
      if (seen.has(file.toLowerCase())) continue;
      seen.add(file.toLowerCase());
      targets.push({ verb: verbMatch[1], file });
    }
  }
  return targets;
}

// 文件存在且可读：返回证据条目；失败时返回缺口条目（不抛出，让调用方
// 聚合成 gaps）。
export async function fileDeliveryEvidence(path) {
  try {
    const info = await stat(path);
    if (!info.isFile())
      return { kind: "file", path, gap: "not_a_file", detail: "路径不是普通文件" };
    const content = await readFile(path);
    return {
      kind: "file",
      path,
      bytes: content.length,
      hash: sha256(content),
      readable: true,
      verifiedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      kind: "file",
      path,
      gap: error.code === "ENOENT" ? "not_found" : "unreadable",
      detail: error.code || String(error.message || error),
    };
  }
}

// 外部操作回执引用：source 指明回执来源（如 sandbox:<backend>、
// approval:<id>），receipt 携带回执本身的引用字段。status 明确区分成功
// 回执与失败回执——失败回执是诊断信息,不是成功证据(N4)。
export function receiptEvidence(source, receipt = {}) {
  return {
    ...receipt,
    kind: "receipt",
    source,
    verifiedAt: new Date().toISOString(),
  };
}

// 结构化产物（医疗草稿等非文件交付物）回执：内容哈希是“本次产物”的最小
// 可核对事实；防旧文件冒充需要调用方记录产生时间/来源，这里不猜。
export function artifactEvidence(artifact) {
  const { hash, ...rest } = artifact || {};
  return receiptEvidence("artifact", {
    ...rest,
    ...(artifact?.id ? { artifactId: artifact.id } : {}),
    hash: hash || sha256(JSON.stringify(artifact ?? null)),
  });
}
