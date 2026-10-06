import test from 'node:test';
import assert from 'node:assert/strict';
import {WechatReader,validateRegion} from '../server/chat-connectors/wechat-reader.mjs';
const titleRegion={x:.4,y:.02,width:.3,height:.06},messageRegion={x:.4,y:.1,width:.58,height:.65};
const binding={title:'合成家属',calibration:{titleRegion,messageRegion,aspect:1.25}};
function reader({title='合成家属',matches=1,windowChange=false}={}) {
 let snapshots=0;const calls=[];
 const r=new WechatReader({platform:'darwin',invoke:async i=>{calls.push(i);if(i.action==='status')return{accessibility:true,screenRecording:true,apps:[{id:'com.tencent.xinWeChat'}]};if(i.action==='snapshot')return{windowId:windowChange?++snapshots:1,bounds:{X:0,Y:0,Width:1000,Height:800}};return{ok:true};},captureWindow:async()=>Buffer.from('fixture'),ocr:async(_bytes,_signal,options)=>options?.region?.y===titleRegion.y?{lines:[{text:title,confidence:.9}]}:options?.region?{lines:[{text:'合成消息',confidence:.9}],image:'c3ludGhldGlj'}:{width:1000,height:800,lines:Array.from({length:matches},()=>({text:'合成家属',confidence:.9,box:{x:.2,y:.2,width:.2,height:.1}}))}});
 return{r,calls};
}
test('wechat capture keeps cropped evidence and refuses changed windows or invalid regions',async()=>{
 const {r}=reader();const result=await r.read(binding,new AbortController().signal);assert.equal(result.text,'合成消息');assert.equal(result.evidence.coverage,'visible-window');assert.equal(result.evidence.image,'c3ludGhldGlj');
 await assert.rejects(reader({windowChange:true}).r.capture(),/窗口发生变化/);
 assert.throws(()=>validateRegion({x:.9,y:0,width:.2,height:.3}),/有效/);
});
test('duplicate search names never produce a blind first-result click or read',async()=>{
 const {r,calls}=reader({title:'其他人',matches:2});await assert.rejects(r.read(binding,new AbortController().signal),/手动打开/);assert.equal(calls.some(c=>['click','type','key'].includes(c.action)),false);
});
test('cancelled read never invokes desktop or screenshot operations',async()=>{
 const {r,calls}=reader();const c=new AbortController();c.abort();await assert.rejects(r.read(binding,c.signal),/取消/);assert.equal(calls.length,0);
});

test('login prompt in AX or OCR stops before any input or source collection',async()=>{
 for(const prompt of ['为了你的账号安全，请重新登录。','需在手机上完成登录','请在手机上确认登录']) for(const fromAX of [true,false]) {
  const {r,calls}=reader(); const invoke=r.invoke,ocr=r.ocr;
  r.invoke=async i=>({...await invoke(i),...(fromAX&&i.action==='snapshot'?{text:prompt}:{})});
  if(!fromAX)r.ocr=async(...args)=>({...await ocr(...args),lines:[{text:prompt,confidence:.99}]});
  await assert.rejects(r.read(binding),e=>e.code==='CHAT_LOGIN_REQUIRED');
  assert.equal(calls.some(c=>['key','click','type'].includes(c.action)),false);
 }
});
test('second visual capture catches a chat switch even when AX chrome remains identical',async()=>{
 const {r}=reader();const ocr=r.ocr;let reads=0;
 r.ocr=async(...args)=>{if(args[2]?.region?.y===titleRegion.y&&++reads===2)return{lines:[{text:'其他人',confidence:.99}]};return ocr(...args);};
 await assert.rejects(r.read(binding),e=>e.code==='CHAT_WINDOW');
});
test('concurrent preview cannot interrupt a read and cancellation releases the lock',async()=>{
 const {r}=reader();const capture=r.captureWindow;let release; r.captureWindow=()=>new Promise(resolve=>release=resolve);
 const c=new AbortController();const pending=r.read(binding,c.signal);
 while(!release)await new Promise(resolve=>setImmediate(resolve));
 await assert.rejects(r.capture(),e=>e.code==='CHAT_BUSY');c.abort();release(Buffer.from('fixture'));await assert.rejects(pending,/取消/);
 r.captureWindow=capture;assert.ok(await r.read(binding));
});
test('similar titles containing different spaces are never treated as identical',async()=>{
 await assert.rejects(reader({title:'合成 家属'}).r.read(binding),e=>e.code==='CHAT_IDENTITY');
});
test('listNames returns deduped left-list candidates and ignores noise and out-of-band lines',async()=>{
 const {r}=reader();
 const invoke=r.ocr;
 r.ocr=async(bytes,_signal,options)=>options?.region?invoke(bytes,_signal,options):{width:1000,height:800,lines:[
  {text:'June',confidence:.95,box:{x:.13,y:.15,width:.04,height:.03}},
  {text:'June',confidence:.9,box:{x:.13,y:.22,width:.04,height:.03}},
  {text:'李雷',confidence:.9,box:{x:.13,y:.29,width:.04,height:.03}},
  {text:'10:32',confidence:.95,box:{x:.13,y:.36,width:.04,height:.03}},
  {text:'聊天区消息',confidence:.95,box:{x:.4,y:.5,width:.2,height:.03}},
  {text:'A',confidence:.95,box:{x:.13,y:.43,width:.02,height:.03}},
  {text:'低置信行',confidence:.5,box:{x:.13,y:.5,width:.04,height:.03}},
 ]};
 const result=await r.listNames(new AbortController().signal);
 assert.deepEqual(result.names,['June','李雷']);
});
