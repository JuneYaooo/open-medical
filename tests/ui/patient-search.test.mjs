import test from "node:test";
import assert from "node:assert/strict";
import { matchesNameInitials, nameInitials, surnameInitial } from "../../src/pinyin-initials.js";
import { birthYearFromAge, patientQuickMatch, phoneDigits } from "../../src/patient-labels.js";

test("surname table fixes polyphone and previously wrong entries", () => {
  assert.equal(surnameInitial("邵华"), "s");
  assert.equal(surnameInitial("曾国藩"), "z");
  assert.equal(surnameInitial("单田芳"), "s");
  assert.equal(surnameInitial("仇英"), "q");
});

test("full-name initials match multi-letter queries", () => {
  assert.equal(nameInitials("张三"), "zs");
  assert.ok(matchesNameInitials("张三", "zs"));
  assert.ok(matchesNameInitials("张三丰", "zsf"));
  assert.ok(matchesNameInitials("张三", "z"));
  assert.ok(matchesNameInitials("张三", "z三"));
  assert.ok(!matchesNameInitials("张三", "ls"));
  assert.ok(!matchesNameInitials("张三", "zsx"));
});

test("characters that cannot be resolved never match", () => {
  assert.equal(nameInitials("A☆"), "a?");
  assert.ok(!matchesNameInitials("☆", "a"));
});

test("quick patient match: name, number, initials, phone tail", () => {
  const p = { id: "abcdef12-0000", name: "王小明", patientNumber: "HT-0012", phone: "138-1234-5678" };
  assert.ok(patientQuickMatch(p, "小明"));
  assert.ok(patientQuickMatch(p, "ht-00"));
  assert.ok(patientQuickMatch(p, "wxm"));
  assert.ok(patientQuickMatch(p, "5678"));
  assert.ok(patientQuickMatch(p, "13812345"));
  assert.ok(!patientQuickMatch(p, "1234"));
  assert.ok(!patientQuickMatch(p, "a"));
  assert.equal(phoneDigits("+86 138-1234-5678"), "8613812345678");
});

test("birthYearFromAge validates 0–120", () => {
  assert.equal(birthYearFromAge("60", 2026), 1966);
  assert.equal(birthYearFromAge(0, 2026), 2026);
  assert.equal(birthYearFromAge("121", 2026), "");
  assert.equal(birthYearFromAge("-1", 2026), "");
  assert.equal(birthYearFromAge("6.5", 2026), "");
});
