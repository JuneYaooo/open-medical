import { useState } from "react";
import { api } from "./agent-runtime";
import { Download, FileText, Loader2, Share2, X } from "lucide-react";
import { SHARE_SECTIONS, FINDING_LABELS, REDACT_MARK, buildShareSections, renderShareHtml } from "../shared/share-report.mjs";
import "./share-wizard.css";

// 脱敏分享向导：选内容 → 看打码预览 → 存 JSON / 导出 PDF。
// 预览返回的就是最终导出的内容，医生确认过什么就发出去什么；
// 桌面版走主进程 printToPDF，浏览器回退到系统打印（可另存为 PDF）。
export function ShareWizard({ patientId, patientName, onClose, onError }) {
  const [step, setStep] = useState(1);
  const [sections, setSections] = useState(() => new Set(SHARE_SECTIONS.map(([key]) => key)));
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const toggleSection = (key) => {
    setSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const runPreview = async () => {
    setBusy(true);
    try {
      const result = await api(`/api/patients/${patientId}/share`, "POST", { sections: [...sections] });
      setPreview(result);
      setStep(2);
    } catch (err) {
      onError?.(err.message);
    } finally {
      setBusy(false);
    }
  };
  const downloadJson = () => {
    const blob = new Blob([JSON.stringify(preview.record, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${preview.record.pseudoId}-脱敏.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice("JSON 已保存到下载文件夹（内容与上方预览完全一致）。");
  };
  const shareReport = () => ({
    title: "脱敏病历摘要",
    subtitle: `${preview.record.pseudoId} · ${preview.record.gender === "male" ? "男" : preview.record.gender === "female" ? "女" : "性别未登记"} · ${preview.record.ageBand ? `${preview.record.ageBand} 岁` : "年龄未登记"}`,
    sections: buildShareSections(preview.record).filter((section) => section.rows.length),
    note: preview.record.note,
    footer: `生成时间：${new Date(preview.record.exportedAt).toLocaleString("zh-CN")}`,
    fileName: `${preview.record.pseudoId}-脱敏病历`,
  });
  const exportPdf = async () => {
    setBusy(true);
    try {
      const report = shareReport();
      if (window.omwDesktop?.shareReport) {
        const result = await window.omwDesktop.shareReport(report);
        if (result?.ok) setNotice(`PDF 已保存：${result.path}`);
        else if (result?.canceled) setNotice("");
        else throw new Error(result?.error || "导出失败");
      } else {
        const printWindow = window.open("", "_blank", "width=860,height=980");
        if (!printWindow) throw new Error("浏览器拦截了打印窗口，请允许弹窗后重试。");
        printWindow.document.write(renderShareHtml(report));
        printWindow.document.close();
        printWindow.focus();
        printWindow.print();
        setNotice("已打开打印窗口：选择「另存为 PDF」即可保存文件。");
      }
    } catch (err) {
      onError?.(err.message);
    } finally {
      setBusy(false);
    }
  };
  const highlighted = (text) => {
    const parts = String(text).split(REDACT_MARK);
    return parts.map((part, index) => (
      <span key={index}>
        {part}
        {index < parts.length - 1 && <mark className="share-mark">［已脱敏］</mark>}
      </span>
    ));
  };
  return <div className="acceptance share-wizard" role="dialog" aria-label="脱敏分享">
    <header className="share-head">
      <div>
        <h2><Share2 size={17} /> 脱敏分享{patientName ? ` · ${patientName}` : ""}</h2>
        <p>先抹掉身份，再分享。三步：选内容 → 看预览 → 导出文件。</p>
      </div>
      <button className="icon-button" aria-label="关闭" onClick={onClose}><X size={17} /></button>
    </header>
    {step === 1 && <div className="share-step">
      <h3>这份分享要包含哪些内容？</h3>
      <div className="share-sections">
        {SHARE_SECTIONS.map(([key, label]) => (
          <label key={key}>
            <input type="checkbox" checked={sections.has(key)} onChange={() => toggleSection(key)} />
            {label}
          </label>
        ))}
      </div>
      <p className="share-hint">无论怎么选，姓名、电话、病历号都不会出现；出生年只会以年龄段呈现。自由文本里的证件号、手机号、住院号会自动打码。</p>
      <div className="toolbar-actions">
        <button className="secondary" onClick={onClose}>取消</button>
        <button onClick={runPreview} disabled={busy || !sections.size}>
          {busy ? <Loader2 className="spin" size={14} /> : <FileText size={14} />} 生成脱敏预览
        </button>
      </div>
    </div>}
    {step === 2 && preview && <div className="share-step">
      <h3>预览：这就是会发出去的全部内容</h3>
      {preview.findings.length > 0 ? <p className="share-findings" role="status">
        已自动抹掉：{preview.findings.map((finding) => `${FINDING_LABELS.find(([key]) => key === finding.category)?.[1] || finding.category} ${finding.count} 处`).join("、")}（预览中标黄部分）。
      </p> : <p className="share-findings" role="status">这次内容里没有扫到需要打码的号码，身份字段也已移除。</p>}
      <div className="share-preview">
        {buildShareSections(preview.record).filter((section) => section.rows.length).map((section) => (
          <section key={section.heading}>
            <h4>{section.heading}</h4>
            <ul>
              {section.rows.map(([label, value], index) => (
                <li key={index}><span>{label}</span><strong>{highlighted(value)}</strong></li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="share-hint">机器只负责常见格式，昵称、住址这类间接信息请顺眼一扫。看过了再导出，发出去的就是这份内容。</p>
      {notice && <p className="form-notice" role="status">{notice}</p>}
      <div className="toolbar-actions">
        <button className="secondary" onClick={() => { setStep(1); setNotice(""); }}>上一步</button>
        <button className="secondary" onClick={downloadJson} disabled={busy}><Download size={14} /> 保存 JSON</button>
        <button onClick={exportPdf} disabled={busy}>
          {busy ? <Loader2 className="spin" size={14} /> : <FileText size={14} />}
          {window.omwDesktop?.shareReport ? " 导出 PDF" : " 打印 / 另存 PDF"}
        </button>
      </div>
    </div>}
  </div>;
}
