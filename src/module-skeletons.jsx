import { BookOpen, CalendarClock, FileText, Activity, ClipboardList, Users } from "lucide-react";

// Module landing views for capabilities that roll out in later phases.
// Each keeps its own file-level component so the phase upgrade replaces
// this file's export wholesale.
const MODULES = {
  followups: {
    icon: CalendarClock,
    title: "随访管理",
    phase: "第三期上线",
    desc: "按病种/术式的随访计划模板，自动排程提醒，结构化随访记录与逾期追踪。",
    features: [
      "随访计划模板：术后 1 周 / 1 月 / 3 月等节点，含复查项目与注意事项",
      "患者入组后自动展开为定时任务，提醒进入统一提醒中心",
      "结构化随访记录：结果、事件、依从性、下次计划",
      "逾期随访自动进入风险提醒",
    ],
  },
  cases: {
    icon: FileText,
    title: "病例库",
    phase: "第四期上线",
    desc: "本地病例库与相似病例搜索：结构化摘要 + 全文检索，为临床决策与科研取例提供参考。",
    features: [
      "从患者档案或会话成果一键收入病例库",
      "结构化摘要：诊断、人口学、关键检验、治疗与结局",
      "相似病例搜索：结构过滤 + 文本相关性，返回匹配理由",
      "全部数据仅存本机，科研输出支持脱敏",
    ],
  },
  guidelines: {
    icon: BookOpen,
    title: "指南库",
    phase: "第二期上线",
    desc: "本地上传指南 PDF 建立全文索引，检索结果带文档与行号出处，作为临床草稿的引用依据。",
    features: [
      "PDF / Markdown 指南导入，自动抽取全文并分块索引",
      "全文检索返回原文块，带文档名与行号出处",
      "机构与年份标签管理（中华医学会、NICE、WHO 等）",
      "引用到会话：把指南条目作为材料送入工作流",
    ],
  },
  research: {
    icon: Activity,
    title: "数据分析",
    phase: "第四期上线",
    desc: "面向科研的确定性统计分析：描述统计、组间比较、回归与样本量计算，结果以待复核草稿交付。",
    features: [
      "数据集选择：会话材料或本地 CSV",
      "分析模板：描述统计 / 组间比较 / 回归 / 生存 / 样本量",
      "沙箱内计算，优先 numpy/scipy，缺失时回退内置实现",
      "输出表格与图，标注方法学假设，复核后才可确认",
    ],
  },
  drg: {
    icon: ClipboardList,
    title: "DRG 测算",
    phase: "第四期上线",
    desc: "基于 CHS-DRG 公开分组方案的本地测算器：单例分组、批量分析与权重费率配置。",
    features: [
      "主诊断 + 其他诊断 + 手术操作 → MDC → DRG 分组",
      "相对权重（RW）与预估费用，权重费率可按本院配置",
      "批量 CSV 分析：CMI、组分布、费用偏差",
      "支持导入医院自有分组器数据；结果仅供参考",
    ],
  },
};

export function ModuleView({ view, onView }) {
  const mod = MODULES[view];
  if (!mod) return null;
  const Icon = mod.icon;
  return (
    <div className="module-view">
      <section className="module-card">
        <div className="module-head">
          <span className="module-icon">
            <Icon size={22} />
          </span>
          <div>
            <h1>{mod.title}</h1>
            <p className="module-phase">{mod.phase} · 信息架构已就位</p>
          </div>
        </div>
        <p className="module-desc">{mod.desc}</p>
        <ul className="module-features">
          {mod.features.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <div className="module-actions">
          <button className="secondary" onClick={() => onView("home")}>
            返回医疗工作台
          </button>
        </div>
        <p className="module-note">
          医疗安全边界不变：所有结论性输出均为待复核草稿，本地数据不出本机，外部检索只发送检索词。
        </p>
      </section>
    </div>
  );
}

export const MODULE_VIEW_IDS = Object.keys(MODULES);
export const MODULE_ICONS = { Users };
