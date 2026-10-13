import { learningPrefs } from "./personal-context.mjs";
const learningEnabled = db => learningPrefs(db).habits;
import { check } from '../errors.mjs';

// Intake execution belongs to the server, not an HTTP connection or modal.
export class IntakeJobs {
  constructor(bridge, pending) {
    this.bridge = bridge; this.pending = pending; this.active = new Map();
    for (const w of bridge.service.store.list()) {
      if (w.intakeJob?.status === 'running') this.save(w.id, { status: 'interrupted', progress: '应用已退出，资料和处理记录已保存，可继续处理。' });
    }
  }
  save(id, patch) {
    this.bridge.service.store.update(id, w => { w.intakeJob = { ...w.intakeJob, ...patch, updatedAt: new Date().toISOString() }; });
    return this.get(id);
  }
  get(id) { return this.bridge.requireSessionWorkspace(id).intakeJob || null; }
  drafts(id) { return this.pending.list({ type: 'patient-create', sourceSessionId: id }); }
  start(id, { correction = '', externalConsent, reviewMode = 'preserve' } = {}) {
    const w = this.bridge.requireSessionWorkspace(id);
    check(externalConsent === true, 'CONSENT_REQUIRED', '请确认使用当前模型处理资料');
    check(typeof correction === 'string' && correction.length <= 10000, 'INVALID_INPUT', '补充内容过长');
    check(!this.active.has(id) && !this.bridge.service.active.has(id), 'RUN_ACTIVE', '该建档任务正在后台处理', 409);
    check(!w.patientId, 'PATIENT_SESSION', '请为新患者创建独立的建档任务', 409);
    check(w.materials?.length, 'NO_MATERIALS', '没有可解析的资料');
    check(!this.pending.list({status:'applied', type:'patient-create', sourceSessionId:id, limit:1}).length, 'ALREADY_CREATED', '该任务已完成建档', 409);
    const remembered = this.pending.doctor && learningEnabled(this.pending.store.db) ? this.pending.doctor.extractStated(correction, { via: 'intake-correction' }) : [];
    const changes = this.drafts(id).map(d => this.pending.reviewCorrection(d.id, reviewMode)).filter(Boolean).join('\n');
    if (changes) correction = `请在新草稿保留医生的手动修改：\n${changes}\n${correction}`;
    check(correction.length <= 30000, 'INVALID_INPUT', '修改内容过长，请分批整理');
    const control = new AbortController();
    const entry = { control, promise: null };
    this.active.set(id, entry);
    this.save(id, { remembered, status: 'running', progress: '已进入后台，准备识别资料…', error: '', reply: '', startedAt: new Date().toISOString() });
    entry.promise = this.run(id, correction, control.signal).finally(() => this.active.delete(id));
    return this.get(id);
  }
  async run(id, correction, signal) {
    try {
      const saved = this.bridge.get(id), ready = [];
      const failures = (saved.intakeIssues || []).filter(i => i.stage === 'upload');
      for (const [index, file] of saved.files.entries()) {
        signal.throwIfAborted();
        this.save(id, {progress:`识别资料 ${index + 1}/${saved.files.length}：${file.name}`});
        try { ready.push(await this.bridge.prepareMaterial(id, file.id, { signal })); }
        catch (err) { signal.throwIfAborted(); failures.push({name:file.name, error:err.message, stage:'ocr'}); }
        this.bridge.saveIntakeIssues(id, failures);
      }
      signal.throwIfAborted();
      check(ready.length, 'NO_READABLE_MATERIALS', '这些资料暂未识别出可用文字，请更换清晰文件后重试。');
      const drafts = this.drafts(id);
      check(drafts.length <= 1, 'MULTIPLE_DRAFTS', '该任务有多个建档草稿，请打开工作区核对。');
      // Keep the editable draft available until a replacement is successfully proposed.
      this.save(id, {progress:`已读取 ${ready.length} 份资料，正在整理患者档案…`});
      const prepared = this.bridge.prepareSend(id, {
        mode:'model', workflow:'patient-intake', externalConsent:true, fileIds:ready.map(f=>f.id), skills:['medical-record'], isolatedContext:true,
        message: intakePrompt(ready.length, failures.length, correction),
      });
      let reply = '';
      const result = await this.bridge.executeSend(prepared, event => {
        if (event.type === 'message.delta') reply = (reply + (event.payload?.text || event.payload?.delta || '')).slice(-20000);
        if (event.type === 'tool.complete') this.save(id, {progress:event.payload?.tool === 'save_intake_notes' ? `已识别 ${ready.length} 份资料，已保存 ${event.payload.batchesSaved || 0} 批事实笔记` : '正在核对资料并整理档案…'});
      });
      signal.throwIfAborted();
      check(result.status === 'completed', 'INTAKE_FAILED', result.error || '本次处理未完成，请继续处理');
      const hasDraft = this.drafts(id).length > 0;
      // 跑完却没有草稿分两种：模型在提问（回复以问号收尾，或明确说需要
      // 补充什么），或是输出被截断、提案工具没调用成——前者等医生补充，
      // 后者该直接重试，别让医生对着一句英文叙述猜要补什么。
      const asksQuestion = /[?？]\s*["」』']?\s*$/.test((reply || '').trim())
        || /请补充|需要补充|请提供|请告知|请确认|请说明/.test(reply || '');
      const claimsDraft = /(?:已(?:经)?(?:成功|为您|为你|一次性){0,2}(?:调用\s*`?patient_create_propose|提交|生成|创建)[\s\S]{0,50}(?:草稿|提案))|(?:草稿|提案)已(?:经)?(?:成功)?(?:提交|生成|创建)/.test(reply);
      check(hasDraft || !claimsDraft, 'INTAKE_DRAFT_MISSING', '未生成可核对的档案草稿。资料已保存，请重试。');
      this.save(id, {status:'needs_input', reply, progress:hasDraft
        ? '档案草稿已生成，等待你核对确认'
        : asksQuestion
          ? '需要补充信息，请查看说明后继续'
          : '模型未完成草稿提交（输出中断），请点「继续解析已保存资料」重试，资料无需重新上传'});
    } catch (err) {
      this.save(id, {status:signal.aborted ? 'interrupted' : 'failed', error:signal.aborted ? '' : err.message, progress:signal.aborted ? '已停止，资料和处理记录已保存，可继续处理。' : '处理未完成，资料已保存，无需重新上传。'});
    }
  }
  cancel(id) { const entry=this.active.get(id); entry?.control.abort(); this.bridge.cancel(id); return !!entry; }
  async stop() { for(const id of this.active.keys()) this.cancel(id); await Promise.allSettled([...this.active.values()].map(e=>e.promise)); }
}

function intakePrompt(count, failures, correction) {
  return `请自动解析所选 ${count} 份病例资料并为一位患者建档。全程用中文向医生叙述。图片和扫描页已完成本地文字识别，read_source 可读取识别全文，不要再次逐张 inspect_image。使用 read_intake_batch 从头读取，每批立即用 save_intake_notes 保存带来源的完整临床事实再继续 nextCursor。直到 complete=true 后，用 read_intake_notes 取回全部笔记（按 nextIndex 连续读取），调用 read_personal_context 读取适用的习惯与参考，再生成提案，不要重复扫描全部原文。仅有具体冲突时 read_source 核对对应行。提取患者身份、诊断、用药、过敏、检验和就诊经历。诊断列表一条只写一个临床问题：name 用规范病名，status 区分确诊（confirmed）/疑似待排（suspected）/影像检验偶然发现（finding）/待核对（needs_review），依据与 OCR 疑点写 note；同一诊断的多份材料合并为一条并在 sources 列全来源；清单页无数值、OCR 歧义等资料核对事项不建诊断条目，放 note。clinicalSummary 必须单独写可读的病史摘要（text 与 source），按时间交代疾病、治疗、复查及最新资料，疑似不改为确诊；note 仅存资料核对备注，身份编号和 OCR 冲突不能代替病史摘要。保留来源，区分疑似与确诊，不推算出生年，不补造缺失内容。核对已有患者避免重复建档。资料足够时必须调用 patient_create_propose 生成待核对草稿，不能直接写入；调用时一次完成、不要分段输出草稿内容；仅当身份不清、材料属于多人或无法读取时用简短中文问题说明需要补充什么。不要要求用户重新填写材料已有的信息。材料较多时必须压缩提案规模：诊断最多 12 条（优先确诊与主要问题）、用药只列当前在用、检验只列关键异常项、就诊保留疗程关键节点（入院、手术/介入、出院、复查，最多 12 条），来源一律一行一条写文件名；宁可精简也不要让提案被输出上限截断——没写全的细节，建档后可用档案更新提案继续补充。${failures ? `本批有 ${failures} 份资料读取失败，未纳入本次整理，必须在摘要中标明资料不完整。` : ''}${correction.trim() ? `\n用户补充或纠正：${correction.trim()}` : ''}`;
}
