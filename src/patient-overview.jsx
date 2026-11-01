import { useEffect, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  CalendarDays,
  ClipboardList,
  Pill,
} from "lucide-react";
import {
  DIAGNOSIS_STATUS_LABELS,
  diagnosisSources,
  groupDiagnoses,
} from "../shared/diagnoses.mjs";
import { dashboardLabComparison } from "../shared/patient-dashboard.mjs";
import { FLAG_ARROW, FLAG_LABEL, labFlag } from "../shared/lab-flags.mjs";
import { allergyState } from "../shared/patient-list-brief.mjs";
import { localCalendarDate } from "../shared/calendar-date.mjs";
import { api } from "./agent-runtime";
import "./patient-overview.css";
import { Slot } from "./plugin-slots";
import { PatientAttention } from "./patient-attention";

const LAB_ROWS = 6;

function MoreLink({ children, onClick }) {
  return (
    <button type="button" className="om-link" onClick={onClick}>
      {children}
      <ArrowUpRight size={14} aria-hidden="true" />
    </button>
  );
}

export function medicationLine(m) {
  return [m.name || m.drug || "未命名用药", m.dose, m.frequency].filter(Boolean).join(" ");
}

// Days between two calendar dates, both YYYY-MM-DD.
function dayOffset(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`), b = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86400000) : null;
}

export function relativeDay(date, today = localCalendarDate()) {
  const days = dayOffset(today, date);
  if (days === null) return "";
  if (days === 0) return "今天";
  if (days === 1) return "明天";
  if (days > 1) return `${days} 天后`;
  if (days === -1) return "昨天";
  return `${-days} 天前`;
}

// Latest-value rows with abnormal hints; abnormal first, then most recent.
export function overviewLabRows(groups, gender) {
  const rank = { high: 0, low: 0, normal: 1, "": 2 };
  return groups
    .map((group) => {
      const summary = dashboardLabComparison(group);
      const single = summary.latestRecords.length && summary.values.length === 1 ? summary.latestRecords[0] : null;
      const flag = single && summary.date ? labFlag(single, { gender }) : { flag: "", range: summary.latestRecords[0]?.referenceRange || "", source: "" };
      return { ...summary, ...flag };
    })
    .sort((a, b) => rank[a.flag] - rank[b.flag] || String(b.date).localeCompare(String(a.date)) || a.item.localeCompare(b.item, "zh-CN"));
}

export function LabValue({ row }) {
  const flagged = row.flag === "high" || row.flag === "low";
  return (
    <span className={`om-value ${flagged ? row.flag : ""}`} title={flagged ? `${FLAG_LABEL[row.flag]}（${row.source === "generic" ? "按通用参考范围" : "按报告参考范围"}）` : undefined}>
      {row.values.join(" / ")}
      {flagged && <span className="om-flag" aria-label={FLAG_LABEL[row.flag]}>{FLAG_ARROW[row.flag]}</span>}
    </span>
  );
}

export function LabRange({ row }) {
  if (!row.range) return <span className="om-range-generic">报告未注明</span>;
  return (
    <span>
      {row.range}
      {row.source === "generic" && <span className="om-range-generic">（通用参考）</span>}
    </span>
  );
}

export function LabDelta({ row }) {
  if (row.delta === null || row.delta === undefined) return <span className="om-range-generic">—</span>;
  if (row.delta === 0) return <span>持平</span>;
  return <span>{row.delta > 0 ? "↑" : "↓"} {Math.abs(row.delta)}</span>;
}

function useNextAppointment(patientId, revision) {
  const [next, setNext] = useState(null);
  useEffect(() => {
    let live = true;
    api(`/api/patients/${encodeURIComponent(patientId)}/appointments`)
      .then((value) => {
        if (!live) return;
        const today = value.today || localCalendarDate();
        const upcoming = (value.appointments || [])
          .filter((a) => a.status === "scheduled" && a.date >= today)
          .sort((a, b) => `${a.date} ${a.time || ""}`.localeCompare(`${b.date} ${b.time || ""}`));
        setNext(upcoming[0] ? { ...upcoming[0], today } : false);
      })
      .catch(() => {
        if (live) setNext(false);
      });
    return () => {
      live = false;
    };
  }, [patientId, revision]);
  return next;
}

export function patientGaps(patient) {
  const gaps = [];
  if (allergyState(patient).status === "unknown") gaps.push({ label: "过敏史未记录", tab: "medications", edit: true });
  const meds = patient.medications || [];
  const unknownMeds = meds.filter((m) => !m.status || m.status === "unknown").length;
  if (unknownMeds) gaps.push({ label: `${unknownMeds} 条用药状态未记录`, tab: "medications", edit: true });
  if (!(patient.diagnoses || []).length) gaps.push({ label: "尚未登记诊断", tab: "diagnoses", edit: true });
  if (!patient.birthYear) gaps.push({ label: "出生年份未记录", identity: true });
  return gaps;
}

export function PatientOverview({
  patient,
  session,
  groups,
  onNavigate,
  onOpenWorkspace,
  onView,
  riskPanel,
}) {
  const next = useNextAppointment(patient.id, patient.revision);
  const diagnosisGroups = groupDiagnoses(patient.diagnoses);
  const diagnosisCount = diagnosisGroups.reduce((total, group) => total + group.items.length, 0);
  const clinical = diagnosisGroups.filter((group) => ["confirmed", "suspected"].includes(group.status)).flatMap((group) => group.items.map((item) => ({ ...item, suspected: group.status === "suspected" })));
  const visits = [...(patient.visits || [])].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  const medications = patient.medications || [];
  const activeMeds = medications.filter((m) => m.status === "active");
  const plan = patient.treatmentPlan;
  const labRows = overviewLabRows(groups, patient.gender || "");
  const abnormal = labRows.filter((row) => row.flag === "high" || row.flag === "low");
  const judged = labRows.filter((row) => row.flag);
  const undatedLabs = labRows.reduce((total, row) => total + row.undatedCount, 0);
  const gaps = patientGaps(patient);
  const summary = patient.clinicalSummary?.text;

  const nextLabel = next
    ? { value: `${next.date}${next.time ? ` ${next.time}` : ""}`, rel: relativeDay(next.date, next.today), note: [next.reason, next.place].filter(Boolean).join(" · ") }
    : plan?.reviewDate && plan.status !== "completed"
      ? { value: plan.reviewDate, rel: relativeDay(plan.reviewDate), note: "治疗方案复评" }
      : null;

  return (
    <div className="patient-overview">
      <section className="om-facts" aria-label="临床要点">
        <div className="om-fact">
          <span>主要诊断</span>
          {clinical.length ? (
            <strong>
              {clinical.slice(0, 3).map((d, i) => (
                <span key={i}>
                  {i > 0 && "、"}
                  {d.name}
                  {d.suspected && <span className="ov-suspected">（疑似）</span>}
                </span>
              ))}
            </strong>
          ) : (
            <strong className="is-muted">未登记</strong>
          )}
          {clinical.length > 3 && <small>另有 {clinical.length - 3} 项</small>}
          {!clinical.length && diagnosisCount > 0 && <small>{diagnosisCount} 条记录待核对</small>}
        </div>
        <div className="om-fact">
          <span>当前用药</span>
          {activeMeds.length ? <strong>{activeMeds.length} 种在用</strong> : <strong className="is-muted">{medications.length ? "无标记在用" : "无记录"}</strong>}
          {activeMeds.length > 0 && <small>{activeMeds.slice(0, 3).map(medicationLine).join("；")}{activeMeds.length > 3 ? ` 等` : ""}</small>}
        </div>
        <div className={`om-fact ${abnormal.length ? "alert" : ""}`}>
          <span>异常检验</span>
          {abnormal.length ? (
            <strong className="is-danger">{abnormal.length} 项超出参考范围</strong>
          ) : judged.length ? (
            <strong>未见异常</strong>
          ) : (
            <strong className="is-muted">{labRows.length ? "无可判断项" : "无检验记录"}</strong>
          )}
          {abnormal.length > 0 ? (
            <small>
              {abnormal.slice(0, 3).map((row, i) => (
                <span key={row.key} className="ov-nowrap">
                  {i > 0 && "； "}
                  {row.item} <LabValue row={row} /> {row.unit}
                </span>
              ))}
            </small>
          ) : judged.length ? (
            <small>最近 {judged.length} 项均在参考范围内</small>
          ) : null}
        </div>
        <div className="om-fact">
          <span>下次复诊</span>
          {nextLabel ? (
            <strong>
              {nextLabel.value}
              {nextLabel.rel && <span className="ov-relative">{nextLabel.rel}</span>}
            </strong>
          ) : (
            <strong className="is-muted">{next === null ? "读取中…" : "未安排"}</strong>
          )}
          {nextLabel?.note && <small>{nextLabel.note}</small>}
        </div>
      </section>

      {(summary || gaps.length > 0) && (
        <section className="ov-summary" aria-label="病史摘要">
          {summary && (
            <p>
              <b>病史摘要</b>
              {summary}
              {patient.clinicalSummary?.source && <span className="om-source"> · {patient.clinicalSummary.source}</span>}
            </p>
          )}
          {gaps.length > 0 && (
            <div className="ov-gaps">
              <b>待补充</b>
              {gaps.map((gap) => (
                <button
                  type="button"
                  key={gap.label}
                  className="om-chip is-caution"
                  disabled={patient.archived || gap.identity}
                  title={gap.identity ? "在「编辑信息」中补充" : "打开编辑"}
                  onClick={() => onNavigate(gap.tab, gap.edit ? { edit: true } : undefined)}
                >
                  {gap.label}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {riskPanel}
      <PatientAttention patient={patient} onNavigate={onNavigate} onOpenWorkspace={onOpenWorkspace} onView={onView} />

      <div className="ov-grid">
        <div className="ov-column">
          <section className="om-card ov-labs" aria-label="最近检验">
            <header className="om-card-head">
              <h3><Activity size={18} aria-hidden="true" />最近检验</h3>
              <span className="om-count">{labRows.length ? `${labRows.length} 项指标` : ""}</span>
            </header>
            {labRows.length ? (
              <table className="om-table">
                <thead>
                  <tr>
                    <th>项目</th>
                    <th className="num">最新结果</th>
                    <th>参考范围</th>
                    <th className="num">较上次</th>
                    <th className="num">日期</th>
                  </tr>
                </thead>
                <tbody>
                  {labRows.slice(0, LAB_ROWS).map((row) => (
                    <tr key={row.key} className={row.flag === "high" || row.flag === "low" ? `abnormal ${row.flag}` : ""}>
                      <td>
                        <button
                          type="button"
                          className="om-row-button"
                          aria-label={`核对${row.item} ${row.unit || "单位未记录"}的记录与来源`}
                          onClick={() => onNavigate("labs", { focusLab: row.key })}
                        >
                          {row.item}
                        </button>
                        {row.latestConflict && <span className="om-chip is-caution ov-inline-chip">同日多值</span>}
                      </td>
                      <td className="num">
                        <LabValue row={row} /> <span className="om-meta">{row.unit || "单位未记录"}</span>
                      </td>
                      <td><LabRange row={row} /></td>
                      <td className="num"><LabDelta row={row} /></td>
                      <td className="num om-meta">{row.date || "日期待核对"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="om-empty">还没有检验记录。补充报告资料后会在这里列出最新结果。</p>
            )}
            {(labRows.length > LAB_ROWS || undatedLabs > 0) && (
              <p className="om-meta ov-note">
                {labRows.length > LAB_ROWS && `另有 ${labRows.length - LAB_ROWS} 项指标未列出。`}
                {undatedLabs > 0 && `${undatedLabs} 条检验日期待核对，未参与最新结果判断。`}
              </p>
            )}
            {labRows.length > 0 && (
              <footer className="om-card-foot">
                <MoreLink onClick={() => onNavigate("labs")}>全部检验与趋势</MoreLink>
              </footer>
            )}
          </section>

          <section className="om-card ov-visits" aria-label="最近就诊">
            <header className="om-card-head">
              <h3><CalendarDays size={18} aria-hidden="true" />就诊经过</h3>
              <span className="om-count">{visits.length ? `共 ${visits.length} 次` : ""}</span>
            </header>
            {visits.length ? (
              <ol className="ov-visit-list">
                {visits.slice(0, 3).map((visit, i) => (
                  <li key={i}>
                    <time>{visit.date || "日期未记录"}</time>
                    <div>
                      <b>{visit.reason || "就诊原因未记录"}</b>
                      {visit.note && <p>{visit.note}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="om-empty">尚无就诊记录。</p>
            )}
            {visits.length > 0 && (
              <footer className="om-card-foot">
                <MoreLink onClick={() => onNavigate("visits")}>{visits.length > 3 ? `查看全部 ${visits.length} 次就诊` : "就诊时间轴"}</MoreLink>
              </footer>
            )}
          </section>
        </div>

        <div className="ov-column">
          <section className="om-card ov-diagnoses" aria-label="诊断摘要">
            <header className="om-card-head">
              <h3><ClipboardList size={18} aria-hidden="true" />诊断</h3>
              <span className="om-count">{diagnosisCount ? `${diagnosisCount} 项` : ""}</span>
            </header>
            {diagnosisCount ? (
              diagnosisGroups.map((group) => (
                <div className="ov-dx-group" key={group.status}>
                  {(diagnosisGroups.length > 1 || group.status !== "confirmed") && <h4>{group.label || DIAGNOSIS_STATUS_LABELS[group.status]}</h4>}
                  <ul className="ov-dx-list">
                    {group.items.slice(0, 4).map((d, i) => (
                      <li key={i} title={diagnosisSources(d).join("；") || undefined}>
                        <span className="ov-dx-name">{d.name}{d.code && <span className="om-meta"> {d.code}</span>}</span>
                        <span className="om-meta">{d.date || "日期未记录"}</span>
                      </li>
                    ))}
                  </ul>
                  {group.items.length > 4 && <p className="om-meta">另有 {group.items.length - 4} 项</p>}
                </div>
              ))
            ) : (
              <p className="om-empty">尚未登记诊断。</p>
            )}
            <footer className="om-card-foot">
              <MoreLink onClick={() => onNavigate("diagnoses")}>诊断与病史</MoreLink>
            </footer>
          </section>

          <section className="om-card ov-treatment" aria-label="当前用药与方案">
            <header className="om-card-head">
              <h3><Pill size={18} aria-hidden="true" />用药与方案</h3>
              <span className="om-count">{activeMeds.length ? `${activeMeds.length} 种在用` : ""}</span>
            </header>
            {activeMeds.length ? (
              <ul className="ov-med-list">
                {activeMeds.slice(0, 6).map((m, i) => (
                  <li key={m.id || i}>
                    <b>{m.name || m.drug || "未命名用药"}</b>
                    <span>{[m.dose || "剂量未记录", m.frequency || "频次未记录"].join(" · ")}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="om-empty">{medications.length ? `已保存 ${medications.length} 条用药记录，暂无标记为在用。` : "尚无用药记录。"}</p>
            )}
            {activeMeds.length > 6 && <p className="om-meta">另有 {activeMeds.length - 6} 种在用药物</p>}
            <div className="ov-plan">
              {plan ? (
                <>
                  <span className="om-chip is-ok">{{ active: "方案进行中", paused: "方案已暂停", completed: "方案已完成" }[plan.status] || "方案状态未记录"}</span>
                  <b>{plan.title || "已保存治疗方案"}</b>
                  {plan.reviewDate && <span className="om-meta">复评 {plan.reviewDate}</span>}
                </>
              ) : (
                <span className="om-meta">尚未建立治疗方案</span>
              )}
            </div>
            <footer className="om-card-foot">
              <MoreLink onClick={() => onNavigate("medications")}>用药与治疗</MoreLink>
            </footer>
          </section>
          <Slot name="patient.overviewCards" patient={patient} />
        </div>
      </div>
      <p className="ov-files om-meta">
        资料文件 {session.files?.length || 0} 份
        <MoreLink onClick={() => onNavigate("library")}>打开资料库</MoreLink>
      </p>
    </div>
  );
}
