import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import {
  rawDiffs,
  evaluateHabit,
  factualMetrics,
} from "./learning-metrics-v2.mjs";
import { canonical, renderLearningGold } from "./learning-v2-domain.mjs";

export async function materialUpload(path, name) {
  const buffer = await readFile(path);
  if (/\.png$/i.test(name)) return { name, image: buffer.toString("base64") };
  if (/\.docx$/i.test(name)) {
    const { default: mammoth } = await import("mammoth");
    return { name, text: (await mammoth.extractRawText({ buffer })).value };
  }
  if (/\.pdf$/i.test(name)) {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const require = createRequire(import.meta.url),
      base = dirname(require.resolve("pdfjs-dist/package.json"));
    const loading = getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
      cMapUrl: join(base, "cmaps/"),
      cMapPacked: true,
      standardFontDataUrl: join(base, "standard_fonts/"),
    });
    const doc = await loading.promise;
    try {
      const pages = [];
      for (let i = 1; i <= doc.numPages; i++)
        pages.push(
          (await (await doc.getPage(i)).getTextContent()).items
            .map((t) => t.str)
            .join("\n"),
        );
      return {
        name,
        text: pages.join("\n\n"),
        extraction: {
          type: "pdf_text",
          pageCount: doc.numPages,
          emptyPages: pages.flatMap((p, i) => (p.trim() ? [] : [i + 1])),
        },
      };
    } finally {
      await loading.destroy();
    }
  }
  return { name, text: buffer.toString("utf8") };
}
export function nextReviewEdit(current, final, persona) {
  const d = rawDiffs(current, final).find((d) => d.section !== "tags");
  if (d) {
    const payload = structuredClone(current),
      reasons = {};
    if (!["diagnoses", "medications", "labs", "visits"].includes(d.section)) {
      if (d.after === undefined) delete payload[d.section];
      else payload[d.section] = structuredClone(d.after);
    } else if (d.op === "delete") {
      if (d.section === "diagnoses")
        reasons[`diagnoses:${d.beforeIndex}`] =
          d.itemBefore.status === "finding" &&
          persona.rules.some(
            (r) => r.kind === "exclude" && r.names.includes(d.itemBefore.name),
          )
            ? "不该算诊断"
            : "资料里没有";
      payload[d.section].splice(d.beforeIndex, 1);
    } else if (d.op === "add") {
      payload[d.section] ??= [];
      payload[d.section].push(structuredClone(d.itemAfter));
    } else if (d.after === undefined)
      delete payload[d.section][d.beforeIndex][d.field];
    else payload[d.section][d.beforeIndex][d.field] = structuredClone(d.after);
    return { payload, reasons, edit: d };
  }
  const before = current.tags || [],
    after = final.tags || [];
  const missing = after.find((x) => !before.includes(x)),
    extra = before.find((x) => !after.includes(x));
  if (missing !== undefined || extra !== undefined) {
    const payload = structuredClone(current);
    payload.tags =
      missing !== undefined
        ? [...before, missing]
        : before.filter((_, i) => i !== before.indexOf(extra));
    return {
      payload,
      reasons: {},
      edit: {
        section: "tags",
        op: missing !== undefined ? "add" : "delete",
        value: missing ?? extra,
      },
    };
  }
  return null;
}
export async function submitReviewEdits(request, action, final, persona) {
  let current = structuredClone(action.payload),
    revision = action.reviewRevision || 0;
  const edits = [],
    reasons = Object.fromEntries(
      rawDiffs(action.payload, final)
        .filter((d) => d.op === "delete" && d.section === "diagnoses")
        .map((d) => [
          `diagnoses:${d.beforeIndex}`,
          d.itemBefore.status === "finding" &&
          persona.rules.some(
            (r) => r.kind === "exclude" && r.names.includes(d.itemBefore.name),
          )
            ? "不该算诊断"
            : "资料里没有",
        ]),
    );
  for (let i = 0; i < 1000; i++) {
    const next = nextReviewEdit(current, final, persona);
    if (!next) return { reviewRevision: revision, edits, payload: current };

    const saved = await request(
      `/api/pending-actions/${action.id}/review-draft`,
      "PATCH",
      { payload: next.payload, reasons, expectedRevision: revision },
    );
    if (saved.reviewRevision !== revision + 1)
      throw new Error("review PATCH did not advance revision by one");
    edits.push({ ...next.edit, revision: saved.reviewRevision });
    revision = saved.reviewRevision;
    current = next.payload;
  }
  throw new Error("Review edit convergence exceeded 1000 changes");
}
// A candidate earns effective credit only on evidence after it was activated.
// Stored prompt-only intentions without an observed application get no credit.
export function habitEvidence(habit, draft, gold, persona) {
  const judgment = evaluateHabit(habit, persona),
    before = draft.preHabitPayload;
  if (!before || !judgment.correct) return [];
  const changes = (draft.habitChanges || []).filter(
    (c) => c.habitId === habit.id,
  );
  if (!changes.length) return [];
  const safe = renderLearningGold(gold, persona, { traps: false });
  const evidence = changes.map((c) => {
    const wanted = safe[c.section] || [];
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    // Compare only fields this operation changed; source metadata is irrelevant.
    const changedKeys = c.after
      ? Object.keys(c.after).filter((k) => !same(c.before?.[k], c.after[k]))
      : [];
    const afterMatches = c.after
      ? wanted.some(
          (row) =>
            changedKeys.every((k) => same(row[k], c.after[k])) &&
            canonical(row.name ?? row.item ?? row.reason) ===
              canonical(c.after.name ?? c.after.item ?? c.after.reason),
        )
      : !wanted.some(
          (row) => canonical(row.name) === canonical(c.before?.name),
        );
    const beforeMatches = c.before
      ? wanted.some(
          (row) =>
            changedKeys.every((k) => same(row[k], c.before[k])) &&
            canonical(row.name ?? row.item ?? row.reason) ===
              canonical(c.before.name ?? c.before.item ?? c.before.reason),
        )
      : false;
    const isolatedBefore = { [c.section]: c.before ? [c.before] : [] },
      isolatedAfter = { [c.section]: c.after ? [c.after] : [] };
    const factsBefore = factualMetrics(isolatedBefore, gold, persona)
      .factualDisagreements.length;
    const factsAfter = factualMetrics(isolatedAfter, gold, persona)
      .factualDisagreements.length;
    return {
      habitId: habit.id,
      ruleIds: judgment.ruleIds,
      changed: true,
      correct: afterMatches && !beforeMatches && factsAfter <= factsBefore,
    };
  });
  return evidence;
}
