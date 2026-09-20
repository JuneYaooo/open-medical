import { createHash } from "node:crypto";
import { stat, readFile } from "node:fs/promises";

// 交付证据（路线文档 §4.2/§12 DeliveryEvidence）的最小通用件：
// - normalizeDelivery：把域/服务层交付钩子的返回值归一为
//   { delivered, evidence[], gaps[] }；钩子未提供或形状无效时返回 null，
//   调用方保持现状（兼容）。
// - fileDeliveryEvidence / missingFileEvidence：文件类证据——存在且可读，
//   记录路径、字节长度与 sha256；证据必须来自运行时事实，不做 AI 自评。
// - receiptEvidence：外部操作回执引用（沙箱后端、审批应用结果、子任务
//   完成记录等），只引用运行时已发生的回执，不伪造。
export function normalizeDelivery(value) {
  if (!value || typeof value !== "object") return null;
  const delivered = value.delivered === true;
  const evidence = Array.isArray(value.evidence)
    ? value.evidence.filter((e) => e && typeof e === "object")
    : [];
  const gaps = Array.isArray(value.gaps)
    ? value.gaps
        .map((g) =>
          typeof g === "string" ? { reason: "gap", detail: g } : g,
        )
        .filter((g) => g && typeof g === "object")
    : [];
  if (!delivered && !gaps.length)
    gaps.push({
      reason: "no_verifiable_output",
      detail: "交付检查未通过但没有说明缺口。",
    });
  return {
    delivered,
    evidence,
    gaps,
    ...(typeof value.method === "string" ? { method: value.method } : {}),
    verifiedAt: typeof value.verifiedAt === "string" ? value.verifiedAt : new Date().toISOString(),
  };
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

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
// approval:<id>），receipt 携带回执本身的引用字段。
export function receiptEvidence(source, receipt = {}) {
  return {
    kind: "receipt",
    source,
    ...receipt,
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
