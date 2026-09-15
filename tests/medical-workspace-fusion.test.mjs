import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionEngine } from "../server/core/permissions.mjs";
import { fixture } from "./helpers.mjs";

// Full fusion: the project workspace always carries the medical capability.
// The model auto-dispatches (patient materials -> provenance-traced
// proposals; guideline files -> RAG knowledge base); no manual switch.
test("project workspaces always carry medical tools alongside full permissions", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omw-fusion-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = await fixture(t, { database: join(dir, "medical.sqlite") });
  const perms = new PermissionEngine({ profile: "standard", grants: {} });

  const created = await f.json("/api/workspaces", "POST", {
    title: "融合工作区",
    root: dir,
    directoryConsent: true,
  });
  assert.equal(created.status, 201);
  const wsId = created.data.id;

  const names = f.server.workspaces
    .registry(wsId, "run-check")
    .definitions(perms)
    .map((d) => d.function.name);

  for (const tool of [
    "literature_search",
    "guideline_search",
    "guideline_ingest",
    "medical_scale_calculate",
    "lab_knowledge_search",
    "assess_adverse_reaction",
    "medication_safety_check",
    "similar_case_search",
    "drg_group",
    "doctor_memory_get",
    "patient_record_propose",
    "knowledge_base_status",
  ])
    assert.ok(names.includes(tool), `缺少医疗工具 ${tool}`);
  for (const tool of ["read_file", "list_directory"])
    assert.ok(names.includes(tool), `缺少项目工具 ${tool}`);

  // Status tool reports docs + embedder mode with actionable advice.
  const status = await f.server.runtime.toolPlugins
    .get("knowledge_base_status")
    .execute({});
  assert.ok(status.docs >= 0);
  assert.ok(status.advice.length > 10);

  // The medical auto-dispatch discipline is always part of the system prompt.
  const system = f.server.workspaces.systemFor({});
  assert.ok(system.includes("自动调度"));
  assert.ok(system.includes("patient_record_propose"));
  assert.ok(system.includes("guideline_ingest"));
});

test("guideline knowledge base: RAG ingest and hybrid search via injected embedder", async (t) => {
  const f = await fixture(t);
  const boot = (await f.json("/api/bootstrap")).data;
  assert.ok(boot.guidelines.rag);

  // Ingest through the agent tool with a deterministic embedder stub:
  // vectors encode keyword presence so semantic search is predictable.
  const service = f.server.runtime.toolPlugins.get("guideline_ingest");
  f.server.guidelines.embedder = {
    available: () => true,
    status: () => ({ enabled: true, provider: "stub" }),
    model: "stub-v1",
    embed: async (inputs) =>
      inputs.map((text) => [
        text.includes("高血压") ? 1 : 0,
        text.includes("妊娠") ? 1 : 0,
        text.includes("抗凝") ? 1 : 0,
      ]),
  };

  const saved = await service.execute({
    title: "妊娠高血压诊疗要点",
    text: "妊娠期高血压诊断与治疗规范（测试文本）。重度妊娠期高血压患者收缩压≥160mmHg 或舒张压≥110mmHg 时，应在医生指导下尽快启动降压治疗；降压药物选择需兼顾胎儿安全性，避免使用血管紧张素转换酶抑制剂与血管紧张素受体拮抗剂。终止妊娠的时机应由产科医生结合孕周与病情综合评估。本规范为测试用途的示例文本，用于验证知识库分块与向量化索引流程，包含足量字符以满足导入校验要求。",
    org: "测试学会",
    year: 2025,
  });
  assert.equal(saved.embedded, saved.chunkCount);

  const tool = f.server.runtime.toolPlugins.get("guideline_search");
  const hits = await tool.execute({ query: "妊娠 高血压" });
  assert.equal(hits.count, 1);
  assert.ok(["vector", "hybrid"].includes(hits.hits[0].matchedVia));
  assert.ok(hits.hits[0].vectorScore > 0.9);
  assert.ok(hits.rag.embeddedChunks >= 1);
});

test("embedding model provenance: stale vectors detected and reindex rebuilds", async (t) => {
  const f = await fixture(t);
  const service = f.server.runtime.toolPlugins.get("guideline_ingest");
  f.server.guidelines.embedder = {
    available: () => true,
    status: () => ({ enabled: true, provider: "stub" }),
    model: "model-a",
    embed: async (inputs) => inputs.map((text) => [text.length, 1]),
  };
  await service.execute({
    title: "模型溯源测试指南",
    text: "这是一个用于验证向量模型版本管理的足够长的测试文本。高血压患者收缩压增高的场合应重复测量并评估靶器官损害，结合既往病史与在用药物情况综合判断，必要时安排动态血压监测以明确诊断，并按指南启动降压治疗与随访。",
    org: "测试",
    year: 2025,
  });

  // Doctor switches the embedding model: old vectors become stale.
  f.server.guidelines.embedder.model = "model-b";
  const staleSearch = await f.server.runtime.toolPlugins
    .get("guideline_search")
    .execute({ query: "收缩压" });
  assert.equal(staleSearch.rag.stale, true);
  assert.ok(staleSearch.rag.indexedModels.includes("model-a"));
  // Text matching still works during staleness (graceful degradation).
  assert.equal(staleSearch.count, 1);

  // Reindex rebuilds every chunk under the current model.
  const reindexed = await f.server.guidelines.reindex();
  assert.equal(reindexed.model, "model-b");
  assert.equal(reindexed.stale, false);
  const freshSearch = await f.server.runtime.toolPlugins
    .get("guideline_search")
    .execute({ query: "收缩压" });
  assert.equal(freshSearch.rag.stale, false);
  assert.ok(freshSearch.rag.indexedModels.includes("model-b"));
  assert.ok(!freshSearch.rag.indexedModels.includes("model-a"));
});

test("patients: clinical items accept provenance source fields", async (t) => {
  const f = await fixture(t);
  const created = await f.json("/api/patients", "POST", {
    name: "溯源患者",
    diagnoses: [
      { code: "I10", name: "原发性高血压", source: "门诊病历.txt L12" },
    ],
    medications: [{ name: "氨氯地平", dose: "5mg", source: "出院小结 L4" }],
    labs: [
      {
        item: "血钾",
        value: 3.2,
        unit: "mmol/L",
        date: "2025-09-01",
        source: "检验报告.txt L3",
      },
    ],
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.diagnoses[0].source, "门诊病历.txt L12");
  assert.equal(created.data.labs[0].source, "检验报告.txt L3");
  assert.equal(created.data.medications[0].source, "出院小结 L4");
});
