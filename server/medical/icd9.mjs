import { check } from "../errors.mjs";

// Built-in quick lookup for frequently used ICD-9-CM-3 procedure codes.
// Not an exhaustive coding library — hospitals should treat their own
// coding dictionary as authoritative.
export const ICD9_COMMON = [
  ["96.04", "气管插管"],
  ["31.1", "气管切开术"],
  ["34.04", "胸腔闭式引流术"],
  ["32.29", "肺病损切除术"],
  ["35.21", "二尖瓣置换术"],
  ["36.06", "经皮冠脉球囊扩张"],
  ["36.07", "经皮冠脉支架植入（药物洗脱）"],
  ["00.66", "经皮冠脉支架植入（PTCA附加）"],
  ["28.2", "扁桃体切除术"],
  ["21.5", "鼻中隔矫正术"],
  ["13.41", "人工晶体植入术"],
  ["47.09", "阑尾切除术"],
  ["51.23", "腹腔镜胆囊切除术"],
  ["51.22", "开腹胆囊切除术"],
  ["43.6", "胃部分切除术"],
  ["53.0", "腹股沟疝修补术（单侧）"],
  ["49.46", "痔切除术"],
  ["06.2", "单侧甲状腺叶切除术"],
  ["06.3", "甲状腺全切除术"],
  ["85.43", "单侧乳房切除术"],
  ["68.4", "经腹全子宫切除术"],
  ["74.1", "子宫下段剖宫产术"],
  ["81.51", "全髋关节置换术"],
  ["81.54", "全膝关节置换术"],
  ["55.04", "经皮肾镜取石术"],
  ["56.0", "输尿管切开取石术"],
  ["57.32", "膀胱镜检查"],
  ["39.50", "血管腔内成形术（未特指）"],
  ["87.44", "支气管动脉造影（示例：介入操作）"],
  ["45.16", "胃镜检查"],
  ["45.23", "结肠镜检查"],
  ["51.88", "内镜下逆行胰胆管造影 ERCP"],
];

export function searchIcd9(query, { limit = 10 } = {}) {
  check(
    Number.isInteger(limit) && limit >= 1 && limit <= 30,
    "INVALID_INPUT",
    "返回数量须为 1–30",
  );
  const text = String(query || "").trim().toLowerCase();
  if (!text) return [];
  const scored = [];
  for (const [code, name] of ICD9_COMMON) {
    const codeLower = code.toLowerCase();
    const nameLower = name.toLowerCase();
    if (codeLower === text) scored.push([3, code, name]);
    else if (codeLower.startsWith(text)) scored.push([2, code, name]);
    else if (nameLower.includes(text) || codeLower.includes(text))
      scored.push([1, code, name]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit).map(([, code, name]) => ({ code, name }));
}
