import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DesktopControl } from '../core/desktop-control.mjs';
import { recognizeImage, localOcrAvailable } from '../core/image-ocr.mjs';
import { check } from '../errors.mjs';
const exec = promisify(execFile), bundle = 'com.tencent.xinWeChat';
const normalized = value => value.normalize('NFC').trim();
const cancelled = signal => check(!signal?.aborted,'CHAT_CANCELLED','读取已取消',409);
export function assertWechatSession(text = '') {
  check(!/为了你的账号安全|重新登录|重新登陆|安全验证|扫码登录|扫描二维码登录|log\s*in\s*again|sign\s*in\s*again|scan.*QR.*log/i.test(text), 'CHAT_LOGIN_REQUIRED', '微信显示登录或安全验证提示。读取已停止，请在微信中手动处理后重新读取；不会自动重试登录。',409);
}
export function validateRegion(r) {
  check(r && ['x','y','width','height'].every(k => Number.isFinite(r[k])) && r.x >= 0 && r.y >= 0 && r.width >= .02 && r.height >= .015 && r.x+r.width <= 1.000001 && r.y+r.height <= 1.000001, 'CHAT_REGION', '请在窗口预览上选择有效的标题和消息区域');
  return { x:r.x,y:r.y,width:r.width,height:r.height };
}
export class WechatReader {
  constructor({ invoke, captureWindow, ocr, platform = process.platform } = {}) {
    this.invoke = invoke || (input => DesktopControl.prototype.native(input));
    this.captureWindow = captureWindow || this.screenshot;
    this.ocr = ocr || recognizeImage; this.platform = platform; this.busy = false;
  }
  async status() {
    if (this.platform !== 'darwin') return { ready:false,message:'此安装版的微信读取支持 macOS；Windows 适配尚未安装' };
    if (this.ocr === recognizeImage && !localOcrAvailable()) return { ready:false,message:'缺少本地文字识别组件，请更新桌面安装包' };
    let result;
    try { result = await this.invoke({action:'status'}); } catch { return { ready:false,message:'原生桌面组件不可用，请更新安装包并检查辅助功能权限' }; }
    return { ready: result.accessibility && result.screenRecording && result.apps.some(a=>a.id===bundle), message: !result.accessibility ? '请在系统设置中授予工作台桌面组件辅助功能权限' : !result.screenRecording ? '请在系统设置中授予工作台桌面组件录屏权限' : !result.apps.some(a=>a.id===bundle) ? '请打开并登录微信' : '客户端与权限可用；首次关联时仍需核验登录账号及会话', coverage:'visible-window', navigation:'manual', loginVerified:false };
  }
  async screenshot(id,signal) {
    check(Number.isSafeInteger(id) && id > 0, 'CHAT_WINDOW', '未找到可读取的微信窗口');
    const dir = await mkdtemp(join(tmpdir(),'medical-chat-'));
    try { const path=join(dir,'window.png'); await exec('/usr/sbin/screencapture',['-x','-o','-l',String(id),path],{timeout:10000,signal}); const bytes=await readFile(path); check(bytes.length <= 4_000_000,'CHAT_IMAGE','微信窗口图片过大，请缩小窗口后重试'); return bytes; }
    finally { await rm(dir,{recursive:true,force:true}); }
  }
  async exclusive(work) {
    check(!this.busy,'CHAT_BUSY','微信正在读取，请稍后重试',409);
    this.busy=true; try { return await work(); } finally { this.busy=false; }
  }
  async capture(signal) { return this.exclusive(()=>this.captureFrame(signal)); }
  async captureFrame(signal) {
    check(!signal?.aborted,'CHAT_CANCELLED','读取已取消',409);
    const state = await this.status(); check(state.ready,'CHAT_NOT_READY',state.message,503);
    await this.invoke({action:'focus',app:bundle});
    const before = await this.invoke({action:'snapshot',app:bundle});
    cancelled(signal); assertWechatSession(before.text);
    const bytes = await this.captureWindow(before.windowId,signal);
    const after = await this.invoke({action:'snapshot',app:bundle});
    check(before.windowId === after.windowId && JSON.stringify(before.bounds) === JSON.stringify(after.bounds) && before.text === after.text,'CHAT_WINDOW','微信窗口发生变化，请重新读取',409);
    cancelled(signal); assertWechatSession(after.text);
    const result = await this.ocr(bytes,signal);
    cancelled(signal); assertWechatSession(result.lines.map(l=>l.text).join('\n'));
    check(result.width>0 && result.height>0 && result.lines.length,'CHAT_IMAGE','微信窗口未读到文字，请展开主窗口后重试',409);
    return { image:bytes.toString('base64'),width:result.width,height:result.height,lines:result.lines,bounds:before.bounds,windowId:before.windowId };
  }
  async title(snapshot,region,signal) {
    const result = await this.ocr(Buffer.from(snapshot.image,'base64'),signal,{region:validateRegion(region)});
    const lines=result.lines.filter(l=>l.confidence>=.65);
    check(lines.length === 1,'CHAT_IDENTITY','标题区域未能识别唯一会话名称，请重新选择区域',409);
    return lines[0].text.trim();
  }
  async read(binding,signal) { return this.exclusive(()=>this.readCurrent(binding,signal)); }
  async readCurrent(binding,signal) {
    cancelled(signal);
    const snapshot = await this.captureFrame(signal);
    const c = binding.calibration; check(c,'CHAT_CALIBRATION','请重新关联并校准聊天区域');
    validateRegion(c.messageRegion);
    check(Math.abs(snapshot.width/snapshot.height-c.aspect)<.03,'CHAT_CALIBRATION','微信窗口比例已改变，请重新关联并校准区域',409);
    const title=await this.title(snapshot,c.titleRegion,signal);
    check(normalized(title)===normalized(binding.title),'CHAT_IDENTITY',`请先在微信手动打开「${binding.title}」后再读取。当前会话不匹配，未搜索或切换聊天。`,409);
    const result=await this.ocr(Buffer.from(snapshot.image,'base64'),signal,{region:c.messageRegion,includeImage:true});
    cancelled(signal);
    check(result.lines.length && result.lines.every(l=>l.confidence>=.5),'CHAT_OCR','聊天区域文字不清晰，请调整窗口后重试',409);
    const text=result.lines.map(l=>l.text).join('\n');
    check(text.length<=20000,'CHAT_LIMIT','可见文字过多，请缩小读取区域');
    check(result.image,'CHAT_IMAGE','聊天区域证据未生成，请重试');
    // A sparse AX tree cannot prove the visible conversation stayed unchanged.
    // Re-capture and compare the actual title and selected message text.
    const verified = await this.captureFrame(signal);
    check(verified.windowId===snapshot.windowId && JSON.stringify(verified.bounds)===JSON.stringify(snapshot.bounds),'CHAT_WINDOW','微信窗口发生变化，请重新读取',409);
    const verifiedTitle = await this.title(verified,c.titleRegion,signal);
    const verifiedText = await this.ocr(Buffer.from(verified.image,'base64'),signal,{region:c.messageRegion});
    cancelled(signal);
    check(normalized(verifiedTitle)===normalized(title) && verifiedText.lines.every(l=>l.confidence>=.5) && verifiedText.lines.map(l=>l.text).join('\n')===text,'CHAT_WINDOW','读取期间聊天内容发生变化，请待画面稳定后重试',409);
    return { text,fingerprint:createHash('sha256').update(text).digest('hex'),evidence:{image:result.image,lines:result.lines,observedTitle:title,coverage:'visible-window'} };
  }
}
