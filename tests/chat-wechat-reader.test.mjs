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
test('desktop bindings verify avatar or header name before ingesting the message area',async()=>{
 const avatarBinding={title:'合成家属',calibration:{messageRegion,aspect:1.25,avatarHash:'f1e0e1e1e1e1e1e1'}};
 // 头像未命中且顶栏无同名:拒读,且绝不点击或输入(读错会话比拒绝读取严重)。
 const refused=reader();
 await assert.rejects(refused.r.read(avatarBinding),e=>e.code==='CHAT_IDENTITY');
 assert.equal(refused.calls.some(c=>['click','key','type'].includes(c.action)),false);
 // 顶栏精确同名(头像带被卡片占满的视口)也放行。
 const named=reader();
 const baseOcr=named.r.ocr;
 named.r.ocr=async(b,s,o)=>o?.region?baseOcr(b,s,o):{width:1000,height:800,lines:[{text:'合成家属',confidence:.95,box:{x:.3,y:.05,width:.2,height:.05}}]};
 assert.equal((await named.r.read(avatarBinding)).text,'合成消息');
 // 头像指纹命中同样放行。
 const withAvatar=reader();
 const baseInvoke=withAvatar.r.invoke;
 withAvatar.r.invoke=async i=>i.action==='find-avatar'?{found:true,hash:'f1e0e1e1e1e1e1e1',region:{x:.16,y:.5,width:.13,height:.05}}:baseInvoke(i);
 await assert.doesNotReject(withAvatar.r.read(avatarBinding));
});
test('locate retries identity verification on fresh frames but clicks only once',async()=>{
 const make=(recover=true)=>{
  let frames=0;const calls=[];
  const r=new WechatReader({platform:'win32',
   invoke:async i=>{calls.push(i.action);
    if(i.action==='status')return{apps:[{id:'微信'}]};
    if(i.action==='snapshot')return{windowId:7,bounds:{X:0,Y:0,Width:548,Height:794},text:'微信'};
    if(i.action==='find-avatar')return{found:false};
    return{ok:true};},
   captureWindow:async()=>Buffer.from('frame'),
   ocr:async()=>{frames++;const header=frames===1?null:(frames===2||!recover)?'其他人':'June';
    return {width:548,height:794,lines:header?[{text:header,confidence:.95,box:{x:.3,y:.06,width:.15,height:.05}}]:[{text:'June',confidence:.95,box:{x:.15,y:.3,width:.12,height:.04}}]};}});
  r.status=async()=>({ready:true,message:'ok'});
  return {r,calls,get frames(){return frames;}};
 };
 const ok=make();
 const result=await ok.r.locate('June',null,new AbortController().signal);
 assert.equal(result.navigated,true);
 assert.equal(result.nameVisible,true);
 assert.equal(ok.calls.filter(a=>a==='click').length,1,'切聊动画期间只点击一次');
 assert.ok(ok.frames>=3,'用点击后的新帧重试核验');
 const stuck=make(false);
 await assert.rejects(stuck.r.locate('June',null,new AbortController().signal),e=>e.code==='CHAT_LOCATE');
 assert.equal(stuck.calls.filter(a=>a==='click').length,1,'核验失败也不重复点击');
});
test('locate tolerates the back-arrow glyph OCR-merged into the header line',async()=>{
 const r=new WechatReader({platform:'win32',
  invoke:async i=>{
   if(i.action==='status')return{apps:[{id:'微信'}]};
   if(i.action==='snapshot')return{windowId:7,bounds:{X:0,Y:0,Width:548,Height:794},text:'微信'};
   return{ok:true};},
  captureWindow:async()=>Buffer.from('frame'),
  ocr:async()=>({width:548,height:794,lines:[{text:'〈 June',confidence:.95,box:{x:.21,y:.08,width:.13,height:.05}}]})});
 r.status=async()=>({ready:true,message:'ok'});
 const result=await r.locate('June',null,new AbortController().signal);
 assert.equal(result.navigated,false,'顶栏命中(剥离箭头装饰后同名)即不点击');
});
test('header identity never treats another name or a suffix as the bound conversation',async()=>{
 const avatarBinding={title:'June',calibration:{messageRegion,aspect:1.25,avatarHash:'f1e0e1e1e1e1e1e1'}};
 const withHeader=header=>{
  const h=reader();
  h.r.ocr=async(b,s,o)=>o?.region?{lines:[{text:'合成消息',confidence:.9}],image:'c3ludGhldGlj'}:{width:1000,height:800,lines:[{text:header,confidence:.95,box:{x:.21,y:.08,width:.13,height:.05}}]};
  return h.r;
 };
 await assert.rejects(withHeader('〈 June2').read(avatarBinding),e=>e.code==='CHAT_IDENTITY','带后缀的相似名字不算同一会话');
 await assert.rejects(withHeader('其他人').read(avatarBinding),e=>e.code==='CHAT_IDENTITY');
 await assert.doesNotReject(withHeader('〈 June').read(avatarBinding),'箭头粘连的顶栏名剥掉装饰后应命中');
 await assert.doesNotReject(withHeader('June').read(avatarBinding));
});
test('send verifies ultra-short texts by the paste-clear-repaste behavior chain when OCR cannot read them',async()=>{
 // 真机校准:系统 OCR 把「你好」读成「亻子」,任何倍率/紧裁剪/二值化都救不回,匹配率恒 0。
 let frames=0,darkIdx=0;const calls=[];
 const darks=[100,500,400,400,105,430,104,590];
 const r=new WechatReader({platform:'win32',
  invoke:async i=>{calls.push(i.action==='key'?`key:${i.key}`:i.action);
   if(i.action==='status')return{apps:[{id:'微信'}]};
   if(i.action==='snapshot')return{windowId:7,bounds:{X:0,Y:0,Width:548,Height:794},text:'微信'};
   if(i.action==='hash')return{dark:darks[Math.min(darkIdx++,darks.length-1)],hash:'0'.repeat(16)};
   return{ok:true};},
  captureWindow:async()=>Buffer.from(`frame-${++frames}`),
  ocr:async()=>({width:548,height:794,lines:[{text:'亻 子',confidence:.9}]})});
 r.status=async()=>({ready:true,message:'ok'});
 const binding={title:'June',calibration:{messageRegion,aspect:548/794,inputPoint:{x:.5,y:.85}}};
 const out=await r.send(binding,'你好',new AbortController().signal);
 assert.equal(out.evidence.mode,'behavioral');
 assert.equal(out.evidence.coverage,'verified-send');
 assert.equal(calls.filter(a=>a==='paste').length,2,'行为链会清空后二次粘贴');
 assert.deepEqual(calls.filter(a=>String(a).startsWith('key:')),['key:ctrl+a','key:Delete','key:ctrl+a','key:Delete','key:Return'],'Return 只按一次,且在核验通过之后');
});
test('send aborts when the short-text behavior chain does not collapse back to baseline',async()=>{
 let frames=0,darkIdx=0;const calls=[];
 const darks=[100,500,400,400,380];
 const r=new WechatReader({platform:'win32',
  invoke:async i=>{calls.push(i.action);
   if(i.action==='status')return{apps:[{id:'微信'}]};
   if(i.action==='snapshot')return{windowId:7,bounds:{X:0,Y:0,Width:548,Height:794},text:'微信'};
   if(i.action==='hash')return{dark:darks[Math.min(darkIdx++,darks.length-1)],hash:'0'.repeat(16)};
   return{ok:true};},
  captureWindow:async()=>Buffer.from(`frame-${++frames}`),
  ocr:async()=>({width:548,height:794,lines:[{text:'亻 子',confidence:.9}]})});
 r.status=async()=>({ready:true,message:'ok'});
 const binding={title:'June',calibration:{messageRegion,aspect:548/794,inputPoint:{x:.5,y:.85}}};
 await assert.rejects(r.send(binding,'你好',new AbortController().signal),e=>e.code==='CHAT_SEND_VERIFY'&&/行为核验/.test(e.message));
 assert.equal(calls.includes('Return')||calls.includes('key:Return'),false,'核验不过绝不按 Return');
});
test('send uses the plain OCR path and pastes once when the text is readable',async()=>{
 let frames=0,darkIdx=0;const calls=[];
 const r=new WechatReader({platform:'win32',
  invoke:async i=>{calls.push(i.action);
   if(i.action==='status')return{apps:[{id:'微信'}]};
   if(i.action==='snapshot')return{windowId:7,bounds:{X:0,Y:0,Width:548,Height:794},text:'微信'};
   if(i.action==='hash')return{dark:(darkIdx++===0?100:400),hash:'0'.repeat(16)};
   return{ok:true};},
  captureWindow:async()=>Buffer.from(`frame-${++frames}`),
  ocr:async()=>({width:548,height:794,lines:[{text:'血压偏高，请按时服药并记录晨起心率',confidence:.95}]})});
 r.status=async()=>({ready:true,message:'ok'});
 const binding={title:'June',calibration:{messageRegion,aspect:548/794,inputPoint:{x:.5,y:.85}}};
 const out=await r.send(binding,'血压偏高，请按时服药并记录晨起心率',new AbortController().signal);
 assert.equal(out.evidence.mode,'ocr');
 assert.equal(calls.filter(a=>a==='paste').length,1,'OCR 可读时不走行为链');
 assert.equal(calls.filter(a=>a==='key').length,3,'ctrl+a、Delete、Return 各一次');
});
test('scan clicks the in-place back arrow from a chat view and groups list rows with stable fingerprints',async()=>{
 let clicked=null;let view='chat';let frames=0;
 const chatLines=[{text:'〈 June',confidence:.95,box:{x:.21,y:.08,width:.13,height:.05}},{text:'消息内容',confidence:.95,box:{x:.4,y:.3,width:.2,height:.04}}];
 const listLines=[
  {text:'June',confidence:.95,box:{x:.13,y:.15,width:.12,height:.03}},
  {text:'你好，最近怎么样',confidence:.9,box:{x:.34,y:.15,width:.3,height:.03}},
  {text:'21:13',confidence:.9,box:{x:.85,y:.15,width:.08,height:.03}},
  {text:'李雷',confidence:.95,box:{x:.13,y:.27,width:.12,height:.03}},
  {text:'[图片]',confidence:.9,box:{x:.34,y:.27,width:.2,height:.03}},
  {text:'昨天',confidence:.9,box:{x:.85,y:.27,width:.08,height:.03}},
  {text:'王五',confidence:.95,box:{x:.13,y:.39,width:.12,height:.03}},
  {text:'收到',confidence:.9,box:{x:.34,y:.39,width:.2,height:.03}},
  {text:'周三',confidence:.9,box:{x:.85,y:.39,width:.08,height:.03}},
 ];
 const r=new WechatReader({platform:'win32',
  invoke:async i=>{
   if(i.action==='click'){clicked=i;view='list';}
   if(i.action==='status')return{apps:[{id:'微信'}]};
   if(i.action==='snapshot')return{windowId:7,bounds:{X:0,Y:0,Width:548,Height:794},text:'微信'};
   return{ok:true};},
  captureWindow:async()=>Buffer.from(`frame-${++frames}`),
  ocr:async()=>({width:548,height:794,lines:view==='chat'?chatLines:listLines})});
 r.status=async()=>({ready:true,message:'ok'});
 const first=await r.scanConversationList(new AbortController().signal);
 assert.ok(clicked,'聊天视图下会点返回箭头回列表');
 assert.ok(clicked.x>100&&clicked.x<140&&clicked.y>50&&clicked.y<110,'点击落在顶栏行首的箭头位置');
 assert.deepEqual(first.rows.map(row=>row.name),['June','李雷','王五'],'时间戳行不作名字,预览归入所在行');
 assert.equal(first.rows[0].fingerprint,first.rows[0].fingerprint);
 const second=await r.scanConversationList(new AbortController().signal);
 assert.deepEqual(second.rows,first.rows,'同画面指纹稳定');
 // 已在列表视图:不再点击
 let clicks=0;view='list';
 const listed=new WechatReader({platform:'win32',
  invoke:async i=>{if(i.action==='click')clicks++;if(i.action==='status')return{apps:[{id:'微信'}]};if(i.action==='snapshot')return{windowId:7,bounds:{X:0,Y:0,Width:548,Height:794},text:'微信'};return{ok:true};},
  captureWindow:async()=>Buffer.from('f'),
  ocr:async()=>({width:548,height:794,lines:listLines})});
 listed.status=async()=>({ready:true});
 await listed.scanConversationList(new AbortController().signal);
 assert.equal(clicks,0,'已在列表视图不点击');
 // 永远回不到列表:报错且不乱点第二次
 view='chat';let chatClicks=0;
 const stuck=new WechatReader({platform:'win32',
  invoke:async i=>{if(i.action==='click')chatClicks++;if(i.action==='status')return{apps:[{id:'微信'}]};if(i.action==='snapshot')return{windowId:7,bounds:{X:0,Y:0,Width:548,Height:794},text:'微信'};return{ok:true};},
  captureWindow:async()=>Buffer.from('f'),
  ocr:async()=>({width:548,height:794,lines:chatLines})});
 stuck.status=async()=>({ready:true});
 await assert.rejects(stuck.scanConversationList(new AbortController().signal),e=>e.code==='CHAT_LOCATE');
 assert.equal(chatClicks,1,'只尝试一次返回,失败即停');
});
test('avatar scanning scrolls the message area up, retries and restores the position',async()=>{
 const make=(platform,foundOnScan)=>{
  const wheels=[];let scans=0;
  const r=new WechatReader({platform,
   invoke:async i=>{
    if(i.action==='find-avatar'){scans++;return scans>=(foundOnScan?3:99)?{found:true,hash:'f1e0e1e1e1e1e1e1',region:{x:.16,y:.3,width:.13,height:.05}}:{found:false};}
    if(i.action==='wheel'){wheels.push(i.ticks);return{wheeled:true};}
    return{ok:true};},
   captureWindow:async()=>Buffer.from(`frame-${scans}`),
   ocr:async()=>({width:548,height:794,lines:[]})});
  return {r,wheels};
 };
 const snapshot={image:Buffer.from('x').toString('base64'),width:548,height:794,lines:[],bounds:{X:20,Y:30,Width:548,Height:794},windowId:7};
 const scanned=make('win32',true);
 const found=await scanned.r.findAvatarScanning(snapshot,null,new AbortController().signal);
 assert.equal(found.found,true);
 assert.deepEqual(scanned.wheels,[3,3,-6],'上滚两拍找到头像后等量滚回原位');
 const direct=make('win32',false);
 const first=await direct.r.findAvatarScanning(snapshot,null,new AbortController().signal);
 assert.equal(first.found,false,'滚动上限内仍找不到就如实返回未找到');
 assert.equal(direct.wheels.at(-1),-12,'失败路径也要滚回原位');
 const mac=make('darwin',true);
 const out=await mac.r.findAvatarScanning(snapshot,null,new AbortController().signal);
 assert.equal(out.found,false);
 assert.deepEqual(mac.wheels,[],'非 Windows 不滚动');
});
