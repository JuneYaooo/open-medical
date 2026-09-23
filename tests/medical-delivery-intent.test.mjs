import test from 'node:test';
import assert from 'node:assert/strict';
import {requestsMedicalDeliverable} from '../shared/medical-delivery.mjs';
test('saved deliverables require receipts without forcing ordinary clinical answers into files',()=>{
 for(const question of ['生成一份核对表','请导出患者用药 PDF','保存这份报告','create a patient document'])assert.equal(requestsMedicalDeliverable(question),true,question);
 for(const question of ['这个患者过往用药情况总结一下','帮我看看这个报告','用表格比较这两种方案','相似病例有哪些'])assert.equal(requestsMedicalDeliverable(question),false,question);
});
