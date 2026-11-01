export const TOOL_VIEWS = ["tools", "care", "followups", "research", "literature", "cases", "clinical-ref", "data-analysis", "drg"];
// Cross-patient follow-up and message lists are daily work: in medical mode
// they sit under 今日待办, not 资料与工具.
export const AGENDA_VIEWS = ["care", "followups", "schedule"];

// Only opaque record IDs belong in navigation; never put chart contents in URLs.
export const VIEW_LABELS = {
  examples: "示例体验", care: "患者消息", agenda: "今日待办", schedule: "复诊名单", settings: "设置", home: "新建任务", patients: "患者", followups: "随访", research: "临床试验",
  "data-analysis": "科研统计", projects: "项目文件", tools: "资料与工具", tasks: "任务记录",
  knowledge: "知识库", literature: "文献研究", "clinical-ref": "临床速查",
  cases: "病例库", drg: "DRG", review: "任务记录", history: "任务记录",
  workspaces: "项目工作区", workbench: "任务工作区",
};

// Plugin tabs are the only non-whitelisted patient tabs allowed in the URL:
// p:<pluginId>:<tabId>. Keep the grammar narrow so arbitrary view state cannot
// leak into navigation.
export function isPluginTab(tab) {
  return typeof tab === "string" && /^p:[a-z][a-z0-9-]{1,39}:[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(tab);
}

// A plugin can take over an existing patient tab via legacyTab without adding a
// new whitelisted name. Keep the grammar as narrow as defineUiPlugin's check.
export function isLegacyTab(tab) {
  return typeof tab === "string" && /^[a-z][a-z0-9-]*$/.test(tab);
}

export function readLocation() {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("view");
  const view = requested === "review" ? "tasks" : Object.hasOwn(VIEW_LABELS, requested) ? requested : "home";
  const tabs = view === "patients" ? ["overview", "diagnoses", "clinical", "medications", "labs", "visits", "library", "assistance", "messages", "appointments", "followups", "tracking"] : view === "workspaces" ? ["files", "review", "media", "browser", "terminal", "extensions", "history", "settings"] : view === "workbench" ? ["materials", "results", "runs", "knowledge"] : [];
  const requestedTab = params.get("tab");
  const tab = tabs.includes(requestedTab) || (view === "patients" && (isPluginTab(requestedTab) || isLegacyTab(requestedTab))) ? requestedTab : undefined;
  return {
    view,
    id: params.get(view === "patients" ? "patient" : view === "workspaces" ? "workspace" : "session") || "",
    tab,
  };
}

export function writeLocation(view, { id, tab, replace = false } = {}) {
  const url = new URL(window.location.href);
  for (const key of ["view", "patient", "workspace", "session", "tab", "case"]) url.searchParams.delete(key);
  url.searchParams.set("view", view);
  if (id) url.searchParams.set(view === "patients" ? "patient" : view === "workspaces" ? "workspace" : "session", id);
  if (tab) url.searchParams.set("tab", tab);
  // Filling the default patient tab is URL normalization, not a new visit.
  // In particular, restoring a legacy no-tab URL must retain the forward stack.
  const current = readLocation();
  const samePatientPage = view === "patients" && current.view === view &&
    (current.id || "") === (id || "") &&
    (current.tab || "overview") === (tab || "overview");
  if (url.href !== window.location.href) {
    const replaceEntry = replace || samePatientPage;
    window.history[replaceEntry ? "replaceState" : "pushState"](replaceEntry ? window.history.state : null, "", url);
  }
}
