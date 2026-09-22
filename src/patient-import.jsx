import { useRef, useState } from "react";
import { Upload, Download } from "lucide-react";
import { PATIENT_IMPORT_TEMPLATE } from "../shared/patient-import.mjs";
import { api } from "./agent-runtime";
import { Modal } from "./components";

export function PatientImportModal({ onClose, onImported, onOpenPatient }) {
  const [text, setText] = useState(""), [preview, setPreview] = useState(null), [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const requestId = useRef(crypto.randomUUID()), inFlight = useRef(false), fileInput = useRef(null);
  const loadFile = async (file) => {
    if (!file) return;
    try {
      if (file.size > 200000) throw new Error("表格超过 200KB，请分批导入");
      setText(await file.text()); setPreview(null); setError("");
    } catch (err) { setError(err.message); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob(["\uFEFF" + PATIENT_IMPORT_TEMPLATE], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = "患者导入模板.csv"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const run = async (commit) => {
    if (inFlight.current) return; inFlight.current = true; setBusy(true); setError("");
    try {
      if (commit) {
        const result = await api("/api/patients/import/commit", "POST", { text, fingerprint: preview.fingerprint, requestId: requestId.current, selectedRows: selected,
          distinctRows: preview.rows.filter((row) => row.status === "same_name" && selected.includes(row.row)).map((row) => row.row) });
        await onImported(result);
      } else {
        const result = await api("/api/patients/import/preview", "POST", { text });
        setPreview(result); setSelected(result.rows.filter((row) => row.status === "ready").map((row) => row.row)); requestId.current = crypto.randomUUID();
      }
    } catch (err) { setError(err.message); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <Modal title="导入已有患者" wide onClose={() => { if (!busy) onClose(); }}>
    <div className="patient-import"><p className="muted">支持 CSV 文件或从 Excel 复制表格。先预览、核对身份，再新建档案；每次最多 200 位。</p>
      {!preview ? <><div className="toolbar-actions"><button className="secondary" disabled={busy} onClick={download}><Download size={14} /> 下载空白模板</button><button className="secondary" disabled={busy} onClick={() => fileInput.current.click()}><Upload size={14} /> 选择表格文件</button><input ref={fileInput} type="file" accept=".csv,.tsv,.txt" hidden onChange={(e) => { loadFile(e.target.files?.[0]); e.target.value = ""; }} /></div>
        <label>患者表格文本<textarea rows={10} maxLength={200000} disabled={busy} value={text} onChange={(e) => setText(e.target.value)} placeholder={`${PATIENT_IMPORT_TEMPLATE}可直接粘贴包含表头的 Excel 单元格`} /></label>
        <small className="muted">目前导入基础身份、分组和标签。临床病史、用药和检验请在建档后导入原始材料。</small></> : <>
        <div className="import-summary"><b>{preview.rows.length} 条记录</b><span>{preview.counts.ready} 条可新建</span><span>{preview.counts.same_name} 条同名待核对</span><span>{preview.counts.existing} 条编号已存在</span><span>{preview.counts.invalid} 条需修正</span></div>
        <p className="muted">相同编号不会覆盖已有档案；同名行需要逐条确认。错误行可返回修改，也可仅导入已选行。</p>
        <div className="import-table"><table><thead><tr><th>选择</th><th>行</th><th>姓名 / 编号</th><th>基础信息</th><th>核对结果</th></tr></thead><tbody>{preview.rows.map((row) => <tr key={row.row}><td><input type="checkbox" aria-label={`选择第 ${row.row} 行${row.status === "same_name" ? "，已核对是另一位同名患者" : ""}`} disabled={busy || ["existing", "invalid"].includes(row.status)} checked={selected.includes(row.row)} onChange={(e) => setSelected((prev) => e.target.checked ? [...prev, row.row] : prev.filter((number) => number !== row.row))} /></td><td>{row.row}</td><td><b>{row.input.name || "缺少姓名"}</b><small>{row.input.patientNumber || "未填编号"}</small></td><td>{row.input.birthYear ? `${row.input.birthYear} 年生` : "出生年未填"}<small>{row.input.phone || "电话未填"}</small></td><td>{row.status === "ready" ? "可新建" : row.status === "existing" ? <><span>编号已存在{row.existing.archived ? "（已归档）" : ""}</span><button className="text-button" disabled={busy} onClick={() => onOpenPatient(row.existing.id)}>打开已有档案</button></> : row.status === "invalid" ? row.errors.join("；") : <><b>勾选表示：已核对是另一位患者</b><small>{row.matches.map((p) => `${p.name} · ${p.patientNumber || p.id.slice(0, 8)} · ${p.birthYear || "出生年未填"}`).join("；")}{row.sameBatchName ? `；表内另有 ${row.sameBatchName} 条同名记录` : ""}</small></>}</td></tr>)}</tbody></table></div>
      </>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="modal-actions">{preview && <button className="secondary" disabled={busy} onClick={() => { setPreview(null); setError(""); }}>返回修改表格</button>}<button className="primary" disabled={busy || (preview ? !selected.length : !text.trim())} onClick={() => run(Boolean(preview))}>{busy ? "处理中…" : preview ? `新建 ${selected.length} 位患者` : "预览并检查"}</button></div>
    </div>
  </Modal>;
}
