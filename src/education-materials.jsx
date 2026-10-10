import { useState } from "react";
import { api } from "./agent-runtime";

// 患教素材工具条:新建素材进入待复核,已复核素材可按患者分组批量群发
// (走待确认托盘,确认后逐患者创建企业微信单发任务,成员仍需手动点发送)。
export function EducationTools({ onCreated, onProposed, onError }) {
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ title: "", body: "" });
  const [busy, setBusy] = useState(false);
  const [broadcast, setBroadcast] = useState(null);
  const create = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await api("/api/knowledge/education-materials", "POST", { title: form.title, body: form.body });
      setForm({ title: "", body: "" });
      setCreating(false);
      onCreated?.("患教素材已创建，核对内容后请把它标记为「来源已核对」，才会被智能回复引用。");
    } catch (e) {
      onError?.(e.message);
    } finally {
      setBusy(false);
    }
  };
  const startBroadcast = async () => {
    try {
      const [mats, patients] = await Promise.all([
        api("/api/knowledge/education-materials?reviewStatus=reviewed"),
        api("/api/patients?summary=1"),
      ]);
      const live = (patients.patients || []).filter((p) => !p.archived);
      const groups = [...new Set(live.flatMap((p) => p.groups || []))].sort((a, b) => a.localeCompare(b, "zh-CN"));
      setBroadcast({
        materials: mats.materials || [],
        patients: live,
        groups,
        materialId: mats.materials?.[0]?.id || "",
        group: groups[0] || "",
        customText: "",
      });
    } catch (e) {
      onError?.(e.message);
    }
  };
  const recipients = broadcast
    ? broadcast.patients.filter((p) => broadcast.group && (p.groups || []).includes(broadcast.group))
    : [];
  const propose = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const material = broadcast.materials.find((m) => m.id === broadcast.materialId);
      await api("/api/care/education-broadcast/propose", "POST", {
        materialId: broadcast.customText.trim() ? "" : broadcast.materialId,
        materialTitle: broadcast.customText.trim() ? "" : material?.title || "",
        text: broadcast.customText.trim() || undefined,
        patientIds: recipients.map((p) => p.id),
      });
      onProposed?.(`已创建患教群发提案（${recipients.length} 位患者），请到「待确认」托盘核对内容后确认执行。`);
      setBroadcast(null);
    } catch (e) {
      onError?.(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="education-tools" aria-label="患教素材工具">
      <div className="toolbar-actions">
        <button className="secondary" onClick={() => setCreating(!creating)}>{creating ? "收起新建" : "新建患教素材"}</button>
        <button className="secondary" onClick={startBroadcast}>按分组批量发送</button>
        <small className="muted">智能回复只引用「来源已核对」的素材；发送前请在素材上完成核对。</small>
      </div>
      {creating && (
        <form className="education-form" onSubmit={create}>
          <label>
            素材标题
            <input required maxLength={150} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="如：肝癌介入术后居家注意事项" />
          </label>
          <label>
            素材正文（患者能看懂的大白话；智能回复只转述这里写明的内容）
            <textarea required rows={8} maxLength={20000} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
          </label>
          <div className="toolbar-actions">
            <button className="primary" type="submit" disabled={busy || !form.title.trim() || !form.body.trim()}>{busy ? "保存中…" : "保存素材（待复核）"}</button>
            <button className="text-button" type="button" onClick={() => setCreating(false)}>取消</button>
          </div>
        </form>
      )}
      {broadcast && (
        <div className="education-broadcast" role="dialog" aria-label="按分组批量发送患教">
          <h4>按分组批量发送患教</h4>
          <div className="education-broadcast-row">
            <label>患者分组
              <select value={broadcast.group} onChange={(e) => setBroadcast({ ...broadcast, group: e.target.value })}>
                {!broadcast.groups.length && <option value="">（暂无患者分组）</option>}
                {broadcast.groups.map((group) => <option key={group} value={group}>{group}</option>)}
              </select>
            </label>
            <label>患教素材
              <select value={broadcast.materialId} onChange={(e) => setBroadcast({ ...broadcast, materialId: e.target.value, customText: "" })}>
                {!broadcast.materials.length && <option value="">（暂无已核对素材）</option>}
                {broadcast.materials.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
              </select>
            </label>
          </div>
          <p className="muted">将为本分组 {recipients.length} 位患者创建企业微信单发任务：{recipients.slice(0, 8).map((p) => p.name).join("、")}{recipients.length > 8 ? ` 等 ${recipients.length} 人` : ""}。确认提案后成员仍需在企业微信中手动点发送。</p>
          <div className="toolbar-actions">
            <button className="primary" disabled={busy || !recipients.length || (!broadcast.materialId && !broadcast.customText.trim())} onClick={propose}>{busy ? "创建中…" : "创建群发提案"}</button>
            <button className="text-button" onClick={() => setBroadcast(null)}>取消</button>
          </div>
        </div>
      )}
    </section>
  );
}
