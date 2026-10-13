// Minimal, sandbox-safe bridge: the renderer is a plain web page served by the
// local runtime; native actions use narrow, fixed IPC endpoints.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("omwDesktop", {
  permissionStatus: () => ipcRenderer.invoke('omw:permission-status'),
  openPermissionSettings: kind => ipcRenderer.invoke('omw:permission-settings',kind),
  showInstalledApp: () => ipcRenderer.invoke('omw:show-installed-app'),
  chooseDirectory: () => ipcRenderer.invoke("omw:choose-directory"),
  openDataDirectory: () => ipcRenderer.invoke("omw:open-data-directory"),
  editModelConfig: () => ipcRenderer.invoke("omw:edit-model-config"),
  loginItemAtLogin: () => ipcRenderer.invoke("omw:login-item"),
  setLoginItemAtLogin: (open) => ipcRenderer.invoke("omw:set-login-item", open),
  relaunchApp: () => ipcRenderer.invoke("omw:relaunch"),
  showNotification: (options) => ipcRenderer.invoke("omw:show-notification", options),
  onOpenView: (handler) => { ipcRenderer.on("omw:open-view", (_event, view) => handler(view)); },
});
