import { useEffect, useState } from "react";
import { BookOpen, FileText, Loader2, MessageSquare, MessageSquareText } from "lucide-react";
import { api } from "./agent-runtime";
import { SlotItem, useActiveSlot } from "./plugin-slots";
import "./tools-clarity.css";
import "./research-hub.css";

// 研究页：诊所医生用自己的患者做探索性研究的入口。先看本机数据够不够，
// 再用一句话提问交给助手（cohort_query / cohort_compare 在本机确定性计算），
// 文献、试验、统计和写作按阶段排在下面。结果都是待复核草稿。

const EXAMPLES = [
  "比较用和不用二甲双胍的 2 型糖尿病患者最近一次 HbA1c 有没有差别",
  "我的高血压患者里，血压控制不达标的人有哪些共同特点",
  "2 型糖尿病患者中，HbA1c ≥ 8% 和 < 8% 的人合并糖尿病肾病的比例有没有差别",
];

// Titles that research entry points give their tasks, so the page can list
// recent research work without a separate tag.
const RESEARCH_TITLES = ["研究 · ", "科研统计 · ", "文献研究 · ", "文献收集 · ", "临床试验 · ", "个案报告写作", "准备循证检索"];
export const isResearchTask = (task) => !task.patientId && RESEARCH_TITLES.some((prefix) => String(task.title || "").startsWith(prefix));

const WRITING = [
  { flowId: "case-report", icon: FileText, name: "个案报告写作", desc: "选一位患者或上传病例材料，按 CARE 框架生成个案报告草稿。" },
  { flowId: "evidence", icon: BookOpen, name: "准备循证检索", desc: "从临床问题整理 PICO、检索式和证据核查步骤。" },
];

function DataOverview({ summary, error, onPick, disabled }) {
  if (error) return <p className="om-meta">暂时读取不到本机患者库概况：{error}</p>;
  if (!summary) return <p className="om-meta" role="status">正在读取本机患者库概况…</p>;
  if (!summary.patients) return <p className="om-meta">本机还没有患者档案（不含已归档）。可以先在「患者」中建档或导入，也可以先从文献找方向。</p>;
  const c = summary.coverage || {};
  const share = (n) => `${Math.round(((n || 0) / summary.patients) * 100)}%`;
  const facts = [
    ["患者", `${summary.patients} 位`],
    ["有诊断", share(c.diagnoses?.patients)],
    ["有用药", share(c.medications?.patients)],
    ["有检验", share(c.labs?.patients)],
    ["有就诊记录", share(c.visits?.patients)],
  ];
  const chips = (label, list, ask) => list?.length > 0 && <div className="research-hub-chips" role="group" aria-label={label}>
    <span>{label}</span>
    {list.map((item) => <button type="button" key={item.name} disabled={disabled} title="填入研究问题，可再修改" onClick={() => onPick(ask(item))}>
      {item.name}<small>{item.patients} 人</small>
    </button>)}
  </div>;
  return <div className="research-hub-data" aria-label="本机数据概况">
    <dl>{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {chips("常见诊断", summary.topDiagnoses, (item) => `我的「${item.name}」患者：年龄、性别分布，常用药和常查检验分别是什么，最近一次检验结果大致怎样？`)}
    {chips("常查检验", summary.topLabs, (item) => `有「${item.name}」记录的患者，最近一次结果在不同诊断人群之间有没有差别？`)}
    <p className="om-source">只统计未归档患者；这里只有计数，姓名和逐人数据不会交给模型。</p>
  </div>;
}

export function ResearchHub({ config, sessions = [], onOpenTask, onNavigate, onStartTemplate, onModelSettings }) {
  const modelReady = Boolean(config?.modelConfigured);
  const [summary, setSummary] = useState(null);
  const [summaryError, setSummaryError] = useState("");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const researchTools = useActiveSlot("tools.directory").filter((tool) => tool.meta?.category === "科研");
  useEffect(() => {
    let alive = true;
    api("/api/research-overview")
      .then((value) => alive && setSummary(value))
      .catch((err) => alive && setSummaryError(err.message));
    return () => { alive = false; };
  }, []);

  const start = async (text) => {
    const value = text.trim();
    if (!value || busy) return;
    if (!modelReady) {
      setQuestion(value);
      setError("需先连接模型：把问题翻译成分组条件需要模型，统计本身在本机计算。问题已保留。");
      return;
    }
    setBusy(true); setError("");
    try {
      const task = await api("/api/sessions", "POST", { title: `研究 · ${value.slice(0, 40)}` });
      await onOpenTask(task.id, { submit: true, draft: value });
    } catch (err) {
      setQuestion(value);
      setError(err.message);
    } finally { setBusy(false); }
  };
  const recent = sessions.filter(isResearchTask).slice(0, 6);

  return <main id="main" className="work-directory tools-directory research-hub" aria-label="研究">
    <header className="directory-heading">
      <div>
        <h1>研究</h1>
        <p>用本诊所的档案做探索性研究：先看数据够不够，再提问、圈人群、比较，最后写成文字。结果都是待复核的草稿。</p>
      </div>
    </header>

    <section className="research-hub-start" aria-label="从我的患者出发">
      <h2><MessageSquareText size={17} aria-hidden="true" />从我的患者出发</h2>
      <DataOverview summary={summary} error={summaryError} disabled={busy} onPick={(text) => { setQuestion(text); setError(""); }} />
      <form onSubmit={(event) => { event.preventDefault(); start(question); }}>
        <textarea rows={3} aria-label="研究问题" value={question} disabled={busy}
          placeholder="用一句话说人群、比较的组和关心的指标，例如：比较用和不用二甲双胍的 2 型糖尿病患者最近一次 HbA1c"
          onChange={(event) => setQuestion(event.target.value)} />
        <div className="research-hub-actions">
          <button className="primary" type="submit" disabled={busy || !question.trim()}>
            {busy && <Loader2 className="spin" size={14} aria-hidden="true" />}交给助手分析
          </button>
          {!modelReady && <span className="om-meta">未连接模型。<button type="button" className="text-button" onClick={onModelSettings}>去连接模型</button></span>}
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
      </form>
      <div className="research-hub-examples" role="group" aria-label="示例问题">
        <span>示例 · 点击直接开始</span>
        {EXAMPLES.map((text) => <button type="button" key={text} disabled={busy} onClick={() => start(text)}>{text}</button>)}
      </div>
      <p className="om-source">助手会先确认人群、分组、结局和时间范围，再从本机档案建队列并计算；缺资料的患者单独列出，不当作阴性。会写明各组人数、检验方法、p 值和 95% 置信区间，并提示混杂与多重比较。</p>
    </section>

    <section className="tool-group" aria-label="文献、试验与统计">
      <h2>文献、试验与统计<small>找方向、管试验、自带数据分析</small></h2>
      {researchTools.length
        ? <div className="directory-tools">{researchTools.map((tool) => <SlotItem key={`${tool.pluginId}:${tool.id}`} contribution={tool} onNavigate={onNavigate} config={config} />)}</div>
        : <p className="om-meta">文献研究、临床试验和科研统计插件都未启用，可在 设置 → 插件 中开启。</p>}
    </section>

    <section className="tool-group" aria-label="写作">
      <h2>写作<small>从病例材料到文字草稿</small></h2>
      <div className="directory-tools">{WRITING.map(({ flowId, icon: Icon, name, desc }) => <article key={flowId}>
        <a className="tool-card-link" href="?view=home" onClick={(event) => { event.preventDefault(); onStartTemplate(flowId); }}>
          <Icon size={24} /><h2>{name}</h2><p>{desc}</p><footer><small>任务模板</small></footer>
        </a>
      </article>)}</div>
    </section>

    {recent.length > 0 && <section className="tool-group research-hub-recent" aria-label="最近的研究任务">
      <h2>最近的研究任务</h2>
      <ul>{recent.map((task) => <li key={task.id}>
        <button type="button" onClick={() => onOpenTask(task.id)}><MessageSquare size={15} aria-hidden="true" /><span>{task.title}</span>
          {task.updatedAt && <small>{new Date(task.updatedAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}</small>}</button>
      </li>)}</ul>
    </section>}
  </main>;
}
