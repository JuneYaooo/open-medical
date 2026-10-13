import { createServer } from "../server/agent.mjs";
import { TERM_GROUPS } from "../shared/review-diff.mjs";
// This probe replays one recorded real-model draft through the normal proposal /
// confirmation transaction. It measures retirement, not model accuracy.
export async function selfHealingProbe(recordedDraft, persona) {
  const diagnosis = recordedDraft?.diagnoses?.find((d) =>
    TERM_GROUPS.some((g) => g.includes(d.name)),
  );
  if (!diagnosis)
    return { status: "unverified", reason: "没有适用术语的真实草稿可重放" };
  const terms = TERM_GROUPS.find((g) => g.includes(diagnosis.name)),
    good = terms[persona.termDirection === "full" ? 1 : 0],
    bad = terms[persona.termDirection === "full" ? 0 : 1];
  const server = createServer({ database: ":memory:", apiKey: "" });
  try {
    const memory = server.doctor.addMemory({
      content: "故意注入的错误写法",
      status: "confirmed",
      kind: "consolidated",
    });
    const rule = {
      type: "term_replace",
      section: "diagnoses",
      field: "name",
      from: good,
      to: bad,
    };
    server.store.db
      .prepare("UPDATE doctor_memories SET origin='learned',rule=? WHERE id=?")
      .run(JSON.stringify(rule), memory.id);
    for (let i = 1; i <= 5; i++) {
      const baseline = {
        name: `合成退场探针${i}`,
        diagnoses: [{ ...diagnosis, name: good }],
      };
      const action = server.pending.propose({
        type: "patient-create",
        summary: "退场探针",
        payload: baseline,
        prepare: (payload) => {
          const result = server.pending.habitLearner.postprocess(payload, [
            memory.id,
          ]);
          return {
            ...result.payload,
            preHabitPayload: payload,
            habitChanges: result.changes,
            personalization: { habits: [{ id: memory.id }] },
          };
        },
      });
      server.pending.confirm(action.id, { payload: baseline });
      if (server.doctor.memoryRow(memory.id).status === "paused")
        return {
          status: "passed",
          patients: i,
          method: "recorded-model-draft-replay",
          ledger: server.pending.reviewLog.ledger(memory.id),
        };
    }
    return {
      status: "failed",
      patients: 5,
      method: "recorded-model-draft-replay",
    };
  } finally {
    await server.shutdown();
  }
}
