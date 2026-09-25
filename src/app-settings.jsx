import { ChatConnectionSettings } from "./chat-followups";
import { useEffect, useRef, useState } from "react";
import { api, medicalEnabled } from "./agent-runtime";
import { WorkspaceExtensionsPanel } from "./workspace-extensions";

export function AppSettingsView({ config, onModel, onDoctor, onProjects }) {
  const [section, setSection] = useState(() => new URLSearchParams(window.location.search).get("settingsTab") === "followup" ? "followup" : "general");
  const [projects, setProjects] = useState([]), [selected, setSelected] = useState("");
  const [workspace, setWorkspace] = useState(null), [error, setError] = useState(""), [loading, setLoading] = useState(false), [reload, setReload] = useState(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    if (section !== "connections") return;
    let alive = true;
    setLoading(true); setError("");
    api("/api/workspaces").then(value => { if (alive) setProjects(value.workspaces.filter(w => !w.archived && w.kind !== "session")); }).catch(e => { if (alive) setError(e.message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [section, reload]);
  useEffect(() => {
    let alive = true;
    setWorkspace(null);
    if (!selected) return;
    setError("");
    api(`/api/workspaces/${selected}`).then(value => { if (alive) setWorkspace(value); }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [selected, reload]);
  async function refresh(id) {
    const value = await api(`/api/workspaces/${id}`);
    if (selectedRef.current === id) setWorkspace(value);
  }
  return <section className="app-settings-page" aria-label="应用设置">
    <header className="directory-heading"><div><h1>设置</h1><p>管理模型、工具能力与连接。</p></div></header>
    <div className="app-settings-layout">
      <nav aria-label="设置分类">
        <button aria-pressed={section === "general"} onClick={() => setSection("general")}>模型与运行</button>
        {medicalEnabled(config) && <button aria-pressed={section === "followup"} onClick={() => setSection("followup")}>随访连接</button>}
        <button aria-pressed={section === "connections"} onClick={() => setSection("connections")}>工具与连接</button>
      </nav>
      <div className="app-settings-content">
        {section === "general" ? <section><h2>模型与运行</h2><p>{config?.modelConfigured ? `当前模型：${config.provider} · ${config.model}` : "尚未配置模型"}</p><div className="toolbar-actions"><button onClick={onModel}>配置模型</button>{medicalEnabled(config) && <button onClick={onDoctor}>医生档案与记忆</button>}</div></section> : section === "followup" ? <ChatConnectionSettings /> : <section>
          <h2>工具与连接</h2><p>浏览器、隔离终端、插件与 MCP 在这里配置。访问范围和授权按项目保存。</p>
          {error && <div role="alert"><p>{error}</p><button onClick={() => setReload(v => v + 1)}>重新加载设置</button></div>}
          {loading && <p role="status">正在读取项目…</p>}
          <label className="settings-project-picker">配置所属项目<select aria-label="配置所属项目" value={selected} onChange={e => setSelected(e.target.value)}><option value="">请选择项目</option>{projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
          {!loading && !error && !projects.length && <p>先连接项目，为工具确定可访问的资料范围。<button onClick={onProjects}>连接项目</button></p>}
          {selected && !workspace && !error && <p role="status">正在读取项目配置…</p>}
          {workspace && <><p className="muted">当前项目：{workspace.title}</p><WorkspaceExtensionsPanel key={workspace.id} workspace={workspace} refresh={refresh} disabled={workspace.runs?.some(r => r.status === "running")} focus="configuration" /></>}
        </section>}
      </div>
    </div>
  </section>;
}
