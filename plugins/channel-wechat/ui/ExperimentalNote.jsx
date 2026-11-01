// 微信 / 企业微信渠道依赖界面自动化或第三方工具，存在账号受限风险；
// 保留功能，但在设置中明确标注为实验性，并推荐飞书分身。
export const EXPERIMENTAL_NOTE = "通过界面自动化或第三方工具接入，可能导致账号受限；推荐使用飞书分身。";
export const EXPERIMENTAL_CHANNELS = new Set(["wechat", "wx-cli", "wecom", "wecom-aibot"]);

export function ExperimentalChip() {
  return <em className="om-chip is-caution" title={EXPERIMENTAL_NOTE}>实验性</em>;
}

// 企微智能机器人走官方接口，不是界面自动化；只提示平台限制。
export const WECOM_BOT_NOTE = "企业微信机器人受平台能力与使用规范限制，暂不支持医生分身式自动聊天；推荐使用飞书分身。";

export function ExperimentalNote({ text = EXPERIMENTAL_NOTE }) {
  return <p className="muted experimental-channel-note"><ExperimentalChip /> {text}</p>;
}
