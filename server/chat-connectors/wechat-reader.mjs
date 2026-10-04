import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DesktopControl } from '../core/desktop-control.mjs';
import { recognizeImage, localOcrAvailable } from '../core/image-ocr.mjs';
import {
  WindowsWechatControl,
  recognizeWindowsImage,
  windowsWechatAvailable,
  verifyOcrContains,
  matchRatio,
  ocrLinesText,
} from './wechat-windows.mjs';
import { check } from '../errors.mjs';
const exec = promisify(execFile), bundle = 'com.tencent.xinWeChat';
const normalized = value => value.normalize('NFC').trim();
const cancelled = signal => check(!signal?.aborted,'CHAT_CANCELLED','读取已取消',409);
const wait = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});
export function assertWechatSession(text = '') {
  check(!/为了你的账号安全|重新登录|重新登陆|安全验证|扫码登录|扫描二维码登录|需在手机上完成登录|请在手机上确认登录|log\s*in\s*again|sign\s*in\s*again|scan.*QR.*log|confirm.*log.?in.*phone/i.test(text), 'CHAT_LOGIN_REQUIRED', '微信显示登录或安全验证提示。读取已停止，请在微信中手动处理后重新读取；不会自动重试登录。',409);
}
export function validateRegion(r) {
  check(r && ['x','y','width','height'].every(k => Number.isFinite(r[k])) && r.x >= 0 && r.y >= 0 && r.width >= .02 && r.height >= .015 && r.x+r.width <= 1.000001 && r.y+r.height <= 1.000001, 'CHAT_REGION', '请在窗口预览上选择有效的标题和消息区域');
  return { x:r.x,y:r.y,width:r.width,height:r.height };
}
export class WechatReader {
  constructor({ invoke, captureWindow, ocr, platform = process.platform, control } = {}) {
    // Windows 默认走内置 PowerShell 桌面控制与系统 OCR;macOS 走原生控制与 Vision OCR。
    if (!invoke && !captureWindow && platform === 'win32') {
      const windows = control || new WindowsWechatControl();
      invoke = (input, signal) => windows.invoke(input, signal);
      captureWindow = (id, signal) => windows.capture(id, signal);
      ocr = ocr || recognizeWindowsImage;
    }
    this.invoke = invoke || (input => DesktopControl.prototype.native(input));
    this.captureWindow = captureWindow || this.screenshot;
    this.ocr = ocr || recognizeImage; this.platform = platform; this.busy = false;
  }
  async status() {
    if (this.platform === 'win32') {
      if (!windowsWechatAvailable()) return { ready:false,message:'缺少 Windows 桌面控制组件，请更新工作台安装包' };
      let result;
      try { result = await this.invoke({ action:'status' }); } catch { return { ready:false,message:'Windows 桌面控制组件不可用，请更新安装包后重试' }; }
      const running = Array.isArray(result.apps) && result.apps.length > 0;
      return { ready:running, message:running ? '已找到微信窗口；请在微信中手动打开要读取或回复的会话' : '请打开并登录微信', coverage:'visible-window', navigation:'manual', loginVerified:false };
    }
    if (this.platform !== 'darwin') return { ready:false,message:'此安装版的微信读取支持 macOS 与 Windows' };
    if (this.ocr === recognizeImage && !localOcrAvailable()) return { ready:false,message:'缺少本地文字识别组件，请更新桌面安装包' };
    let result;
    try { result = await this.invoke({action:'status'}); } catch { return { ready:false,message:'原生桌面组件不可用，请更新安装包并检查辅助功能权限' }; }
    return { ready: result.accessibility && result.screenRecording && result.apps.some(a=>a.id===bundle), message: !result.accessibility ? '请在系统设置中授予工作台桌面组件辅助功能权限' : !result.screenRecording ? '请在系统设置中授予工作台桌面组件录屏权限' : !result.apps.some(a=>a.id===bundle) ? '请打开并登录微信' : '客户端与权限可用；首次关联时仍需核验登录账号及会话', coverage:'visible-window', navigation:'manual', loginVerified:false };
  }
  async screenshot(id,signal) {
    check(Number.isSafeInteger(id) && id > 0, 'CHAT_WINDOW', '未找到可读取的微信窗口');
    if (this.platform === 'win32') return this.captureWindow(id, signal);
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
    const appId = this.platform === 'darwin' ? bundle : '微信,WeChat,Weixin';
    await this.invoke({action:'focus',app:appId}, signal);
    const before = await this.invoke({action:'snapshot',app:appId}, signal);
    cancelled(signal); assertWechatSession(before.text);
    const bytes = await this.captureWindow(before.windowId,signal);
    const after = await this.invoke({action:'snapshot',app:appId}, signal);
    check(before.windowId === after.windowId && JSON.stringify(before.bounds) === JSON.stringify(after.bounds) && before.text === after.text,'CHAT_WINDOW','微信窗口发生变化，请重新读取',409);
    cancelled(signal); assertWechatSession(after.text);
    const result = await this.ocr(bytes,signal);
    cancelled(signal); assertWechatSession(result.lines.map(l=>l.text).join('\n'));
    check(result.width>0 && result.height>0 && result.lines.length,'CHAT_IMAGE','微信窗口为空白或未识别到文字，未读取任何消息。请先确认微信主窗口显示正常；无需反复修改系统权限。',409);
    return { image:bytes.toString('base64'),width:result.width,height:result.height,lines:result.lines,bounds:before.bounds,windowId:before.windowId };
  }
  async title(snapshot,region,signal) {
    const result=await this.ocr(Buffer.from(snapshot.image,'base64'),signal,{region:validateRegion(region)});
    const lines=result.lines.filter(l=>l.confidence>=.65);
    check(lines.length === 1,'CHAT_IDENTITY','标题区域未能识别唯一会话名称，请重新选择区域',409);
    return lines[0].text.trim();
  }
  // 会话身份核验：macOS 用标题区域 OCR;Windows 紧凑模式无可见标题，退回
  // 「标题区域可选 + 窗口比例 + 双帧稳定」核验,发送前另有与最近读取画面的内容比对。
  async verifyIdentity(snapshot,binding,signal) {
    const c = binding.calibration; check(c,'CHAT_CALIBRATION','请重新关联并校准聊天区域');
    check(Math.abs(snapshot.width/snapshot.height-c.aspect)<.03,'CHAT_CALIBRATION','微信窗口比例已改变，请重新关联并校准区域',409);
    if (c.titleRegion) {
      const title=await this.title(snapshot,c.titleRegion,signal);
      check(normalized(title)===normalized(binding.title),'CHAT_IDENTITY',`请先在微信手动打开「${binding.title}」后再读取。当前会话不匹配，未搜索或切换聊天。`,409);
    }
    cancelled(signal);
  }
  async read(binding,signal) { return this.exclusive(()=>this.readCurrent(binding,signal)); }
  async readCurrent(binding,signal) {
    cancelled(signal);
    const snapshot = await this.captureFrame(signal);
    await this.verifyIdentity(snapshot,binding,signal);
    const result=await this.ocr(Buffer.from(snapshot.image,'base64'),signal,{region:validateRegion(binding.calibration.messageRegion),includeImage:true});
    cancelled(signal);
    check(result.lines.length && result.lines.every(l=>l.confidence>=.5),'CHAT_OCR','聊天区域文字不清晰，请调整窗口后重试',409);
    const text=result.lines.map(l=>l.text).join('\n');
    check(text.length<=20000,'CHAT_LIMIT','可见文字过多，请缩小读取区域');
    check(result.image,'CHAT_IMAGE','聊天区域证据未生成，请重试');
    // A sparse AX tree cannot prove the visible conversation stayed unchanged.
    // Re-capture and compare the actual title and selected message text.
    const verified = await this.captureFrame(signal);
    check(verified.windowId===snapshot.windowId && JSON.stringify(verified.bounds)===JSON.stringify(snapshot.bounds),'CHAT_WINDOW','微信窗口发生变化，请重新读取',409);
    if (binding.calibration.titleRegion) {
      const verifiedTitle = await this.title(verified,binding.calibration.titleRegion,signal);
      check(normalized(verifiedTitle)===normalized(binding.title),'CHAT_WINDOW','读取期间聊天内容发生变化，请待画面稳定后重试',409);
    }
    const verifiedText = await this.ocr(Buffer.from(verified.image,'base64'),signal,{region:binding.calibration.messageRegion});
    cancelled(signal);
    check(verifiedText.lines.every(l=>l.confidence>=.5) && verifiedText.lines.map(l=>l.text).join('\n')===text,'CHAT_WINDOW','读取期间聊天内容发生变化，请待画面稳定后重试',409);
    return { text,fingerprint:createHash('sha256').update(text).digest('hex'),evidence:{image:result.image,lines:result.lines,observedTitle:binding.title,coverage:'visible-window'} };
  }
  // 回复(已验证发送)：点击输入框 → 粘贴 → OCR 核验输入区 → 发送 → OCR 核验会话区。
  // options.recentText 为该会话最近一次读取的画面文本:发送前核对当前画面与之连续,
  // 防止把回复发进另一个会话。任一核验失败即中止；失败意味着不报告成功。
  async send(binding, text, signal, options = {}) {
    check(typeof text === 'string' && text.trim().length > 0 && text.length <= 2000,'CHAT_SEND','回复内容需为 1–2000 字');
    return this.exclusive(async () => {
      cancelled(signal);
      const snapshot = await this.captureFrame(signal);
      await this.verifyIdentity(snapshot,binding,signal);
      const c = binding.calibration;
      if (options.recentText) {
        const area = await this.ocr(Buffer.from(snapshot.image,'base64'),signal,{region:validateRegion(c.messageRegion)});
        const ratio = matchRatio(options.recentText, ocrLinesText(area.lines));
        check(ratio >= .45,'CHAT_IDENTITY',`当前画面与最近读取的内容不连续(重叠 ${Math.round(ratio*100)}%)。请先在微信手动打开「${binding.title}」，重新读取后再回复。`,409);
        cancelled(signal);
      }
      const point = c.inputPoint && Number.isFinite(c.inputPoint.x) && Number.isFinite(c.inputPoint.y) ? c.inputPoint : { x:.5,y:.85 };
      check(point.x > .1 && point.x < .98 && point.y > .6 && point.y < .95,'CHAT_CALIBRATION','输入框位置无效，请重新关联会话');
      const b = snapshot.bounds;
      await this.invoke({ action:'click', x: Math.round(b.X + point.x*b.Width), y: Math.round(b.Y + point.y*b.Height) }, signal);
      await wait(250, signal);
      // 先清空输入框再粘贴：失败重试不叠加；若点击落在别处，清空无副作用，粘贴核验会拦下。
      await this.invoke({ action:'key', key:'ctrl+a' }, signal);
      await wait(150, signal);
      await this.invoke({ action:'key', key:'Delete' }, signal);
      await wait(150, signal);
      await this.invoke({ action:'paste', text }, signal);
      await wait(700, signal);
      cancelled(signal);
      const pastedFrame = await this.captureWindow(snapshot.windowId, signal);
      const pasted = await this.ocr(pastedFrame, signal, { region:{ x:0, y:Math.max(0,point.y-.19), width:1, height:.97-Math.max(0,point.y-.19) }, scale:3 });
      const inputCheck = verifyOcrContains(text, pasted.lines, { minRatio:.6 });
      check(inputCheck.ok,'CHAT_SEND_VERIFY',`输入框内容未通过核验(匹配率 ${inputCheck.ratio})，已取消发送；请手动检查微信输入框。`,409);
      cancelled(signal);
      await this.invoke({ action:'key', key:'Return' }, signal);
      await wait(900, signal);
      cancelled(signal);
      const sentFrame = await this.captureWindow(snapshot.windowId, signal);
      const sent = await this.ocr(sentFrame, signal, { scale:2 });
      const sentCheck = verifyOcrContains(text, sent.lines, { minRatio:.55 });
      check(sentCheck.ok,'CHAT_SEND_VERIFY',`发送后未在会话窗口核验到消息内容(匹配率 ${sentCheck.ratio})；如已发出请人工确认，未发出请在微信中手动发送。`,409);
      return { text, fingerprint:createHash('sha256').update(text).digest('hex'), evidence:{ image:sentFrame.toString('base64'), lines:sent.lines, observedTitle:binding.title, coverage:'verified-send', inputRatio:inputCheck.ratio, sentRatio:sentCheck.ratio } };
    });
  }
}
