import test from "node:test";
import assert from "node:assert/strict";
import { DeepSeekProvider } from "../server/provider.mjs";
import { fixture } from "./helpers.mjs";
const tc = (name, args = {}) => ({
  id: crypto.randomUUID(),
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const answer = (calls) => ({
  message: { role: "assistant", content: "", tool_calls: calls },
});
async function seed(t, provider) {
  const f = await fixture(t, { provider });
  const patient = (
    await f.json("/api/patients", "POST", { name: "合成纳排患者" })
  ).data;
  const _file = (
    await f.json(`/api/sessions/${patient.sessionId}/files`, "POST", {
      name: "合成病历.txt",
      text: "患者年龄45岁。\n明确记录正在参加另一干预试验。",
    })
  ).data;
  const trial = (
    await f.json("/api/trials", "POST", {
      title: "合成试验",
      version: "2026-09",
      inclusion: "年龄至少18岁\n近7天完成肝功能检查",
      exclusion: "正在参加另一干预试验",
    })
  ).data;
  const source = (await f.json(`/api/sessions/${patient.sessionId}`)).data
    .files[0];
  return {
    ...f,
    patient,
    trial,
    file: source,
    path: `/api/trials/${trial.id}/screenings/${patient.id}/ai`,
  };
}
async function finish(f) {
  for (let n = 0; n < 150; n++) {
    const j = (await f.json(f.path)).data.jobs[0];
    if (j.status !== "running") return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("job timeout");
}
test("AI eligibility runs via agent tools, verifies sources, persists draft, and ends without extra model call", async (t) => {
  const provider = new DeepSeekProvider({ apiKey: "synthetic", model: "test" });
  let n = 0,
    f;
  provider.complete = async (messages, tools) => {
    n++;
    assert.ok(!tools.some((t) => t.function.name === "code_execute"));
    if (n === 1)
      return answer([
        tc("read_trial_criteria"),
        tc("read_source", { sourceId: f.file.id, startLine: 1, endLine: 2 }),
      ]);
    if (n === 2)
      return answer([
        tc("save_trial_eligibility_batch", {
          checks: f.trial.criteria.map((c, i) => ({
            id: c.id,
            value: i === 1 ? "unknown" : "yes",
            reason: i === 1 ? "缺少近期检查" : "原文明确记录",
            evidenceDate: "未记载",
            missing: i === 1 ? "近7天肝功能报告" : "",
            citations:
              i === 1
                ? []
                : [
                    {
                      sourceId: f.file.id,
                      startLine: 1,
                      endLine: 2,
                      quote:
                        i === 0
                          ? "患者年龄45岁。"
                          : "明确记录正在参加另一干预试验。",
                    },
                  ],
          })),
        }),
      ]);
    throw Error("must finish from saved artifact");
  };
  f = await seed(t, provider);
  assert.equal((await f.json(f.path, "POST", {})).status, 412);
  const started = await f.json(f.path, "POST", { externalConsent: true });
  assert.equal(started.status, 202);
  const result = await finish(f);
  assert.equal(result.status, "completed", result.error);
  assert.equal(n, 2);
  assert.equal(result.conflicts, 1);
  assert.equal(result.missing, 1);
  assert.equal(result.checks.length, 3);
  assert.equal(
    (await f.json(f.path.replace("/ai", ""))).data.revision,
    0,
    "AI does not overwrite review",
  );
  const patient = (await f.json(`/api/patients/${f.patient.id}`)).data;
  assert.equal(patient.revision, f.patient.revision);
  await f.json(`/api/patients/${patient.id}`, "PATCH", {
    expectedRevision: patient.revision,
    birthYear: 1981,
  });
  assert.equal((await f.json(f.path)).data.jobs[0].stale, true);
});
test("invalid evidence cannot become a delivered eligibility result", async (t) => {
  const provider = new DeepSeekProvider({ apiKey: "synthetic", model: "test" });
  let n = 0,
    f;
  provider.complete = async () => {
    n++;
    if (n === 1)
      return answer([
        tc("save_trial_eligibility_batch", {
          checks: f.trial.criteria.map((c) => ({
            id: c.id,
            value: "no",
            reason: "未记录",
            evidenceDate: "",
            missing: "",
            citations: [],
          })),
        }),
      ]);
    return { message: { role: "assistant", content: "已完成，全部符合" } };
  };
  f = await seed(t, provider);
  await f.json(f.path, "POST", { externalConsent: true });
  const job = await finish(f);
  assert.equal(job.status, "failed");
  assert.equal(job.checks.length, 0);
});
test("duplicate starts share a background job and cancellation rejects late writes", async (t) => {
  const provider = new DeepSeekProvider({ apiKey: "synthetic", model: "test" });
  let release;
  provider.complete = () =>
    new Promise((r) => {
      release = r;
    });
  const f = await seed(t, provider),
    first = (await f.json(f.path, "POST", { externalConsent: true })).data;
  const second = (await f.json(f.path, "POST", { externalConsent: true })).data;
  assert.equal(first.id, second.id);
  const other = (
    await f.json("/api/patients", "POST", { name: "合成其他患者" })
  ).data;
  assert.equal(
    (
      await f.json(
        `/api/trials/${f.trial.id}/screenings/${other.id}/ai/${first.id}`,
        "DELETE",
      )
    ).status,
    404,
  );
  assert.equal(
    (await f.json(`${f.path}/${first.id}`, "DELETE")).data.status,
    "cancelled",
  );
  release?.({ message: { role: "assistant", content: "晚到响应" } });
  assert.equal((await finish(f)).status, "cancelled");
});

test('restart preserves partial checks and marks unfinished jobs interrupted', async () => {
  const {DatabaseSync}=await import('node:sqlite');
  const {TrialEligibilityJobs}=await import('../server/medical/trial-eligibility-jobs.mjs');
  const db=new DatabaseSync(':memory:');
  try {
    const service=new TrialEligibilityJobs({store:{db}});
    service.write({id:'synthetic-partial',status:'running',checks:[{id:'criterion',value:'unknown',missing:'近期检查'}]});
    const recovered=new TrialEligibilityJobs({store:{db}}).get('synthetic-partial');
    assert.equal(recovered.status,'interrupted');assert.equal(recovered.checks.length,1);assert.match(recovered.error,/重启/);
  } finally {db.close();}
});

test('new materials invalidate previously completed AI screening without changing patient fields', async t => {
  const provider=new DeepSeekProvider({apiKey:'synthetic',model:'test'});let f;
  provider.complete=async()=>answer([tc('save_trial_eligibility_batch',{checks:f.trial.criteria.map(c=>({id:c.id,value:'unknown',reason:'缺少足够资料',evidenceDate:'',missing:'待补原始报告',citations:[]}))})]);
  f=await seed(t,provider);await f.json(f.path,'POST',{externalConsent:true});assert.equal((await finish(f)).stale,false);
  await f.json(`/api/sessions/${f.patient.sessionId}/files`,'POST',{name:'补充检查.txt',text:'新的合成检查资料'});
  assert.equal((await f.json(f.path)).data.jobs[0].stale,true);
});
