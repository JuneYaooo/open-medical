import test from "node:test";
import assert from "node:assert/strict";
import {
  ResearchService,
  welchTTest,
  mannWhitney,
  chiSquare,
  fisherExact2x2,
  normalInv,
  normalCdf,
  parseCsv,
} from "../server/medical/research.mjs";
import { fixture } from "./helpers.mjs";

const CSV = [
  "group,age,outcome,crp",
  "treat,52,1,12.4",
  "treat,61,0,8.1",
  "treat,58,1,9.9",
  "treat,49,0,7.2",
  "treat,66,1,14.8",
  "control,54,0,15.2",
  "control,63,1,18.7",
  "control,47,0,16.1",
  "control,70,1,22.4",
  "control,59,0,13.9",
].join("\n");

const sources = () => [{ id: "file-1", name: "cohort.csv", text: CSV, hash: "x" }];

test("statistical primitives match reference values", () => {
  assert.equal(normalInv(0.975).toFixed(5), "1.95996");
  assert.equal(normalCdf(1.95996).toFixed(4), "0.9750");
  // Classic tea-tasting two-sided Fisher exact.
  assert.equal(fisherExact2x2([[3, 1], [1, 3]]).p.toFixed(4), "0.4857");
  assert.equal(fisherExact2x2([[10, 2], [3, 9]]).p.toFixed(5), "0.01228");
  assert.equal(chiSquare([[315, 101], [108, 32]]).p.toFixed(3), "0.733");
  // Clean separation must give a tiny p-value.
  const welch = welchTTest([[27.5, 28.1, 26.9, 27.3], [30.2, 29.5, 31.1, 30.8]]);
  assert.ok(welch.p < 0.01);
  assert.ok(welch.df > 4 && welch.df < 7);
  const mw = mannWhitney([[1, 2, 3, 4, 5, 6, 7, 8], [9, 10, 11, 12, 13, 14, 15, 16]]);
  assert.ok(mw.p < 0.001);
  assert.throws(() => fisherExact2x2([[1, 2], [3]]), /2×2/);
  assert.throws(() => chiSquare([[5]]), /2×2/);
});

test("parseCsv handles quoted fields and rejects empty tables", () => {
  const { header, records } = parseCsv('name,note\n"张,三","说""你好"""\n李四,plain');
  assert.deepEqual(header, ["name", "note"]);
  assert.equal(records[0].name, "张,三");
  assert.equal(records[0].note, '说"你好"');
  assert.throws(() => parseCsv("only-header\n"), /表头和至少一行/);
});

test("research profile: numeric and categorical summaries", () => {
  const research = new ResearchService();
  const result = research.profile({ sources: sources(), sourceId: "file-1" });
  assert.equal(result.rows, 10);
  assert.equal(result.columns.group.type, "categorical");
  assert.equal(result.columns.group.levels[0].level, "treat");
  assert.equal(result.columns.group.levels[0].count, 5);
  assert.equal(result.columns.crp.type, "numeric");
  assert.ok(result.columns.crp.mean > 13 && result.columns.crp.mean < 14);
  assert.ok(Math.abs(result.columns.crp.median - 14.35) < 1e-9);
  assert.throws(
    () => research.profile({ sources: sources(), sourceId: "missing" }),
    (err) => err.code === "NOT_FOUND",
  );
});

test("research test: auto selects chi-square for binary, welch for numeric", () => {
  const research = new ResearchService();
  const binary = research.test({ sources: sources(), sourceId: "file-1", outcome: "outcome", group: "group" });
  assert.equal(binary.method, "chi-square");
  assert.ok(binary.p > 0 && binary.p <= 1);
  const numeric = research.test({ sources: sources(), sourceId: "file-1", outcome: "crp", group: "group" });
  assert.equal(numeric.method, "welch-t");
  assert.ok(numeric.p > 0 && numeric.p <= 1);
  const fisher = research.test({ sources: sources(), sourceId: "file-1", outcome: "outcome", group: "group", method: "fisher" });
  assert.equal(fisher.method, "fisher-exact");
  assert.throws(
    () => research.test({ sources: sources(), sourceId: "file-1", outcome: "crp", group: "nope" }),
    /分组列不存在/,
  );
  // Three-level group is rejected (two-group comparisons only).
  const three = CSV + "\ntreat,44,0,6.4\ncontrol,52,1,9.1\nother,55,0,7.7";
  assert.throws(
    () =>
      research.test({
        sources: [{ id: "f", name: "x", text: three, hash: "x" }],
        sourceId: "f",
        outcome: "crp",
        group: "group",
      }),
    /恰好有 2 个水平/,
  );
});

test("research sample size formulas", () => {
  const research = new ResearchService();
  const means = research.sampleSize({ design: "means", delta: 5, sd: 10, alpha: 0.05, power: 0.9 });
  // Two-sample formula: n = 2*(z_{a/2}+z_b)^2*sd^2/delta^2 = 84.06 -> 85.
  assert.equal(means.n1, 85);
  const proportions = research.sampleSize({ design: "proportions", p1: 0.2, p2: 0.1, alpha: 0.05, power: 0.8 });
  // Fleiss-type two-proportion formula lands near 200 per group.
  assert.ok(proportions.n1 >= 190 && proportions.n1 <= 210, `n1=${proportions.n1}`);
  assert.throws(() => research.sampleSize({ design: "means", delta: 5, sd: 0 }), /sd>0/);
});

test("research deidentify produces stable pseudonyms without original values", () => {
  const research = new ResearchService();
  const result = research.deidentify({
    sources: sources(),
    sourceId: "file-1",
    columns: ["group"],
  });
  // original values replaced by deterministic pseudonyms
  assert.ok(!result.csv.split("\n")[1].startsWith("treat,"));
  assert.ok(result.csv.includes("GROU"));
  assert.equal(result.rows, 10);
  const again = new ResearchService().deidentify({
    sources: sources(),
    sourceId: "file-1",
    columns: ["group"],
  });
  assert.equal(again.csv, result.csv); // deterministic
  assert.throws(
    () => research.deidentify({ sources: sources(), sourceId: "file-1", columns: ["nope"] }),
    /列不存在/,
  );
});

test("research agent tools registered and research REST endpoints work", async (t) => {
  const f = await fixture(t);
  const boot = (await f.json("/api/bootstrap")).data;
  for (const tool of ["cohort_profile", "stats_test", "sample_size", "deidentify_csv"])
    assert.ok(boot.tools.includes(tool), tool);

  const session = await f.session();
  await f.json(`/api/sessions/${session.id}/files`, "POST", {
    name: "cohort.csv",
    text: CSV,
  });
  const profile = await f.json("/api/research/profile", "POST", {
    sessionId: session.id,
    sourceId: (await f.json(`/api/sessions/${session.id}`)).data.files[0].id,
    columns: ["age", "group"],
  });
  assert.equal(profile.status, 200);
  assert.equal(profile.data.columns.age.type, "numeric");

  const test = await f.json("/api/research/test", "POST", {
    sessionId: session.id,
    sourceId: profile.data.sourceId,
    outcome: "crp",
    group: "group",
    method: "mann-whitney",
  });
  assert.equal(test.status, 200);
  assert.equal(test.data.method, "mann-whitney");

  const sample = await f.json("/api/research/sample-size", "POST", {
    design: "means",
    delta: 5,
    sd: 10,
  });
  assert.equal(sample.status, 200);
  assert.ok(sample.data.total >= 100);

  const deid = await f.json("/api/research/deidentify", "POST", {
    sessionId: session.id,
    sourceId: profile.data.sourceId,
    columns: ["group"],
  });
  assert.equal(deid.status, 200);
  assert.ok(deid.data.csv.split("\n").length === 11);
});
