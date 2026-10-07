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
  flatName,
  flattenForMatch,
  headerNameHit,
  hashDistance,
  AVATAR_BAND,
  AVATAR_MATCH_DISTANCE,
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
      return { ready:running, message:running ? '已找到微信窗口；关联、读取与回复都支持按备注名自动定位并核验头像（绑定卡默认勾选「读取前自动定位」），不会在微信中搜索' : '请打开并登录微信', coverage:'visible-window', navigation:'manual', loginVerified:false };
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
    // 存了头像指纹的绑定,读取前核验当前会话身份(头像或顶栏精确同名),
    // 避免微信停在别的会话时把别人的聊天录进这个患者的档案。
    if (binding.calibration.avatarHash) {
      const confirmedBy = await this.confirmAvatar(snapshot,binding,signal);
      check(confirmedBy,'CHAT_IDENTITY',`当前会话与「${binding.title}」不一致（头像与顶栏名都未匹配），未读取。请先在微信中打开「${binding.title}」，或改用「读取前自动定位」。`,409);
      cancelled(signal);
    }
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
  // 头像:在消息区左竖带找最近的头像块并计算指纹;绑定存指纹,之后每次定位/发送重比对。
  async findAvatar(snapshot, signal, band) {
    const bytes = Buffer.from(snapshot.image, 'base64');
    const result = await this.invoke({ action:'find-avatar', image: bytes.toString('base64'), band: band || AVATAR_BAND }, signal);
    return result && result.found ? result : { found: false };
  }
  // 视口内抓不到头像(最新消息是卡片或纯出向文本,左头像列为空)时,在消息区向上滚动
  // 重试找较早的入向消息头像,结束后滚回原位。只用于关联预览、重抓指纹这类以「取得
  // 头像指纹」为目的的调用;读取与发送的画面核验不用它,避免移动作为基准的画面。
  async findAvatarScanning(snapshot, signal, band) {
    const first = await this.findAvatar(snapshot, signal, band);
    if (first.found || this.platform !== 'win32') return first;
    const b = snapshot.bounds;
    const x = Math.round(b.X + .55 * b.Width), y = Math.round(b.Y + .4 * b.Height);
    let result = first, up = 0;
    for (let i = 0; i < 4 && !result.found; i++) {
      await this.invoke({ action:'wheel', x, y, ticks: 3 }, signal);
      up += 3;
      await wait(450, signal);
      const frame = await this.captureWindow(snapshot.windowId, signal);
      result = await this.findAvatar({ ...snapshot, image: frame.toString('base64') }, signal, band);
    }
    if (up) {
      await this.invoke({ action:'wheel', x, y, ticks: -up }, signal);
      await wait(300, signal);
    }
    return result;
  }
  avatarMatches(fingerprint, storedHash) {
    return Boolean(fingerprint?.found && storedHash && hashDistance(fingerprint.hash, storedHash) <= AVATAR_MATCH_DISTANCE);
  }
  // 会话身份双信号:头像指纹一致,或顶栏名字精确匹配。头像带被卡片、纯出向消息占满时
  // (该视口左列没有头像),顶栏精确同名仍能确认会话;两者都不过才算身份核验失败。
  async confirmAvatar(snapshot, binding, signal) {
    const fingerprint = await this.findAvatar(snapshot, signal, binding.calibration.avatarBand);
    if (this.avatarMatches(fingerprint, binding.calibration.avatarHash)) return 'avatar';
    if (headerNameHit(snapshot.lines, binding.title)) return 'name';
    return null;
  }
  // 会话列表候选(Windows 紧凑单栏布局):列表视图下行名从窗口左侧约 12% 处开始;
  // 聊天视图下的消息文本约从 32% 起,正好落在带外,顶栏名字由 y 下界排除。
  // 只读当前画面,不导航;仅作输入提示,关联仍走 locate 精确匹配 + 人工确认。
  async listNames(signal) {
    return this.exclusive(async () => {
      const snapshot = await this.captureFrame(signal);
      const noise = /^[\d\s:：.。/]+$|^(今天|昨天|前天)(的?)?(上午|中午|下午|晚上)?$/;
      const seen = new Set();
      const rows = snapshot.lines
        .filter(l => l.confidence >= .8 && !noise.test(l.text.trim()) && l.text.trim().length >= 2
          && l.box.y > .1 && l.box.y < .92 && l.box.x > .11 && l.box.x < .3)
        .sort((a,b) => a.box.y - b.box.y);
      const names = [];
      for (const row of rows) {
        const key = flatName(row.text);
        if (!seen.has(key)) { seen.add(key); names.push(row.text.trim()); }
      }
      return { names: names.slice(0, 30) };
    });
  }
  // 按备注名定位会话(Windows):当前顶栏名字即命中则不动;否则在会话列表中找
  // 唯一精确同名行并点击;导航后核验顶栏名字或头像指纹,任一通过才算定位成功。
  async locate(name, avatarHash, signal) {
    check(typeof name === 'string' && name.trim(), 'CHAT_LOCATE', '请填写微信备注名');
    return this.exclusive(async () => {
      cancelled(signal);
      const snapshot = await this.captureFrame(signal);
      if (headerNameHit(snapshot.lines, name)) return { snapshot, navigated: false, nameVisible: true };
      const rows = snapshot.lines.filter(l => flatName(l.text) === flatName(name) && l.box.y > .08 && l.box.y < .92 && l.box.x > .12 && l.box.x < .6);
      check(rows.length === 1, 'CHAT_LOCATE', rows.length
        ? `会话列表中有 ${rows.length} 个「${name}」，无法自动选择；请在微信中人工打开该会话后重试`
        : `会话列表中未找到「${name}」；请在微信中人工打开该会话（或将其置顶）后重试`, 409);
      const b = snapshot.bounds, row = rows[0];
      await this.invoke({ action:'click', x: Math.round(b.X + (row.box.x + row.box.width/2)*b.Width), y: Math.round(b.Y + (row.box.y + row.box.height/2)*b.Height) }, signal);
      await wait(1100, signal);
      // 切聊动画与 OCR 抖动会让单帧核验偶发失败:重试只重复只读的截屏核验,不重复点击。
      let after = null, nameOk = false, avatarOk = false;
      for (let attempt = 0; attempt < 3 && !nameOk && !avatarOk; attempt++) {
        if (attempt) await wait(700, signal);
        after = await this.captureFrame(signal);
        cancelled(signal);
        nameOk = headerNameHit(after.lines, name);
        avatarOk = false;
        if (!nameOk && avatarHash) avatarOk = this.avatarMatches(await this.findAvatar(after, signal), avatarHash);
      }
      check(nameOk || avatarOk, 'CHAT_LOCATE', `已点击「${name}」但未能核验会话身份，请在微信中人工确认当前会话后重试`, 409);
      return { snapshot: after, navigated: true, nameVisible: nameOk };
    });
  }
  // 回复(已验证发送)：点击输入框 → 粘贴 → OCR 核验输入区 → 发送 → OCR 核验会话区。
  // options.avatarHash 提供时,发送前用头像指纹核验当前会话身份;
  // options.recentText 提供时,额外核对当前画面与最近读取画面连续。
  // 任一核验失败即中止；失败意味着不报告成功。
  async send(binding, text, signal, options = {}) {
    check(typeof text === 'string' && text.trim().length > 0 && text.length <= 2000,'CHAT_SEND','回复内容需为 1–2000 字');
    return this.exclusive(async () => {
      cancelled(signal);
      const snapshot = await this.captureFrame(signal);
      await this.verifyIdentity(snapshot,binding,signal);
      const c = binding.calibration;
      if (c.avatarHash) {
        const confirmedBy = await this.confirmAvatar(snapshot,binding,signal);
        check(confirmedBy,'CHAT_IDENTITY',`当前会话与关联「${binding.title}」不一致（头像与顶栏名都未匹配），未发送。请确认微信中打开的是「${binding.title}」。`,409);
        cancelled(signal);
      }
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
      // 输入带只框输入框自身与其下工具栏,不含会话气泡:框体长高会盖掉气泡的深色像素,
      // 把带拉太高反而抵消粘贴带来的增量(真机实测整带 delta 只有 183,曾被阈值 200 误拒)。
      const inputBand = { x:0, y:Math.max(0,point.y-.10), width:1, height:.97-Math.max(0,point.y-.10) };
      // 清空后先截基准帧:深色像素对比必须以「清空后的输入框」为起点,否则残留文本会抵消变化量。
      await wait(150, signal);
      const preFrame = await this.captureWindow(snapshot.windowId, signal);
      const preBand = await this.invoke({ action:'hash', image: preFrame.toString('base64'), region: inputBand }, signal);
      // 消息区基准:发送后若内容过短无法 OCR 核验,用「消息区画面变化」作辅助已发证据。
      const msgPre = await this.invoke({ action:'hash', image: preFrame.toString('base64'), region: validateRegion(c.messageRegion) }, signal);
      await this.invoke({ action:'click', x: Math.round(b.X + point.x*b.Width), y: Math.round(b.Y + point.y*b.Height) }, signal);
      await wait(200, signal);
      await this.invoke({ action:'paste', text }, signal);
      await wait(700, signal);
      cancelled(signal);
      let pastedFrame = await this.captureWindow(snapshot.windowId, signal);
      let pastedBand = await this.invoke({ action:'hash', image: pastedFrame.toString('base64'), region: inputBand }, signal);
      let pasted = await this.ocr(pastedFrame, signal, { region: inputBand, scale:3 });
      let inputCheck = verifyOcrContains(text, pasted.lines, { minRatio:.5 });
      // 双信号:输入带深色像素显著增加(粘贴真正落进输入框)+ OCR 容差匹配(内容大致是待发文本)。
      // 阈值相对细采样校准:真实粘贴 ≥ 数百,粘贴落空时两帧几乎逐像素一致(≈0)。
      let landed = pastedBand.dark > preBand.dark + 120;
      if (landed && !inputCheck.ok) {
        // 渲染时差会让单帧 OCR 偶发漏读:等待后重采一帧再核一次。
        await wait(600, signal);
        cancelled(signal);
        pastedFrame = await this.captureWindow(snapshot.windowId, signal);
        pastedBand = await this.invoke({ action:'hash', image: pastedFrame.toString('base64'), region: inputBand }, signal);
        pasted = await this.ocr(pastedFrame, signal, { region: inputBand, scale:3 });
        inputCheck = verifyOcrContains(text, pasted.lines, { minRatio:.5 });
        landed = pastedBand.dark > preBand.dark + 120;
      }
      // 超短中文(如「你好」)在系统 OCR 下是形近字重灾区(真机:你好→亻子,任何倍率/紧裁剪/
      // 二值化都读不出),OCR 路线对它天然失效。改用行为链证明「出现在带内的就是输入框里
      // 随我们粘贴出现的内容」:清空应回落到基准,再次粘贴应再次出现。
      let behavioral = false;
      if (!inputCheck.ok && landed && flattenForMatch(text).length <= 8) {
        await this.invoke({ action:'key', key:'ctrl+a' }, signal);
        await wait(150, signal);
        await this.invoke({ action:'key', key:'Delete' }, signal);
        await wait(300, signal);
        const clearedFrame = await this.captureWindow(snapshot.windowId, signal);
        const clearedBand = await this.invoke({ action:'hash', image: clearedFrame.toString('base64'), region: inputBand }, signal);
        await this.invoke({ action:'click', x: Math.round(b.X + point.x*b.Width), y: Math.round(b.Y + point.y*b.Height) }, signal);
        await wait(200, signal);
        await this.invoke({ action:'paste', text }, signal);
        await wait(700, signal);
        cancelled(signal);
        const againFrame = await this.captureWindow(snapshot.windowId, signal);
        const againBand = await this.invoke({ action:'hash', image: againFrame.toString('base64'), region: inputBand }, signal);
        const collapsed = Math.abs(clearedBand.dark - preBand.dark) <= 60;
        const reappeared = againBand.dark > preBand.dark + 120;
        check(collapsed && reappeared,'CHAT_SEND_VERIFY',`输入框内容过短无法用 OCR 核验，行为核验也未通过(清空回落:${collapsed?'正常':'异常'}，再次粘贴:${reappeared?'正常':'异常'})，已取消发送；请手动检查微信输入框。`,409);
        behavioral = true;
      }
      check((inputCheck.ok && landed) || behavioral,'CHAT_SEND_VERIFY',`输入框内容未通过核验(画面变化 ${landed?'有':'无'}，匹配率 ${inputCheck.ratio})，已取消发送；请手动检查微信输入框。`,409);
      cancelled(signal);
      await this.invoke({ action:'key', key:'Return' }, signal);
      await wait(900, signal);
      cancelled(signal);
      const sentFrame = await this.captureWindow(snapshot.windowId, signal);
      const sent = await this.ocr(sentFrame, signal, { scale:2 });
      const sentCheck = verifyOcrContains(text, sent.lines, { minRatio:.55 });
      let sentVerified = sentCheck.ok;
      if (!sentVerified && behavioral) {
        // 短文本已发证据:输入框回落到基准(内容离开输入框)+ 消息区画面发生变化。
        const boxAfter = await this.invoke({ action:'hash', image: sentFrame.toString('base64'), region: inputBand }, signal);
        const areaAfter = await this.invoke({ action:'hash', image: sentFrame.toString('base64'), region: validateRegion(c.messageRegion) }, signal);
        sentVerified = boxAfter.dark <= preBand.dark + 60 && Math.abs(areaAfter.dark - msgPre.dark) >= 40;
      }
      check(sentVerified,'CHAT_SEND_VERIFY',`发送后未在会话窗口核验到消息内容(匹配率 ${sentCheck.ratio})；如已发出请人工确认，未发出请在微信中手动发送。`,409);
      return { text, fingerprint:createHash('sha256').update(text).digest('hex'), evidence:{ image:sentFrame.toString('base64'), lines:sent.lines, observedTitle:binding.title, coverage:'verified-send', mode: behavioral?'behavioral':'ocr', inputRatio:inputCheck.ratio, sentRatio:sentCheck.ratio } };
    });
  }
}
