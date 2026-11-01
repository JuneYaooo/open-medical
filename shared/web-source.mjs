// 网页来源的站点识别与证据等级标签（确定性，仅按域名）。等级只是来源性质
// 提示，不是对内容质量的判断。
const SITES = [
  [/(^|\.)mp\.weixin\.qq\.com$/, "微信公众号文章", "wechat"],
  [/(^|\.)yiigle\.com$/, "中华医学期刊网", "journal"],
  [/(^|\.)cma\.org\.cn$/, "中华医学会", "society"],
  [/(^|\.)cnki\.(net|com\.cn)$/, "中国知网", "journal"],
  [/(^|\.)wanfangdata\.com\.cn$/, "万方数据", "journal"],
  [/(^|\.)cqvip\.com$/, "维普", "journal"],
  [/(^|\.)(pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov|europepmc\.org)$/, "PubMed/PMC", "journal"],
  [/(^|\.)bbs\.dxy\.cn$/, "丁香园论坛", "forum"],
  [/(^|\.)dxy\.(cn|com)$/, "丁香园", "forum"],
  [/(^|\.)nhc\.gov\.cn$/, "国家卫生健康委员会", "society"],
];
export const WEB_GRADE_LABELS = {
  journal: "期刊/文献数据库",
  society: "学会/机构网站",
  wechat: "非同行评审，证据等级较低",
  forum: "医生社区/资讯，非同行评审，证据等级较低",
  other: "一般网页，来源性质待核对",
};
export function normalizeWebUrl(input) {
  try {
    const url = new URL(String(input).trim());
    url.hash = "";
    if (url.pathname.length > 1 && url.pathname.endsWith("/") && !url.search) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.href;
  } catch {
    return String(input || "").trim();
  }
}
export function webSourceInfo(input) {
  let host = "";
  try { host = new URL(String(input)).hostname.replace(/^www\./, "").toLowerCase(); } catch {}
  const hit = SITES.find(([pattern]) => pattern.test(host));
  const grade = hit?.[2] || "other";
  return {
    sourceSite: hit?.[1] || host || "网页",
    sourceHost: host,
    evidenceGrade: grade,
    lowerGrade: grade === "wechat" || grade === "forum" || grade === "other",
    sourceLabel: `${hit?.[1] || host || "网页"} · ${WEB_GRADE_LABELS[grade]}`,
  };
}
