import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { check, identifier } from "../../../server/errors.mjs";
import { EDUCATION_COLLECTION } from "../../../server/medical/guidelines.mjs";
import { normalizeQuestionnaire } from "../../followup/core/surveys.mjs";

// A care pack bundles everything needed to manage one condition in a private
// practice: a follow-up plan (with questionnaires), lab monitor thresholds and
// patient-education material. Packs are plain JSON so new ones can be added
// without code; they validate against the same rules as hand-made plans.
export const planIdFor = (packId) => `pack_${packId}`;

export function loadPacks(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => validatePack(JSON.parse(readFileSync(join(dir, name), "utf8")), name));
}

export function validatePack(pack, origin = "") {
  const where = origin ? `（${origin}）` : "";
  check(pack && typeof pack === "object", "CARE_PACK", `专病包格式无效${where}`);
  identifier(pack.id);
  for (const key of ["version", "name", "disease", "summary"])
    check(typeof pack[key] === "string" && pack[key].trim(), "CARE_PACK", `专病包 ${pack.id} 缺少 ${key}`);
  check(pack.plan && Array.isArray(pack.plan.nodes) && pack.plan.nodes.length >= 1 && pack.plan.nodes.length <= 12, "CARE_PACK", `专病包 ${pack.id} 须包含 1–12 个随访节点`);
  for (const node of pack.plan.nodes) if (node.questionnaire) normalizeQuestionnaire(node.questionnaire);
  for (const monitor of pack.labMonitors || [])
    check(typeof monitor.item === "string" && ["gt", "lt"].includes(monitor.op) && Number.isFinite(monitor.threshold), "CARE_PACK", `专病包 ${pack.id} 的检验监测无效`);
  for (const doc of pack.education || [])
    check(typeof doc.title === "string" && doc.title.trim() && typeof doc.body === "string" && doc.body.trim(), "CARE_PACK", `专病包 ${pack.id} 的患教素材无效`);
  return pack;
}

export function createCarePackService({ packs, followups, riskRules, guidelines }) {
  const byId = new Map(packs.map((pack) => [pack.id, pack]));
  const pack = (id) => {
    identifier(id);
    const value = byId.get(id);
    check(value, "NOT_FOUND", "专病包不存在", 404);
    return value;
  };
  const installedPlan = (id) => followups().listPlans().find((plan) => plan.id === planIdFor(id)) || null;
  const educationTitles = () => {
    if (!guidelines) return new Set();
    try {
      return new Set(guidelines.list({ collection: EDUCATION_COLLECTION }).map((doc) => doc.title));
    } catch {
      return new Set();
    }
  };
  const installPlanSync = (value) =>
    followups().installPlan(planIdFor(value.id), {
      name: value.plan.name,
      disease: value.disease,
      nodes: value.plan.nodes,
      source: { kind: "care-pack", id: value.id, version: value.version },
    });

  return {
    list() {
      const titles = educationTitles();
      return packs.map((value) => {
        const plan = installedPlan(value.id);
        return {
          id: value.id,
          version: value.version,
          name: value.name,
          disease: value.disease,
          summary: value.summary,
          references: value.references || [],
          nodes: value.plan.nodes.map((node) => ({ offsetDays: node.offsetDays, title: node.title, questionnaire: node.questionnaire?.title || null })),
          questionnaires: value.plan.nodes.filter((node) => node.questionnaire).length,
          labMonitors: (value.labMonitors || []).map((monitor) => ({ item: monitor.item, op: monitor.op, threshold: monitor.threshold, unit: monitor.unit || "" })),
          education: (value.education || []).map((doc) => ({ title: doc.title, imported: titles.has(doc.title) })),
          installed: plan ? { planId: plan.id, version: plan.source?.version || "" } : null,
          upToDate: Boolean(plan && plan.source?.version === value.version),
        };
      });
    },
    get(id) {
      return pack(id);
    },
    // Install the follow-up template and import education material into the
    // 患教素材 knowledge base (skipping titles that already exist, so a
    // doctor's edits are never overwritten). Reinstall updates the template.
    async install(id) {
      const value = pack(id);
      const plan = installPlanSync(value);
      const titles = educationTitles();
      const imported = [];
      const skipped = [];
      if (guidelines)
        for (const doc of value.education || []) {
          if (titles.has(doc.title)) {
            skipped.push(doc.title);
            continue;
          }
          await guidelines.addDocument({
            title: doc.title,
            text: doc.body,
            kind: "患教",
            collection: EDUCATION_COLLECTION,
            org: value.name,
            source: "local",
            fileName: "",
          });
          imported.push(doc.title);
        }
      return { planId: plan.id, version: value.version, education: { imported, skipped } };
    },
    // Enroll a patient: the pack's plan becomes dated follow-ups and its lab
    // thresholds become monitors. Runs inside the proposal transaction.
    apply(patientId, id, startDate) {
      const value = pack(id);
      if (!installedPlan(value.id)) installPlanSync(value);
      // Enrolling the same patient in the same pack version from the same
      // start date twice returns the first enrollment instead of duplicating
      // every follow-up node.
      const requestId = `pack_${createHash("sha256").update(JSON.stringify([value.id, value.version, patientId, startDate])).digest("hex").slice(0, 40)}`;
      const jobs = followups().applyTemplate(patientId, { planId: planIdFor(value.id), startDate, requestId });
      return { pack: value.id, followups: Array.isArray(jobs) ? jobs.length : 0, ...this.addMonitors(patientId, value.id) };
    },
    // Lab thresholds only: used when the doctor applied the pack's follow-up
    // template from the follow-up page. An active monitor on the same item and
    // direction is kept as is.
    addMonitors(patientId, id) {
      identifier(patientId);
      const value = pack(id);
      const wanted = value.labMonitors || [];
      const service = riskRules();
      if (!service) return { monitors: 0, monitorsSkipped: wanted.length, monitorsUnavailable: true };
      const existing = service.listMonitors(patientId).filter((monitor) => monitor.status === "active");
      const created = [];
      for (const monitor of wanted) {
        if (existing.some((row) => row.item === monitor.item && row.op === monitor.op)) continue;
        created.push(service.createMonitor(patientId, monitor));
      }
      if (created.length) service.evaluatePatient(patientId);
      return { monitors: created.length, monitorsSkipped: wanted.length - created.length };
    },
  };
}
