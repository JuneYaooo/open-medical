import {TrialAIReview} from "./trial-ai-review";
import { EnrollmentSelect, TrialCandidatesPanel } from "./trial-candidates";
import {splitEligibility} from "../shared/trial-protocol.mjs";
import { useEffect, useRef, useState } from "react";
import { api } from "./agent-runtime";
import { importKnowledge } from "./import-knowledge";
import { patientOptionLabel } from "./patient-labels";
import "./medical-modules.css";
const blank = {
  title: "",
  registration: "",
  version: "",
  sourceUrl: "",
  site: "",
  recruitment: "待研究中心确认",
  protocolText: "",
  inclusion: "",
  exclusion: "",
};
const OPEN_KEY = "omw-trial-open";
// Lets the agenda open one trial's candidate list on arrival.
export function requestTrial(id) { try { sessionStorage.setItem(OPEN_KEY, id); } catch { /* storage unavailable */ } }
function takeTrialRequest() { try { const id = sessionStorage.getItem(OPEN_KEY); sessionStorage.removeItem(OPEN_KEY); return id; } catch { return null; } }

function EnrollmentControl({ trialId, patientId }) {
  const [enrollment, setEnrollment] = useState(null), [error, setError] = useState("");
  const load = () => api(`/api/trials/${trialId}/enrollments/${patientId}`).then(setEnrollment).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [trialId, patientId]);
  if (!enrollment) return error ? <p className="form-error">{error}</p> : null;
  return <div className="trial-enrollment" aria-label="入组状态">
    <b>入组状态</b>
    <EnrollmentSelect trialId={trialId} patientId={patientId} enrollment={enrollment} onChanged={() => { setError(""); load(); }} onError={setError} />
    {enrollment.consentDate && <span className="muted">知情同意 {enrollment.consentDate}</span>}
    {enrollment.history.length > 0 && <span className="muted">此前：{enrollment.history.slice(-3).map((h) => h.stage === "none" ? "未处理" : ({ shortlisted: "拟邀请", contacted: "已联系", consented: "已签同意", enrolled: "已入组", declined: "拒绝", ineligible: "不符合", withdrawn: "退出" })[h.stage]).join(" → ")}</span>}
    {error && <p role="alert" className="form-error">{error}</p>}
  </div>;
}

export function TrialScreeningView({ onOpenPatient }) {
  const [patientBrief, setPatientBrief] = useState(null);
  const [registryId, setRegistryId] = useState(""),
    [trials, setTrials] = useState([]),
    [patients, setPatients] = useState([]),
    [trial, setTrial] = useState(null),
    [patientId, setPatientId] = useState(""),
    [record, setRecord] = useState(null),
    [form, setForm] = useState(() => {
      try {
        return (
          JSON.parse(localStorage.getItem("medical.trial.protocol-draft")) ||
          null
        );
      } catch {
        return null;
      }
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const request = useRef(0);
  const inFlight = useRef(false);
  const [draftConflict, setDraftConflict] = useState(null);
  const draftKey =
    trial && patientId
      ? `medical.trial.screening-draft.${trial.id}.${patientId}`
      : "";
  useEffect(() => {
    try {
      if (form)
        localStorage.setItem(
          "medical.trial.protocol-draft",
          JSON.stringify(form),
        );
      else localStorage.removeItem("medical.trial.protocol-draft");
    } catch {
      setError("本机草稿暂存失败，请保存方案后再离开。");
    }
  }, [form]);
  const load = async () => {
    const [a, b] = await Promise.all([
      api("/api/trials"),
      api("/api/patients?summary=1"),
    ]);
    setTrials(a.trials);
    setPatients(b.patients.filter((p) => !p.archived));
    const wanted = takeTrialRequest();
    if (wanted) { const t = a.trials.find((x) => x.id === wanted); if (t) setTrial(t); }
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    const generation = ++request.current;
    setRecord(null);
    setPatientBrief(null);
    setDraftConflict(null);
    setError("");
    setNotice("");
    if (!trial || !patientId) return;
    Promise.all([
      api(`/api/trials/${trial.id}/screenings/${patientId}`),
      api(`/api/patients/${patientId}/brief`),
    ])
      .then(([r, brief]) => {
        if (generation === request.current) {
          setPatientBrief(brief);
          let draft = null;
          try {
            draft = JSON.parse(localStorage.getItem(draftKey));
          } catch {
            /* no usable local draft */
          }
          const reusable =
            draft?.revision === r.revision &&
            Array.isArray(draft.checks) &&
            draft.checks.length === trial.criteria.length &&
            trial.criteria.every((c) =>
              draft.checks.some((d) => d.id === c.id),
            );
          if (draft && !reusable) setDraftConflict(draft);
          if (reusable) setNotice("已恢复这位患者尚未保存的初筛草稿。");
          setRecord(
            reusable
              ? draft
              : {
                  ...r,
                  checks: trial.criteria.map(
                    (c) =>
                      r.checks.find((x) => x.id === c.id) || {
                        id: c.id,
                        value: "unknown",
                        evidence: "",
                      },
                  ),
                },
          );
        }
      })
      .catch((e) => {
        if (generation === request.current) setError(e.message);
      });
    return () => {
      request.current++;
    };
  }, [trial?.id, patientId]);
  const run = async (fn) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  };
  const create = (event) => {
    event.preventDefault();
    run(async () => {
      const value = await api("/api/trials", "POST", form);
      await load();
      setTrial(value);
      setForm(null);
      setNotice("方案已保存。按原文逐项初筛，正式资格由研究团队确认。");
    });
  };
  const upload = (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    run(async () => {
      const result = await importKnowledge(file, setNotice);
      if (!result.text?.trim())
        throw new Error("未读取到方案文字，请补充文本资料。");
      const parsed=splitEligibility(result.text);
      setForm((old) => ({
        ...old,
        inclusion: parsed.inclusion,
        exclusion: parsed.exclusion,
        title: old.title || file.name.replace(/\.[^.]+$/, ""),
        protocolText: result.text,
      }));
      setNotice(`已读取方案原文。${parsed.criteriaNotice} 新资料已替换原有条件草稿，请核对后保存。`);
    });
  };
  const patient = patients.find((p) => p.id === patientId);
  const editRecord = (value) => {
    setRecord(value);
    setNotice("改动已暂存在本机，尚未保存核对记录。");
    try {
      localStorage.setItem(draftKey, JSON.stringify(value));
    } catch {
      setError("本机草稿暂存失败，请保存初筛记录后再离开。");
    }
  };
  const update = (id, patch) =>
    editRecord({
      ...record,
      checks: record.checks.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    });
  return (
    <div className="module-view trial-hub">
      <div className="module-head">
        <div>
          <h1>临床试验入组初筛</h1>
          <p className="module-phase">
            选择方案和患者，AI 自动核对纳排条件，集中查看冲突、缺失资料与病历依据。
          </p>
        </div>
        <button
          className="primary"
          disabled={busy}
          onClick={() => setForm({ ...blank })}
        >
          添加试验方案
        </button>
      </div>
      <form
        className="trial-registry-search"
        onSubmit={(event) => {
          event.preventDefault();
          run(async () => {
            const result = await api(
              `/api/trials/registry/${encodeURIComponent(registryId.trim())}`,
            );
            setForm({ ...blank, ...result });
            setNotice(
              `${result.notice} ${result.criteriaNotice} 注册年龄：${result.demographics.minimumAge || "未说明"}～${result.demographics.maximumAge || "未说明"}；性别：${result.demographics.sex || "未说明"}。`,
            );
          });
        }}
      >
        <label>
          按注册号读取试验
          <input
            aria-label="NCT 注册号"
            placeholder="NCT 加 8 位数字"
            value={registryId}
            onChange={(e) => setRegistryId(e.target.value)}
            maxLength={20}
          />
        </label>
        <button className="secondary" disabled={busy || !registryId.trim()}>
          读取注册资料
        </button>
        <small>仅发送注册号，不发送患者资料</small>
      </form>
      <div className="trial-links">
        <a href="https://www.chinadrugtrials.org.cn/" target="_blank" rel="noreferrer">
          药物临床试验登记与信息公示
        </a>
        <a href="https://www.chictr.org.cn/" target="_blank" rel="noreferrer">
          中国临床试验注册中心
        </a>
        <a href="https://clinicaltrials.gov/" target="_blank" rel="noreferrer">
          ClinicalTrials.gov
        </a>
        <a
          href="https://www.cancer.gov/research/participate/clinical-trials-search"
          target="_blank"
          rel="noreferrer"
        >
          NCI 肿瘤试验
        </a>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="form-notice">
          {notice}
        </p>
      )}
      {form ? (
        <form className="module-card trial-form" onSubmit={create}>
          <h2>保存方案与筛选标准</h2>
          <fieldset disabled={busy} className="trial-form">
            <label>
              上传方案资料
              <input
                type="file"
                accept=".pdf,.docx,.txt,.md,.json,.png,.jpg,.jpeg,.xlsx"
                onChange={upload}
              />
            </label>
            <div className="trial-meta">
              {[
                ["title", "试验名称", true],
                ["registration", "注册号", false],
                ["version", "方案版本与日期", true],
                ["site", "研究中心", false],
                ["recruitment", "招募状态（需核实）", false],
                ["sourceUrl", "来源链接", false],
              ].map(([key, label, required]) => (
                <label key={key}>
                  {label}
                  <input
                    required={required}
                    type={key === "sourceUrl" ? "url" : "text"}
                    maxLength={key === "sourceUrl" ? 2000 : key === "title" ? 500 : 200}
                    value={form[key]}
                    onChange={(e) =>
                      setForm({ ...form, [key]: e.target.value })
                    }
                  />
                </label>
              ))}
            </div>
            <details>
              <summary>方案原文（{form.protocolText.length} 字符）</summary>
              <textarea
                aria-label="方案原文"
                value={form.protocolText}
                onChange={(e) =>
                  setForm({ ...form, protocolText: e.target.value })
                }
              />
            </details>
            <label>
              入选标准（每行一项）
              <textarea
                aria-label="入选标准（每行一项）"
                required
                value={form.inclusion}
                onChange={(e) =>
                  setForm({ ...form, inclusion: e.target.value })
                }
              />
            </label>
            <label>
              排除标准（每行一项）
              <textarea
                aria-label="排除标准（每行一项）"
                required
                value={form.exclusion}
                onChange={(e) =>
                  setForm({ ...form, exclusion: e.target.value })
                }
              />
            </label>
            <p className="muted">
              按方案原文保留逻辑、阈值和时间窗。方案更新时添加新版本，保留旧版核对记录。
            </p>
            <div className="toolbar-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setForm(null)}
              >
                取消
              </button>
              <button type="submit" className="primary">
                保存试验方案
              </button>
            </div>
          </fieldset>
        </form>
      ) : trial ? (
        <section className="module-card">
          <button
            className="text-button"
            disabled={busy}
            onClick={() => {
              setTrial(null);
              setPatientId("");
              setRecord(null);
            }}
          >
            ← 试验方案列表
          </button>
          <h2>{trial.title}</h2>
          <p className="muted">
            {[trial.registration || "注册号未记录", trial.version, trial.recruitment, trial.site || "研究中心待核实"].join(" · ")}
            {trial.sourceUrl && <> · <a href={trial.sourceUrl} target="_blank" rel="noreferrer">核对来源</a></>}
          </p>
          <label>
            选择初筛患者
            <select
              aria-label="选择初筛患者"
              disabled={busy}
              value={patientId}
              onChange={(e) => setPatientId(e.target.value)}
            >
              <option value="">请选择患者</option>
              {patients.map((p) => (
                <option key={p.id} value={p.id}>
                  {patientOptionLabel(p, patients)}
                </option>
              ))}
            </select>
          </label>
          {!patientId && <TrialCandidatesPanel trial={trial} onScreen={setPatientId} onOpenPatient={onOpenPatient} />}
          {patientId && <div className="trial-patient-bar">
            <button className="text-button" disabled={busy} onClick={() => setPatientId("")}>← 返回候选患者</button>
            <EnrollmentControl trialId={trial.id} patientId={patientId} />
          </div>}
          {patient && !record && !error && (
            <p role="status">正在读取这位患者的初筛记录…</p>
          )}
          {draftConflict && (
            <details className="form-error" open>
              <summary>另一次修改已保存，本机旧草稿未覆盖新记录</summary>
              <p>
                下面保留旧草稿供核对。请把需要保留的依据补入最新记录后再保存。
              </p>
              <pre className="source-text">
                {JSON.stringify(draftConflict.checks, null, 2)}
                {draftConflict.note}
              </pre>
              <button
                className="secondary"
                onClick={() => {
                  localStorage.removeItem(draftKey);
                  setDraftConflict(null);
                }}
              >
                已核对，清除旧草稿
              </button>
            </details>
          )}
          {patient && record && (
            <>
              {patientBrief && (
                <section
                  className="trial-patient-context"
                  aria-label="初筛患者资料"
                >
                  <div>
                    <b>{patientBrief.identity.name}</b>
                    <span>
                      {" "}
                      ·{" "}
                      {{ female: "女", male: "男" }[
                        patientBrief.identity.gender
                      ] || "性别待核对"}{" "}
                      ·{" "}
                      {patientBrief.identity.birthYear
                        ? `${patientBrief.identity.birthYear} 年生`
                        : "出生年份未记录"}
                    </span>
                    {onOpenPatient && (
                      <button
                        className="text-button"
                        onClick={() => onOpenPatient(patientId)}
                      >
                        查看患者档案
                      </button>
                    )}
                  </div>
                  <p>
                    {patientBrief.diagnoses
                      .slice(0, 3)
                      .map((d) => d.name)
                      .join(" · ") || "尚无已登记诊断"}
                  </p>
                  {record.patientRevision !== undefined &&
                    record.patientRevision !== patientBrief.revision && (
                      <p className="form-notice">
                        患者档案在上次初筛后有更新，请重新核对受影响的条件。
                      </p>
                    )}
                </section>
              )}
              <p className="muted">
                {record.updatedAt
                  ? `上次核对：${new Date(record.updatedAt).toLocaleString("zh-CN")}。`
                  : "尚未保存本患者的初筛记录。"}
                患者资料变化后应重新核对；本表不会自动确认符合资格。
              </p>
              <TrialAIReview key={`${trial.id}.${patientId}`} trial={trial} patientId={patientId} onAdopt={job=>{
                editRecord({...record,checks:job.checks.map(c=>({id:c.id,value:c.value,evidence:[c.reason,c.evidenceDate,c.missing,...c.citations.map(r=>`${r.sourceName} 第${r.startLine}–${r.endLine}行：${r.quote}`)].filter(Boolean).join('\n').slice(0,3000)})),note:`根据 ${job.screeningDate} AI 初筛草稿核对；任务 ${job.id}`});
                document.getElementById('trial-doctor-review')?.setAttribute('open','');
              }}/>
              <details id="trial-doctor-review" className="trial-doctor-review"><summary>医生核对与保存{record.revision?` · 已保存 ${record.revision} 次`:''}</summary>
              <fieldset disabled={busy} className="trial-form">
                {trial.criteria.map((c) => {
                  const value = record.checks.find((x) => x.id === c.id);
                  return (
                    <div className="trial-review-row" key={c.id}>
                      <p>
                        <b>{c.kind === "include" ? "入选条件" : "排除条件"}</b>
                        <br />
                        {c.text}
                      </p>
                      <select
                        aria-label={`判断：${c.text}`}
                        value={value.value}
                        onChange={(e) =>
                          update(c.id, { value: e.target.value })
                        }
                      >
                        <option value="unknown">资料不足 / 待核对</option>
                        <option value="yes">
                          {c.kind === "include"
                            ? "满足此条件"
                            : "触发此排除条件"}
                        </option>
                        <option value="no">
                          {c.kind === "include"
                            ? "不满足此条件"
                            : "未触发此排除条件"}
                        </option>
                      </select>
                      <label>
                        依据、资料日期或缺少什么
                        <textarea
                          value={value.evidence}
                          onChange={(e) =>
                            update(c.id, { evidence: e.target.value })
                          }
                        />
                      </label>
                    </div>
                  );
                })}
                <label>
                  初筛备注
                  <textarea
                    value={record.note}
                    onChange={(e) =>
                      editRecord({ ...record, note: e.target.value })
                    }
                  />
                </label>
                <button
                  className="primary"
                  onClick={() =>
                    run(async () => {
                      const result = await api(
                        `/api/trials/${trial.id}/screenings/${patientId}`,
                        "PUT",
                        { ...record, expectedRevision: record.revision },
                      );
                      setRecord(result);
                      localStorage.removeItem(draftKey);
                      setNotice(result.summary);
                    })
                  }
                >
                  保存初筛记录
                </button>
              </fieldset>
              </details>
              {record.revision > 0 && (
                <p>
                  上次保存结论：
                  <b>{record.summary}</b> · 待补 {record.missing} 项 · 条件冲突{" "}
                  {record.conflicts} 项
                </p>
              )}
              <details>
                <summary>方案原文与核对历史</summary>
                <pre className="source-text">
                  {trial.protocolText ||
                    "未附完整原文，请核对来源链接与筛选标准。"}
                </pre>
                {record.history.map((h) => (
                  <div key={h.revision}>
                    <h4>
                      第 {h.revision} 次 · {h.updatedAt}
                    </h4>
                    {h.checks.map((c) => (
                      <p key={c.id}>
                        {trial.criteria.find((t) => t.id === c.id)?.text}：
                        {c.value === "unknown"
                          ? "待核对"
                          : c.value === "yes"
                            ? "是"
                            : "否"}{" "}
                        · {c.evidence}
                      </p>
                    ))}
                  </div>
                ))}
              </details>
            </>
          )}
        </section>
      ) : (
        <div className="trial-grid">
          {trials.map((t) => (
            <article key={t.id} className="module-card trial-card">
              <h2>{t.title}</h2>
              <p>
                {t.registration || "注册号待补"} · {t.version}
              </p>
              <p>
                {t.recruitment} · {t.criteria.length} 项条件
              </p>
              <button
                className="secondary"
                onClick={() => {
                  setTrial(t);
                  setError("");
                  setPatientId("");
                }}
              >
                打开初筛
              </button>
            </article>
          ))}
          {!trials.length && (
            <p>
              先添加一份试验方案，再选择患者逐项排查。可从上方注册平台查找方案与研究中心。
            </p>
          )}
        </div>
      )}
    </div>
  );
}
