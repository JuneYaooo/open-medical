import test from "node:test";
import assert from "node:assert/strict";
import { parsePatientImport, parsePatientImportTable } from "../../shared/patient-import.mjs";

test("unknown header columns are skipped and reported instead of rejecting the sheet", () => {
  const { rows, ignoredColumns } = parsePatientImportTable("姓名,住址,电话,备注,\n张三,北京,13800000000,老病人,\n");
  assert.deepEqual(ignoredColumns, ["住址", "备注"]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].errors, []);
  assert.equal(rows[0].input.name, "张三");
  assert.equal(rows[0].input.phone, "13800000000");
  assert.equal("住址" in rows[0].input, false);
  assert.equal(Object.keys(rows[0].input).includes("undefined"), false);
});

test("duplicate known columns are still rejected", () => {
  assert.throws(() => parsePatientImport("姓名,电话,联系电话\n张三,1,2\n"), /重复列/);
});

test("年龄 / age columns become an estimated birth year", () => {
  const rows = parsePatientImport("姓名,年龄\n张三,60\n李四,61岁\n王五,130\n赵六,abc\n钱七,0\n", { currentYear: 2026 });
  assert.equal(rows[0].input.birthYear, 1966);
  assert.equal(rows[1].input.birthYear, 1965);
  assert.match(rows[2].errors.join(), /0–120/);
  assert.match(rows[3].errors.join(), /0–120/);
  assert.equal(rows[4].input.birthYear, 2026);
  assert.equal("age" in rows[0].input, false);
  const english = parsePatientImport("name,age\nZhang,40\n", { currentYear: 2026 });
  assert.equal(english[0].input.birthYear, 1986);
});

test("an explicit birth year wins over age", () => {
  const rows = parsePatientImport("姓名,出生年份,年龄\n张三,1950,60\n", { currentYear: 2026 });
  assert.equal(rows[0].input.birthYear, 1950);
});

test("missing 姓名 column is still an error", () => {
  assert.throws(() => parsePatientImport("住址,电话\n北京,1\n"), /姓名/);
});
