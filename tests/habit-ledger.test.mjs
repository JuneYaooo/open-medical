import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.mjs";
import { DoctorProfile } from "../server/medical/doctor-profile.mjs";
import { ReviewLog } from "../server/medical/review-log.mjs";
test("learned pauses at 30% with five applications; stated only flags; feedback dedupes", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const doctor = new DoctorProfile(store),
    log = new ReviewLog(store);
  const learned = doctor.addMemory({ content: "写法习惯" });
  store.db
    .prepare("UPDATE doctor_memories SET origin='learned' WHERE id=?")
    .run(learned.id);
  const stated = doctor.saveStated({ content: "以后摘要简短" });
  for (const m of [learned, stated]) {
    for (let i = 0; i < 5; i++) log.feedback(m.id, `a${i}`, "applied");
    log.feedback(m.id, "a0", "reverted");
    log.feedback(m.id, "a1", "reverted");
    log.feedback(m.id, "a1", "reverted");
    assert.equal(log.ledger(m.id).reverted, 2);
  }
  assert.equal(doctor.memoryRow(learned.id).status, "paused");
  assert.equal(doctor.memoryRow(stated.id).status, "confirmed");
  assert.equal(log.ledger(stated.id).conflict, true);
});
test("three not-applicable votes pause a learned habit without deleting history", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const doctor = new DoctorProfile(store),
    log = new ReviewLog(store);
  const m = doctor.addMemory({ content: "写法" });
  store.db
    .prepare("UPDATE doctor_memories SET origin='learned' WHERE id=?")
    .run(m.id);
  for (let i = 0; i < 3; i++) log.feedback(m.id, `a${i}`, "notApplicable");
  assert.equal(doctor.memoryRow(m.id).status, "paused");
  assert.equal(
    store.db.prepare("SELECT COUNT(*) n FROM habit_history").get().n,
    1,
  );
});
