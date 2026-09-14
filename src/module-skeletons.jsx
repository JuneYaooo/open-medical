import { ClipboardList } from "lucide-react";

// Module landing views for capabilities that roll out in later phases.
// Each keeps its own file-level component so the phase upgrade replaces
// this file's export wholesale.
const MODULES = {
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
