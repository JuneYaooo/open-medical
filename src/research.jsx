import { useEffect, useRef, useState } from "react";
import { api } from "./agent-runtime";
import { Download, Loader2, Sigma, Upload } from "lucide-react";

// Research analysis view: pick a session CSV, run deterministic descriptive
// stats / two-group tests / sample-size / de-identification. Results are
// draft material — methods and assumptions are always displayed.
const fmt = (value) =>
  typeof value === "number" ? String(Number(value.toFixed(4))) : value == null ? "—" : String(value);

export function ResearchView() {
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
  const [test, setTest] = useState({ outcome: "", group: "", method: "auto" });
  const [testResult, setTestResult] = useState(null);
  const [size, setSize] = useState({ design: "means", delta: "", sd: "", p1: "", p2: "", alpha: 0.05, power: 0.8 });
  const [sizeResult, setSizeResult] = useState(null);
  const [deidColumns, setDeidColumns] = useState("");

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
  useEffect(() => { setTestResult(null); }, [test.outcome, test.group, test.method]);
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

  return (
    <div className="module-view">
      <section className="module-card research-view">
        <div className="module-head">
          <div>
            <h1>科研统计 · 数据分析</h1>
            <p className="module-phase">上传 CSV 或选择已有任务中的数据，先检查数据，再选择分析方法。</p>
          </div>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="research-import">
          <button className="primary" disabled={busy || uploading} onClick={() => uploadRef.current?.click()}><Upload size={16}/>{uploading ? "正在导入…" : "上传 CSV 数据"}</button>
          <input ref={uploadRef} type="file" accept=".csv" hidden onChange={uploadDataset}/>
          <span>也可以选择已有数据。文件保存在本机任务中。</span>
        </div>
        {uploadNotice && <p role="status">{uploadNotice}</p>}
        <div className="followup-apply">
          <select aria-label="选择数据所在任务" value={sessionId} disabled={busy || uploading} onChange={(e) => pickSession(e.target.value)}>
            <option value="">选择已有任务…</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
          <select aria-label="选择 CSV 数据" value={sourceId} onChange={(e) => { setSourceId(e.target.value); setProfile(null); setTestResult(null); setError(""); }} disabled={busy || uploading || filesLoading || !files.length}>
            <option value="">{filesLoading ? "正在读取材料…" : !sessionId ? "请上传 CSV 或选择任务" : files.length ? "选择 CSV 数据…" : "该会话没有 CSV 材料"}</option>
            {files.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>

        <section className="followups-section">
          <h3>
            <Sigma size={14} /> 描述统计
          </h3>
          <button className="secondary" onClick={runProfile} disabled={busy || uploading || !sourceId}>
            {busy ? <Loader2 className="spin" size={14} /> : null}
            分析数据集
          </button>
          {profile && (
            <table className="research-table">
              <thead>
                <tr>
                  <th>列</th>
                  <th>类型</th>
                  <th>n</th>
                  <th>统计</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(profile.columns).map(([column, stat]) => (
                  <tr key={column}>
                    <td>{column}</td>
                    <td>{stat.type === "numeric" ? "数值" : "分类"}</td>
                    <td>{stat.n}</td>
                    <td>
                      {stat.type === "numeric"
                        ? `均值 ${fmt(stat.mean)} · SD ${fmt(stat.sd)} · 中位 ${fmt(stat.median)} [${fmt(stat.min)}–${fmt(stat.max)}]`
                        : stat.levels.map((l) => `${l.level}:${l.count}`).join(" · ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="followups-section">
          <h3>组间比较</h3>
          <div className="followup-apply">
            <input disabled={busy || uploading}
              value={test.outcome}
              aria-label="结局变量列名" placeholder="结局变量列名"
              onChange={(e) => setTest({ ...test, outcome: e.target.value })}
            />
            <input disabled={busy || uploading}
              value={test.group}
              aria-label="分组变量列名" placeholder="分组变量列名"
              onChange={(e) => setTest({ ...test, group: e.target.value })}
            />
            <select aria-label="统计检验方法" disabled={busy || uploading} value={test.method} onChange={(e) => setTest({ ...test, method: e.target.value })}>
              <option value="auto">自动选择</option>
              <option value="welch-t">Welch t 检验</option>
              <option value="mann-whitney">Mann-Whitney U</option>
              <option value="chi-square">卡方检验</option>
              <option value="fisher">Fisher 精确检验</option>
            </select>
            <button
              onClick={runTest}
              disabled={busy || uploading || !sourceId || !test.outcome.trim() || !test.group.trim()}
            >
              运行检验
            </button>
          </div>
          {testResult && (
            <pre className="doctor-digest">
              {JSON.stringify(
                Object.fromEntries(
                  Object.entries(testResult).filter(([key]) => key !== "note"),
                ),
                null,
                1,
              )}
            </pre>
          )}
          {testResult?.note && <p className="module-note">{testResult.note}</p>}
        </section>

        <section className="followups-section">
          <h3>样本量估算（两独立组）</h3>
          <div className="followup-apply">
            <select aria-label="样本量研究设计" disabled={busy || uploading} value={size.design} onChange={(e) => setSize({ ...size, design: e.target.value })}>
              <option value="means">均值比较</option>
              <option value="proportions">比例比较</option>
            </select>
            {size.design === "means" ? (
              <>
                <input disabled={busy || uploading}
                  value={size.delta}
                  aria-label="预期差值 Δ" placeholder="预期差值 Δ"
                  onChange={(e) => setSize({ ...size, delta: e.target.value })}
                />
                <input disabled={busy || uploading}
                  value={size.sd}
                  aria-label="标准差 σ" placeholder="标准差 σ"
                  onChange={(e) => setSize({ ...size, sd: e.target.value })}
                />
              </>
            ) : (
              <>
                <input disabled={busy || uploading}
                  value={size.p1}
                  aria-label="对照组率 p1" placeholder="对照组率 p1"
                  onChange={(e) => setSize({ ...size, p1: e.target.value })}
                />
                <input disabled={busy || uploading}
                  value={size.p2}
                  aria-label="试验组率 p2" placeholder="试验组率 p2"
                  onChange={(e) => setSize({ ...size, p2: e.target.value })}
                />
              </>
            )}
            <button onClick={runSize} disabled={busy || uploading}>
              计算
            </button>
          </div>
          {sizeResult && (
            <p className="literature-authors">
              每组 <b>{sizeResult.n1}</b> 例，共 {sizeResult.total} 例（α={sizeResult.alpha},
              power={sizeResult.power}）。{sizeResult.note}
            </p>
          )}
        </section>

        <section className="followups-section">
          <h3>数据脱敏导出</h3>
          <div className="followup-apply">
            <input disabled={busy || uploading}
              value={deidColumns}
              aria-label="需要脱敏的列名" placeholder="需要脱敏的列名，逗号分隔（如 姓名,住院号）"
              onChange={(e) => setDeidColumns(e.target.value)}
            />
            <button className="secondary" onClick={runDeidentify} disabled={busy || uploading || !sourceId || !deidColumns.trim()}>
              <Download size={14} /> 生成脱敏 CSV
            </button>
          </div>
        </section>
        <p className="module-note">
          统计在本地确定性完成（Welch t / Mann-Whitney / 卡方 / Fisher 精确检验，均给出 p
          值与方法学提示）。结果为待复核草稿，请在解读前核对数据质量与假设。
        </p>
      </section>
    </div>
  );
}
