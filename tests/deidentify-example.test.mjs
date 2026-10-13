import test from "node:test";
import assert from "node:assert/strict";
import { deidentifyExample } from "../server/medical/deidentify-example.mjs";
test("example removes identifiers in fields and prose, preserves only relative chronology and age band", () => {
  const value = {
    name: "王某测试",
    phone: "13812345678",
    patientNumber: "HOSP888",
    birthYear: 1972,
    birthDate: "1972-03-05",
    note: "王某测试 电话13812345678 住院号HOSP888 身份证110101197203051234",
    labs: [
      { item: "血糖", value: 5, date: "2026-01-01", source: "王某测试.pdf" },
    ],
    visits: [{ date: "2026-04-01", reason: "复查" }],
  };
  const clean = deidentifyExample(value),
    json = JSON.stringify(clean);
  assert.doesNotMatch(
    json,
    /王某测试|13812345678|HOSP888|110101197203051234|1972-03-05|2026-01-01|2026-04-01/,
  );
  assert.match(clean.ageBand, /多岁/);
  assert.equal(clean.labs[0].value, 5);
  assert.match(clean.visits[0].date, /^首诊后\d+天$/);
});
test("nested IDs, source excerpts and free-text labeled names do not survive", () => {
  const s = deidentifyExample({
    name: "患者甲",
    sourceInput: "秘密",
    clinicalSummary: {
      text: "姓名：患者甲。2026年1月3日复查。证件号：ABC999 电话 13999999999",
      source: "私密目录",
    },
    sourceSessionId: "PRIVATE_SESSION",
  });
  assert.doesNotMatch(
    JSON.stringify(s),
    /秘密|患者甲|ABC999|13999999999|2026年1月3日|PRIVATE_SESSION|私密目录/,
  );
});
