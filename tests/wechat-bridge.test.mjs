import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.mjs';

test('legacy whole-window capture and blind first-result send remain retired even with old environment flags',async t=>{
 const f=await fixture(t,{wechatBridge:true,wechatBridgePlatform:'darwin'});
 const patient=(await f.json('/api/patients','POST',{name:'合成旧桥接患者'})).data;
 let nativeCalls=0;f.server.wechat.runner=async()=>{nativeCalls++;throw Error('must not run');};
 const status=(await f.json('/api/wechat/status')).data;
 assert.equal(status.enabled,false);assert.equal(status.retired,true);
 for(const path of ['/api/wechat/read','/api/wechat/send']){
  const result=await f.json(path,'POST',{patientId:patient.id,text:'never send'});
  assert.equal(result.status,410);assert.equal(result.data.code,'WECHAT_LEGACY_RETIRED');
 }
 assert.equal(nativeCalls,0);assert.equal(f.server.patients.messages(patient.id).length,0);
});
test('retired endpoints still require authentication and new collector does not enable itself',async t=>{
 const f=await fixture(t);
 assert.equal((await fetch(f.origin+'/api/wechat/read',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
 const configs=(await f.json('/api/chat-followups/settings')).data.connections;
 assert.ok(configs.every(c=>!c.enabled));
 assert.equal((await f.json('/api/chat-followups/preview','POST',{consent:true})).status,409);
});

test('direct legacy bridge calls cannot bypass retired HTTP routes',async()=>{
 const {WeChatMacBridge}=await import('../server/wechat-bridge.mjs');
 const bridge=new WeChatMacBridge({enabled:true});assert.equal(bridge.status().retired,true);
 await assert.rejects(bridge.send('unused','never send'),e=>e.code==='WECHAT_LEGACY_RETIRED');
 await assert.rejects(bridge.readFrontChat('unused'),e=>e.code==='WECHAT_LEGACY_RETIRED');
});
