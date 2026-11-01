// Deterministic safety for the Feishu avatar. Red-flag symptoms and outbound
// wording rules are shared with the care pipeline (import only); the avatar
// adds promise wording and asker-side confusion / worsening signals.
import {
  detectRedFlags,
  screenOutbound,
} from "../../followup/core/care/red-flags.mjs";

export { detectRedFlags };

export const AVATAR_SAFETY_REPLY =
  "您描述的情况可能需要尽快处理。请立即拨打 120 或前往最近医院急诊就医，不要等待线上回复；已提醒医生关注这段对话。";

export const DEFAULT_DISPLAY_NAME = "医生的 AI 助手";

// Every outbound avatar reply ends with this line. It is not configurable
// beyond the persona name so the avatar can never pass as the doctor.
export function disclosureLine(displayName) {
  const name = String(displayName || "").trim() || DEFAULT_DISPLAY_NAME;
  return `—— ${name}（AI 自动回复，非医生本人）`;
}

export function withDisclosure(text, displayName) {
  return `${String(text || "").trim()}\n\n${disclosureLine(displayName)}`;
}

const PROMISE = /保证(能|会|可以)?(治好|痊愈|没事)|一定(能|会)(治好|好起来|痊愈)|包治|根治|肯定没(事|问题)|绝对(安全|没问题)/;
const CONFUSION = /没(看|听)懂|不明白|看不懂|听不懂|什么意思|还是不(懂|清楚|行)|说的不对|答非所问|没用/;
const WORSENING = /越来越(重|严重|疼|痛|难受)|加重了|更(严重|疼|痛|难受)了|恶化|反复发作|一直不好|没有好转/;
const NO_SOURCE = /没有找到相关依据/;

// Review an outbound model-written answer. Excerpt replies are the doctor's
// own material and are not screened for dose wording.
export function reviewReply({ answer = "", modelWritten = false } = {}) {
  const reasons = [];
  if (modelWritten) {
    const screen = screenOutbound(answer.slice(0, 1000));
    for (const reason of screen.reasons)
      if (!["回复过长", "回复为空"].includes(reason)) reasons.push(reason);
    if (PROMISE.test(answer)) reasons.push("包含疗效承诺");
  }
  return reasons;
}

// Signals on the asker's side. Worsening symptoms need the doctor; confusion
// is tracked for insights and highlighted when the avatar keeps failing.
export function reviewInbound(text = "") {
  const value = String(text);
  const reasons = [];
  if (WORSENING.test(value)) reasons.push("提问人描述症状加重");
  if (CONFUSION.test(value)) reasons.push("提问人表示没有看懂");
  return reasons;
}

export const isNoSourceReply = (text) => NO_SOURCE.test(String(text || ""));
