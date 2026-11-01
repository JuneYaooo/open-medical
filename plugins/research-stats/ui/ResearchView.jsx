import { useEffect, useRef, useState } from "react";
import { api } from "../../../src/agent-runtime";
import "../../../src/tools-clarity.css";
import "./research-stats.css";
import { Download, Loader2, MessageSquareText, Sigma, Upload } from "lucide-react";

// 科研统计页。主入口是一句话研究问题：交给助手从本机患者库建队列、
// 用本地确定性代码做统计（cohort_query / cohort_compare）。CSV 上传分析
// 作为折叠的高级入口保留：描述统计、两组检验、样本量和脱敏导出。
// 结果都是待复核草稿，方法与假设始终显示。
const fmt = (value) =>
  typeof value === "number" ? String(Number(value.toFixed(4))) : value == null ? "—" : String(value);
const METHOD_LABEL = { "welch-t": "Welch t 检验", "mann-whitney": "Mann-Whitney U 检验", "chi-square": "卡方检验", "fisher-exact": "Fisher 精确检验" };
const pText = (p) => (typeof p !== "number" ? "—" : p < 0.001 ? "< 0.001" : fmt(Number(p.toFixed(4))));

// Two-group test result: the p value and direction first, method details after.
function TestResult({ result }) {
  const significant = typeof result.p === "number" && result.p < 0.05;
  const stats = [
    ["t", result.t], ["df", result.df], ["U", result.u], ["z", result.z], ["χ²", result.chi2], ["OR", result.oddsRatio], ["合计", result.total],
  ].filter(([, value]) => value !== undefined && value !== null);
  const groups = result.group1 && result.group2 ? [result.group1, result.group2] : null;
  return (
    <div className="tool-result" role="status">
      <div className="tool-result-headline">
        <span className="tool-result-value">p {pText(result.p)}</span>
        <span className="tool-result-label">{METHOD_LABEL[result.method] || result.method} · {result.outcome}{result.positive ? `（阳性 = ${result.positive}）` : ""} 按 {result.group} 分组</span>
        {typeof result.p === "number" ? <span className={`om-chip ${significant ? "is-ok" : ""}`}>{significant ? "p < 0.05" : "p ≥ 0.05"}</span> : <span className="om-chip is-caution">未能计算 p 值</span>}
      </div>
      {groups && (
        <table className="om-table research-groups">
          <thead><tr><th>组别</th><th className="num">n</th><th className="num">均值</th><th className="num">SD</th></tr></thead>
          <tbody>{groups.map((g, i) => <tr key={i}><td>{result.levels?.[i] ?? `第 ${i + 1} 组`}</td><td className="num">{g.n}</td><td className="num">{fmt(g.mean)}</td><td className="num">{fmt(g.sd)}</td></tr>)}</tbody>
        </table>
      )}
      {result.n1 !== undefined && !groups && <p className="om-meta">两组例数：{result.n1} / {result.n2}{result.levels ? `（${result.levels.join(" / ")}）` : ""}</p>}
      {stats.length > 0 && <dl className="tool-kv">{stats.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{fmt(value)}</dd></div>)}</dl>}
      <details className="om-disclosure research-raw"><summary>原始结果</summary>
        <pre className="doctor-digest">{JSON.stringify(Object.fromEntries(Object.entries(result).filter(([key]) => key !== "note")), null, 1)}</pre>
      </details>
      {result.note && <p className="om-source">{result.note}</p>}
    </div>
  );
}

const EXAMPLES = [
  "比较用和不用二甲双胍的 2 型糖尿病患者最近一次 HbA1c 有没有差别",
  "高血压患者中，男性和女性最近一次 LDL-C 控制情况有没有不同",
  "2 型糖尿病患者里，HbA1c ≥ 8% 和 < 8% 的人合并糖尿病肾病的比例有没有差别",
];

// 本机患者库概况：只有计数和常见项目名，用来判断问题能不能在本地数据上研究。
function DataSummary({ summary, error }) {
  if (error) return <p className="om-meta">暂时读取不到本机患者库概况：{error}</p>;
  if (!summary) return <p className="om-meta" role="status">正在读取本机患者库概况…</p>;
  if (!summary.patients) return <p className="om-meta">本机患者库还没有患者档案（不含已归档）。可先在「患者」中导入档案，或在下方上传 CSV 自行分析。</p>;
  const c = summary.coverage || {};
  const names = (list) => list.map((item) => `${item.name}${item.units?.length ? `（${item.units.join("/")}）` : ""} ${item.patients} 人`).join("、");
  return (
    <div className="research-data-summary om-meta">
      <p>
        本机患者库：<b>{summary.patients}</b> 位患者（不含已归档）；有诊断记录 {c.diagnoses?.patients ?? 0} 位，用药记录 {c.medications?.patients ?? 0} 位，检验记录 {c.labs?.patients ?? 0} 位，记录出生年份 {summary.ageKnown} 位。
      </p>
      {(summary.topDiagnoses?.length > 0 || summary.topLabs?.length > 0) && (
        <details>
          <summary>常见诊断、检验与用药</summary>
          {summary.topDiagnoses?.length > 0 && <p>诊断：{names(summary.topDiagnoses)}</p>}
          {summary.topLabs?.length > 0 && <p>检验：{names(summary.topLabs)}</p>}
          {summary.topMedications?.length > 0 && <p>用药：{names(summary.topMedications)}</p>}
        </details>
      )}
    </div>
  );
}

function QuestionEntry({ config, onOpenTask, onSettings }) {
  const [question, setQuestion] = useState("");
  const [summary, setSummary] = useState(null);
  const [summaryError, setSummaryError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const modelReady = Boolean(config?.modelConfigured);
  useEffect(() => {
    let alive = true;
    api("/api/research/dictionary-summary")
      .then((value) => alive && setSummary(value))
      .catch((err) => alive && setSummaryError(err.message));
    return () => {
      alive = false;
    };
  }, []);
  const submit = async (event) => {
    event.preventDefault();
    const text = question.trim();
    if (!text || busy) return;
    if (!modelReady) {
      setError("需先连接模型：把研究问题翻译成分组条件需要模型；统计本身在本机计算。问题已保留，可在 设置 → 模型与运行 中连接模型。");
      return;
    }
    if (!onOpenTask) {
      setError("当前页面无法打开任务，请从工作台提问。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const task = await api("/api/sessions", "POST", { title: `科研统计 · ${text.slice(0, 40)}` });
      // 医生的问题原样作为提问；数据来源说明作为附带上下文。
      await onOpenTask(task.id, {
        submit: true,
        draft: text,
        context: { kind: "research-stats-question", label: "科研统计 · 本机患者库", scope: {} },
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="tool-section research-question">
      <div className="tool-section-head">
        <div>
          <h2><MessageSquareText size={16} /> 想研究什么问题？</h2>
          <p>用一句话描述人群、比较的组和关心的指标。助手会先确认口径，从本机患者库建立各组队列，统计由本机确定性计算；缺资料的患者单独列出，不当作阴性。</p>
        </div>
      </div>
      <DataSummary summary={summary} error={summaryError} />
      <form onSubmit={submit} className="research-question-form">
        <textarea
          rows={3}
          value={question}
          aria-label="研究问题"
          placeholder="例如：比较用和不用二甲双胍的 2 型糖尿病患者最近一次 HbA1c 有没有差别"
          onChange={(e) => setQuestion(e.target.value)}
          disabled={busy}
        />
        <div className="research-examples" role="group" aria-label="示例问题">
          {EXAMPLES.map((text) => (
            <button type="button" key={text} className="secondary" disabled={busy} onClick={() => setQuestion(text)}>
              {text}
            </button>
          ))}
        </div>
        <div className="research-import">
          <button className="primary" type="submit" disabled={busy || !question.trim()} title={modelReady ? undefined : "需先连接模型"}>
            {busy ? <Loader2 className="spin" size={14} /> : null}
            交给助手分析
          </button>
          {!modelReady && (
            <span className="om-meta">
              未连接模型。{onSettings && <button type="button" className="text-button" onClick={onSettings}>去连接模型</button>}
            </span>
          )}
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
      </form>
      <p className="om-source">结果是探索性、相关性的待复核草稿：会注明各组人数、缺失原因、检验方法、p 值与 95% 置信区间，以及混杂和多重比较的提示。</p>
    </section>
  );
}

export function ResearchView({ config, onOpenTask, onSettings }) {
  const selectionGeneration = useRef(0);
  const uploadRef = useRef(null);
  const uploadSession = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [uploadNotice, setUploadNotice] = useState("");
  const [filesLoading, setFilesLoading] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState("");
  const [files, setFiles] = useState([]);
  const [sourceId, setSourceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [profile, setProfile] = useState(null);
  const [test, setTest] = useState({ outcome: "", group: "", method: "auto", positive: "" });
  const [testResult, setTestResult] = useState(null);
  const [size, setSize] = useState({ design: "means", delta: "", sd: "", p1: "", p2: "", alpha: 0.05, power: 0.8 });
  const [sizeResult, setSizeResult] = useState(null);
  const [deidColumns, setDeidColumns] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    api("/api/sessions")
      .then((value) => setSessions(value.sessions))
      .catch((err) => setError(err.message));
  }, []);
  const uploadDataset = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || uploading) return;
    if (!/\.csv$/i.test(file.name) || !file.size || file.size > 2000000) {
      setError("请选择非空 CSV 文件，大小不超过 2MB。"); return;
    }
    setUploading(true); setError(""); setUploadNotice("");
    const version = ++selectionGeneration.current;
    try {
      const text = await file.text();
      let task = uploadSession.current;
      if (!task) { task = await api("/api/sessions", "POST", {title: `数据分析 · ${file.name}`}); uploadSession.current = task; }
      await api(`/api/sessions/${task.id}/files`, "POST", {name:file.name, text});
      const detail = await api(`/api/sessions/${task.id}`);
      if (version !== selectionGeneration.current) return;
      setSessions(old => [{...detail}, ...old.filter(s => s.id !== detail.id)]);
      setSessionId(detail.id);
      const datasets = detail.files.filter(f => /\.csv$/i.test(f.name));
      setFiles(datasets); setSourceId(datasets.at(-1)?.id || "");
      setProfile(null); setTestResult(null);
      setUploadNotice(`已保存「${file.name}」，可开始分析；文件可在任务记录中继续使用。`);
      uploadSession.current = null;
    } catch (err) { setError(err.message); }
    finally { setUploading(false); }
  };
  const useExample = async () => {
    if (busy || uploading) return;
    setUploading(true); setError("");
    const version = ++selectionGeneration.current;
    try {
      const pack = await api("/api/demo-pack", "POST", {});
      const detail = await api(`/api/sessions/${pack.sessionId}`);
      if (version !== selectionGeneration.current) return;
      const datasets = detail.files.filter(f => /\.csv$/i.test(f.name));
      setSessions(old => [detail, ...old.filter(s => s.id !== detail.id)]);
      setSessionId(detail.id); setFiles(datasets); setSourceId(datasets.find(f => f.name === "示例研究数据.csv")?.id || "");
      setProfile(null); setTestResult(null);
      setTest({ outcome: "sbp", group: "group", method: "auto", positive: "" });
      setSize({ design: "means", delta: "8", sd: "12", p1: "", p2: "", alpha: 0.05, power: 0.8 });
      setDeidColumns("subject");
      setUploadNotice("已安装示例数据包（同时向患者、病例、知识库等页面加入虚构示例，可在「示例体验」页删除），并选中其中 12 行虚构研究数据。先查看数据概况，再比较 A/B 两组的 sbp；样本量和脱敏字段也已填入示例。可修改后重新计算。");
    } catch (err) { setError(err.message); }
    finally { setUploading(false); }
  };
  const pickSession = async (id) => {
    const version = ++selectionGeneration.current;
    setSessionId(id);
    setProfile(null);
    setTestResult(null);
    setSourceId("");
    setFiles([]);
    setError("");
    setFilesLoading(Boolean(id));
    if (!id) return;
    try {
      const detail = await api(`/api/sessions/${id}`);
      if (version === selectionGeneration.current) setFiles(detail.files.filter((f) => /\.csv$/i.test(f.name)));
    } catch (err) {
      if (version === selectionGeneration.current) setError(err.message);
    } finally {
      if (version === selectionGeneration.current) setFilesLoading(false);
    }
  };
  useEffect(() => { setTestResult(null); }, [test.outcome, test.group, test.method, test.positive]);
  useEffect(() => { setSizeResult(null); }, [size]);
  const run = async (action) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const runProfile = () =>
    run(async () => {
      const value = await api("/api/research/profile", "POST", { sessionId, sourceId });
      setProfile(value);
    });
  const runTest = () =>
    run(async () => {
      const value = await api("/api/research/test", "POST", {
        sessionId,
        sourceId,
        outcome: test.outcome,
        group: test.group,
        method: test.method,
        ...(test.positive.trim() && !["welch-t", "mann-whitney"].includes(test.method) ? { positive: test.positive.trim() } : {}),
      });
      setTestResult(value);
    });
  const runSize = () =>
    run(async () => {
      const value = await api("/api/research/sample-size", "POST", {
        design: size.design,
        alpha: Number(size.alpha),
        power: Number(size.power),
        ...(size.design === "means"
          ? { delta: Number(size.delta), sd: Number(size.sd) }
          : { p1: Number(size.p1), p2: Number(size.p2) }),
      });
      setSizeResult(value);
    });
  const runDeidentify = () =>
    run(async () => {
      const value = await api("/api/research/deidentify", "POST", {
        sessionId,
        sourceId,
        columns: deidColumns.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      });
      const blob = new Blob([value.csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `deidentified-${value.sourceName.replace(/\.csv$/i, "")}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    });

  const columns = profile ? Object.keys(profile.columns) : [];
  const selectedFile = files.find((f) => f.id === sourceId);
  return (
    <div className="module-view tool-page">
      <section className="module-card research-view">
        <div className="module-head">
          <div>
            <h1>科研统计</h1>
            <p className="module-phase">用一句话提出研究问题，助手从本机患者库建立队列并做统计；也可以上传 CSV 自行分析。统计均在本机计算。</p>
          </div>
        </div>
        <QuestionEntry config={config} onOpenTask={onOpenTask} onSettings={onSettings} />
        <details className="om-disclosure research-advanced" open={advancedOpen} onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}>
        <summary>上传 CSV 自行分析（高级）：描述统计、组间比较、样本量估算、脱敏导出</summary>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <section className="tool-section research-source">
          <div className="tool-section-head">
            <div>
              <h2>1 · 选择数据</h2>
              <p>{selectedFile ? `当前数据：${selectedFile.name}` : "上传 CSV，或从已有任务中选择。文件保存在本机任务中。"}</p>
            </div>
          </div>
          <div className="research-import">
            <button className="primary" disabled={busy || uploading} onClick={() => uploadRef.current?.click()}><Upload size={16}/>{uploading ? "正在导入…" : "上传 CSV 数据"}</button>
            <button className="secondary" disabled={busy || uploading} onClick={useExample} title="会安装完整示例数据包：虚构患者、病例、知识库与研究数据">使用示例数据</button>
            <input ref={uploadRef} type="file" accept=".csv" hidden onChange={uploadDataset}/>
          </div>
          {uploadNotice && <p role="status" className="om-meta">{uploadNotice}</p>}
          <div className="tool-row research-pick">
            <select className="grow" aria-label="选择数据所在任务" value={sessionId} disabled={busy || uploading} onChange={(e) => pickSession(e.target.value)}>
              <option value="">选择已有任务…</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
            <select className="grow" aria-label="选择 CSV 数据" value={sourceId} onChange={(e) => { setSourceId(e.target.value); setProfile(null); setTestResult(null); setError(""); }} disabled={busy || uploading || filesLoading || !files.length}>
              <option value="">{filesLoading ? "正在读取材料…" : !sessionId ? "请上传 CSV 或选择任务" : files.length ? "选择 CSV 数据…" : "该会话没有 CSV 材料"}</option>
              {files.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section className="tool-section">
          <div className="tool-section-head">
            <div>
              <h2><Sigma size={16} /> 描述统计</h2>
              <p>逐列给出类型、例数与均值/中位数或分类计数。</p>
            </div>
            <button className="secondary" onClick={runProfile} disabled={busy || uploading || !sourceId}>
              {busy ? <Loader2 className="spin" size={14} /> : null}
              分析数据集
            </button>
          </div>
          {profile ? (
            <table className="om-table research-table">
              <thead>
                <tr>
                  <th>列</th>
                  <th>类型</th>
                  <th className="num">n</th>
                  <th>统计</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(profile.columns).map(([column, stat]) => (
                  <tr key={column}>
                    <td><b>{column}</b></td>
                    <td>{stat.type === "numeric" ? "数值" : "分类"}</td>
                    <td className="num">{stat.n}</td>
                    <td>
                      {stat.type === "numeric"
                        ? `均值 ${fmt(stat.mean)} · SD ${fmt(stat.sd)} · 中位 ${fmt(stat.median)} [${fmt(stat.min)}–${fmt(stat.max)}]`
                        : stat.levels.map((l) => `${l.level}:${l.count}`).join(" · ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="tool-list-empty">{sourceId ? "点击「分析数据集」查看各列概况；列名会用于下方组间比较。" : "先选择数据。"}</p>}
        </section>

        <section className="tool-section">
          <div className="tool-section-head">
            <div>
              <h2>组间比较</h2>
              <p>选择结局变量与分组变量；「自动选择」按数据类型选用检验方法。二分类结局（如 是/否、yes/no、阳性/阴性）用卡方或 Fisher，无法识别阳性时请填写阳性取值。</p>
            </div>
          </div>
          <div className="tool-row">
            <input className="grow" disabled={busy || uploading}
              value={test.outcome}
              list={columns.length ? "research-columns" : undefined}
              aria-label="结局变量列名" placeholder="结局变量列名"
              onChange={(e) => setTest({ ...test, outcome: e.target.value })}
            />
            <input className="grow" disabled={busy || uploading}
              value={test.group}
              list={columns.length ? "research-columns" : undefined}
              aria-label="分组变量列名" placeholder="分组变量列名"
              onChange={(e) => setTest({ ...test, group: e.target.value })}
            />
            {columns.length > 0 && <datalist id="research-columns">{columns.map((c) => <option key={c} value={c} />)}</datalist>}
            <select aria-label="统计检验方法" disabled={busy || uploading} value={test.method} onChange={(e) => setTest({ ...test, method: e.target.value })}>
              <option value="auto">自动选择</option>
              <option value="welch-t">Welch t 检验</option>
              <option value="mann-whitney">Mann-Whitney U</option>
              <option value="chi-square">卡方检验</option>
              <option value="fisher">Fisher 精确检验</option>
            </select>
            {!["welch-t", "mann-whitney"].includes(test.method) && (
              <input disabled={busy || uploading}
                value={test.positive}
                aria-label="阳性取值（可选）" placeholder="阳性取值（可选，如 yes）"
                onChange={(e) => setTest({ ...test, positive: e.target.value })}
              />
            )}
            <button
              className="primary"
              onClick={runTest}
              disabled={busy || uploading || !sourceId || !test.outcome.trim() || !test.group.trim()}
            >
              运行检验
            </button>
          </div>
          {testResult && <TestResult result={testResult} />}
        </section>

        <div className="research-pair">
          <section className="tool-section">
            <div className="tool-section-head">
              <div>
                <h2>样本量估算（两独立组）</h2>
                <p>α = 0.05，power = 0.8，两组等量。</p>
              </div>
            </div>
            <div className="tool-row">
              <select aria-label="样本量研究设计" disabled={busy || uploading} value={size.design} onChange={(e) => setSize({ ...size, design: e.target.value })}>
                <option value="means">均值比较</option>
                <option value="proportions">比例比较</option>
              </select>
              {size.design === "means" ? (
                <>
                  <input className="grow" disabled={busy || uploading}
                    value={size.delta}
                    aria-label="预期差值 Δ" placeholder="预期差值 Δ"
                    onChange={(e) => setSize({ ...size, delta: e.target.value })}
                  />
                  <input className="grow" disabled={busy || uploading}
                    value={size.sd}
                    aria-label="标准差 σ" placeholder="标准差 σ"
                    onChange={(e) => setSize({ ...size, sd: e.target.value })}
                  />
                </>
              ) : (
                <>
                  <input className="grow" disabled={busy || uploading}
                    value={size.p1}
                    aria-label="对照组率 p1" placeholder="对照组率 p1"
                    onChange={(e) => setSize({ ...size, p1: e.target.value })}
                  />
                  <input className="grow" disabled={busy || uploading}
                    value={size.p2}
                    aria-label="试验组率 p2" placeholder="试验组率 p2"
                    onChange={(e) => setSize({ ...size, p2: e.target.value })}
                  />
                </>
              )}
              <button className="primary" onClick={runSize} disabled={busy || uploading}>
                计算
              </button>
            </div>
            {sizeResult && (
              <div className="tool-result" role="status">
                <div className="tool-result-headline">
                  <span className="tool-result-value">每组 {sizeResult.n1} 例</span>
                  <span className="tool-result-label">共 {sizeResult.total} 例 · α={sizeResult.alpha} · power={sizeResult.power}</span>
                </div>
                <p className="om-source">{sizeResult.note}</p>
              </div>
            )}
          </section>

          <section className="tool-section">
            <div className="tool-section-head">
              <div>
                <h2>数据脱敏导出</h2>
                <p>把指定列替换为伪标识后下载 CSV。每次导出使用新的随机密钥且不保存，编码无法还原；同一文件内同一原始值编码一致。</p>
              </div>
            </div>
            <div className="tool-row">
              <input className="grow" disabled={busy || uploading}
                value={deidColumns}
                list={columns.length ? "research-columns" : undefined}
                aria-label="需要脱敏的列名" placeholder="需要脱敏的列名，逗号分隔（如 姓名,住院号）"
                onChange={(e) => setDeidColumns(e.target.value)}
              />
              <button className="secondary" onClick={runDeidentify} disabled={busy || uploading || !sourceId || !deidColumns.trim()}>
                <Download size={14} /> 生成脱敏 CSV
              </button>
            </div>
          </section>
        </div>
        <p className="tool-footnote">
          统计在本地确定性完成（Welch t / Mann-Whitney / 卡方 / Fisher 精确检验，均给出 p
          值与方法学提示）。结果为待复核草稿，请在解读前核对数据质量与假设。
        </p>
        </details>
      </section>
    </div>
  );
}
