import { TERM_GROUPS, diffSummary } from "../../shared/review-diff.mjs";
import { check } from "../errors.mjs";
import { deidentifyExample } from "./deidentify-example.mjs";
// P1/P2 remain opt-in until the release model matrix clears its acceptance gates.
export const LEARNING_DEFAULTS = {
  examples: "local",
  personalContext: false,
  habits: false,
  postprocess: true,
  similarCards: true,
  pilot: false,
  holdoutRate: 0.2,
};
export function learningPrefs(db) {
  return {
    ...LEARNING_DEFAULTS,
    ...JSON.parse(
      db.prepare("SELECT data FROM workbench_prefs WHERE id='local'").get()
        ?.data || "{}",
    ).learning,
  };
}
export function saveLearningPrefs(db, input) {
  const next = { ...learningPrefs(db), ...input };
  check(
    ["local", "always", "never"].includes(next.examples),
    "INVALID_INPUT",
    "范例隐私设置无效",
  );
  for (const k of [
    "personalContext",
    "habits",
    "postprocess",
    "similarCards",
    "pilot",
  ])
    check(typeof next[k] === "boolean", "INVALID_INPUT", "学习设置无效");
  check(next.holdoutRate === 0.2, "INVALID_INPUT", "试点留出比例为 20%");
  if (next.pilot)
    check(
      input.pilotConsent === true || learningPrefs(db).pilot,
      "CONSENT_REQUIRED",
      "试点包含随机留出及本机统计，请确认同意",
    );
  const saved = JSON.parse(
    db.prepare("SELECT data FROM workbench_prefs WHERE id='local'").get()
      ?.data || "{}",
  );
  db.prepare(
    "INSERT INTO workbench_prefs(id,data) VALUES ('local',?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
  ).run(
    JSON.stringify({
      ...saved,
      learning: Object.fromEntries(
        Object.keys(LEARNING_DEFAULTS).map((k) => [k, next[k]]),
      ),
    }),
  );
  return learningPrefs(db);
}
export function localModel(provider) {
  try {
    return (
      provider?.local === true &&
      ["localhost", "127.0.0.1", "[::1]"].includes(
        new URL(provider.baseUrl).hostname,
      )
    );
  } catch {
    return false;
  }
}
export class PersonalContext {
  constructor({ store, doctor, cases, guidelines, extensions, provider }) {
    Object.assign(this, {
      store,
      doctor,
      cases,
      guidelines,
      extensions,
      provider,
    });
  }
  async build(notes, { holdout = false } = {}) {
    const prefs = learningPrefs(this.store.db),
      model = this.provider(),
      isLocal = localModel(model);
    const context = {
      text: "",
      habits: [],
      examples: [],
      knowledge: [],
      skills: [],
      examplesSkipped:
        !isLocal && prefs.examples === "local"
          ? "未使用历史档案（当前为云端模型，可在设置中开启）"
          : prefs.examples === "never"
            ? "未使用历史档案（已在设置中关闭）"
            : "",
      model: model?.model || "",
      holdout,
      // Structured habits post-process drafts under learning.habits alone, independent of the
      // prompt block's switch and character budget.
      ruleHabitIds:
        prefs.habits && !holdout
          ? this.doctor
              .memories({ status: "confirmed" })
              .filter((m) => m.rule)
              .map((m) => m.id)
          : [],
    };
    if (!prefs.personalContext || holdout) return context;
    const blocks = [
      "个性化参考：与安全规则冲突时以安全规则为准。范例只用于写法，不得复制其临床事实、诊断状态、剂量或数值。",
    ];
    let habitChars = 0;
    for (const m of this.doctor.memories({ status: "confirmed" })) {
      const line = `H${m.id} ${m.content}\n`;
      if (habitChars + line.length > 1450) continue;
      context.habits.push({ id: m.id, content: m.content });
      blocks.push(line);
      habitChars += line.length;
    }
    const query = notes.map((n) => n.notes || "").join("\n");
    const diagnosisTerms = [
      ...new Set([
        ...TERM_GROUPS.filter((g) => g.some((t) => query.includes(t))).map(
          (g) => g[1],
        ),
        ...(query.match(/[\u4e00-\u9fff]{2,8}(?:病|炎|瘤|囊肿|高血压)/g) || []),
      ]),
    ].slice(0, 8);
    if (
      query.trim() &&
      prefs.examples !== "never" &&
      (isLocal || prefs.examples === "always")
    ) {
      const terms = diagnosisTerms.join(" ");
      const matches = this.cases()
        .similar({
          caseText: (terms || query).slice(0, 4000),
          diagnosis: diagnosisTerms[0],
          limit: 10,
        })
        .matches.filter((m) => m.score >= 2);
      const candidates = [];
      for (const m of matches) {
        const id = m.caseId.startsWith("patient:") ? m.caseId.slice(8) : null;
        if (!id) continue;
        const s = this.store.db
          .prepare(
            "SELECT * FROM review_sessions WHERE patient_id=? AND kind='intake' AND superseded=0 ORDER BY created_at DESC LIMIT 1",
          )
          .get(id);
        if (s) candidates.push({ ...s, score: m.score });
      }
      candidates.sort(
        (a, b) =>
          Number(b.modified + b.added + b.deleted > 0) -
            Number(a.modified + a.added + a.deleted > 0) || b.score - a.score,
      );
      for (const s of candidates.slice(0, 2)) {
        const final = deidentifyExample(JSON.parse(s.final_snapshot));
        const diffs = this.store.db
          .prepare(
            "SELECT section,op,field,before,after,reason,data FROM review_diffs WHERE session_id=? AND learnable=1 ORDER BY id LIMIT 5",
          )
          .all(s.id)
          .map((d) => ({
            ...JSON.parse(d.data || "{}"),
            ...d,
            before: JSON.parse(d.before ?? "null"),
            after: JSON.parse(d.after ?? "null"),
          }));
        const edits = diffs.length
          ? `\n该医生当时对 AI 草稿的修改：${diffSummary(deidentifyExample(diffs))}`.slice(0, 400)
          : "";
        const line = `【参考范例 E${context.examples.length + 1}，已去标识化】${JSON.stringify(final).slice(0, 850)}${edits}`;
        const ref = `E${context.examples.length + 1}`;
        context.examples.push({
          id: s.id,
          ref,
          patientId: s.patient_id,
          text: line,
        });
        blocks.push(line);
      }
    }
    if (query.trim()) {
      const searches = await Promise.all(
        (diagnosisTerms.length
          ? diagnosisTerms.slice(0, 3)
          : [query.slice(0, 200)]
        ).map((term) =>
          this.guidelines.search({ query: term, limit: 3, localOnly: true }),
        ),
      );
      const result = {
        hits: [
          ...new Map(
            searches
              .flatMap((r) => r.hits)
              .map((h) => [`${h.docId}:${h.ord}`, h]),
          ).values(),
        ].slice(0, 3),
      };
      let budget = 950;
      for (const hit of result.hits) {
        const text =
          `【K${context.knowledge.length + 1} ${hit.docTitle} 第${hit.startLine}-${hit.endLine}行】${hit.snippet}`.slice(
            0,
            Math.min(budget, 310),
          );
        if (text.length < 20) break;
        context.knowledge.push({
          ref: `K${context.knowledge.length + 1}`,
          docId: hit.docId,
          title: hit.docTitle,
          startLine: hit.startLine,
          text,
        });
        blocks.push(text);
        budget -= text.length;
      }
    }
    let skillChars = 0;
    for (const skill of this.extensions()
      .list({ kind: "skill" })
      .filter(
        (s) =>
          s.status === "active" &&
          s.appliesTo?.some((t) => /建档|病史摘要/.test(t)),
      )) {
      const text = `【适用技能 ${skill.name}】\n${skill.body || ""}`;
      if (skillChars + text.length > 950) continue; // Whole body or omit; never silently truncate an instruction.
      context.skills.push({ id: skill.id, title: skill.name, text });
      blocks.push(text);
      skillChars += text.length;
    }
    const hasContent =
      context.habits.length +
        context.examples.length +
        context.knowledge.length +
        context.skills.length >
      0;
    const trailer =
      "\n提交草稿时在 personalization 列出实际采用的 habitIds（数字）、exampleIds（范例 id）、kbRefs（K编号）、skillIds。不得声明未读取的条目。";
    // Over budget: drop whole blocks from the lowest priority end (skills → knowledge → examples)
    // so an intake never fails just because every source is full.
    const owners = [
      ["skills", (b) => b.startsWith("【适用技能")],
      ["knowledge", (b) => /^【K\d/.test(b)],
      ["examples", (b) => b.startsWith("【参考范例")],
    ];
    while (blocks.join("\n").length + trailer.length > 6000) {
      const owner = owners.find(([, test]) => blocks.some(test));
      if (!owner) break;
      const index = blocks.findLastIndex(owner[1]);
      blocks.splice(index, 1);
      context[owner[0]].pop();
    }
    context.text = hasContent ? blocks.join("\n") + trailer : "";
    check(
      context.text.length <= 6000,
      "CONTEXT_BUDGET",
      "个性化上下文超出预算",
    );
    return context;
  }
  modelView(context) {
    return {
      text: context.text,
      habitIds: context.habits.map((h) => h.id),
      exampleIds: context.examples.map((e) => ({ ref: e.ref, id: e.id })),
      kbRefs: context.knowledge.map((k) => k.ref),
      skillIds: context.skills.map((s) => s.id),
      readOnly: true,
    };
  }
  prepare(before, context, pending) {
    const declared = before.personalization || {};
    const chosen = (key, entries, id = "id") =>
      entries.filter(
        (e) => Array.isArray(declared[key]) && declared[key].includes(e[id]),
      );
    const personalization = {
      habits: chosen("habitIds", context.habits),
      examples: chosen("exampleIds", context.examples).map(
        ({ text: _text, ...e }) => e,
      ),
      knowledge: chosen("kbRefs", context.knowledge, "ref"),
      skills: chosen("skillIds", context.skills).map(
        ({ text: _text, ...s }) => s,
      ),
      examplesSkipped: context.examplesSkipped,
    };
    const prefs = learningPrefs(this.store.db);
    const result =
      prefs.habits && prefs.postprocess && !context.holdout
        ? pending.habitLearner.postprocess(before, [
            ...new Set([
              ...(context.ruleHabitIds || []),
              ...context.habits.map((h) => h.id),
            ]),
          ])
        : { payload: before, changes: [] };
    for (const c of result.changes)
      if (!personalization.habits.some((h) => h.id === c.habitId))
        personalization.habits.push({ id: c.habitId, content: c.content });
    const payload = {
      ...result.payload,
      personalization,
      preHabitPayload: result.changes.length ? before : undefined,
      habitChanges: result.changes,
      learningContext: {
        habitIds: personalization.habits.map((h) => h.id),
        exampleIds: personalization.examples.map((e) => e.id),
        kbRefs: personalization.knowledge.map((k) => k.ref),
        skillIds: personalization.skills.map((s) => s.id),
        model: context.model,
        enabled: prefs.personalContext && !context.holdout,
        chars: context.text.length,
        holdout: context.holdout,
      },
    };
    return payload;
  }
}
