// Opt-in network/model checks with synthetic patients only. Never reads the user's patient database.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright-core';
import {caseForDisplay} from '../shared/case-profile.mjs';
import {comparisonScore} from '../shared/case-comparison.mjs';
import {fixture} from './helpers.mjs';
if(existsSync('.env'))process.loadEnvFile('.env');
const model={providerName:process.env.AI_PROVIDER||'anthropic',apiKey:process.env.ANTHROPIC_API_KEY||process.env.DEEPSEEK_API_KEY||'',baseUrl:process.env.ANTHROPIC_BASE_URL||process.env.DEEPSEEK_BASE_URL,model:process.env.ANTHROPIC_MODEL||process.env.DEEPSEEK_MODEL};
const skip=process.env.MODEL_E2E!=='on'||!model.apiKey;
async function seed(t){
 const f=await fixture(t,{...model,followupOptions:{autoStart:false}});
 const p=(await f.json('/api/patients','POST',{name:'合成临床流程患者',gender:'male',birthYear:1960,diagnoses:[{name:'肝细胞癌术后',source:'合成测试记录'}],medications:[{name:'替诺福韦',status:'unknown',source:'合成历史记录，当前使用情况未确认'}]})).data;
 const file=(await f.json(`/api/sessions/${p.sessionId}/files`,'POST',{name:'合成病历-仅供软件验收.txt',text:'本文件是人工合成的软件验收资料，不对应真实患者。\n2025-05-01：肝细胞癌手术后，病理报告未随材料提供。\n2025-08-01：影像报告提示术区结节，复发性质未确定，医嘱建议进一步核对增强影像及病理。\n既往乙型肝炎病史；历史记录写有替诺福韦，但未记录剂量和当前服用状态。\n本次资料没有 Child-Pugh、ECOG、近期肝肾功能、确切分期或新的系统治疗医嘱。\n测试目的：确认助手能描述资料不足并停止，不编造具体方案。'})).data;
 return {...f,p,file};
}
test('real model: treatment assessment finishes one source-backed limited draft without looping',{skip,timeout:240000},async t=>{
 const f=await seed(t),started=Date.now();
 await f.chat(f.p.sessionId,'这个患者的治疗方案是否合理？请核对所给历史医嘱，资料不足就说明缺口，不要猜测新的处方。',{mode:'standard',externalConsent:true,fileIds:[f.file.id]});
 const s=(await f.json(`/api/sessions/${f.p.sessionId}`)).data,r=s.runs.at(-1),drafts=r.artifacts.filter(a=>a.type==='treatment_review');
 t.diagnostic(JSON.stringify({durationMs:Date.now()-started,status:r.status,outcome:r.outcome,artifactCount:drafts.length,error:r.error}));
 assert.equal(r.status,'completed');assert.equal(drafts.length,1);assert.ok(drafts[0].matches.length>0);assert.ok(drafts[0].infoGaps.length>0);assert.equal(drafts[0].status,'draft');
 assert.ok(s.messages.filter(m=>m.role==='assistant'&&m.runId===r.id).length<=1);
});
test('real model: similar-case lookup ends with traceable candidates or explicit search gaps',{skip,timeout:300000},async t=>{
 const f=await seed(t),started=Date.now();
 await f.chat(f.p.sessionId,'查找这个患者的相似病例，包括本地和网上病例，按疾病、阶段、治疗、用药、年龄性别比较，资料不足明确说明。',{mode:'standard',externalConsent:true,fileIds:[f.file.id]});
 const s=(await f.json(`/api/sessions/${f.p.sessionId}`)).data,r=s.runs.at(-1),drafts=r.artifacts.filter(a=>a.type==='similar_cases');
 t.diagnostic(JSON.stringify({durationMs:Date.now()-started,status:r.status,outcome:r.outcome,artifactCount:drafts.length,candidates:drafts[0]?.cases?.length,error:r.error}));
 mkdirSync('output',{recursive:true});const trace=f.server.workspaces.store.db.prepare('SELECT data FROM agent_trace WHERE run_id=? ORDER BY id').all(r.id).map(row=>JSON.parse(row.data)).filter(row=>row.type==='tool.result');writeFileSync('output/iteration38-case-trace.json',JSON.stringify(trace,null,2));if(r.status!=='completed')t.diagnostic(JSON.stringify({failures:trace.filter(row=>row.output?.error).map(row=>({tool:row.call.function.name,error:row.output.error.slice(0,900)}))}));
 assert.equal(r.status,'completed');assert.equal(drafts.length,1);assert.equal(drafts[0].status,'draft');
 for(const item of drafts[0].cases||[]){assert.ok(item.source||item.url||item.reference||item.id);}
 mkdirSync('output/playwright',{recursive:true});writeFileSync('output/iteration38-real-similar-result.json',JSON.stringify(drafts[0],null,2));
 t.diagnostic(JSON.stringify({comparisons:drafts[0].cases.map(caseForDisplay).map(c=>({reference:c.reference,score:comparisonScore(c.comparison),available:(c.comparison||[]).filter(row=>row.candidateQuote).map(row=>row.dimension)}))}));
 const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 if(existsSync(chrome)){
  const browser=await chromium.launch({executablePath:chrome,headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:1000}});await page.goto(f.origin+'/?view=patients');await page.locator('.patient-card',{hasText:'合成临床流程患者'}).click();await page.getByRole('button',{name:'打开病例工作区',exact:true}).click();
  // Entering a patient workspace starts a new question; select the saved run explicitly.
  const history=page.locator('.patient-question-history');
  await history.locator('summary').click();
  await history.getByRole('button',{name:/查找这个患者的相似病例/}).click();
  await page.getByRole('region',{name:'相似患者对照'}).waitFor();assert.equal(await page.locator('.case-row').count(),drafts[0].cases.length);await page.screenshot({path:'output/playwright/iteration38-real-cases.png',fullPage:true});if(drafts[0].cases.length){await page.locator('.case-row').first().click();await page.getByRole('region',{name:'病例概况'}).waitFor();await page.screenshot({path:'output/playwright/iteration38-real-case-detail.png',fullPage:true});}
 }

});
