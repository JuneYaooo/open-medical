import { ChatConnectionSettings } from "./chat-followups";
import { useEffect, useRef, useState } from "react";
import { api, medicalEnabled } from "./agent-runtime";
import { dueNotifyEnabled, setDueNotifyEnabled } from "./due-notify";
import { WorkspaceExtensionsPanel } from "./workspace-extensions";
import { ExtensionCenter, takeSettingsTab } from "./extension-center";
import { PluginCenter } from "./plugin-center";
import { FeishuKnowledgeBotSettings } from "./feishu-knowledge-bot";
import { DoctorNotificationSettings } from "./doctor-notifications";

// 桌面壳(Electron)专用入口:原菜单栏里的「登录时自动启动/打开数据目录/
// 编辑模型配置/重启」迁到这里。浏览器里没有 window.omwDesktop,整个分区不渲染。
function DesktopAppPanel({ desktop }) {
  const [autoLogin, setAutoLogin] = useState(null);
  const [dueNotify, setDueNotify] = useState(() => dueNotifyEnabled());
  const [note, setNote] = useState("");
  useEffect(() => {
    desktop.loginItemAtLogin?.().then(setAutoLogin).catch(() => setAutoLogin(false));
  }, [desktop]);
  async function toggleAutoLogin(event) {
    const requested = event.target.checked;
    setAutoLogin(requested);
    try {
      setAutoLogin(await desktop.setLoginItemAtLogin(requested));
      setNote(requested ? "已开启登录时自动启动。" : "已关闭登录时自动启动。");
    } catch (error) {
      setAutoLogin(!requested);
      setNote(`设置失败：${error.message}`);
    }
  }
  function toggleDueNotify(event) {
    const on = event.target.checked;
    setDueNotifyEnabled(on);
    setDueNotify(on);
    setNote(on ? "已开启到期提醒：随访、复诊、新结果等新待办出现且窗口不在前台时，系统会通知你。" : "已关闭到期提醒，到期的事项仍会列在「今日待办」页里。");
  }
  return <section aria-label="桌面应用">
    <h2>桌面应用</h2>
    <p>启动行为与维护操作在这里管理；手动改过配置文件后，用「重启应用」生效。</p>
    {note && <p className="settings-desktop-note" role="status">{note}</p>}
    <div className="toolbar-actions">
      {desktop.loginItemAtLogin && <label className="settings-login-item"><input type="checkbox" checked={autoLogin === true} disabled={autoLogin === null} onChange={toggleAutoLogin} />登录时自动启动</label>}
      {desktop.showNotification && <label className="settings-login-item"><input type="checkbox" checked={dueNotify} onChange={toggleDueNotify} />到期事项系统提醒</label>}
      {desktop.openDataDirectory && <button onClick={() => desktop.openDataDirectory().catch(() => {})}>打开数据目录</button>}
      {desktop.editModelConfig && <button onClick={() => desktop.editModelConfig().catch(() => {})}>编辑高级配置文件（model.env）…</button>}
      {desktop.relaunchApp && <button onClick={() => desktop.relaunchApp().catch(() => {})}>重启应用</button>}
    </div>
    <p className="settings-desktop-note">日常模型切换用上面的「配置模型」；model.env 供高级参数（MCP 令牌、嵌入配置等）手动编辑。</p>
  </section>;
}

export function AppSettingsView({ config, onModel, onDoctor, onProjects, onAsk }) {
  const param = new URLSearchParams(window.location.search).get("settingsTab");
  const [section, setSection] = useState(() => takeSettingsTab() || (["followup", "plugins", "notifications", "knowledge-bot"].includes(param) ? param : "general"));
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
        {window.omwDesktop && <button aria-pressed={section === "desktop"} onClick={() => setSection("desktop")}>桌面应用</button>}
        {medicalEnabled(config) && <button aria-pressed={section === "skills"} onClick={() => setSection("skills")}>技能</button>}
        {medicalEnabled(config) && <button aria-pressed={section === "workbench"} onClick={() => setSection("workbench")}>我的工作台</button>}
        {medicalEnabled(config) && <button aria-pressed={section === "knowledge-bot"} onClick={() => setSection("knowledge-bot")}>飞书知识库机器人</button>}
        {medicalEnabled(config) && <button aria-pressed={section === "notifications"} onClick={() => setSection("notifications")}>医生提醒</button>}
        {medicalEnabled(config) && <button aria-pressed={section === "followup"} onClick={() => setSection("followup")}>随访连接</button>}
        {medicalEnabled(config) && <button aria-pressed={section === "plugins"} onClick={() => setSection("plugins")}>插件</button>}
        <button aria-pressed={section === "connections"} onClick={() => setSection("connections")}>工具与连接</button>
      </nav>
      <div className="app-settings-content">
        {section === "knowledge-bot" ? <FeishuKnowledgeBotSettings /> : section === "notifications" ? <DoctorNotificationSettings /> : window.omwDesktop && section === "desktop" ? <DesktopAppPanel desktop={window.omwDesktop} /> : section === "skills" ? <ExtensionCenter view="skills" onAsk={onAsk} /> : section === "workbench" ? <ExtensionCenter onAsk={onAsk} /> : section === "plugins" ? <PluginCenter /> : section === "general" ? <section><h2>模型与运行</h2><p>{config?.modelConfigured ? `当前模型：${config.provider} · ${config.model}` : "尚未配置模型"}</p><div className="toolbar-actions"><button onClick={onModel}>配置模型</button>{medicalEnabled(config) && <button onClick={onDoctor}>医生档案与记忆</button>}</div></section> : section === "followup" ? <ChatConnectionSettings /> : <section>
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
