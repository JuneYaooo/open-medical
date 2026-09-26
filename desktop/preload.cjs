// Minimal, sandbox-safe bridge: the renderer is a plain web page served by the
// local runtime; native actions use narrow, fixed IPC endpoints.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("omwDesktop", {
  permissionStatus: () => ipcRenderer.invoke('omw:permission-status'),
  openPermissionSettings: kind => ipcRenderer.invoke('omw:permission-settings',kind),
  showInstalledApp: () => ipcRenderer.invoke('omw:show-installed-app'),
  chooseDirectory: () => ipcRenderer.invoke("omw:choose-directory"),
});
