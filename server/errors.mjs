export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export function check(condition, code, message, status = 400) {
  if (!condition) throw new AppError(code, message, status);
}
export function string(value, name, max = 20000) {
  const overlong = typeof value === "string" && value.length > max;
  check(
    typeof value === "string" && value.trim().length > 0 && !overlong,
    "INVALID_INPUT",
    // 报出当前字数，否则调用方（尤其是模型）只能盲改。
    overlong
      ? `${name} 当前 ${value.length} 字，须为 1–${max} 字符，请压缩`
      : `${name} 必须是 1–${max} 字符的文本`,
  );
  return value.trim();
}
export function identifier(value) {
  check(
    typeof value === "string" &&
      /^[A-Za-z0-9_-]{1,100}$/.test(value) &&
      !["__proto__", "constructor", "prototype"].includes(value),
    "INVALID_ID",
    "无效标识",
  );
  return value;
}
