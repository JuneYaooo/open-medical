import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {parseWechatExport,parseWechatExportBatch} from '../server/chat-connectors/wechat-export.mjs';
import {fixture} from './helpers.mjs';
const text='合成家属 2026-09-25 10:00\n已预约复查。';
const input={filename:'聊天记录.txt',data:Buffer.from(text).toString('base64')};
test('TXT and ZIP preserve text without inventing identity or executing attachments',async()=>{
 const plain=await parseWechatExport(input);assert.equal(plain.text,text);
 const zip=new JSZip();zip.file('记录/聊天.txt',text);zip.file('记录/photo.jpg','not an image');
 const result=await parseWechatExport({filename:'导出.zip',data:await zip.generateAsync({type:'base64'})});
 assert.equal(result.text,text);assert.deepEqual(result.attachments,['记录/photo.jpg']);assert.equal(result.senderId,undefined);
});
test('ambiguous archives, traversal, corrupt data, excessive expansion and unsupported text fail closed',async()=>{
 for(const names of [['../a.txt']]) {const z=new JSZip();for(const n of names)z.file(n,text);await assert.rejects(parseWechatExport({filename:'x.zip',data:await z.generateAsync({type:'base64'})}));}
 // 旧单会话入口拒绝多 TXT；批量入口才接受。
 const two=new JSZip();two.file('a.txt',text);two.file('b.txt',text);
 await assert.rejects(parseWechatExport({filename:'x.zip',data:await two.generateAsync({type:'base64'})}),/批量导入/);
 const z=new JSZip();z.file('a.txt','x'.repeat(200000));await assert.rejects(parseWechatExport({filename:'x.zip',data:await z.generateAsync({type:'base64',compression:'DEFLATE'})}),/过大/);
 await assert.rejects(parseWechatExport({...input,data:'!!!!'}));await assert.rejects(parseWechatExport({...input,filename:'x.exe'}));
 await assert.rejects(parseWechatExport({...input,data:Buffer.from([0xff,0xfe,0,0]).toString('base64')}));
});
test('batch parse: multi-TXT ZIP becomes one conversation per file, named by filename',async()=>{
 const zip=new JSZip();zip.file('张三.txt',text);zip.file('子目录/李四.txt',text);zip.file('photo.jpg','not an image');
 const batch=await parseWechatExportBatch({filename:'批量.zip',data:await zip.generateAsync({type:'base64'})});
 assert.equal(batch.conversations.length,2);
 assert.deepEqual(batch.conversations.map(c=>c.name).sort(),['张三','李四']);
 assert.ok(batch.conversations.every(c=>c.text===text));
 assert.deepEqual(batch.attachments,['photo.jpg']);
 const single=await parseWechatExportBatch(input);
 assert.equal(single.conversations.length,1);assert.equal(single.conversations[0].name,'聊天记录');
 const tooMany=new JSZip();for(let n=0;n<51;n++)tooMany.file(`会话${n}.txt`,text);
 await assert.rejects(parseWechatExportBatch({filename:'x.zip',data:await tooMany.generateAsync({type:'base64'})}),/50/);
});
test('import -> review -> summarize -> archive works without native permission or connection; dedup and patient scope hold',async t=>{
 const f=await fixture(t,{chatFollowups:{provider:()=>({complete:async()=>({message:{content:'家属反馈已预约复查，待核实时间。'}})})}});
 const p=(await f.json('/api/patients','POST',{name:'合成导入患者'})).data;
 const q=(await f.json('/api/patients','POST',{name:'另一个合成患者'})).data;
 const preview=async()=> (await f.json('/api/chat-followups/imports/preview','POST',{...input,patientId:p.id,consent:true})).data;
 let v=await preview();const commit={patientId:p.id,previewId:v.id,title:'合成会话',speakerName:'合成家属',relationship:'family',confirmed:true};
 assert.equal((await f.json('/api/chat-followups/imports','POST',{...commit,patientId:q.id})).status,409);
 assert.equal((await f.json('/api/chat-followups/imports','POST',{...commit,confirmed:false})).status,412);
 assert.equal((await f.json('/api/chat-followups/imports','POST',commit)).data.added,1);
 assert.equal((await f.json('/api/chat-followups/imports','POST',commit)).status,409);
 v=await preview();assert.equal((await f.json('/api/chat-followups/imports','POST',{...commit,previewId:v.id})).data.added,0);
 const state=(await f.json(`/api/chat-followups/patients/${p.id}`)).data;assert.equal(state.drafts.length,1);assert.equal(state.bindings[0].mode,'import');
 let d=state.drafts[0];assert.match(d.sourceText,/发言人待核验/);
 const result=await f.json(`/api/chat-followups/drafts/${d.id}/summarize`,'POST',{revision:0,externalConsent:true});assert.equal(result.status,200);d=result.data;
 assert.equal((await f.json(`/api/chat-followups/drafts/${d.id}/archive`,'POST',{revision:d.revision,note:d.note,confirmed:true,contactedAt:'2026-09-25T02:00:00Z'})).status,200);
 assert.equal((await f.json(`/api/chat-followups/patients/${q.id}`)).data.drafts.length,0);
 assert.equal(f.server.chatFollowups.config('wechat').enabled,false);
});
test('batch import: multi-TXT ZIP previews conversations, suggests patients and imports per conversation',async t=>{
 const f=await fixture(t,{chatFollowups:{provider:()=>({complete:async()=>({message:{content:'家属反馈已预约复查，待核实时间。'}})})}});
 const zhang=(await f.json('/api/patients','POST',{name:'张三'})).data;
 const li=(await f.json('/api/patients','POST',{name:'李四'})).data;
 const zip=new JSZip();zip.file('张三.txt',text);zip.file('李四.txt',text+'补充一句。');
 const preview=(await f.json('/api/chat-followups/imports/preview','POST',{filename:'批量.zip',data:await zip.generateAsync({type:'base64'}),consent:true})).data;
 assert.equal(preview.batch,true);
 assert.equal(preview.conversations.length,2);
 const zhangRow=preview.conversations.find(c=>c.name==='张三');
 const stranger=preview.conversations.find(c=>c.name==='李四');
 assert.equal(zhangRow.match?.patientId,zhang.id,'同名患者应给出姓名匹配建议');
 assert.equal(zhangRow.match?.matchedBy,'name');
 assert.equal(stranger.match?.patientId,li.id);
 assert.ok(zhangRow.snippet.length>0&&zhangRow.chars>0);
 // 归属由医生逐会话确认：导入张三的会话。
 const first=(await f.json('/api/chat-followups/imports','POST',{patientId:zhang.id,previewId:preview.id,conversationId:zhangRow.id,title:'张三',speakerName:'张三',relationship:'self',confirmed:true})).data;
 assert.equal(first.added,1);assert.equal(first.remaining,1);
 // 重复确认同一会话被拒绝（已从批次移除）。
 assert.equal((await f.json('/api/chat-followups/imports','POST',{patientId:zhang.id,previewId:preview.id,conversationId:zhangRow.id,title:'张三',speakerName:'张三',relationship:'self',confirmed:true})).status,409);
 // 未核对归属的确认被拒绝。
 assert.equal((await f.json('/api/chat-followups/imports','POST',{patientId:li.id,previewId:preview.id,conversationId:stranger.id,title:'李四',speakerName:'李四',relationship:'self',confirmed:false})).status,412);
 const second=(await f.json('/api/chat-followups/imports','POST',{patientId:li.id,previewId:preview.id,conversationId:stranger.id,title:'李四',speakerName:'李四',relationship:'self',confirmed:true})).data;
 assert.equal(second.added,1);assert.equal(second.remaining,0);
 assert.equal((await f.json(`/api/chat-followups/patients/${zhang.id}`)).data.drafts.length,1);
 assert.equal((await f.json(`/api/chat-followups/patients/${li.id}`)).data.drafts.length,1);
});
