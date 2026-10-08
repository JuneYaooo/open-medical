// OCR 文本质量评分：纯函数、离线、跨平台（Node 与浏览器，均走 TextDecoder）。
// 背景：Windows 本地 OCR（Windows.Media.Ocr）不提供真实置信度（native-ocr.ps1
// 写死 0.95），且中文输出天然逐字空格分隔——「字间空格」不能当乱码信号。
// 因此用五个可解释的统计特征打分：
//   commonRatio    汉字落在 GB2312 一级常用字带的比例（乱码多为生僻字/异体字）
//   wordHitsPer100 常用词命中率（词汤式乱码几乎不含真实词；短文本不评估）
//   dedupRatio     相邻二元组重复率（「值：值 斑块：斑块」式无数值模板页极高）
//   bracketNoise   成对括号失衡与游离符号密度（《》〗@# 在乱码中异常密集）
//   lowConfidence  低置信度行占比（仅 macOS 本地 OCR 有真实置信度；视觉模型
//                  的 [无法辨认] 标记单独按密度计罚）
// 信号缺证据时记 null 并跳过对应计罚；结果供自动升级视觉模型、原始资料页
// 质量徽章/提醒、材料 manifest 提示模型三处使用。

const GB_BAND_LEAD = [0xb0, 0xd7];
const GB_BAND_TRAIL = [0xa1, 0xfe];
// 常用词表：通用医疗/文书词汇，双字起步。词汤式乱码的命中率显著低于真实报告。
const COMMON_WORDS = [
  "患者", "姓名", "年龄", "性别", "住院", "出院", "入院", "门诊", "病房", "诊断",
  "临床", "检查", "检验", "报告", "日期", "医院", "医学", "科室", "病史", "体格",
  "既往", "过敏", "药物", "用药", "血压", "血糖", "蛋白", "细胞", "淋巴", "肿瘤",
  "肝脏", "肾脏", "甲状腺", "超声", "心电图", "病理", "活检", "治疗", "化疗", "复查",
  "随访", "评估", "建议", "未见", "异常", "增大", "增多", "结节", "囊肿", "结石",
  "感染", "发热", "胰腺", "脾脏", "胆囊", "结肠", "直肠", "动脉", "静脉", "血流",
  "结论", "意见", "医师", "备注", "剂量", "注射", "口服", "影像", "所见", "全身",
  "显像", "断层", "密度", "代谢", "病变", "转移", "骨髓", "贫血", "免疫", "标本",
  "描述", "部位", "大小", "周期", "数值", "范围", "清晰", "对比",
];

let commonHanSet = null;
function commonHan() {
  if (commonHanSet) return commonHanSet;
  try {
    const bytes = [];
    for (let lead = GB_BAND_LEAD[0]; lead <= GB_BAND_LEAD[1]; lead++)
      for (let trail = GB_BAND_TRAIL[0]; trail <= GB_BAND_TRAIL[1]; trail++)
        bytes.push(lead, trail);
    commonHanSet = new Set(new TextDecoder("gbk").decode(new Uint8Array(bytes)));
  } catch {
    commonHanSet = null; // 环境不支持 gbk 解码时跳过该信号
  }
  return commonHanSet;
}

const HAN = /\p{Script=Han}/u;
const ourMarkers = /\[识别置信度低，请核对原图\]|\[文字识别待核对\]/g;

export function assessOcrQuality(text, { lines } = {}) {
  const raw = String(text || "");
  const unrecognizable = (raw.match(/\[无法辨认\]/g) || []).length;
  // 我们自己加的页眉/页尾说明整行以「[」开头，连同行内低置信度标记一起剔除。
  const clean = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("["))
    .join("\n")
    .replace(ourMarkers, "");
  const nonSpace = clean.replace(/\s+/g, "");
  const tokens = clean.split(/\s+/).filter(Boolean);
  let hanCount = 0;
  let hanInBand = 0;
  const band = commonHan();
  for (const ch of nonSpace) {
    if (!HAN.test(ch)) continue;
    hanCount++;
    if (band && band.has(ch)) hanInBand++;
  }
  const deSpaced = nonSpace;

  let wordHits = null;
  if (hanCount >= 40) {
    let hits = 0;
    for (const word of COMMON_WORDS) if (deSpaced.includes(word)) hits++;
    wordHits = (hits * 100) / hanCount;
  }
  let commonRatio = null;
  if (band && hanCount >= 30) commonRatio = hanInBand / hanCount;

  let dedupRatio = null;
  if (tokens.length >= 8) {
    const seen = new Map();
    let repeats = 0;
    const grams = Math.max(1, tokens.length - 3);
    for (let i = 0; i + 1 < tokens.length; i++) {
      const key = tokens[i] + "\u0000" + tokens[i + 1];
      const last = seen.get(key);
      if (last !== undefined && i - last <= 12) repeats++;
      seen.set(key, i);
    }
    dedupRatio = repeats / grams;
  }

  let bracketNoise = 0;
  for (const [open, close] of [["《", "》"], ["【", "】"], ["「", "」"], ["『", "』"]])
    bracketNoise += Math.abs(nonSpace.split(open).length - nonSpace.split(close).length);
  for (const ch of "〈〉〖〗@#^~`|=<>\\") bracketNoise += nonSpace.split(ch).length - 1;
  const bracketNoisePer100 = (bracketNoise * 100) / Math.max(1, nonSpace.length);
  const unrecognizablePer100 = (unrecognizable * 100) / Math.max(1, tokens.length);

  const usable = (lines || []).filter((l) => typeof l.confidence === "number");
  const lowConfidence = usable.length
    ? usable.filter((l) => l.confidence < 0.7).length / usable.length
    : null;

  // 阈值按真实病例语料校准（14 页手机拍照医疗文档）：可读页词命中率 ≥7，
  // 受损关键页 4–5，无数值模板页 ≤2 且二元组重复率 ≥0.24。
  let score = 100;
  if (wordHits !== null) {
    if (wordHits < 3.5) score -= 45;
    else if (wordHits < 6.5) score -= (6.5 - wordHits) * 14;
  }
  if (commonRatio !== null) {
    if (commonRatio < 0.85) score -= 20;
    else if (commonRatio < 0.92) score -= 8;
  }
  if (dedupRatio !== null && dedupRatio > 0.15) score -= Math.min(35, (dedupRatio - 0.15) * 90);
  if (bracketNoisePer100 > 6) score -= Math.min(8, (bracketNoisePer100 - 6) * 2);
  if (lowConfidence !== null && lowConfidence > 0.55) score -= 65;
  else if (lowConfidence !== null && lowConfidence > 0.3) score -= 45;
  if (unrecognizablePer100 > 0.5) score -= Math.min(45, (unrecognizablePer100 - 0.5) * 25);
  // 近乎空白的结果（只剩我们加的说明文字）按差评处理：一张真的可读的页面不会只有十来个字符。
  if (nonSpace.length < 12) score = Math.min(score, 30);
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score,
    level: score >= 75 ? "good" : score >= 45 ? "fair" : "poor",
    signals: {
      hanCount,
      commonRatio: commonRatio === null ? null : Number(commonRatio.toFixed(3)),
      wordHitsPer100: wordHits === null ? null : Number(wordHits.toFixed(2)),
      dedupRatio: dedupRatio === null ? null : Number(dedupRatio.toFixed(3)),
      bracketNoisePer100: Number(bracketNoisePer100.toFixed(2)),
      lowConfidenceRatio: lowConfidence === null ? null : Number(lowConfidence.toFixed(3)),
      unrecognizablePer100: Number(unrecognizablePer100.toFixed(2)),
    },
  };
}

export const OCR_QUALITY_LABELS = { good: "识别质量良好", fair: "识别待核对", poor: "识别质量差" };
