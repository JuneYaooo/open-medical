// Generic cross-page intents for plugin-owned views. Fixed-shell components do
// not import plugin files: they only publish a namespaced intent that the
// plugin consumes when its legacy view mounts.
const KEY_PREFIX = "omw-plugin-intent:";

export function requestPluginIntent(pluginId, name, payload = null) {
  try {
    sessionStorage.setItem(
      `${KEY_PREFIX}${pluginId}:${name}`,
      JSON.stringify(payload),
    );
  } catch {
    /* storage unavailable */
  }
}

export function takePluginIntent(pluginId, name) {
  const key = `${KEY_PREFIX}${pluginId}:${name}`;
  try {
    const raw = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Publishes the intents an agenda item of action.type "view" needs, so the
// agenda page and the home "today" list open the same target.
export function publishAgendaViewIntent(item, requestSettingsTab) {
  const action = item?.action || {};
  if (action.view === "care" && action.tab)
    requestPluginIntent("followup", "care-tab", { tab: action.tab, patientId: item.patientId, patientName: item.patientName });
  if (action.view === "research" && action.trialId)
    requestPluginIntent("trials", "open-trial", { trialId: action.trialId });
  if (action.view === "settings" && action.settingsTab === "knowledge-bot" && action.chatId)
    requestPluginIntent("feishu-knowledge-bot", "open-chat", { chatId: action.chatId });
  if (action.view === "settings" && action.settingsTab) requestSettingsTab?.(action.settingsTab);
  return action.view;
}

// Kept in the fixed shell because the home checklist probes /api/care/settings
// before any plugin view mounts. It returns data only; all rendering stays in
// the followup plugin.
export function careSetupProgress(settings) {
  const c = settings?.channels || {};
  const configured = (id) =>
    Boolean(c.list?.find((item) => item.id === id)?.configured);
  const done = {
    corp: Boolean(c.corp?.corpId),
    kf: configured("wecom-kf"),
    app: Boolean(
      c.notifier?.configured && settings?.alerts?.notifyUserIds?.length,
    ),
    contact: Boolean(c.corp?.hasContactSecret),
  };
  return {
    done,
    count: Object.values(done).filter(Boolean).length,
    total: 4,
    essential: done.corp && done.kf && done.app,
  };
}
