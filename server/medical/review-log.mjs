import { randomUUID } from "node:crypto";
import {
  reviewDiff,
  reviewCounts,
  paragraphDiff,
  normalizedEditDistance,
} from "../../shared/review-diff.mjs";
import { deidentifyExample } from "./deidentify-example.mjs";
import { classifyDiff } from "./habit-learner.mjs";
import { sqliteTransaction } from "../sqlite-transaction.mjs";
import { check } from "../errors.mjs";
export class ReviewLog {
  constructor(store) {
    this.store = store;
    this.db = store.db;
  }
  record({
    kind = "intake",
    action,
    patientId,
    ai = action?.payload || {},
    final = ai,
    reviewMs = 0,
    reasons = {},
    superseded = false,
    materialText = "",
  }) {
    return sqliteTransaction(this.db, () => {
      check(
        Number.isFinite(reviewMs) && reviewMs >= 0 && reviewMs <= 604800000,
        "INVALID_INPUT",
        "核对用时无效",
      );
      const existing =
        action?.id &&
        this.db
          .prepare("SELECT id FROM review_sessions WHERE action_id=?")
          .get(action.id);
      if (existing) return { id: existing.id, alreadyRecorded: true };
      const raw =
          kind === "artifact"
            ? paragraphDiff(ai.text, final.text)
            : reviewDiff(ai, final),
        diffs = kind === "artifact" ? raw : reviewDiff(ai, final, { reasons }),
        counts = reviewCounts(
          kind === "artifact"
            ? { tags: ai.text.split(/\n\s*\n/).filter(Boolean) }
            : ai,
          raw,
        );
      const id = randomUUID(),
        now = new Date().toISOString();
      const patient =
        patientId &&
        this.db.prepare("SELECT data FROM patients WHERE id=?").get(patientId);
      const identities = [ai, final, patient ? JSON.parse(patient.data) : {}];
      const redact = (value) =>
        deidentifyExample(value, identities, { relativeDates: false });
      this.db
        .prepare(
          `INSERT INTO review_sessions(id,kind,action_id,patient_id,model,context,ai_items,modified,added,deleted,review_ms,ai_snapshot,final_snapshot,superseded,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          kind,
          action?.id || null,
          patientId || action?.payload?.sourceSessionId || action?.id || null,
          ai.learningContext?.model || "",
          JSON.stringify(ai.learningContext || {}),
          counts.aiItems,
          counts.modified,
          counts.added,
          counts.deleted,
          Math.round(reviewMs),
          JSON.stringify(redact(ai)),
          JSON.stringify(redact(final)),
          Number(superseded),
          now,
        );
      for (const diff of diffs) {
        const classification =
          kind === "artifact"
            ? { category: "style", learnable: false, rule: null }
            : classifyDiff(diff, { materialText });
        const data = redact({ ...diff, ...classification });
        if (diff.section === "identity") {
          data.before = "已隐藏";
          data.after = "已隐藏";
        }
        const change = (ai.habitChanges || []).find(
          (c) =>
            c.section === diff.section &&
            ((diff.op === "modify" &&
              diff.beforeIndex === (c.afterIndex ?? c.index) &&
              c.before?.[diff.field] === diff.after &&
              c.after?.[diff.field] === diff.before) ||
              (c.after === null &&
                diff.op === "add" &&
                JSON.stringify(diff.after) === JSON.stringify(c.before))),
        );
        this.db
          .prepare(
            `INSERT INTO review_diffs(session_id,section,op,field,before,after,reason,category,learnable,superseded,habit_id,data,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            diff.section,
            diff.op,
            diff.field,
            JSON.stringify(data.before),
            JSON.stringify(data.after),
            diff.reason,
            classification.category,
            Number(kind === "intake" && classification.learnable),
            Number(superseded),
            change?.habitId || null,
            JSON.stringify(data),
            now,
          );
        if (change && !superseded)
          this.feedback(change.habitId, action.id, "reverted");
      }
      return { id, ...counts };
    });
  }
  feedback(habitId, actionId, kind) {
    check(
      ["applied", "reverted", "notApplicable"].includes(kind),
      "INVALID_INPUT",
      "反馈类型无效",
    );
    this.db
      .prepare(
        "INSERT OR IGNORE INTO habit_feedback(habit_id,action_id,kind,created_at) VALUES (?,?,?,?)",
      )
      .run(habitId, actionId, kind, new Date().toISOString());
    const ledger = this.ledger(habitId);
    if (
      (ledger.applied >= 5 && ledger.reverted / ledger.applied >= 0.3) ||
      ledger.notApplicable >= 3
    ) {
      const memory = this.db
        .prepare("SELECT * FROM doctor_memories WHERE id=?")
        .get(habitId);
      if (memory?.origin === "learned" && memory.status === "confirmed") {
        this.db
          .prepare(
            "INSERT INTO habit_history(habit_id,decision,snapshot,created_at) VALUES (?,?,?,?)",
          )
          .run(
            habitId,
            "auto-paused",
            JSON.stringify(memory),
            new Date().toISOString(),
          );
        this.db
          .prepare(
            "UPDATE doctor_memories SET status='paused',updated_at=? WHERE id=?",
          )
          .run(new Date().toISOString(), habitId);
        this.db
          .prepare(
            "INSERT INTO learning_events(type,subject,data,created_at) VALUES (?,?,?,?)",
          )
          .run(
            "habit-paused",
            String(habitId),
            JSON.stringify({
              message: `暂停了习惯 H${habitId}：最近常被你改回`,
            }),
            new Date().toISOString(),
          );
      }
    }
    return {
      ...ledger,
      paused:
        this.db
          .prepare("SELECT status FROM doctor_memories WHERE id=?")
          .get(habitId)?.status === "paused",
    };
  }
  ledger(id) {
    const counts = Object.fromEntries(
      this.db
        .prepare(
          "SELECT kind,COUNT(*) n FROM habit_feedback WHERE habit_id=? GROUP BY kind",
        )
        .all(id)
        .map((r) => [r.kind, r.n]),
    );
    const memory = this.db
      .prepare("SELECT rule,created_at FROM doctor_memories WHERE id=?")
      .get(id);
    const rule = memory?.rule ? JSON.parse(memory.rule) : null;
    let rates = null;
    if (rule?.section && memory) {
      const activated = Date.parse(memory.created_at),
        day = 86400000;
      const rate = (lo, hi) => {
        const sessions = this.db
          .prepare(
            "SELECT id,ai_snapshot FROM review_sessions WHERE kind='intake' AND superseded=0 AND created_at>=? AND created_at<?",
          )
          .all(new Date(lo).toISOString(), new Date(hi).toISOString());
        const items = sessions.reduce(
          (n, r) => n + (JSON.parse(r.ai_snapshot)[rule.section]?.length || 0),
          0,
        );
        const edits = sessions.reduce(
          (n, r) =>
            n +
            this.db
              .prepare(
                "SELECT COUNT(*) n FROM review_diffs WHERE session_id=? AND section=? AND (? IS NULL OR field=?)",
              )
              .get(r.id, rule.section, rule.field || null, rule.field || null)
              .n,
          0,
        );
        return items ? edits / items : null;
      };
      rates = {
        before: rate(activated - 30 * day, activated),
        after: rate(activated, activated + 30 * day),
      };
    }
    return {
      applied: 0,
      reverted: 0,
      notApplicable: 0,
      ...counts,
      rates,
      conflict:
        (counts.applied >= 5 && counts.reverted / counts.applied >= 0.3) ||
        counts.notApplicable >= 3,
    };
  }
  stats(range = "90d") {
    check(
      /^\d{1,4}d$/.test(range),
      "INVALID_INPUT",
      "统计范围须为天数，例如 90d",
    );
    const since = new Date(
      Date.now() - Number(range.slice(0, -1)) * 86400000,
    ).toISOString();
    const sessions = this.db
      .prepare(
        "SELECT id,ai_items,modified,added,deleted,review_ms,created_at,context,ai_snapshot,final_snapshot FROM review_sessions WHERE kind='intake' AND superseded=0 AND created_at>=? ORDER BY created_at,id",
      )
      .all(since);
    const details = this.db
      .prepare(
        `SELECT d.*,s.patient_id FROM review_diffs d JOIN review_sessions s ON s.id=d.session_id WHERE s.kind='intake' AND d.superseded=0 AND s.created_at>=? ORDER BY d.id DESC`,
      )
      .all(since);
    const weekly = new Map(),
      sections = new Map();
    for (const s of sessions) {
      const day = new Date(s.created_at);
      day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
      const week = day.toISOString().slice(0, 10),
        context = JSON.parse(s.context || "{}"),
        group = context.holdout
          ? "holdout"
          : (context.enabled ?? context.chars > 0)
            ? "learning"
            : "baseline",
        key = `${week}:${group}`;
      const row = weekly.get(key) || {
        week,
        group,
        count: 0,
        edits: 0,
        items: 0,
        ser: 0,
        fer: 0,
        fastZero: 0,
        summaryDistance: 0,
        reviewDurations: [],
        sections: {},
      };
      row.summaryDistance += normalizedEditDistance(
        JSON.parse(s.ai_snapshot).clinicalSummary?.text || "",
        JSON.parse(s.final_snapshot).clinicalSummary?.text || "",
      );
      row.reviewDurations.push(s.review_ms);
      const snapshot = JSON.parse(s.ai_snapshot);
      for (const section of [
        "diagnoses",
        "medications",
        "labs",
        "visits",
        "clinicalSummary",
        "identity",
        "allergy",
        "allergies",
        "groups",
        "tags",
      ]) {
        const diffs = details.filter(
          (d) => d.session_id === s.id && d.section === section,
        );
        const aiItems =
          section === "clinicalSummary"
            ? Number(Boolean(snapshot.clinicalSummary?.text))
            : section === "identity"
              ? [
                  "name",
                  "gender",
                  "birthYear",
                  "phone",
                  "patientNumber",
                ].filter((k) => snapshot[k] != null && snapshot[k] !== "")
                  .length
              : section === "allergy"
                ? Number(Boolean(snapshot.allergyStatus))
                : snapshot[section]?.length || 0;
        const counts = reviewCounts(
          snapshot,
          diffs.map((d) => JSON.parse(d.data)),
        );
        const part = row.sections[section] || { items: 0, edits: 0 };
        part.items += aiItems;
        part.edits += counts.total;
        part.rate = part.items ? part.edits / part.items : null;
        row.sections[section] = part;
      }
      row.count++;
      row.edits += s.modified + s.added + s.deleted;
      row.items += s.ai_items;
      row.fastZero += Number(
        s.review_ms < 20000 && s.modified + s.added + s.deleted === 0,
      );
      row.ser += details.filter(
        (d) =>
          d.session_id === s.id &&
          ["term", "unit", "format", "spurious", "omission"].includes(
            d.category,
          ),
      ).length;
      row.fer += details.filter(
        (d) => d.session_id === s.id && d.category === "clinical",
      ).length;
      weekly.set(key, row);
    }
    for (const d of details) {
      const key = `${d.section}.${d.field}`;
      sections.set(key, (sections.get(key) || 0) + 1);
    }
    const durations = sessions.map((s) => s.review_ms).sort((a, b) => a - b);
    const average = (rows) =>
      rows.length
        ? rows.reduce((n, s) => n + s.modified + s.added + s.deleted, 0) /
          rows.length
        : null;
    return {
      events: this.db
        .prepare(
          "SELECT type,COUNT(*) count FROM learning_events WHERE created_at>=? GROUP BY type",
        )
        .all(since),
      habitsSummary: {
        activated: this.db
          .prepare(
            "SELECT COUNT(*) n FROM habit_history WHERE decision='activated' AND created_at>=?",
          )
          .get(since).n,
        undone: this.db
          .prepare(
            "SELECT COUNT(DISTINCT habit_id) n FROM habit_history WHERE decision='undo' AND created_at>=?",
          )
          .get(since).n,
        feedback: Object.fromEntries(
          this.db
            .prepare(
              "SELECT kind,COUNT(*) n FROM habit_feedback WHERE created_at>=? GROUP BY kind",
            )
            .all(since)
            .map((r) => [r.kind, r.n]),
        ),
      },
      count: sessions.length,
      remaining: Math.max(0, 5 - sessions.length),
      recentAverage: average(sessions.slice(-30)),
      previousAverage: average(sessions.slice(-60, -30)),
      medianReviewMs: durations.length
        ? (durations[Math.floor((durations.length - 1) / 2)] +
            durations[Math.floor(durations.length / 2)]) /
          2
        : null,
      series: [...weekly.values()].map(({ reviewDurations, ...r }) => ({
        ...r,
        summaryDistance: r.summaryDistance / r.count,
        medianReviewMs: reviewDurations.sort((a, b) => a - b)[
          Math.floor(reviewDurations.length / 2)
        ],
        rate: r.items ? r.edits / r.items : null,
        ser: r.items ? r.ser / r.items : null,
        fer: r.items ? r.fer / r.items : null,
      })),
      sections: [...sections]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count),
    };
  }
  details(section) {
    return this.db
      .prepare(
        `SELECT d.*,s.patient_id FROM review_diffs d JOIN review_sessions s ON s.id=d.session_id WHERE d.section=? AND d.superseded=0 ORDER BY d.id DESC LIMIT 10`,
      )
      .all(section)
      .map((r) => ({
        id: r.id,
        section: r.section,
        op: r.op,
        field: r.field,
        before: JSON.parse(r.before),
        after: JSON.parse(r.after),
        patientId: r.patient_id,
        patientLabel: "某患者",
        category: r.category,
      }));
  }
  clear() {
    return sqliteTransaction(this.db, () => {
      this.db.exec(
        "DELETE FROM review_diffs; DELETE FROM review_sessions; DELETE FROM habit_feedback; DELETE FROM habit_patterns; DELETE FROM habit_history; DELETE FROM learning_events; DELETE FROM doctor_memories WHERE kind='consolidated' OR json_extract(source,'$.type')='stated';",
      );
      // Pending drafts retain clinical content but lose references to erased learning data.
      for (const row of this.db
        .prepare(
          "SELECT id,payload FROM pending_actions WHERE type='patient-create'",
        )
        .all()) {
        const payload = JSON.parse(row.payload);
        for (const key of [
          "learningContext",
          "personalization",
          "habitChanges",
          "preHabitPayload",
        ])
          delete payload[key];
        this.db
          .prepare("UPDATE pending_actions SET payload=? WHERE id=?")
          .run(JSON.stringify(payload), row.id);
      }
      return { ok: true };
    });
  }
}
