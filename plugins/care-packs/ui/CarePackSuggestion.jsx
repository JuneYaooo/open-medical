import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { api } from "../../../src/agent-runtime";
import { localCalendarDate } from "../../../shared/calendar-date.mjs";
import { suggestPacks } from "../match.mjs";
import { enrollInPack, monitorNote } from "./enroll.js";
import "./care-packs.css";

const OP = { gt: ">", lt: "<" };

// Top of a patient's follow-up tab: when a confirmed diagnosis fits a care
// pack the patient is not on, offer one-click enrollment instead of making
// the doctor find the template.
export default function CarePackSuggestion({ patient, followups, onChanged }) {
  const [packs, setPacks] = useState(null);
  const [dismissed, setDismissed] = useState([]);
  const [startDate, setStartDate] = useState(localCalendarDate());
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let alive = true;
    api("/api/p/care-packs/packs").then((result) => alive && setPacks(result.packs || [])).catch(() => alive && setPacks([]));
    return () => { alive = false; };
  }, []);
  useEffect(() => { setDismissed([]); setNotice(""); setError(""); }, [patient.id]);

  const suggestions = suggestPacks(packs, patient.diagnoses, followups).filter(({ pack }) => !dismissed.includes(pack.id));
  const enroll = async (pack) => {
    if (busy) return;
    setBusy(pack.id); setError(""); setNotice("");
    try {
      const applied = await enrollInPack(pack.id, patient.id, startDate);
      setNotice(`已按「${pack.name}」入组：排入 ${applied.followups} 个随访节点，加上 ${applied.monitors} 项检验监测${monitorNote(applied)}。下面的提醒计划里可以逐项调整。`);
      await onChanged?.();
    } catch (err) { setError(err.message); }
    finally { setBusy(""); }
  };

  if (!suggestions.length && !notice && !error) return null;
  return <section className="care-pack-suggestions" aria-label="管理包推荐">
    {notice && <p className="notice" role="status">{notice}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {suggestions.map(({ pack, diagnosis, renewal }) => <article className="care-pack-suggestion" key={pack.id}>
      <div className="care-pack-suggestion-main">
        <b><Sparkles size={15} aria-hidden="true" />{renewal ? `上一轮「${pack.name}」已全部到期，可以续一年` : `按诊断推荐：${pack.name}`}</b>
        <small>依据档案诊断「{diagnosis}」 · 一年 {pack.nodes.length} 个随访节点{pack.questionnaires ? `（${pack.questionnaires} 份问卷）` : ""}{pack.labMonitors.length ? ` · ${pack.labMonitors.length} 项检验监测` : ""}</small>
        <details>
          <summary>查看包内容</summary>
          <ul>
            <li><b>随访节点</b>{pack.nodes.map((node) => `第 ${node.offsetDays} 天 ${node.title}${node.questionnaire ? "（问卷）" : ""}`).join("、")}</li>
            {pack.labMonitors.length > 0 && <li><b>检验监测</b>{pack.labMonitors.map((m) => `${m.item} ${OP[m.op]} ${m.threshold}${m.unit ? ` ${m.unit}` : ""}`).join("、")}</li>}
            {pack.references.length > 0 && <li><b>参考</b>{pack.references.join("；")}</li>}
          </ul>
        </details>
      </div>
      <div className="care-pack-suggestion-actions">
        <label>开始日期<input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} disabled={Boolean(busy)} /></label>
        <button type="button" className="primary" disabled={Boolean(busy) || !startDate} onClick={() => enroll(pack)}>{busy === pack.id ? "正在入组…" : renewal ? "续一年" : "入组"}</button>
        <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => setDismissed((list) => [...list, pack.id])}>暂不需要</button>
      </div>
    </article>)}
  </section>;
}
