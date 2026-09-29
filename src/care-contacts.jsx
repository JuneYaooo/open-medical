import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Search, Send, UserPlus, Users } from "lucide-react";
import { api } from "./agent-runtime";
import { Modal } from "./components";

const VIEWS = [["suggested", "待确认匹配"], ["unmatched", "未关联"], ["bound", "已关联"], ["groups", "客户群"]];
const TASK = { draft: "草稿", submitting: "正在提交", awaiting_member: "待群主发送", sent: "已发送", rejected: "企业微信未接受", delivery_failed: "发送未完成", unknown: "结果待核实" };
const RELATION = { self: "本人", family: "家属" };
const fmt = (value) => value ? new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
const day = (value) => value ? new Date(value).toLocaleDateString("zh-CN") : "";

// Remark, phone, tags and groups of one WeCom customer, as the member sees them.
export function ContactFacts({ contact }) {
  return <p className="care-contact-facts">
    {contact.remark && contact.remark !== contact.name && <span>微信昵称 {contact.name}</span>}
    {contact.mobiles?.length > 0 && <span>备注电话 {contact.mobiles.join("、")}</span>}
    {contact.description && <span>描述 {contact.description}</span>}
    {contact.tags?.map((t) => <span key={t} className="care-tag">{t}</span>)}
    {contact.groups?.length > 0 && <span>所在群 {contact.groups.map((g) => g.name).join("、")}</span>}
    {contact.addedAt && <span>{day(contact.addedAt)} 添加 · 负责人 {contact.member}</span>}
  </p>;
}

// Links a customer to a patient after the doctor picked 本人/家属; returns the notice text.
export async function linkContact(contact, patientId, relationship) {
  const b = await api("/api/wecom/bindings", "POST", { patientId, member: contact.member, external: contact.external, relationship, confirmed: true });
  const w = b.remarkWriteBack;
  return w?.ok && w.remark && !w.skipped ? `已关联，企业微信备注已改为「${w.remark}」。` : w && !w.ok ? `已关联。企业微信备注未能修改：${w.detail}` : "已关联。";
}

export function CareContacts({ onOpenPatient, onSetup }) {
  const [view, setView] = useState(null);
  const [query, setQuery] = useState("");
  const [data, setData] = useState(null);
  const [groups, setGroups] = useState(null);
  const [patients, setPatients] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [broadcast, setBroadcast] = useState(null);
  const [openGroup, setOpenGroup] = useState(null);

  const load = useCallback(async () => {
    try {
      const q = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
      const [contacts, groupList] = await Promise.all([api(`/api/wecom/contacts${q}`), api(`/api/wecom/groups${q}`)]);
      setData(contacts); setGroups(groupList); setError("");
      // Open where the work is: confirmations first, then unlinked customers.
      setView((v) => v || (contacts.counts.suggested ? "suggested" : contacts.counts.unmatched ? "unmatched" : groupList.groups.length ? "groups" : "bound"));
    } catch (e) { setError(e.message); }
  }, [query]);
  useEffect(() => { const t = setTimeout(load, query ? 250 : 0); return () => clearTimeout(t); }, [load, query]);
  useEffect(() => { api("/api/patients?summary=1").then((v) => setPatients(v.patients || [])).catch(() => {}); }, []);

  async function act(key, run) {
    setBusy(key); setError(""); setNotice("");
    try { const message = await run(); if (message) setNotice(message); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(""); }
  }
  const sync = () => act("sync", async () => { const s = await api("/api/wecom/directory/sync", "POST", {}); return `已同步 ${s.contacts} 位客户、${s.groups} 个客户群。`; });
  const link = (c, patientId, relationship) => act(c.external + "link", () => linkContact(c, patientId, relationship));
  const createAndLink = (c) => act(c.external + "create", async () => {
    const created = await api("/api/patients", "POST", { name: (c.remark || c.name).slice(0, 40), ...(c.mobiles?.[0] ? { phone: c.mobiles[0] } : {}) });
    const patient = created.patient || created;
    setPatients((list) => [...list, patient]);
    return `已新建患者「${patient.name}」。${await linkContact(c, patient.id, "self")}`;
  });

  if (!data && !error) return <p role="status" className="care-loading"><Loader2 size={16} className="spin" />正在读取客户…</p>;
  const status = data?.status || groups?.status;
  if (status && !status.configured) return <div className="care-empty">
    <p>还没有接入企业微信客户联系。接入后，助理企业微信里的客户和客户群会自动同步到这里，系统会推荐每位客户对应的患者，你点一下确认即可。</p>
    <button type="button" className="primary" onClick={onSetup}>打开接入向导</button>
  </div>;
  const counts = { ...(data?.counts || {}), groups: groups?.groups.length || 0 };
  const list = (data?.contacts || []).filter((c) => c.state === view);

  return <section className="care-contacts" aria-label="客户与群">
    <p className="care-channels">
      <span>共 <b>{status?.contacts ?? 0}</b> 位客户，已关联 <b>{status?.bound ?? 0}</b> 位 · <b>{status?.groups ?? 0}</b> 个客户群</span>
      <span className={status?.lastError ? "care-warn" : ""}>{status?.syncing ? "正在同步…" : status?.lastError ? `同步失败：${status.lastError}` : status?.lastSyncAt ? `每 6 小时自动同步 · 上次 ${fmt(status.lastSyncAt)}` : "尚未同步"}</span>
      {status?.groupsError && <span className="care-warn">客户群同步失败：{status.groupsError}</span>}
      <button type="button" className="secondary care-sync" disabled={Boolean(busy) || status?.syncing} onClick={sync}><RefreshCw size={14} className={busy === "sync" ? "spin" : ""} />立即同步</button>
    </p>
    <div className="care-contacts-bar">
      <nav className="care-tabs" aria-label="客户分类">
        {VIEWS.map(([id, label]) => <button key={id} type="button" aria-pressed={view === id} onClick={() => setView(id)}>{label}{counts[id] ? <em className={id === "suggested" ? "" : "muted"}>{counts[id]}</em> : null}</button>)}
      </nav>
      <label className="care-search"><Search size={15} /><input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索昵称、备注、电话、标签或患者" aria-label="搜索客户" /></label>
    </div>
    {error && <p role="alert" className="care-error">{error}</p>}
    {notice && <p role="status" className="care-notice">{notice}</p>}

    {view === "suggested" && <>
      <p className="care-hint">系统根据备注手机号、备注里的姓名或编号、微信客服记录推荐了对应的患者。核实后点「是本人」或「是家属」；关联后企业微信里的备注会自动改为「姓名·编号」。</p>
      {!list.length ? <p className="care-empty">没有待确认的匹配。</p> : <ul className="care-list">{list.map((c) => {
        const top = c.suggestion.candidates[0];
        return <li key={c.member + c.external} className="care-card">
          <header><strong>{c.displayName}</strong>{c.type === "wecom" && <span className="care-tag">企业微信用户</span>}</header>
          <ContactFacts contact={c} />
          <div className="care-suggest">
            <p>可能是 <button type="button" className="link" onClick={() => onOpenPatient?.(top.patientId)}>{top.patientName}{top.patientNumber ? `（${top.patientNumber}）` : ""}</button>
              <small>依据：{top.reasons.join("；")}</small></p>
            {c.suggestion.candidates.length > 1 && <p className="care-hint">也可能是：{c.suggestion.candidates.slice(1).map((x) => x.patientName).join("、")}</p>}
          </div>
          <footer>
            <PatientPicker patients={patients} disabled={Boolean(busy)} label="换成其他患者" onPick={(id) => link(c, id, c.suggestion.relationship)} />
            {["self", "family"].map((rel) => <button key={rel} type="button" className={rel === c.suggestion.relationship ? "primary" : "secondary"} disabled={Boolean(busy)} onClick={() => link(c, top.patientId, rel)}>
              {busy === c.external + "link" ? "正在关联…" : `是${RELATION[rel]}`}</button>)}
          </footer>
        </li>;
      })}</ul>}
    </>}

    {view === "unmatched" && <>
      <p className="care-hint">这些客户没有找到对应的患者。可以选择已有患者，或用备注和电话直接新建患者档案。</p>
      {!list.length ? <p className="care-empty">所有客户都已关联或有推荐。</p> : <ul className="care-list compact">{list.map((c) =>
        <li key={c.member + c.external} className="care-card">
          <header><strong>{c.displayName}</strong>{c.type === "wecom" && <span className="care-tag">企业微信用户</span>}</header>
          <ContactFacts contact={c} />
          <footer>
            <PatientPicker patients={patients} disabled={Boolean(busy)} label="关联到已有患者（本人）" onPick={(id) => link(c, id, "self")} />
            <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => createAndLink(c)}><UserPlus size={14} />{busy === c.external + "create" ? "正在新建…" : `新建患者「${(c.remark || c.name).slice(0, 12)}」`}</button>
          </footer>
        </li>)}</ul>}
    </>}

    {view === "bound" && (!list.length ? <p className="care-empty">还没有关联的客户。</p> : <ul className="care-list compact">{list.map((c) =>
      <li key={c.member + c.external} className="care-card">
        <header><strong>{c.displayName}</strong>{c.bindings.map((b) => <button key={b.id} type="button" className="link" onClick={() => onOpenPatient?.(b.patientId)}>{b.patientName} · {RELATION[b.relationship]}</button>)}</header>
        <ContactFacts contact={c} />
        <footer>{c.bindings.map((b) => <button key={b.id} type="button" className="secondary" disabled={Boolean(busy)} onClick={() => { if (window.confirm(`解除「${c.displayName}」与患者 ${b.patientName} 的关联？`)) act(b.id, async () => { await api(`/api/wecom/bindings/${b.id}`, "DELETE"); return "已解除关联。"; }); }}>解除与 {b.patientName} 的关联</button>)}</footer>
      </li>)}</ul>)}

    {view === "groups" && (!groups?.groups.length ? <p className="care-empty">没有同步到客户群。助理在企业微信里建的客户群会出现在这里。</p> : <>
      <p className="care-hint">群发会生成企业微信群发任务，群主在企业微信里点「发送」后才会发到群里。群聊内容本身不会被收集。</p>
      <ul className="care-list compact">{groups.groups.map((g) => <li key={g.chatId} className="care-card">
        <header><strong><Users size={15} /> {g.name}</strong><span className="care-tag">{g.memberCount} 人 · 客户 {g.customerCount}</span><span className="care-hint">群主 {g.owner}</span></header>
        <p className="care-contact-facts">
          {g.patients.length ? <>群里的患者：{g.patients.map((p) => <button key={p.patientId} type="button" className="link" onClick={() => onOpenPatient?.(p.patientId)}>{p.patientName}{p.relationship === "family" ? "（家属）" : ""}</button>)}</> : <span>群里还没有已关联的患者</span>}
          {g.unlinkedCustomers > 0 && <span>另有 {g.unlinkedCustomers} 位客户未关联</span>}
        </p>
        {g.notice && <blockquote>{g.notice}</blockquote>}
        {openGroup?.chatId === g.chatId && <GroupDetail group={openGroup} busy={busy} onRefresh={(task) => act(task.id, async () => { const t = await api(`/api/wecom/group-tasks/${task.id}/refresh`, "POST", {}); setOpenGroup(await api(`/api/wecom/groups/${encodeURIComponent(g.chatId)}`)); return t.detail; })} />}
        <footer>
          <button type="button" className="secondary" onClick={() => openGroup?.chatId === g.chatId ? setOpenGroup(null) : api(`/api/wecom/groups/${encodeURIComponent(g.chatId)}`).then(setOpenGroup).catch((e) => setError(e.message))}>{openGroup?.chatId === g.chatId ? "收起" : "成员与群发记录"}</button>
          <button type="button" className="primary" onClick={() => setBroadcast({ group: g, text: "", requestId: crypto.randomUUID() })}><Send size={14} />群发消息</button>
        </footer>
      </li>)}</ul>
    </>)}

    {broadcast && <Modal title={`群发到「${broadcast.group.name}」`} onClose={() => setBroadcast(null)}>
      <div className="care-confirm">
        <label>内容<textarea rows={5} maxLength={2000} value={broadcast.text} onChange={(e) => setBroadcast({ ...broadcast, text: e.target.value })} placeholder="如：本周五下午门诊停诊一次，复诊请改约下周。" /></label>
        <p className="care-hint">群里有 {broadcast.group.customerCount} 位客户。不要在群里发个人病情。确认后，群主 {broadcast.group.owner} 会在企业微信收到群发任务，点发送后才会发出。</p>
        <footer><button type="button" className="secondary" onClick={() => setBroadcast(null)}>取消</button>
          <button type="button" className="primary" disabled={!broadcast.text.trim() || Boolean(busy)} onClick={() => { const b = broadcast; act("broadcast", async () => {
            const draft = await api("/api/wecom/group-tasks", "POST", { chatId: b.group.chatId, text: b.text, requestId: b.requestId });
            const task = await api(`/api/wecom/group-tasks/${draft.id}/submit`, "POST", { confirmed: true });
            setBroadcast(null);
            return task.detail;
          }); }}>{busy === "broadcast" ? "正在提交…" : "确认，交给群主发送"}</button></footer>
      </div>
    </Modal>}
  </section>;
}

function PatientPicker({ patients, onPick, label, disabled }) {
  return <select className="care-picker" aria-label={label} value="" disabled={disabled} onChange={(e) => e.target.value && onPick(e.target.value)}>
    <option value="">{label}…</option>
    {patients.filter((p) => !p.archived).map((p) => <option key={p.id} value={p.id}>{p.name}{p.patientNumber ? ` · ${p.patientNumber}` : ""}</option>)}
  </select>;
}

function GroupDetail({ group, busy, onRefresh }) {
  const customers = group.members.filter((m) => m.external), staff = group.members.filter((m) => !m.external);
  return <div className="care-group-detail">
    <p className="care-hint">客户 {customers.length} 位：{customers.map((m) => m.patients.length ? `${m.name || "未命名"}（${m.patients.map((p) => p.patientName).join("、")}）` : m.name || "未命名").join("、") || "无"}</p>
    <p className="care-hint">企业成员：{staff.map((m) => m.name || m.id).join("、") || "无"}</p>
    {group.tasks.length > 0 && <ul className="care-group-tasks">{group.tasks.map((t) => <li key={t.id}>
      <span>{fmt(t.createdAt)} · {TASK[t.status] || t.status}</span><p>{t.text}</p>
      {t.status === "awaiting_member" && <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => onRefresh(t)}>查询发送结果</button>}
    </li>)}</ul>}
  </div>;
}
