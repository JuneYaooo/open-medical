import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalDrugName,
  evaluateMedicationSafety,
  MISSED_ALERT_NOTE,
  specialPopulationCautions,
} from "../../server/medical/med-safety.mjs";

const keys = (result) => result.interactions.map((item) => item.ruleKey);

test("用药辅助提醒：青霉素过敏匹配同类药物，并提示头孢交叉过敏", () => {
  const result = evaluateMedicationSafety({
    medications: ["阿莫西林胶囊", "头孢呋辛酯片", "氨氯地平"],
    allergies: ["青霉素"],
  });
  const byMed = Object.fromEntries(result.allergyMatches.map((m) => [m.medication, m]));
  assert.equal(byMed["阿莫西林胶囊"].severity, "critical");
  assert.equal(byMed["头孢呋辛酯片"].kind, "cross");
  assert.equal(byMed["头孢呋辛酯片"].severity, "warning");
  assert.ok(!byMed["氨氯地平"]);
});

test("用药辅助提醒：对单个头孢过敏时，其他头孢按同类提醒而不是直接匹配", () => {
  const [match] = evaluateMedicationSafety({ medications: ["头孢呋辛"], allergies: ["头孢曲松"] }).allergyMatches;
  assert.equal(match.kind, "class");
  assert.equal(match.severity, "warning");
});

test("用药辅助提醒：按药物类别识别相互作用", () => {
  const result = evaluateMedicationSafety({ medications: ["华法林钠片", "阿司匹林肠溶片", "胺碘酮", "芬必得"] });
  for (const key of ["int_anticoag_antiplatelet", "int_anticoag_nsaid", "int_antiplatelet_nsaid", "int_warfarin_potentiator"])
    assert.ok(keys(result).includes(key), key);
});

test("用药辅助提醒：禁止联用的组合为高风险", () => {
  const cases = [
    [["诺欣妥", "依那普利"], "int_arni_acei"],
    [["舒降之", "克拉霉素"], "int_statin3a4_strong"],
    [["吗啡缓释片", "阿普唑仑"], "int_opioid_sedative"],
    [["西地那非", "单硝酸异山梨酯"], "int_pde5_nitrate"],
    [["别嘌醇", "硫唑嘌呤"], "int_xo_thiopurine"],
    [["美罗培南", "丙戊酸钠缓释片"], "int_carbapenem_valproate"],
  ];
  for (const [medications, key] of cases) {
    const hit = evaluateMedicationSafety({ medications }).interactions.find((item) => item.ruleKey === key);
    assert.equal(hit?.severity, "critical", key);
  }
});

test("用药辅助提醒：复方制剂拆成各成分分别核对", () => {
  const result = evaluateMedicationSafety({ medications: ["厄贝沙坦氢氯噻嗪片", "碳酸锂"] });
  assert.ok(keys(result).includes("int_lithium_raas"));
  assert.ok(keys(result).includes("int_lithium_diuretic"));
});

test("用药辅助提醒：同类重复用药与同一药物重复", () => {
  const result = evaluateMedicationSafety({ medications: ["阿托伐他汀", "瑞舒伐他汀", "奥美拉唑", "泮托拉唑", "拜阿司匹灵", "阿司匹林肠溶片"] });
  const dup = result.duplicates.map((item) => item.key);
  assert.ok(dup.includes("class_statin"));
  assert.ok(dup.includes("class_ppi"));
  assert.ok(dup.includes("阿司匹林"));
});

test("用药辅助提醒：名字相近但不同类的药不误判", () => {
  // 依普利酮不是 ACEI；西格列汀不是磺脲类；单个 QT 药物不会自己和自己配对。
  const result = evaluateMedicationSafety({ medications: ["依普利酮", "西格列汀", "格列美脲", "胺碘酮"] });
  assert.ok(!result.duplicates.length);
  assert.ok(!keys(result).includes("int_qt_qt"));
});

test("用药辅助提醒：列出未识别药物并始终附带漏报说明", () => {
  const result = evaluateMedicationSafety({ medications: ["某某胶囊", "二甲双胍"] });
  assert.deepEqual(result.unrecognized, ["某某胶囊"]);
  assert.equal(result.note, MISSED_ALERT_NOTE);
  assert.match(result.note, /可能漏报/);
});

test("用药辅助提醒：特殊人群按类别匹配", () => {
  const { cautions } = specialPopulationCautions({ medications: ["二甲双胍", "地西泮", "布洛芬"], populations: ["elderly", "renal"] });
  const pairs = cautions.map((item) => `${item.medication}:${item.population}`);
  for (const pair of ["二甲双胍:renal", "地西泮:elderly", "布洛芬:renal", "布洛芬:elderly"]) assert.ok(pairs.includes(pair), pair);
});

test("用药辅助提醒：商品名与剂型归一", () => {
  assert.equal(canonicalDrugName("阿司匹林肠溶片"), "阿司匹林");
  assert.equal(canonicalDrugName("拜阿司匹灵"), "阿司匹林");
  assert.equal(canonicalDrugName("左氨氯地平片"), "左氨氯地平");
});
