import { BackupPanel } from "./backup-panel";
// Shared channel layout styles stay in the fixed static entry: plugin panels
// load in async chunks and must not be the first provider of base layout.
import "./doctor-notifications.css";
import "./message-channels.css";
import { useEffect, useRef, useState } from "react";
import { api, bootstrap, medicalEnabled } from "./agent-runtime";
import { dueNotifyEnabled, setDueNotifyEnabled } from "./due-notify";
import { SlotItem, findSettingsPanel, usePluginActive, usePluginConnected, useActiveSlot, useSlot } from "./plugin-slots";
import { WorkspaceExtensionsPanel } from "./workspace-extensions";
import { ExtensionCenter, takeSettingsTab } from "./extension-center";
import { KnowledgeTranscriptionSettings } from "./knowledge-transcription-settings";
import { PrivacySettings } from "./privacy-settings";
import "./settings-clarity.css";

const CHANNEL_SECTIONS = [["channels", "私聊助手"]];
const PERSONAL_SECTIONS = [
  ["skills", "技能"],
  ["care-packs", "专病管理包"],
  ["workbench", "自动化规则"],
  ["learning", "学习与记忆"],
];
// Legacy tabs whose owning panel loads asynchronously. A deep link must
// resolve to its own tab before the panel arrives; the rendering fallback in
// AppSettingsView keeps a disabled plugin from leaving a blank page.
const LEGACY_TAB_GROUPS = {
  "knowledge-bot": "channels",
  notifications: "channels",
  followup: "channels",
  workbench: "personal",
  learning: "personal",
  "care-packs": "personal",
};
const SECTION_ORDER = {
  channels: 10,
  "knowledge-bot": 20,
  notifications: 30,
  followup: 40,
  workbench: 50,
  learning: 60,
};

// Merge fixed and plugin-provided tabs in their original order. Plugin panels
// carry an explicit order; the static fixed tabs use the same scale so an
// async panel never jumps ahead of a fixed one.
export function mergeChannelSections(legacyPanels = []) {
  const merged = CHANNEL_SECTIONS.map(([id, label], index) => ({
    id,
    label,
    order: SECTION_ORDER[id] ?? (index + 1) * 10,
  }));
  for (const panel of legacyPanels) {
    const group = LEGACY_TAB_GROUPS[panel.legacyTab];
    if (group && group !== "channels") continue;
    if (merged.some((item) => item.id === panel.legacyTab)) continue;
    merged.push({
      id: panel.legacyTab,
      label: panel.label,
      order: Number.isFinite(panel.order)
        ? panel.order
        : (SECTION_ORDER[panel.legacyTab] ?? 100),
    });
  }
  return merged
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map((item) => [item.id, item.label]);
}

function settingsGroup(section, legacyPanels = []) {
  if (section === "transcription") return "connections";
  if (section === "plugins") return "plugins";
  if (LEGACY_TAB_GROUPS[section]) return LEGACY_TAB_GROUPS[section];
  if (legacyPanels.some((panel) => panel.legacyTab === section)) return "channels";
  if (CHANNEL_SECTIONS.some(([id]) => id === section)) return "channels";
  if (PERSONAL_SECTIONS.some(([id]) => id === section)) return "personal";
  return section;
}

const SETTINGS_GROUPS = [
  "general",
  "privacy",
  "desktop",
  "connections",
  "channels",
  "personal",
  "backup",
  "plugins",
];

// Resolve a settingsTab from the URL (or a deferred request) against the
// currently registered panels. Plugin UI loads asynchronously, so a deep link
// such as settingsTab=followup may arrive before its panel; keeping the raw
// request in state lets the same computation succeed on the next render.
export function resolveSettingsSection(
  requested,
  legacyPanels = [],
  { medical = true, desktop = false } = {},
) {
  const normalized = requested === "personal" ? "skills" : requested;
  const group = settingsGroup(normalized, legacyPanels);
  if (["channels", "personal"].includes(group) && !medical) return "general";
  if (normalized === "desktop" && !desktop) return "general";
  // Before the lazy panel registers, keep the raw request in state and show the
  // general group; the next render re-resolves once legacyTab exists.
  if (LEGACY_TAB_GROUPS[normalized] && !legacyPanels.some((panel) => panel.legacyTab === normalized)) return "general";
  return SETTINGS_GROUPS.includes(group) ? normalized : "general";
}

function SettingsSubnav({ label, items, section, onSelect }) {
  return <nav className="settings-subnav" aria-label={label}>
    {items.map(([id, title]) => <button key={id} type="button" className="settings-subnav-item" aria-pressed={section === id} onClick={() => onSelect(id)}>{title}</button>)}
  </nav>;
}

// Electron wraps IPC rejections as "Error invoking remote method '…': Error: …".
const ipcMessage = (error) => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");

// Native controls stay unavailable in the developer browser preview.
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
  return <section className="desktop-preferences" aria-label="桌面应用">
    <h2>桌面应用</h2>
    <p className="settings-lead">关闭或隐藏窗口后，后台任务与提醒继续运行；退出应用会停止任务。</p>

    {note && <p className="settings-desktop-note" role="status">{note}</p>}
    <div className="toolbar-actions">
      {desktop.loginItemAtLogin && <label className="settings-login-item"><input type="checkbox" checked={autoLogin === true} disabled={autoLogin === null} onChange={toggleAutoLogin} />登录时自动启动</label>}
      {desktop.showNotification && <label className="settings-login-item"><input type="checkbox" checked={dueNotify} onChange={toggleDueNotify} />到期事项系统提醒</label>}
    </div>
    <details><summary>应用维护</summary>
    <div className="toolbar-actions">
      {desktop.openDataDirectory && <button className="secondary" onClick={() => desktop.openDataDirectory().catch(error => setNote(`打开失败：${ipcMessage(error)}`))}>打开数据目录</button>}
      {desktop.openConfigDirectory && <button className="secondary" onClick={() => desktop.openConfigDirectory().catch(error => setNote(`打开失败：${ipcMessage(error)}`))}>打开配置目录</button>}
      {desktop.relaunchApp && <button className="secondary" onClick={() => desktop.relaunchApp().catch(error => setNote(`重启失败：${ipcMessage(error)}`))}>重启应用</button>}
    </div>
    </details>
  </section>;
}

const PLUGIN_STATUS = { ready: "已启用", disabled: "已停用", unavailable: "不可用" };
const PLUGIN_API = "/api/plugins";

// Panels that also live in a settings tab are linked, not repeated: the
// plugin list stays a scannable on/off overview.
const PANEL_LOCATION = {
  channels: "消息渠道",
  "knowledge-bot": "消息渠道",
  notifications: "消息渠道",
  followup: "消息渠道",
  workbench: "技能与规则",
  learning: "技能与规则",
  "care-packs": "技能与规则",
};

function PluginSettings({ onPluginsChanged, onOpenSection }) {
  const [plugins, setPlugins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const busyRef = useRef(false);
  const panels = useSlot("settings.panels");
  useEffect(() => {
    let alive = true;
    api("/api/plugins")
      .then(value => { if (alive) setPlugins(value.plugins || []); })
      .catch(value => { if (alive) setError(value.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);
  async function toggle(plugin) {
    // The controlled checkbox only changes after the PUT response; this guard
    // also prevents a same-tick double click before React disables the input.
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(plugin.id);
    setError("");
    try {
      await api(`${PLUGIN_API}/${encodeURIComponent(plugin.id)}`, "PUT", { enabled: !plugin.enabled });
      // Refresh the shared bootstrap snapshot so every slot updates immediately;
      // the server persists the new state, so no restart is needed.
      const next = await bootstrap(true);
      onPluginsChanged?.(next.plugins || []);
      const list = await api("/api/plugins");
      setPlugins(list.plugins || []);
    } catch (value) {
      setError(value.message);
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }
  const enabledCount = plugins.filter(plugin => plugin.enabled).length;
  return <section aria-label="插件" className="settings-plugins">
    <h2>插件</h2>
    <p className="settings-lead">插件为工作台增加可选的患者页、对话卡片和设置面板。停用后数据保留，可以随时重新启用。</p>
    {!loading && plugins.length > 0 && <p className="om-meta settings-plugin-count">共 {plugins.length} 个 · 已启用 {enabledCount} 个</p>}
    {error && <p role="alert" className="error-text">{error}</p>}
    {loading && <p role="status">正在读取插件…</p>}
    {!loading && !plugins.length && <p className="muted">还没有安装插件。</p>}
    {!loading && plugins.length > 0 && <ul className="plugin-settings-list">
      {plugins.map(plugin => {
        const ownPanels = panels.filter(item => item.pluginId === plugin.id);
        const inlinePanels = ownPanels.filter(item => !item.legacyTab);
        const linkedPanels = ownPanels.filter(item => item.legacyTab);
        const dormant = plugin.status === "ready" && plugin.enabled && plugin.active === false;
        const tone = plugin.status === "unavailable" ? "is-danger" : dormant ? "is-caution" : plugin.status === "ready" && plugin.enabled ? "is-ok" : "";
        return <li key={plugin.id} className={`plugin-settings-item${plugin.enabled ? "" : " is-off"}`}>
          <div className="plugin-settings-summary">
            <div>
              <div className="plugin-settings-title"><b>{plugin.title}</b><span className={`om-chip ${tone}`}>{dormant ? "已启用 · 待连接渠道" : PLUGIN_STATUS[plugin.status] || plugin.status}</span></div>
              <small>{plugin.id} · v{plugin.version}</small>
              {plugin.reason && <p className="muted">不可用原因：{plugin.reason}</p>}
              {plugin.status === "ready" && linkedPanels.length > 0 && <div className="plugin-settings-links">{linkedPanels.map(item => <button key={`${item.pluginId}:${item.id}`} type="button" className="om-link" onClick={() => onOpenSection?.(item.legacyTab)}>设置「{item.label}」<span className="om-meta">· 位于{PANEL_LOCATION[item.legacyTab] || "设置"}</span></button>)}</div>}
            </div>
            <label className="settings-login-item">
              <input
                type="checkbox"
                aria-label={`启用 ${plugin.title}`}
                checked={Boolean(plugin.enabled)}
                disabled={Boolean(busy) || plugin.status === "unavailable"}
                onChange={() => toggle(plugin)}
              />
              启用
            </label>
          </div>
          {plugin.status === "ready" && inlinePanels.length > 0 && <div className="plugin-settings-panel">
            {inlinePanels.map(item => <SlotItem key={`${item.pluginId}:${item.id}`} contribution={item} plugin={plugin} />)}
          </div>}
        </li>;
      })}
    </ul>}
  </section>;
}

export function AppSettingsView({ config, onModel, onDoctor, onProjects, onAsk, demoPreferenceBusy, onDemoEntryHiddenChange, onPluginsChanged }) {
  useEffect(() => { if (new URLSearchParams(window.location.search).get('doctor') === '1') onDoctor(); }, []);
  const pluginPanels = useActiveSlot("settings.panels");
  const followupActive = usePluginActive("followup");
  const messaging = usePluginConnected("followup");
  const legacyPanels = pluginPanels.filter((panel) => panel.legacyTab);
  const param = new URLSearchParams(window.location.search).get("settingsTab");
  const [requestedSection, updateSection] = useState(
    () => takeSettingsTab() || param || "general",
  );
  const requested = resolveSettingsSection(requestedSection, legacyPanels, {
    medical: medicalEnabled(config),
    desktop: Boolean(window.omwDesktop),
  });
  const requestedPanel = findSettingsPanel(pluginPanels, requested);
  // While a plugin panel is still loading, or when the plugin is disabled,
  // show the group's first tab instead of a blank content area.
  const section = !requestedPanel && LEGACY_TAB_GROUPS[requested]
    ? (LEGACY_TAB_GROUPS[requested] === "personal" ? "skills" : "channels")
    : requested;
  const group = settingsGroup(section, legacyPanels);
  const legacyPanel = findSettingsPanel(pluginPanels, section);
  const channelSections = mergeChannelSections(legacyPanels);
  const personalSections = PERSONAL_SECTIONS.filter(([id]) => id === "skills" || legacyPanels.some((panel) => panel.legacyTab === id));
  function setSection(next) {
    updateSection(next);
    const url = new URL(window.location.href);
    url.searchParams.set("settingsTab", next);
    window.history.replaceState(window.history.state, "", url);
  }
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
    <header className="om-page-head settings-head"><div><h1>设置</h1><span className="om-page-meta">模型、消息渠道、技能规则与数据备份</span></div></header>
    <div className="app-settings-layout">
      <nav aria-label="设置分类" className="settings-nav">
        <button type="button" className="settings-nav-item" aria-pressed={group === "general"} onClick={() => setSection("general")}><span>模型与运行</span>{!config?.modelConfigured && <span className="om-chip is-caution">未配置</span>}</button>
        <button type="button" className="settings-nav-item" aria-pressed={group === "privacy"} onClick={() => setSection("privacy")}><span>隐私保护</span></button>
        {medicalEnabled(config) && <button type="button" className="settings-nav-item" aria-pressed={group === "channels"} onClick={() => setSection("channels")}><span>消息渠道</span></button>}
        {medicalEnabled(config) && <button type="button" className="settings-nav-item" aria-pressed={group === "personal"} onClick={() => setSection("skills")}><span>技能与规则</span></button>}
        <button type="button" className="settings-nav-item" aria-pressed={group === "backup"} onClick={() => setSection("backup")}><span>备份与恢复</span></button>
        <button type="button" className="settings-nav-item" aria-pressed={group === "connections"} onClick={() => setSection("connections")}><span>工具与服务</span></button>
        <button type="button" className="settings-nav-item" aria-pressed={group === "plugins"} onClick={() => setSection("plugins")}><span>插件</span></button>
        {window.omwDesktop && <button type="button" className="settings-nav-item" aria-pressed={group === "desktop"} onClick={() => setSection("desktop")}><span>桌面应用</span></button>}
      </nav>
      <div className="app-settings-content">
        {section === "backup" && <BackupPanel />}
        {section === "privacy" && <section className="settings-general" aria-label="隐私保护">
          <h2>隐私保护</h2>
          <p className="settings-lead">病历先在本机或脱敏服务去掉姓名、电话、证件号等身份信息，再交给模型。</p>
          <div className="om-card settings-privacy-card"><PrivacySettings /></div>
        </section>}
        {group === "plugins" && <PluginSettings onPluginsChanged={onPluginsChanged} onOpenSection={setSection} />}
        {group === "channels" && <>
          <SettingsSubnav label="消息渠道用途" items={channelSections} section={section === "plugins" ? "followup" : section} onSelect={setSection} />
          {!followupActive && <p className="settings-channel-hint"><span className="om-chip is-caution">随访未启用</span><span>随访插件已停用，可在「插件」中重新启用</span></p>}
          {followupActive && !messaging && legacyPanel?.legacyTab === "followup" && <p className="settings-channel-hint"><span className="om-chip is-info">患者消息未连接</span><span>随访计划和到期提醒可直接使用；连接微信或企业微信后才能给患者发消息、发问卷</span></p>}
          {legacyPanel ? <SlotItem key={`${legacyPanel.pluginId}:${legacyPanel.id}`} contribution={legacyPanel} /> : null}
        </>}
        {group === "personal" && <>
          <SettingsSubnav label="技能与规则分类" items={personalSections} section={section} onSelect={setSection} />
          {legacyPanel ? <SlotItem key={`${legacyPanel.pluginId}:${legacyPanel.id}`} contribution={legacyPanel} onDoctor={onDoctor} onAsk={onAsk} /> : <ExtensionCenter key={section} view="skills" onAsk={onAsk} />}
        </>}
        {window.omwDesktop && section === "desktop" && <DesktopAppPanel desktop={window.omwDesktop} />}
        {section === "general" && <section className="settings-general" aria-label="模型与运行">
          <h2>模型与运行</h2>
          <p className="settings-lead">AI 问答、病历整理和资料分析使用这里选择的模型；浏览档案与本地计算不需要模型。</p>
          <div className="om-card settings-status-card">
            <div className="settings-status-main">
              <span className={`om-chip ${config?.modelConfigured ? "is-ok" : "is-caution"}`}>{config?.modelConfigured ? "已配置" : "未配置"}</span>
              <p><b>{config?.modelConfigured ? `当前模型：${config.provider} · ${config.model}` : "尚未配置模型"}</b>{!config?.modelConfigured && <span className="om-meta">配置后即可在任务中使用 AI。</span>}</p>
            </div>
            <button type="button" className={config?.modelConfigured ? "secondary" : "primary"} onClick={onModel}>{config?.modelConfigured ? "更换模型" : "选择模型"}</button>
          </div>
        </section>}
        {section === "general" && medicalEnabled(config) && <section className="settings-general" aria-label="工作台显示">
          <h2>工作台显示</h2>
          <div className="om-card settings-toggle-card">
            <label className="settings-toggle"><input type="checkbox" checked={!config.demoEntryHidden} disabled={demoPreferenceBusy} onChange={event => onDemoEntryHiddenChange(!event.target.checked)} /><span><b>显示示例体验入口</b><small>在侧栏和首页显示示例入口。隐藏入口会保留已有示例资料。</small></span></label>
          </div>
        </section>}
        {group === "connections" && medicalEnabled(config) && <SettingsSubnav label="工具与服务分类" items={[["connections","项目工具"],["transcription","音视频转写"]]} section={section} onSelect={setSection}/>}
        {section === "transcription" && medicalEnabled(config) && <KnowledgeTranscriptionSettings/>}
        {section === "connections" && <section className="settings-connections">
          <h2>工具与服务</h2><p className="settings-lead">选择项目可使用的工具与服务。访问范围和授权按项目保存。</p>
          {error && <div role="alert" className="settings-error"><p>{error}</p><button type="button" className="secondary" onClick={() => setReload(v => v + 1)}>重新加载设置</button></div>}
          {loading && <p role="status" className="om-meta">正在读取项目…</p>}
          <label className="settings-project-picker">配置所属项目<select aria-label="配置所属项目" value={selected} onChange={e => setSelected(e.target.value)}><option value="">请选择项目</option>{projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
          {!loading && !error && !projects.length && <div className="om-card settings-empty-card"><p className="om-empty">还没有项目。先连接项目，为工具确定可访问的资料范围。</p><button type="button" className="secondary" onClick={onProjects}>连接项目</button></div>}
          {selected && !workspace && !error && <p role="status" className="om-meta">正在读取项目配置…</p>}
          {workspace && <><p className="muted">当前项目：{workspace.title}</p><WorkspaceExtensionsPanel key={workspace.id} workspace={workspace} refresh={refresh} disabled={workspace.runs?.some(r => r.status === "running")} focus="configuration" /></>}
        </section>}
      </div>
    </div>
  </section>;
}
