import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { check, string, AppError } from '../errors.mjs';
const MAX_FILE = 4 * 1024 * 1024, MAX_TEXT = 128 * 1024;
// Never extract archive entries to disk, execute attachments, or infer patient identity.
function decode(bytes) {
  try {
    const utf16 = bytes[0]===0xff && bytes[1]===0xfe;
    const text=new TextDecoder(utf16?'utf-16le':'utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').trim();
    check(text && !text.includes('\0') && text.length<=14000,'CHAT_IMPORT_TEXT','聊天文本须为 1–14000 字，请在微信中分批选择记录后导出');
    return text;
  } catch(e) { if(e instanceof AppError) throw e; throw new AppError('CHAT_IMPORT_TEXT','文本编码无法识别，请使用 UTF-8 或 UTF-16LE 的 TXT 文件',422); }
}
async function boundedText(entry) {
  return new Promise((resolve,reject)=>{
    let size=0,done=false; const chunks=[];const stream=entry.internalStream('uint8array');
    stream.on('data',chunk=>{
      if(done)return; size+=chunk.length;
      if(size>MAX_TEXT){ done=true;stream.pause();reject(new AppError('CHAT_IMPORT_LIMIT','导出文本过大，请分批导出',413)); }
      else chunks.push(Buffer.from(chunk));
    });
    stream.on('error',()=>{if(!done){done=true;reject(new AppError('CHAT_IMPORT_FILE','压缩包文本无法解压，请重新导出',422));}});
    stream.on('end',()=>{if(!done){done=true;resolve(Buffer.concat(chunks));}});stream.resume();
  });
}
export async function parseWechatExport({filename,data}) {
  const batch = await parseWechatExportBatch({filename,data});
  check(batch.conversations.length===1,'CHAT_IMPORT_FILE',`压缩包包含 ${batch.conversations.length} 份聊天 TXT；多份时请使用批量导入`,422);
  const one=batch.conversations[0];
  return {text:one.text,attachments:batch.attachments,filename:batch.filename,fileHash:batch.fileHash};
}

// 批量解析：ZIP 内多份聊天 TXT = 多个会话（每个 ≤14000 字，最多 50 个），
// 会话名取自 TXT 文件名。附件仍只记录文件名；不做身份推断。
export async function parseWechatExportBatch({filename,data}) {
  check(typeof filename==='string' && filename.length<=200 && /\.(txt|zip)$/i.test(filename),'CHAT_IMPORT_FILE','请选择微信导出的 ZIP 或其中的 TXT 文件');
  check(typeof data==='string' && data.length>0 && data.length<=Math.ceil(MAX_FILE/3)*4 && data.length%4===0 && !/[^A-Za-z0-9+/=]/.test(data),'CHAT_IMPORT_LIMIT','文件格式无效或超过 4 MB，请只选择导出的 TXT 文件',413);
  const bytes=Buffer.from(data,'base64');check(bytes.toString('base64')===data,'CHAT_IMPORT_FILE','文件编码无效',422);check(bytes.length<=MAX_FILE,'CHAT_IMPORT_LIMIT','文件不能超过 4 MB',413);
  const fileHash=createHash('sha256').update(bytes).digest('hex');
  let conversations=[],attachments=[];
  if(/\.txt$/i.test(filename)) {
    check(bytes.length<=MAX_TEXT,'CHAT_IMPORT_LIMIT','文本文件过大，请分批导出',413);
    conversations=[{name:conversationName(filename),filename:filename.split(/[\\/]/).at(-1),text:decode(bytes)}];
  } else {
    let zip;try { zip=await JSZip.loadAsync(bytes); } catch { throw new AppError('CHAT_IMPORT_FILE','ZIP 无法打开，请选择未加密的微信导出文件',422); }
    const entries=Object.values(zip.files).filter(e=>!e.dir);
    check(entries.length<=500,'CHAT_IMPORT_LIMIT','附件过多，请分批导出',413);
    check(entries.every(e=>!/(^|[\\/])\.\.([\\/]|$)|^[\\/]|^[A-Za-z]:/.test(e.unsafeOriginalName||e.name)),'CHAT_IMPORT_FILE','压缩包包含无效文件路径',422);
    const files=entries.filter(e=>!e.name.startsWith('__MACOSX/') && !e.name.split('/').at(-1).startsWith('.'));
    const texts=files.filter(e=>/\.txt$/i.test(e.name));
    check(texts.length>=1,'CHAT_IMPORT_FILE','压缩包须至少包含一份聊天 TXT',422);
    check(texts.length<=50,'CHAT_IMPORT_LIMIT','一次最多导入 50 个会话，请分批导出',413);
    for(const entry of texts)
      conversations.push({name:conversationName(entry.name),filename:entry.name.split(/[\\/]/).at(-1).slice(0,300),text:decode(await boundedText(entry))});
    attachments=files.filter(e=>!texts.includes(e)).map(e=>e.name.slice(0,300));
  }
  return {conversations,attachments,filename:filename.split(/[\\/]/).at(-1),fileHash};
}
// 会话名 = TXT 文件名去掉扩展名；文件名即导出时的会话/联系人名。
function conversationName(path) {
  const base=String(path).split(/[\\/]/).at(-1).replace(/\.txt$/i,'').trim();
  return string(base,'会话名称',150);
}
