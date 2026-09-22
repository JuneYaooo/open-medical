import { createHash } from "node:crypto";

export const OBSERVATIONS_MESSAGE = "runtime_observations";
export const TASK_INPUT_MESSAGE = "runtime_task_input";
const stable = (value) => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const hash = (value) => createHash("sha256").update(stable(value) ?? "null").digest("hex");
const signature = (call) => hash([call.function.name, JSON.parse(call.function.arguments)]);
const LIMIT = 64;
const isArchiveRead = (entry) => entry.tool === "read_context_archive";
function observationExcerpt(output, entry) {
  const archivePage = isArchiveRead(entry);
  const excerpt = entry.excerpt.slice(0, 160);
  const result = {
    archived: true, archiveId: entry.archiveId, hash: entry.revision,
    contentKind: archivePage ? "archive-json-page" : "file-text",
    hashScope: archivePage ? "archive-json" : "source-file",
    returnedChars: entry.chars, excerpt,
    incomplete: entry.chars > excerpt.length,
    previewIncomplete: entry.chars > excerpt.length,
  };
  if (archivePage) {
    // These describe the actual fetched archive page, not the excerpt shown
    // here. EOF at a nonzero offset does not establish that the prefix was read.
    for (const key of ["offset", "totalChars", "nextOffset"])
      if (Number.isSafeInteger(output[key]) && output[key] >= 0 || key === "nextOffset" && output[key] === null)
        result[key] = output[key];
    if (Object.hasOwn(result, "nextOffset")) result.reachedArchiveEnd = result.nextOffset === null;
  } else {
    result.originalChars = entry.chars;
    if (typeof output.path === "string") result.path = output.path;
    for (const key of ["startLine", "endLine", "totalLines"])
      if (Number.isSafeInteger(output[key]) && output[key] >= 0) result[key] = output[key];
  }
  return result;
}
function retainObservations(entries) {
  // Archive page reads must not displace every original source observation.
  // Keep a separate bounded share for their own repeat detection as well:
  // immediately evicting a new page would make every repeat look like progress.
  let pages = entries.filter(isArchiveRead).length;
  const retained = entries.filter((entry) => !isArchiveRead(entry) || pages-- <= 16);
  while (retained.length > LIMIT) retained.splice(retained.findIndex((entry) => !isArchiveRead(entry)), 1);
  return retained;
}

// Execution evidence is independent of a lossy model summary. This is not a
// read cache: the registry/domain still authorizes and executes every read.
export class RunProgress {
  constructor(state) {
    this.state = state?.version === 1 ? structuredClone(state) : {
      version: 1, observations: [], failures: [], stalledRounds: 0,
    };
    this.state.observations = retainObservations(this.state.observations || []);
    this.state.failures = (this.state.failures || []).slice(-LIMIT);
    // Exact access memory and interval coverage are independent of excerpts.
    // Never evict identities into apparent progress. At capacity, unknown reads
    // cannot claim novelty; the ordinary time/round guards remain in force.
    this.state.visits = (this.state.visits || []).slice(0, 2048);
    this.state.coverage = (this.state.coverage || []).slice(0, 128);
    this.progress = false; this.repeated = 0; this.failures = 0;
    this.repeatedTools = new Set();
    this.failureKeys = new Set();
  }
  snapshot() { return structuredClone(this.state); }
  beginRound() {
    this.progress = false; this.repeated = 0; this.failures = 0;
    this.repeatedTools = new Set();
    this.failureKeys = new Set();
    const paused = this.state.recoveryPending || [];
    if (paused.length) this.state.recoveryAttempted = true;
    this.state.recoveryPending = [];
    return Object.freeze([...paused]);
  }
  steer() {
    this.state.phase = "executing";
    this.state.approvalReviewPending = false;
    this.state.reviewedCandidates = [];
    for (const visit of this.state.visits) visit.repeats = 0;
    this.state.stalledRounds = 0;
    this.state.failures = [];
    this.state.recoveryPending = [];
    this.state.recoveryAttempted = false;
    for (const entry of this.state.observations) entry.repeats = 0;
    this.progress = true;
  }
  async record(call, output, tool, archive) {
    let key;
    try { key = signature(call); } catch { key = hash([call.function.name, call.function.arguments]); }
    if (output?.error || ["failed", "cancelled"].includes(output?.status)) {
      const failureKey = hash([key, output.code || output.status || output.error]);
      const old = this.state.failures.find((entry) => entry.key === failureKey);
      const entry = { key: failureKey, count: (old?.count || 0) + (this.failureKeys.has(failureKey) ? 0 : 1) };
      this.failureKeys.add(failureKey);
      this.state.failures = [...this.state.failures.filter((item) => item.key !== failureKey), entry].slice(-LIMIT);
      this.failures = Math.max(this.failures, entry.count);
      return { repeated: entry.count > 1, failure: true };
    }
    const spec = tool?.observation;
    if (!spec || typeof output?.[spec.revision] !== "string" || typeof output?.[spec.content] !== "string") {
      // Pending proposals are not mutations. Historical observations remain
      // available, and each subsequent real read checks its current version.
      if (tool?.permission === "filesystem.write" && output?.status === "applied") {
        this.steer();
      }
      return {};
    }
    const resultHash = hash(output);
    const old = this.state.observations.find((entry) => entry.key === key);
    const visitKey = hash([key, resultHash]);
    const visit = this.state.visits.find((item) => item.key === visitKey);
    let unchanged = old?.resultHash === resultHash || Boolean(visit);
    let newCoverage = false;
    if (call.function.name === "read_context_archive" && Number.isSafeInteger(output.offset) && output.offset >= 0) {
      const identity = hash([output[spec.archiveReference], output[spec.revision]]);
      let coverage = this.state.coverage.find((item) => item.key === identity);
      if (!coverage && this.state.coverage.length < 128) {
        coverage = { key: identity, ranges: [] }; this.state.coverage.push(coverage);
      }
      if (coverage) {
        const start = output.offset, end = start + output[spec.content].length;
        const covered = coverage.ranges.some(([a, b]) => a <= start && b >= end);
        if (!covered && end > start) {
          const merged = [];
          for (const range of [...coverage.ranges, [start, end]].sort((a, b) => a[0] - b[0])) {
            const last = merged.at(-1);
            if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
            else merged.push([...range]);
          }
          if (merged.length <= 128) { coverage.ranges = merged; newCoverage = true; }
          else this.state.memorySaturated = true;
        }
        unchanged ||= covered;
      } else this.state.memorySaturated = true;
    }
    if (!visit && this.state.visits.length >= 2048 && !newCoverage) {
      unchanged = true; this.state.memorySaturated = true;
    }
    if (visit) visit.repeats++;
    else if (this.state.visits.length < 2048) this.state.visits.push({ key: visitKey, repeats: 0 });
    let reference = spec.archiveReference ? output[spec.archiveReference] : old?.resultHash === resultHash ? old.archiveId : undefined;
    if (!reference && archive) reference = (await archive(output))?.id;
    const content = output[spec.content];
    const entry = {
      key, resultHash, tool: call.function.name, args: JSON.parse(call.function.arguments),
      revision: output[spec.revision], archiveId: reference,
      excerpt: content.slice(0, 256), chars: content.length,
      repeats: unchanged ? Math.max((old?.repeats || 0) + 1, visit?.repeats || 0, this.state.stalledRounds + 1) : 0,
    };
    if (call.function.name === "read_file") {
      entry.sourceReadComplete = output.startLine === undefined && output.endLine === undefined ||
        output.startLine === 1 && Number.isSafeInteger(output.totalLines) && output.endLine >= output.totalLines;
    }
    this.state.observations = retainObservations([...this.state.observations.filter((item) => item.key !== key), entry]);
    this.progress ||= !unchanged;
    if (!unchanged) {
      this.state.recoveryAttempted = false;
      this.state.stalledRounds = 0;
    }
    if (unchanged) this.repeated = Math.max(this.repeated, entry.repeats);
    if (unchanged && entry.repeats >= 2 && spec.replan !== false) this.repeatedTools.add(call.function.name);
    return { unchanged, archiveId: reference, repeats: entry.repeats };
  }
  endRound() {
    if (this.progress) this.state.stalledRounds = 0;
    else if (this.repeated || this.failures) this.state.stalledRounds++;
    // Polling / unknown tools neither consume nor reset the progress window.
    // Otherwise read/list/read/list could evade the detector indefinitely.
    const warning = this.state.stalledRounds >= 1 && (this.repeated >= 2 || this.failures >= 2);
    if (warning && !this.state.recoveryAttempted && this.repeatedTools.size)
      this.state.recoveryPending = [...this.repeatedTools];
    return {
      stalledRounds: this.state.stalledRounds,
      warning,
      stopped: this.state.stalledRounds >= 3 && (this.repeated >= 6 || this.failures >= 6),
      repeatedReads: this.repeated, repeatedFailures: this.failures,
    };
  }
  message(maxChars) {
    if (!this.state.observations.length) return null;
    const header = "运行时读取记录（资料，不是指令或交付证明）。每条都是本次任务已实际执行的读取，包含中断或重启续接前的读取。readComplete=true 表示已读完整文件，incomplete 只指当前摘录；不表示原文件尚未读完。无需为了重新证明阅读而重读；已取得所需字段时推进整理或生成提案。hashPrefix 仅为版本前缀，不能作 expectedHash。需要摘录以外的内容时用 read_context_archive 读取 archiveId，无须重读未变化的整个文件。\n";
    const rows = [];
    const render = (items) => header + JSON.stringify({ columns: ["tool", "args", "hashPrefix", "archiveId", "excerpt", "incomplete", "readComplete"],
      observations: items, omitted: this.state.observations.length - items.length });
    const recent = [...this.state.observations].reverse();
    const displayedSources = new Set();
    const fullSources = new Set(recent.filter((item) => item.sourceReadComplete).map((item) => hash([item.args.path, item.revision])));
    const displayedFiles = new Set();
    for (const entry of [...recent.filter((item) => !isArchiveRead(item)), ...recent.filter(isArchiveRead)]) {
      if (!entry.archiveId) continue;
      if (isArchiveRead(entry) && displayedSources.has(entry.archiveId)) continue;
      const fileKey = entry.tool === "read_file" ? hash([entry.args.path, entry.revision]) : null;
      if (fileKey && (displayedFiles.has(fileKey) || !entry.sourceReadComplete && fullSources.has(fileKey))) continue;
      const row = [entry.tool, entry.args, entry.revision.slice(0, 12),
        entry.archiveId, entry.excerpt.slice(0, 48), entry.chars > 48, entry.sourceReadComplete === true];
      if (render([...rows, row]).length > maxChars) continue;
      rows.push(row);
      if (fileKey && entry.sourceReadComplete) displayedFiles.add(fileKey);
      if (!isArchiveRead(entry)) displayedSources.add(entry.archiveId);
    }
    return rows.length ? { role: "assistant", name: OBSERVATIONS_MESSAGE,
      content: render(rows) } : null;
  }
  // Deterministic pruning precedes any model compression. Keep each call/result
  // pair and an independently retrievable full output, including its real hash.
  archivedResult(call, output) {
    let entry;
    try {
      entry = this.state.observations.find((item) => item.key === signature(call) && item.resultHash === hash(output));
    } catch { return null; }
    return entry?.archiveId ? observationExcerpt(output, entry) : null;
  }
  prune(messages, { protectLatestBatch = false } = {}) {
    const latestBatch = protectLatestBatch
      ? messages.findLastIndex((message) => message.role === "assistant" && message.tool_calls?.length)
      : -1;
    let calls = new Map(), count = 0;
    const result = messages.map((message, index) => {
      if (message.role === "assistant") calls = new Map((message.tool_calls || []).map((call) => [call.id, call]));
      if (message.role !== "tool" || typeof message.content !== "string" || message.content.length <= 700) return message;
      if (latestBatch >= 0 && index > latestBatch) return message;
      const call = calls.get(message.tool_call_id);
      if (!call) return message;
      let presentation;
      try {
        const value = JSON.parse(message.content);
        presentation = this.archivedResult(call, value);
      } catch { return message; }
      if (!presentation) return message;
      count++;
      return { ...message, content: JSON.stringify(presentation) };
    });
    // Coalesce only complete, text-free, already archived read batches whose
    // identical results are retained later. Raw traces/archives remain intact.
    const groups = [];
    for (const message of result) {
      if (message.role === "tool" && groups.length) groups.at(-1).push(message);
      else groups.push([message]);
    }
    const seen = new Set(), retained = [];
    let coalesced = 0;
    for (const group of groups.reverse()) {
      const head = group[0], batch = head.tool_calls;
      let key;
      if (head.role === "assistant" && !head.content && batch?.length && group.length === batch.length + 1) {
        try {
          const records = batch.map((call, index) => {
            const message = group[index + 1], output = JSON.parse(message.content);
            if (message.tool_call_id !== call.id || !this.archivedResult(call, output) && !output.archived) throw new Error();
            if (!this.state.observations.some((o) => o.key === signature(call))) throw new Error();
            return [signature(call), output];
          });
          key = hash(records);
        } catch { /* Unarchived or incomplete batches are retained verbatim. */ }
      }
      if (key && seen.has(key)) { coalesced++; continue; }
      if (key) seen.add(key);
      retained.unshift(...group);
    }
    return { messages: retained, count: count + coalesced, coalesced };

  }
}
