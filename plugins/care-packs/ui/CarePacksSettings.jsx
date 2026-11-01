import { useEffect, useState } from "react";
import { api } from "../../../src/agent-runtime";
import { localCalendarDate } from "../../../shared/calendar-date.mjs";
import "./care-packs.css";

const OP = { gt: ">", lt: "<" };

function PackCard({ pack, patients, onChanged }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [patientId, setPatientId] = useState(""), [startDate, setStartDate] = useState(localCalendarDate());
  async function action(fn) {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const install = () => action(async () => {
    const result = await api(`/api/p/care-packs/packs/${pack.id}/install`, "POST", {});
    const imported = result.education.imported.length, skipped = result.education.skipped.length;
    setNotice(`已安装随访模板${imported ? `，导入 ${imported} 篇患教素材` : ""}${skipped ? `，${skipped} 篇同名素材已存在未覆盖` : ""}。`);
    await onChanged();
  });
  // The doctor reviewed the pack contents on this card and clicked enroll, so
  // the proposal is confirmed right away; it still leaves an audit record.
  const apply = () => action(async () => {
    const { proposal } = await api(`/api/p/care-packs/packs/${pack.id}/apply`, "POST", { patientId, startDate });
    const { applied } = await api(`/api/pending-actions/${proposal.id}/confirm`, "POST", {});
    const name = patients.find(p => p.id === patientId)?.name || "患者";
    const skipped = applied.monitorsUnavailable ? "（风险规则插件未启用，未加检验监测）" : applied.monitorsSkipped ? `（${applied.monitorsSkipped} 项监测已存在）` : "";
    setNotice(`${name} 已入组：排入 ${applied.followups} 个随访节点，加上 ${applied.monitors} 项检验监测${skipped}。可在患者的随访页查看和调整。`);
    setPatientId("");
  });
  return <article className="care-pack">
    <header>
      <h3>{pack.name}</h3>
      <span className={`om-chip ${pack.upToDate ? "is-ok" : pack.installed ? "is-caution" : ""}`}>
        {pack.upToDate ? `已安装 v${pack.version}` : pack.installed ? `可更新到 v${pack.version}` : "未安装"}
      </span>
    </header>
    <p className="muted">{pack.disease} · {pack.summary}</p>
    <ul className="care-pack-facts">
      <li><b>随访节点</b>{pack.nodes.map(node => `第 ${node.offsetDays} 天 ${node.title}${node.questionnaire ? "（问卷）" : ""}`).join("、")}</li>
      {pack.labMonitors.length > 0 && <li><b>检验监测</b>{pack.labMonitors.map(m => `${m.item} ${OP[m.op]} ${m.threshold}${m.unit ? ` ${m.unit}` : ""}`).join("、")}</li>}
      {pack.education.length > 0 && <li><b>患教素材</b>{pack.education.map(doc => `${doc.title}${doc.imported ? " ✓" : ""}`).join("、")}</li>}
      {pack.references.length > 0 && <li><b>参考</b>{pack.references.join("；")}</li>}
    </ul>
    {error && <p role="alert" className="form-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="toolbar-actions">
      <button type="button" className={pack.upToDate ? "secondary" : "primary"} disabled={busy} onClick={install}>
        {pack.upToDate ? "重新安装" : pack.installed ? "更新" : "安装"}
      </button>
    </div>
    <div className="care-pack-apply">
      <label>应用到患者
        <select value={patientId} onChange={e => setPatientId(e.target.value)} disabled={busy || !patients.length}>
          <option value="">{patients.length ? "选择患者" : "暂无在管患者"}</option>
          {patients.map(p => <option key={p.id} value={p.id}>{p.name}{p.patientNumber ? ` · ${p.patientNumber}` : ""}</option>)}
        </select>
      </label>
      <label>开始日期<input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} disabled={busy} /></label>
      <button type="button" className="secondary" disabled={busy || !patientId || !startDate} onClick={apply}>确认入组</button>
    </div>
  </article>;
}

export function CarePacksSettings() {
  const [packs, setPacks] = useState(null), [patients, setPatients] = useState([]), [error, setError] = useState("");
  const load = async () => {
    try {
      const [list, people] = await Promise.all([api("/api/p/care-packs/packs"), api("/api/patients?summary=1").catch(() => ({ patients: [] }))]);
      setPacks(list.packs);
      setPatients((people.patients || []).filter(p => !p.archived));
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);
  return <section className="care-packs" aria-label="专病管理包">
    <h2>专病管理包</h2>
    <p>一个病种的随访计划、随访问卷、检验监测阈值和患教素材打包在一起。安装后，随访模板出现在患者随访页，患教素材导入知识库「患教素材」，可用于企业微信推送和医生分身科普。也可以在对话里说“把这位患者按高血压管起来”。</p>
    {error && <p role="alert" className="form-error">{error}</p>}
    {!packs && !error && <p role="status">正在读取…</p>}
    {packs?.map(pack => <PackCard key={pack.id} pack={pack} patients={patients} onChanged={load} />)}
    <p className="muted">包内阈值和随访节奏是通用起点，请按患者情况调整；预警只提醒医生复核，不替代临床判断。</p>
  </section>;
}

export default CarePacksSettings;
