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
  ])
    assert.ok(names.includes(tool), `缺少医疗工具 ${tool}`);
  for (const tool of ["read_file", "list_directory"])
    assert.ok(names.includes(tool), `缺少项目工具 ${tool}`);

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
  assert.equal(hits.hits[0].matchedVia, "vector");
  assert.ok(hits.hits[0].vectorScore > 0.9);
  assert.ok(hits.rag.embeddedChunks >= 1);
});
