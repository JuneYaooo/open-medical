import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { conversationRunIds, patientQuestions } from "../shared/patient-conversations.mjs";

test("patient questions isolate history; explicit follow-ups carry only their selected chain", async t => {
  const inputs = [];
  const provider = { provider:"stub", model:"stub", apiKey:"stub",
    async complete(messages) { inputs.push(structuredClone(messages)); if(messages.findLast(m=>m.role==="user")?.content === "模拟失败") throw new Error("合成模型失败"); return {message:{role:"assistant",content:"合成回答："+messages.findLast(m=>m.role==="user").content}}; } };
  const f=await fixture(t,{provider});
  const p=(await f.json("/api/patients","POST",{name:"问答边界测试"})).data;
  const chat=async(message,extra={})=>{
    const r=await f.chat(p.sessionId,message,{mode:"model",externalConsent:true,completion:{kind:"answer"},...extra});
    assert.equal(r.status,200);
    const session=(await f.json("/api/sessions/"+p.sessionId)).data;
    assert.equal(session.runs.at(-1).status,"completed");
    return session.runs.at(-1).id;
  };
  const a=await chat("独立问题甲：解释记录中的甲项");
  const b=await chat("独立问题乙：解释记录中的乙项");
  assert.ok(!JSON.stringify(inputs.at(-1)).includes("独立问题甲"));
  const follow=await chat("请解释刚才的第二点",{conversationParentRunId:a});
  let transcript=JSON.stringify(inputs.at(-1));
  assert.ok(transcript.includes("独立问题甲"));
  assert.ok(!transcript.includes("独立问题乙"));
  await chat("请进一步说明",{conversationParentRunId:follow});
  transcript=JSON.stringify(inputs.at(-1));
  assert.ok(transcript.includes("请解释刚才的第二点"));
  assert.ok(!transcript.includes("独立问题乙"));
  const session=(await f.json("/api/sessions/"+p.sessionId)).data;
  assert.equal(patientQuestions(session).length,2);
  assert.equal(conversationRunIds(session.runs,follow).has(a),true);
  assert.equal(conversationRunIds(session.runs,follow).has(b),false);
  // The ordinary history checkpoint is deliberately poisoned to verify it is never used.
  f.server.workspaces.store.update(p.sessionId,w=>{w.runs.find(r=>r.id===a).contextMessages=[{role:"user",content:"历史混入哨兵"}];});
  await chat("继续核对甲项",{conversationParentRunId:a});
  assert.ok(!JSON.stringify(inputs.at(-1)).includes("历史混入哨兵"));
  const other=(await f.json("/api/patients","POST",{name:"另一患者"})).data;
  const rejected=await f.chat(other.sessionId,"继续",{mode:"model",externalConsent:true,conversationParentRunId:a});
  assert.equal(rejected.status,409);
  const missing=await f.chat(p.sessionId,"继续",{mode:"model",externalConsent:true,conversationParentRunId:"missing"});
  assert.equal(missing.status,409);
  await f.chat(p.sessionId,"模拟失败",{mode:"model",externalConsent:true});
  const failed=(await f.json("/api/sessions/"+p.sessionId)).data.runs.at(-1);
  assert.equal(failed.status,"failed");
  assert.equal((await f.chat(p.sessionId,"追问失败项",{mode:"model",externalConsent:true,conversationParentRunId:failed.id})).status,409);
});

test("question grouping terminates cycles and includes only explicit ancestry",()=>{
 const runs=[{id:"a"},{id:"b"},{id:"c",conversationParentRunId:"a"},{id:"d",resumes:"c"}];
 assert.deepEqual([...conversationRunIds(runs,"d")],["d","c","a"]);
 assert.deepEqual([...conversationRunIds(runs,"missing")],[]);
 assert.deepEqual([...conversationRunIds([{id:"x",conversationParentRunId:"y"},{id:"y",conversationParentRunId:"x"}],"x")],["x","y"]);
});
