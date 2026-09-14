import test from "node:test";
import assert from "node:assert/strict";
import { checkSoakContinuity } from "../scripts/soak-continuity.mjs";

test("soak rejects suspension and clock jumps instead of claiming elapsed time as continuous load", () => {
  assert.equal(checkSoakContinuity(1000, 62000, 60000), 61000);
  assert.equal(checkSoakContinuity(0, 240000, 60000), 240000);
  assert.throws(() => checkSoakContinuity(0, 48 * 3600000, 60000), /interrupted/);
  assert.throws(() => checkSoakContinuity(1000, 0, 60000), /interrupted/);
  assert.equal(checkSoakContinuity(0, 3600000, 3600000), 3600000);
});
