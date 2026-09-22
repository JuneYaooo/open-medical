import { check } from '../errors.mjs';

// A bounded reader for intake: compact text with stable file/line provenance,
// explicit continuation, and a coverage gate before a clinical draft is proposed.
export function configureIntakeTools(registry, workspace, saveNotes = () => {}, initialNotes = []) {
  const allowed = new Set(['read_skill', 'read_source', 'read_intake_batch', 'search_materials', 'patient_create_propose', 'read_context_archive', 'save_intake_notes', 'read_intake_notes']);
  for (const name of registry.tools.keys()) if (!allowed.has(name)) registry.tools.delete(name);
  const seen = new Map(), notes = structuredClone(initialNotes);
  let awaitingNotes = null;
  const selected = context => (context.sources || []).filter(source => workspace.materials.some(file => file.id === source.id));
  const record = (id, line) => { if (!seen.has(id)) seen.set(id, new Set()); seen.get(id).add(line); };
  for (const note of notes) for (const source of note.sources) {
    const file = workspace.materials.find(file => file.id === source.sourceId);
    check(file && source.startLine >= 1 && source.endLine <= file.text.split('\n').length, 'INTAKE_CHECKPOINT', '已有笔记与资料不一致，请重新整理');
    for (let line = source.startLine; line <= source.endLine; line++) record(source.sourceId, line);
  }
  const reader = registry.get('read_source');
  const read = reader.execute;
  reader.execute = async (args, context) => {
    check(!awaitingNotes && selected(context).every(source => seen.get(source.id)?.size === source.text.split('\n').length), 'INTAKE_USE_BATCH', '请先用 read_intake_batch 和 save_intake_notes 读完并保存全部批次，再用 read_source 核对个别原文');
    const result = await read(args, context);
    for (const line of result.lines) record(result.sourceId, line.line);
    return result;
  };
  registry.register({
    permission: 'tools.execute', capability: { backend: 'local' },
    definition: { type: 'function', function: {
      name: 'read_intake_batch', description: '按顺序读取本次建档资料的完整识别原文。默认从头读，每批最多5份且约14000字符，含来源行号。按返回的 nextCursor 继续，直到 complete=true，再提交建档提案。',
      parameters: { type: 'object', properties: { fileIndex: { type: 'integer', minimum: 0 }, startLine: { type: 'integer', minimum: 1 } }, additionalProperties: false },
    } },
    execute: (args, context) => {
      const sources = selected(context);
      if (awaitingNotes) return { awaitingNotes: true, batchId: awaitingNotes.batchId, instruction: '先调用 save_intake_notes 保存刚读批次的患者身份、临床事实和来源，再继续读取。' };
      if (sources.length && sources.every(source => seen.get(source.id)?.size === source.text.split('\n').length)) return { complete: true, nextCursor: null, instruction: '全部资料已经读完且各批笔记已保存。不要重复读取，调用 read_intake_notes 取回事实笔记后立即生成 patient_create_propose。需要核对个别原文时用 read_source。' };
      // The server owns the cursor. A compacted model must not reread the first
      // batch or skip a later file simply because it forgot the returned cursor.
      let index = sources.findIndex(source => seen.get(source.id)?.size !== source.text.split('\n').length);
      if (index < 0) return { complete: true, nextCursor: null, materials: [] };
      let line = sources[index].text.split('\n').findIndex((_, i) => !seen.get(sources[index].id)?.has(i + 1)) + 1, chars = 0;
      const materials = [];
      while (index < sources.length && materials.length < 5 && chars < 14000) {
        const source = sources[index], lines = source.text.split('\n');
        check(line <= lines.length, 'INVALID_CURSOR', '行号超出资料范围');
        const chunk = [], startLine = line;
        while (line <= lines.length) {
          const value = `${line}: ${lines[line - 1]}`;
          check(value.length <= 14000, 'SOURCE_LINE_LIMIT', '单行资料过长，请拆分长文本后重新上传');
          if (chars + value.length > 14000) break;
          chunk.push(value); chars += value.length + 1; record(source.id, line++);
        }
        if (chunk.length) materials.push({ sourceId: source.id, name: source.name, startLine, endLine: line - 1, text: chunk.join('\n') });
        if (line <= lines.length) break;
        index++; line = 1;
      }
      const result = { batchId: `batch-${notes.length + 1}`, materials, complete: index === sources.length, nextCursor: index < sources.length ? { fileIndex: index, startLine: line } : null, readOnly: true };
      awaitingNotes = result;
      return { ...result, instruction: '先调用 save_intake_notes 记录本批身份、病程、诊断、用药、过敏、检验日期数值单位和来源，再按 nextCursor 继续。notes 控制在10000字符内，仅写事实。' };
    },
  });
  registry.register({
    permission: 'tools.execute', capability: { backend: 'local' },
    definition: { type: 'function', function: { name: 'save_intake_notes', description: '保存当前待读批次的事实笔记，不必提供 batchId，系统自动关联。重复提交返回已保存回执。避免长对话压缩后遗忘。保留姓名、关键诊疗事实、日期数值单位、疑似限定词、冲突和文件行号。不创建患者。', parameters: { type: 'object', properties: { batchId: { type: 'string' }, notes: { type: 'string', minLength: 1, maxLength: 10000 } }, required: ['notes'], additionalProperties: false } } },
    execute: args => {
      const prior = args.batchId ? notes.find(note => note.batchId === args.batchId) : !awaitingNotes ? notes.at(-1) : null;
      if (prior) return { intakeNotesSaved: true, ...prior.receipt, alreadySaved: true, instruction: '本批已保存，无需再次提交；继续 read_intake_batch。complete 为 true 时读取事实笔记并提交建档提案。' };
      check(awaitingNotes, 'INTAKE_BATCH', '请先用 read_intake_batch 读取下一批资料');
      check(!args.batchId || awaitingNotes.batchId === args.batchId, 'INTAKE_BATCH', `当前批次为 ${awaitingNotes.batchId}，请不传 batchId 再保存`);
      const result = { intakeNotesSaved: true, complete: awaitingNotes.complete, nextCursor: awaitingNotes.nextCursor, batchesSaved: notes.length + 1 };
      const note = { batchId: awaitingNotes.batchId, sources: awaitingNotes.materials.map(({ sourceId, name, startLine, endLine }) => ({ sourceId, name, startLine, endLine })), notes: args.notes, receipt: result };
      saveNotes(structuredClone([...notes, note]));
      notes.push(note);
      awaitingNotes = null;
      return result;
    },
  });
  registry.register({
    permission: 'tools.execute', capability: { backend: 'local' },
    definition: { type: 'function', function: { name: 'read_intake_notes', description: '读取已保存的建档事实笔记。每次读取1批；按 nextIndex 继续，完整核对后生成提案。笔记是提取结果，必要时按 sourceId 和行号核对原文。', parameters: { type: 'object', properties: { index: { type: 'integer', minimum: 0 } }, additionalProperties: false } } },
    execute: args => { const index = args.index || 0; return { notes: notes.slice(index, index + 1), nextIndex: index + 1 < notes.length ? index + 1 : null, batchesSaved: notes.length }; },
  });
  const proposal = registry.get('patient_create_propose'), propose = proposal.execute;
  proposal.execute = (args, context) => {
    check(!awaitingNotes, "INTAKE_NOTES_REQUIRED", "请先保存最后一批事实笔记");
    const sources = selected(context);
    for (const [index, source] of sources.entries()) {
      const missing = source.text.split('\n').findIndex((_, i) => !seen.get(source.id)?.has(i + 1));
      check(missing === -1, 'INTAKE_NOT_READ', `还有资料未读完，请调用 read_intake_batch，fileIndex=${index}，startLine=${missing + 1}，按 nextCursor 读完后再提交草稿`);
    }
    return propose(args, context);
  };
}
