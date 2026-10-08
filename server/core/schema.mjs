import { check } from "../errors.mjs";
// Intentionally a documented subset; unknown constraints are rejected at registration.
const KEYS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "description",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "default",
  "anyOf",
  "pattern",
]);
export function validateSchema(schema, depth = 0) {
  check(
    schema &&
      typeof schema === "object" &&
      !Array.isArray(schema) &&
      depth < 16,
    "TOOL_SCHEMA",
    "工具 schema 无效",
  );
  if (schema.anyOf !== undefined) {
    check(Array.isArray(schema.anyOf) && schema.anyOf.length > 0 && schema.anyOf.length <= 8,
      "TOOL_SCHEMA", "anyOf 需要 1–8 个候选 schema");
    for (const variant of schema.anyOf) validateSchema(variant, depth + 1);
  }
  for (const key of Object.keys(schema))
    check(KEYS.has(key), "TOOL_SCHEMA", `不支持的 schema 约束：${key}`);
  check(
    [
      "object",
      "array",
      "string",
      "number",
      "integer",
      "boolean",
      "null",
    ].includes(schema.type) || (schema.type === undefined && schema.anyOf),
    "TOOL_SCHEMA",
    "工具 schema 类型无效",
  );
  for (const value of Object.values(schema.properties || {}))
    validateSchema(value, depth + 1);
  if (schema.items) validateSchema(schema.items, depth + 1);
  if (schema.pattern !== undefined) {
    check(schema.type === "string" && typeof schema.pattern === "string" && schema.pattern.length <= 2000,
      "TOOL_SCHEMA", "字符串 pattern 无效");
    try { new RegExp(schema.pattern); } catch { check(false, "TOOL_SCHEMA", "pattern 正则无效"); }
  }
}
export function validateArguments(value, schema, path = "arguments") {
  // 错误信息附上具体原因：模型拿到"哪里错、该怎么改"才能一次修正，
  // 否则只会反复试探或在一次失败后放弃调用。
  const fail = (condition, reason) =>
    check(
      condition,
      "INVALID_TOOL_ARGS",
      `工具参数无效：${path}${reason ? `（${reason}）` : ""}`,
    );
  if (schema.anyOf) {
    fail(
      schema.anyOf.some((variant) => {
        try { validateArguments(value, variant, path); return true; }
        catch (error) { if (error.code !== "INVALID_TOOL_ARGS") throw error; return false; }
      }),
      "不符合任一候选结构",
    );
    if (schema.type === undefined) return;
  }
  if (schema.enum) {
    fail(
      schema.enum.some((x) => x === value),
      `取值必须是：${schema.enum.map((x) => JSON.stringify(x)).join("、")}`,
    );
  }
  if (schema.type === "object") {
    fail(value !== null && typeof value === "object" && !Array.isArray(value), "应为对象");
    for (const key of schema.required || [])
      fail(Object.hasOwn(value, key), `缺少必填字段 "${key}"`);
    for (const [key, item] of Object.entries(value)) {
      const child = Object.hasOwn(schema.properties || {}, key)
        ? schema.properties[key]
        : null;
      if (!child)
        fail(
          schema.additionalProperties === true,
          `出现未定义的字段 "${key}"，只允许：${Object.keys(schema.properties || {}).map((k) => `"${k}"`).join("、") || "无"}`,
        );
      else validateArguments(item, child, `${path}.${key}`);
    }
  } else if (schema.type === "array") {
    fail(Array.isArray(value), "应为数组");
    fail(
      value.length >= (schema.minItems ?? 0) &&
        value.length <= (schema.maxItems ?? 1000),
      `元素数量须为 ${schema.minItems ?? 0}–${schema.maxItems ?? 1000}`,
    );
    for (const item of value)
      if (schema.items) validateArguments(item, schema.items, `${path}[]`);
  } else if (schema.type === "string") {
    fail(typeof value === "string", "应为字符串");
    fail(
      value.length >= (schema.minLength ?? 0) &&
        value.length <= (schema.maxLength ?? 100000),
      `长度须为 ${schema.minLength ?? 0}–${schema.maxLength ?? 100000}`,
    );
    if (schema.pattern !== undefined) fail(new RegExp(schema.pattern).test(value));
  } else if (["number", "integer"].includes(schema.type)) {
    fail(
      typeof value === "number" &&
        Number.isFinite(value) &&
        (schema.type !== "integer" || Number.isInteger(value)),
      schema.type === "integer" ? "应为整数" : "应为数值",
    );
    fail(
      value >= (schema.minimum ?? -Infinity) &&
        value <= (schema.maximum ?? Infinity),
      `超出允许范围 ${schema.minimum ?? "-∞"}–${schema.maximum ?? "∞"}`,
    );
  } else if (schema.type === "null") fail(value === null, "应为 null");
  else fail(typeof value === schema.type, `应为 ${schema.type}`);
}
