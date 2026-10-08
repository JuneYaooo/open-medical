import test from "node:test";
import assert from "node:assert/strict";
import { assessOcrQuality, OCR_QUALITY_LABELS } from "../shared/ocr-quality.mjs";

// 校准样本取自真实场景的形态（手机拍照中文医疗文档经 Windows 本地 OCR 的四类输出），
// 内容为编造，不含真实患者信息；阈值已按真实病例语料校准（可读页词命中率 ≥7，
// 受损关键页 4–5，无数值模板页 ≤2）。
const cleanNarrative = `患者于2024年8月6日行全身PET/CT检查，示全身多发肿大高代谢淋巴结，
肠系膜局部融合成团，结合病史考虑淋巴瘤浸润。胃窦活检标本示轻度慢性萎缩性胃炎伴肠化。
建议结合肠镜病理及相关检查进一步明确，定期随访复查。`;

// Windows OCR 原生输出形态：每个汉字之间带空格——好页面也这样，不允许误判。
const cleanSpaced = cleanNarrative.replace(/([\u4e00-\u9fff])/g, "$1 ");

// 词汤式乱码：生僻字/异体字过半、游离符号与数字串混杂，真实词只剩零星标签
// （对应报告字段区被识别打碎的页面）。
const wordSalad = `渺 像 号 》 3 佣 55 西 射 蒓 枷@邮 凶
注 射 时 闻 《 08 园 2 ！
臨 床 鈴 病 如 檢 臺 蒓 毳
报 告 邇 期 ； 202 驴 02 过 2 湖 过
门 号 磊 0704 倥 遼
剂 鉿 遼 径 静 脈 注 射 出 倥
薹 蒓 毳 邇 鑪 壼 脛 釐 燚 骉 犇 瞐 皛
渺 濶 毳 蒓 邇 鑪 臺 灣 脛 釐
注 射 蒓 枷 邮 凶 园 湖 驴 磊
日 期 鉿 遼 倥 蒓 毳 邇 鑪 壼`;

// 无数值模板页：标签与冒号高密度重复，没有任何实际数值（对应系统导出清单页）。
const emptyTemplate = `值 ： 值 RI: RI PSV ： PSV 斑 块 ： 斑 块 斑 块 值 1 ： 斑 块 值 1 斑 块 值 2 ： 斑 块 值 2
结 论 ： 结 论 射 血 分 数 ： 射 血 分 数 左 室 后 壁 ： 左 室 后 壁 室 间 隔 ： 室 间 隔
左 肾 1 ： 左 肾 1 左 肾 2 ： 左 肾 2 右 肾 1 ： 右 肾 1 右 肾 2 ： 右 肾 2
甲 状 腺 B 超 ： 甲 状 腺 B 超 肾 结 论 ： 肾 结 论
GFR
结 论 ： 结 论 左 ： 左 右 ： 右 EKG ： EKG 胸 片 ： 胸 片
体 重 ： 体 重 身 高 ： 身 高`;

// 系统自己加的页眉/页尾不应参与评分。
const withOurHeaders = `[x.jpg 第 1 页 · 本地文字识别]\n${cleanSpaced}\n[文字识别结果需核对原图；不能据此解读 CT 或病理图像。]`;

test("干净中文报告评分良好，Windows 逐字空格不误判", () => {
  const plain = assessOcrQuality(cleanNarrative);
  const spaced = assessOcrQuality(cleanSpaced);
  assert.equal(plain.level, "good");
  assert.equal(spaced.level, "good", `spacing must not hurt: ${JSON.stringify(spaced.signals)}`);
  assert.equal(assessOcrQuality(withOurHeaders).level, "good", "provenance headers must be ignored");
  assert.ok(plain.signals.commonRatio > 0.9, "real text is mostly common hanzi");
});

test("词汤式乱码评分为差", () => {
  const result = assessOcrQuality(wordSalad);
  assert.equal(result.level, "poor", `score=${result.score} signals=${JSON.stringify(result.signals)}`);
  assert.ok(result.signals.commonRatio < 0.85, "rare/variant hanzi dominate");
});

test("无数值模板页被识别为重复度异常，不得评为良好", () => {
  const result = assessOcrQuality(emptyTemplate);
  assert.notEqual(result.level, "good", `score=${result.score} signals=${JSON.stringify(result.signals)}`);
  assert.ok(result.signals.dedupRatio > 0.15, "label:value template repeats bigrams heavily");
});

test("短文本与英文材料不因证据不足被惩罚", () => {
  assert.equal(assessOcrQuality("血常规：血红蛋白 105 g/L").level, "good");
  assert.equal(assessOcrQuality("No acute cardiopulmonary disease. Follow up in 6 months.").level, "good");
});

test("视觉模型的 [无法辨认] 标记会拉低评分", () => {
  const vision = assessOcrQuality(
    "检查日期 [无法辨认] 报告日期 [无法辨认] [无法辨认] [无法辨认] [无法辨认] [无法辨认] [无法辨认] 随访",
  );
  assert.notEqual(vision.level, "good", `score=${vision.score}`);
  assert.ok(vision.signals.unrecognizablePer100 > 0.5);
});

test("低置信度行占比越高扣分越重（macOS 真实置信度）", () => {
  const lines = (low) => Array.from({ length: 10 }, (_, i) => ({ text: `第${i}行`, confidence: i < low ? 0.4 : 0.95 }));
  assert.notEqual(assessOcrQuality(cleanNarrative, { lines: lines(4) }).level, "good");
  assert.equal(assessOcrQuality(cleanNarrative, { lines: lines(6) }).level, "poor");
});

test("等级标签齐全", () => {
  assert.deepEqual(Object.keys(OCR_QUALITY_LABELS).sort(), ["fair", "good", "poor"]);
});
