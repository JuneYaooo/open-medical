import test from 'node:test';
import assert from 'node:assert/strict';
import {TrialRegistry,splitEligibility} from '../server/medical/trial-registry.mjs';
import {fixture} from './helpers.mjs';
const eligibility='Inclusion Criteria:\n\n1. Adult patients\n2. Confirmed diagnosis\n   a. document A OR\n   b. document B\n\nExclusion Criteria:\n\n* Other intervention\n* Contraindication';
test('registry splitting preserves nested alternatives and refuses multi-cohort shortcuts',()=>{
 const parsed=splitEligibility(eligibility);assert.equal(parsed.inclusion.split('\n').length,2);assert.match(parsed.inclusion,/document A OR b. document B/);assert.equal(parsed.exclusion.split('\n').length,2);
 assert.equal(splitEligibility(eligibility.replace('2. Confirmed diagnosis','Inclusion Criteria for cohort B\n2. Confirmed diagnosis')).inclusion,'');
 assert.equal(splitEligibility('No structured criteria').inclusion,'');
});
test('registry import is explicit, bounded to official host, and never uses patient data',async t=>{
 let requested='';
 const f=await fixture(t,{trialRegistryOptions:{fetchImpl:async url=>{requested=url;return Response.json({protocolSection:{identificationModule:{nctId:'NCT00000001',briefTitle:'Synthetic registry'},statusModule:{overallStatus:'UNKNOWN',lastUpdatePostDateStruct:{date:'2020-01-01'}},eligibilityModule:{eligibilityCriteria:eligibility,minimumAge:'18 Years',sex:'ALL'}}});}}});
 const result=await f.json('/api/trials/registry/NCT00000001');assert.equal(result.status,200);assert.equal(requested,'https://clinicaltrials.gov/api/v2/studies/NCT00000001?format=json');assert.equal(result.data.recruitment,'状态未知');assert.match(result.data.inclusion,/18 Years/);assert.match(result.data.protocolText,/注册性别要求：所有性别/);assert.match(result.data.version,/2020-01-01/);assert.equal((await f.json('/api/trials')).data.trials.length,0,'reading registry never silently saves a protocol');
 assert.equal((await f.json('/api/trials/registry/not-an-id')).status,400);
});
test('registry network, malformed data and wrong IDs fail clearly',async()=>{
 for(const fetchImpl of [async()=>{throw Error('offline');},async()=>new Response('not JSON'),async()=>Response.json({protocolSection:{identificationModule:{nctId:'NCT99999999'}}})])await assert.rejects(new TrialRegistry({fetchImpl}).lookup('NCT00000001'),{code:'TRIAL_REGISTRY'});
});
test('Chinese uploaded protocols split headings and numbered clauses without dropping nested conditions',()=>{
 const result=splitEligibility('方案版本 1\n入选标准：\n1、成年人\n2、符合其中之一\n  a. 条件甲 或\n  b. 条件乙\n排除标准：\n1、参加另一干预试验');
 assert.equal(result.inclusion.split('\n').length,2);assert.match(result.inclusion,/a. 条件甲 或 b. 条件乙/);assert.match(result.exclusion,/参加另一/);
 assert.equal(splitEligibility('队列一\n入选标准\n1、甲\n排除标准\n1、乙\n队列二\n入选标准\n1、丙\n排除标准\n1、丁').inclusion,'');
});
