// Only opaque record IDs belong in navigation; never put chart contents in URLs.
export const VIEW_LABELS = {
  settings: "设置", home: "新建任务", patients: "患者", followups: "随访", research: "临床试验",
  "data-analysis": "科研统计", projects: "项目", tools: "工具", tasks: "任务",
  knowledge: "知识库", literature: "文献检索", "clinical-ref": "临床速查",
  cases: "病例库", drg: "DRG", review: "待复核", history: "任务记录",
  workspaces: "项目工作区", workbench: "任务工作区",
};

export function readLocation() {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("view");
  const view = Object.hasOwn(VIEW_LABELS, requested) ? requested : "home";
  const tabs = view === "patients" ? ["overview", "diagnoses", "clinical", "medications", "labs", "visits", "sources", "assistance", "messages", "followups", "tracking"] : view === "workspaces" ? ["files", "review", "media", "browser", "terminal", "extensions", "history", "settings"] : view === "workbench" ? ["materials", "results", "runs", "knowledge"] : [];
  return {
    view,
    id: params.get(view === "patients" ? "patient" : view === "workspaces" ? "workspace" : "session") || "",
    tab: tabs.includes(params.get("tab")) ? params.get("tab") : undefined,
  };
}

export function writeLocation(view, { id, tab, replace = false } = {}) {
  const url = new URL(window.location.href);
  for (const key of ["view", "patient", "workspace", "session", "tab"]) url.searchParams.delete(key);
  url.searchParams.set("view", view);
  if (id) url.searchParams.set(view === "patients" ? "patient" : view === "workspaces" ? "workspace" : "session", id);
  if (tab) url.searchParams.set("tab", tab);
  if (url.href !== window.location.href)
    window.history[replace ? "replaceState" : "pushState"](null, "", url);
}
