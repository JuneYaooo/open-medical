import { useEffect, useState } from "react";
import { api } from "./agent-runtime";
import { Calculator, FileSpreadsheet, Loader2, Settings2 } from "lucide-react";

const fmt = (value) =>
  typeof value === "number" ? value.toLocaleString("zh-CN") : value == null ? "—" : String(value);

// DRG estimator: single-case grouping, batch CSV analysis, and local
// weight/rate configuration over the bundled (or imported) scheme.
export function DrgView() {
  const [caseForm, setCaseForm] = useState({
    principalDx: "",
    secondaryDx: "",
    procedures: "",
    totalCost: "",
  });
  const [caseResult, setCaseResult] = useState(null);
  const [csvText, setCsvText] = useState("");
  const [batchResult, setBatchResult] = useState(null);
  const [settings, setSettings] = useState(null);
  const [rateInput, setRateInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { setCaseResult(null); }, [caseForm]);
  useEffect(() => { setBatchResult(null); }, [csvText]);
  useEffect(() => { setCaseResult(null); setBatchResult(null); }, [settings]);

  const refreshSettings = async () => {
    const value = await api("/api/drg/settings");
    setSettings(value);
    setRateInput(String(value.rate));
    return value;
  };
  useEffect(() => {
    refreshSettings().catch((err) => setError(err.message));
  }, []);

  const run = (action) => {
    setBusy(true);
    setError("");
    return action()
      .catch((err) => setError(err.message))
      .finally(() => setBusy(false));
  };
  const splitList = (text) =>
    text
      .split(/[;；|]/)
      .map((item) => item.trim())
      .filter(Boolean);
  const groupCase = () =>
    run(async () => {
      const value = await api("/api/drg/group", "POST", {
        principalDx: caseForm.principalDx,
        secondaryDx: splitList(caseForm.secondaryDx),
        procedures: splitList(caseForm.procedures),
        totalCost: caseForm.totalCost ? Number(caseForm.totalCost) : undefined,
      });
      setCaseResult(value);
    });
  const runBatch = () =>
    run(async () => {
      const value = await api("/api/drg/batch", "POST", { csvText });
      setBatchResult(value);
    });
  const saveRate = () =>
    run(async () => {
      const value = await api("/api/drg/settings", "POST", {
        rate: Number(rateInput),
      });
      setSettings(value);
    });
  const importFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    run(async () => {
      const text = await file.text();
      const weights = JSON.parse(text);
      const value = await api("/api/drg/import", "POST", { weights });
      setSettings(value);
    });
  };

  return (
    <div className="module-view">
      <section className="module-card drg-view">
        <div className="module-head">
          <div>
            <h1>DRG 示例测算</h1>
            <p role="note">此页面仅用于演示简化分组，不是完整的本院医保分组器。导入权重也不会补齐分组规则，不能用于实际医保结算。</p>
            <p className="module-phase">
              {settings?.schemeVersion || "加载方案…"} · 费率 {fmt(settings?.rate)} 元/权重
            </p>
          </div>
          <div className="drg-settings">
            <Settings2 size={15} />
            <input disabled={busy}
              value={rateInput}
              inputMode="decimal"
              title="费率（元/权重）"
              onChange={(e) => setRateInput(e.target.value.replace(/[^\d.]/g, ""))}
            />
            <button className="secondary" onClick={saveRate} disabled={busy}>
              保存费率
            </button>
            <label className="drg-import">
              <FileSpreadsheet size={14} /> 导入权重
              <input type="file" accept=".json" hidden onChange={importFile} />
            </label>
          </div>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <section className="followups-section">
          <h3>
            <Calculator size={14} /> 单例分组
          </h3>
          <div className="drg-form">
            <input disabled={busy}
              value={caseForm.principalDx}
              aria-label="主要诊断" placeholder="主要诊断（ICD-10，如 J18.9 社区获得性肺炎）"
              onChange={(e) => setCaseForm({ ...caseForm, principalDx: e.target.value })}
            />
            <input disabled={busy}
              value={caseForm.secondaryDx}
              aria-label="其他诊断" placeholder="其他诊断（多个用 ; 分隔，如 I50.9;E11.9）"
              onChange={(e) => setCaseForm({ ...caseForm, secondaryDx: e.target.value })}
            />
            <input disabled={busy}
              value={caseForm.procedures}
              aria-label="手术操作" placeholder="手术操作（ICD-9-CM-3，多个用 ; 分隔，可留空）"
              onChange={(e) => setCaseForm({ ...caseForm, procedures: e.target.value })}
            />
            <input disabled={busy}
              value={caseForm.totalCost}
              inputMode="decimal"
              aria-label="实际总费用（元，可选）" placeholder="实际总费用（元，可选）"
              onChange={(e) =>
                setCaseForm({ ...caseForm, totalCost: e.target.value.replace(/[^\d.]/g, "") })
              }
            />
            <button onClick={groupCase} disabled={busy || !caseForm.principalDx.trim()}>
              {busy ? <Loader2 className="spin" size={14} /> : null}
              分组
            </button>
          </div>
          {caseResult && (
            <div className="drg-result">
              {caseResult.drgCode ? (
                <>
                  <div className="drg-code">
                    <b>{caseResult.drgCode}</b>
                    <span>
                      {caseResult.adrg} · {caseResult.mdc} ·{" "}
                      {caseResult.complication.label}
                    </span>
                  </div>
                  <p>
                    RW <b>{fmt(caseResult.rw)}</b>（{caseResult.rwSource === "imported" ? "导入数据" : "内置示例"}）
                    · 预估费用 <b>{fmt(caseResult.estimatedCost)} 元</b>
                    {caseResult.actualCost !== undefined && (
                      <>
                        {" "}
                        · 实际 {fmt(caseResult.actualCost)} 元 · 偏差{" "}
                        <b className={caseResult.costDeviation > 0 ? "risk" : ""}>
                          {caseResult.costDeviation > 0 ? "+" : ""}
                          {fmt(caseResult.costDeviation)} 元
                        </b>
                      </>
                    )}
                  </p>
                </>
              ) : (
                <p className="memory-empty">{caseResult.ungroupedReason}</p>
              )}
            </div>
          )}
        </section>

        <section className="followups-section">
          <h3>批量分析（CSV：principal_dx, secondary_dx, procedures, total_cost）</h3>
          <textarea aria-label="批量分组 CSV" disabled={busy}
            className="case-summary"
            rows={4}
            value={csvText}
            placeholder={"principal_dx,secondary_dx,procedures,total_cost\nJ18.9;I50.9;;\nI20.0;E11.9;36.07;58000"}
            onChange={(e) => setCsvText(e.target.value)}
          />
          <button className="secondary" onClick={runBatch} disabled={busy || !csvText.trim()}>
            批量分组并统计 CMI
          </button>
          {batchResult && (
            <div className="drg-result">
              <p>
                共 {batchResult.rows} 例 · 成功分组 {batchResult.grouped} · 未分组{" "}
                {batchResult.ungrouped} · <b>CMI {fmt(batchResult.cmi)}</b> · 预估总额{" "}
                {fmt(batchResult.totalEstimated)} 元
                {batchResult.totalActual ? ` · 实际总额 ${fmt(batchResult.totalActual)} 元` : ""}
              </p>
              <table className="research-table">
                <thead>
                  <tr>
                    <th>主诊断</th>
                    <th>DRG</th>
                    <th>RW</th>
                    <th>预估费用</th>
                  </tr>
                </thead>
                <tbody>
                  {batchResult.results.map((row, index) => (
                    <tr key={index}>
                      <td>{row.principalDx}</td>
                      <td>{row.drgCode || `未分组（${row.ungroupedReason?.slice(0, 18)}…）`}</td>
                      <td>{fmt(row.rw)}</td>
                      <td>{fmt(row.estimatedCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <p className="module-note">
          内置方案为 CHS-DRG 1.1 简化示例（MDC 路由 + 常见病组 + 代表性权重），与本院实际可能存在差异；费率与权重可配置，支持导入本地分组数据覆盖。测算结果仅供参考，不构成医疗或医保结论。
        </p>
      </section>
    </div>
  );
}
