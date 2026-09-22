import test from "node:test";
import assert from "node:assert/strict";
import { continuityFixture, verifyContinuity } from "../scripts/continuity-fixture.mjs";

test("continuity acceptance requires unpredictable values and actual full observations", () => {
  const fixture = continuityFixture();
  const summary = "CONTINUITY_ACCEPTED\n| 文件 | Units |\n|---|---|\n" +
    fixture.records.map((r) => `| ${r.path} | ${r.units} |`).join("\n") + `\n| Total | ${fixture.total} |`;
  assert.equal(fixture.prompt.includes(String(fixture.total)), false);
  assert.doesNotThrow(() => verifyContinuity(fixture, summary, fixture.records));
  assert.throws(() => verifyContinuity(fixture, summary, fixture.records.slice(1)), /Missing full source/);
  assert.throws(() => verifyContinuity(fixture, summary, fixture.records.map((r) => ({ ...r, text: r.text.slice(0, 20) }))), /Missing full source/);
  assert.throws(() => verifyContinuity(fixture, summary.replace(`| ${fixture.records[0].units} |`, "| 1 |"), fixture.records), /Wrong source Units/);
  assert.throws(() => verifyContinuity(fixture, summary.replace(`| Total | ${fixture.total}`, "| Total | 136"), fixture.records), /wrong total/);
  assert.throws(() => verifyContinuity(fixture, summary + `\n| record-1.txt | ${fixture.records[0].units} |`, fixture.records), /Wrong source Units/);
});
