import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import {
  rawDiffs,
  evaluateHabit,
  factualMetrics,
} from "./learning-metrics-v2.mjs";
import {
  canonical,
  renderLearningGold,
  mentionsHistory,
} from "./learning-v2-domain.mjs";

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
// Structured postprocessing evidence is separate from prompt-only evidence.
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

// Prompt-only habits do not appear in habitChanges. Require inclusion in the
// actual prompt context and a subsequent, applicable observation instead.
export async function promptHabitEvidence(
  habit,
  draft,
  gold,
  persona,
  calibration,
) {
  if (!(draft.personalization?.habits || []).some((h) => h.id === habit.id))
    return [];
  const judgment = evaluateHabit(habit, persona);
  if (!judgment.correct) return [];
  const evidence = [];
  for (const ruleId of judgment.ruleIds) {
    const rule = persona.rules.find((r) => r.id === ruleId);
    if (rule.kind === "omission") {
      if (!(gold.historyFacts || []).some((h) => h.kind === rule.history))
        continue;
      const observed = [
        ...(draft.tags || []),
        ...(draft.visits || []).map((v) => v.reason),
      ].some((text) => mentionsHistory(text, rule.history));
      evidence.push({
        habitId: habit.id,
        ruleIds: [ruleId],
        source: "prompt-history",
        observed,
        correct: observed,
      });
    } else if (rule.kind === "summary-order" && calibration?.usable) {
      const result = await calibration.judge(habit, persona, {
        rule,
        summary: draft.clinicalSummary?.text || "",
        gold,
      });
      evidence.push({
        habitId: habit.id,
        ruleIds: [ruleId],
        source: "calibrated-style-judge",
        calibrated: true,
        correct: result.correct,
      });
    }
  }
  return evidence;
}

export const UNDO_MODES = ["after-two-reverts", "oracle", "never"];
export function observeHabitUndo(
  habit,
  draft,
  final,
  persona,
  state,
  mode = "after-two-reverts",
) {
  if (!UNDO_MODES.includes(mode)) throw new Error(`Unknown undo mode: ${mode}`);
  const corrections = rawDiffs(draft, final);
  const reverted = (draft.habitChanges || []).some((change) => {
    if (change.habitId !== habit.id) return false;
    return corrections.some((edit) => {
      if (edit.section !== change.section) return false;
      if (!change.after)
        return (
          edit.op === "add" &&
          canonical(edit.itemAfter?.name) === canonical(change.before?.name)
        );
      if (edit.beforeIndex !== change.index) return false;
      if (edit.op === "delete") return true;
      return (
        edit.op === "modify" &&
        JSON.stringify(change.before?.[edit.field]) !==
          JSON.stringify(change.after?.[edit.field]) &&
        JSON.stringify(edit.before) ===
          JSON.stringify(change.after?.[edit.field])
      );
    });
  });
  const record = (state[habit.id] ||= { reverts: 0, observations: 0 });
  record.observations++;
  if (reverted) record.reverts++;
  const oracleWouldUndo = evaluateHabit(habit, persona).correct === false;
  const noticedWouldUndo = record.reverts >= 2;
  return {
    habitId: habit.id,
    reverted,
    reverts: record.reverts,
    oracleWouldUndo,
    noticedWouldUndo,
    undo:
      mode === "oracle"
        ? oracleWouldUndo
        : mode === "after-two-reverts" && noticedWouldUndo,
  };
}

// The product stores most explicit preferences as natural-language memories.
// Judge intent separately from the downstream summary observation used by G6.
export async function statedHabitJudgments(
  memories,
  stated,
  persona,
  calibration,
) {
  const rule = persona.rules.find((r) => r.id === stated.ruleId);
  if (!rule?.learnableByProduct || !calibration?.usable) return [];
  const judgments = [];
  for (const habit of memories) {
    if (habit.rule) continue;
    const result = await calibration.judge(habit, persona, {
      mode: "stated-intent",
      rule,
    });
    judgments.push({
      habitId: habit.id,
      ruleId: rule.id,
      calibrated: true,
      correct: result.correct,
    });
  }
  return judgments;
}
