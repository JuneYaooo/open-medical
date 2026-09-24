// A question shares the patient chart, but only explicit follow-ups share messages.
export function conversationRunIds(runs = [], leafId) {
  const ids = new Set();
  let run = runs.find(item => item.id === leafId);
  while (run && !ids.has(run.id)) {
    ids.add(run.id);
    run = runs.find(item => item.id === (run.conversationParentRunId || run.resumes));
  }
  return ids;
}
export function patientQuestions(session) {
  const runs = session?.runs || [];
  const grouped = new Map();
  for (const run of runs) {
    const ids = [...conversationRunIds(runs, run.id)];
    const root = ids.at(-1);
    const question = session.messages.find(m => m.role === "user" && m.runId === root)?.content;
    if (question) grouped.set(root, { id: run.id, title: question, status: run.status, mode: run.mode });
  }
  return [...grouped.values()].reverse();
}
