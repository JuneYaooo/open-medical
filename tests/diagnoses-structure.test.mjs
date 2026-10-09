import test from "node:test";
import assert from "node:assert/strict";
import {
  diagnosisStatus,
  diagnosisSources,
  mergeDiagnoses,
  groupDiagnoses,
  sortDiagnoses,
} from "../shared/diagnoses.mjs";
import { briefDraft } from "../shared/patient-brief.mjs";
import { fixture } from "./helpers.mjs";

test("diagnosisStatus: explicit status wins; legacy names infer from wording", () => {
  assert.equal(diagnosisStatus({ name: "滤泡性淋巴瘤", status: "confirmed" }), "confirmed");
  assert.equal(diagnosisStatus({ name: "滤泡性淋巴瘤", status: "finding" }), "finding");

  // Real legacy entries from a follicular lymphoma chart extracted before
  // statuses existed — the grouping must not depend on a re-extraction.
  assert.equal(diagnosisStatus({ name: "滤泡性淋巴瘤（低级别滤泡性淋巴瘤，经左侧腹股沟及颈部淋巴结穿刺活检证实；确诊年份OCR不可读，此处为入院记录日期近似）" }), "confirmed");
  assert.equal(diagnosisStatus({ name: "慢性非萎缩性胃炎伴十二指肠球部霜斑样溃疡（胃镜，具体日不明）" }), "confirmed");
  assert.equal(diagnosisStatus({ name: "轻度贫血、铁蛋白降低" }), "confirmed");
  // 结节病 is a disease, not an incidental nodule.
  assert.equal(diagnosisStatus({ name: "结节病" }), "confirmed");

  assert.equal(diagnosisStatus({ name: "考虑淋巴瘤浸润（PET/CT 印象，待结合病理/肠镜/骨穿）：肠系膜局部融合成团" }), "suspected");
  assert.equal(diagnosisStatus({ name: "胃贲门处代谢增高，暂拟炎性可能，请结合近期胃镜" }), "suspected");

  assert.equal(diagnosisStatus({ name: "肝内小囊肿；胰头脂肪浸润；左输尿管上段轻度扩张伴周围毛斑；前列腺增大伴钙化" }), "finding");
  assert.equal(diagnosisStatus({ name: "双肺散在斑结索灶/结节，右肺水平裂处局部代谢稍高，建议随诊；左肺上叶磨玻璃结节影" }), "finding");
  assert.equal(diagnosisStatus({ name: "主动脉及其分支（含冠状动脉）壁钙化灶" }), "finding");
  assert.equal(diagnosisStatus({ name: "脊柱退行性变（多个节段骨质增生、许莫氏结节）、L1椎体血管瘤" }), "finding");

  assert.equal(diagnosisStatus({ name: "脾脏大小（正常/增大）OCR歧义，待核对" }), "needs_review");
  assert.equal(diagnosisStatus({ name: "低级别滤泡性淋巴瘤（待核对：报告临床诊断栏 OCR 为 DLBCL，与病理结论不一致）" }), "needs_review");
  assert.equal(diagnosisStatus({ name: "结肠多发隆起，性质待病理；横结肠/升结肠/乙状结肠淋巴组织增生，免疫组化进行中" }), "needs_review");
});

test("mergeDiagnoses: same problem across documents becomes one entry with all sources", () => {
  const merged = mergeDiagnoses([
    { code: "C82", name: "滤泡性淋巴瘤", date: "2024-08-14", status: "confirmed", note: "穿刺活检证实", source: "c1-1.jpg 11-17行" },
    { name: "滤泡性淋巴瘤", date: "2025-02-12", sources: ["3.jpg 临床诊断栏", "c1-1.jpg 11-17行"] },
    { name: " 肝内小囊肿 ", source: "j4.jpg 14-32行" },
    { name: "肝内小囊肿", status: "finding" },
  ]);
  assert.equal(merged.length, 2);
  const lymphoma = merged.find((item) => item.name === "滤泡性淋巴瘤");
  assert.equal(lymphoma.date, "2024-08-14"); // first documented date stays
  assert.equal(lymphoma.status, "confirmed");
  assert.equal(lymphoma.note, "穿刺活检证实");
  assert.deepEqual(diagnosisSources(lymphoma), ["c1-1.jpg 11-17行", "3.jpg 临床诊断栏"]);
  assert.equal(lymphoma.source, "c1-1.jpg 11-17行");
  const cyst = merged.find((item) => item.name === "肝内小囊肿");
  assert.equal(cyst.status, "finding"); // gap-filling applies to later fields too
  assert.deepEqual(cyst.sources, ["j4.jpg 14-32行"]);

  // Entries without any source keep the legacy shape (no empty source keys).
  const bare = mergeDiagnoses([{ name: "某诊断" }, { name: "某诊断", code: "X00" }]);
  assert.deepEqual(bare, [{ name: "某诊断", code: "X00" }]);
});

test("groupDiagnoses/sortDiagnoses: confirmed first, chronological inside groups", () => {
  const list = [
    { name: "肝内小囊肿", date: "2024-08-06" },
    { name: "考虑淋巴瘤浸润", date: "2024-08-06" },
    { name: "脾脏大小（正常/增大）OCR歧义，待核对", date: "2025-02-12" },
    { name: "滤泡性淋巴瘤", date: "2024-08-14" },
    { name: "轻度贫血", date: "2024-08-04" },
    { name: "左肾小结石" }, // undated sorts last within its group
  ];
  assert.deepEqual(
    sortDiagnoses(list).map((item) => item.name),
    ["轻度贫血", "滤泡性淋巴瘤", "考虑淋巴瘤浸润", "肝内小囊肿", "左肾小结石", "脾脏大小（正常/增大）OCR歧义，待核对"],
  );
  const groups = groupDiagnoses(list);
  assert.deepEqual(groups.map((group) => group.status), ["confirmed", "suspected", "finding", "needs_review"]);
  assert.deepEqual(groups[0].items.map((item) => item.name), ["轻度贫血", "滤泡性淋巴瘤"]);
  assert.deepEqual(groups[2].items.map((item) => item.name), ["肝内小囊肿", "左肾小结石"]);
  assert.equal(groups[3].items.length, 1);
});

test("patient storage: statuses/notes/sources persist and same-name entries merge", async (t) => {
  const f = await fixture(t);
  const created = await f.json("/api/patients", "POST", {
    name: "诊断结构测试",
    diagnoses: [
      { name: "滤泡性淋巴瘤", status: "confirmed", date: "2024-08-14", note: "经左侧腹股沟及颈部淋巴结穿刺活检证实", source: "c1-1.jpg 11-17行", sources: ["c1-1.jpg 11-17行", "j1-j5.jpg 第1-5页"] },
      { name: "滤泡性淋巴瘤", date: "2025-02-12", source: "3.jpg 临床诊断栏" },
      { name: "肝内小囊肿", status: "finding", source: "j4.jpg 14-32行" },
      { name: "肝内小囊肿", note: "随访即可" },
    ],
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.diagnoses.length, 2);
  const lymphoma = created.data.diagnoses.find((item) => item.name === "滤泡性淋巴瘤");
  assert.equal(lymphoma.status, "confirmed");
  assert.equal(lymphoma.note, "经左侧腹股沟及颈部淋巴结穿刺活检证实");
  assert.deepEqual(lymphoma.sources, ["c1-1.jpg 11-17行", "j1-j5.jpg 第1-5页", "3.jpg 临床诊断栏"]);
  const cyst = created.data.diagnoses.find((item) => item.name === "肝内小囊肿");
  assert.equal(cyst.status, "finding");
  assert.equal(cyst.note, "随访即可");

  const invalid = await f.json("/api/patients", "POST", {
    name: "诊断结构测试二",
    diagnoses: [{ name: "某诊断", status: "maybe" }],
  });
  assert.equal(invalid.status, 400);

  // Doctor edit panel can reclassify a legacy entry via the status select.
  const relabeled = await f.json(`/api/patients/${created.data.id}`, "PATCH", {
    expectedRevision: created.data.revision,
    diagnoses: [{ name: "肝内小囊肿", status: "finding", note: "随访即可", source: "j4.jpg 14-32行" }],
  });
  assert.equal(relabeled.status, 200);
  assert.equal(relabeled.data.diagnoses[0].status, "finding");
});

test("patient_record_propose append: same diagnosis adds a source instead of a duplicate row", async (t) => {
  const f = await fixture(t);
  const patient = (await f.json("/api/patients", "POST", {
    name: "追加归并患者",
    diagnoses: [{ name: "滤泡性淋巴瘤", status: "confirmed", date: "2024-08-14", source: "c1-1.jpg 入院记录" }],
  })).data;

  const service = f.server.runtime.toolPlugins.get("patient_record_propose");
  const proposed = service.execute({
    patientId: patient.id,
    updateMode: "append",
    diagnoses: [{ name: "滤泡性淋巴瘤", date: "2025-02-12", source: "3.jpg 复查PET报告" }],
    summary: "复查报告再次记载同一诊断",
  });
  assert.equal(proposed.status, "pending");
  const confirmed = await f.json(`/api/pending-actions/${proposed.id}/confirm`, "POST");
  assert.equal(confirmed.status, 200);

  const after = (await f.json(`/api/patients/${patient.id}`)).data;
  assert.equal(after.diagnoses.length, 1);
  assert.equal(after.diagnoses[0].date, "2024-08-14");
  assert.deepEqual(after.diagnoses[0].sources, ["c1-1.jpg 入院记录", "3.jpg 复查PET报告"]);
});

test("patient brief and de-identified export prefer confirmed diagnoses", async (t) => {
  const f = await fixture(t);
  const patient = (await f.json("/api/patients", "POST", {
    name: "概览排序患者",
    diagnoses: [
      { name: "肝内小囊肿", status: "finding" },
      { name: "滤泡性淋巴瘤", status: "confirmed", date: "2024-08-14" },
    ],
  })).data;

  const draft = briefDraft({
    revision: patient.revision, fingerprint: "f", generatedAt: "2026-10-09T00:00:00Z",
    diagnoses: patient.diagnoses, medications: [], allergyStatus: "unknown", allergies: [],
    labs: [], visits: [], outcomes: [], messages: [], gaps: [], counts: {},
  });
  const facts = JSON.parse(draft.split("\n\n").pop());
  assert.equal(facts.diagnoses[0].name, "滤泡性淋巴瘤");

  const exported = (await f.json(`/api/patients/${patient.id}/export`)).data;
  assert.equal(exported.diagnoses[0].name, "肝内小囊肿"); // export keeps storage order
  assert.equal(exported.diagnoses[0].status, "finding");
});
