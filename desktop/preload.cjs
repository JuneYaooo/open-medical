// Minimal, sandbox-safe bridge: the renderer is a plain web page served by the
// local runtime; the only native capability it may request is a folder picker.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("omwDesktop", {
  chooseDirectory: () => ipcRenderer.invoke("omw:choose-directory"),
});
