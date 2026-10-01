import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { isCalendarDate } from "../shared/calendar-date.mjs";

test("calendar dates and consent checks use the local day around midnight", () => {
  const script = `
    import { localCalendarDate } from './shared/calendar-date.mjs';
    import { knowledgeMetadata } from './server/medical/knowledge-metadata.mjs';
    import { TrialCandidates } from './server/medical/trial-candidates.mjs';
    const instant = Date.parse('2026-10-01T17:00:00Z');
    const today = localCalendarDate(instant);
    const service = Object.create(TrialCandidates.prototype);
    service.now = () => instant;
    service.trials = { get() {} }; service.patients = { row: id => ({id}) };
    service.enrollment = () => ({consentDate:null,revision:0});
    const result = service.normalizeEnrollment('trial', 'patient', {stage:'consented',consentDate:today});
    let invalid = false;
    try {service.normalizeEnrollment('trial','patient',{stage:'consented',consentDate:'2026-02-31'});} catch {invalid=true;}
    console.log(JSON.stringify({today,accepted:result.consentDate,invalid,due:knowledgeMetadata({reviewDueDate:'2026-10-01'},instant).reviewDue}));
  `;
  for (const [tz, expected, due] of [["Asia/Shanghai", "2026-10-02", true], ["America/Los_Angeles", "2026-10-01", false]]) {
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), env: { ...process.env, TZ: tz }, encoding: "utf8" }));
    assert.deepEqual(result, { today: expected, accepted: expected, invalid: true, due });
  }
  assert.equal(isCalendarDate("2024-02-29"), true);
  assert.equal(isCalendarDate("2026-02-29"), false);
});
