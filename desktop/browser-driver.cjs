const { BrowserWindow, session } = require("electron");
const { randomUUID } = require("node:crypto");

// One nonpersistent Chromium partition per workspace. No renderer gets Node or IPC.
module.exports = async function browserFactory(origins) {
  const partition = session.fromPartition("agent-browser-" + randomUUID(), {
    cache: false,
  });
  const permitted = (input) => {
    try {
      const u = new URL(input);
      return (
        ["http:", "https:"].includes(u.protocol) &&
        !u.username &&
        !u.password &&
        origins.includes(u.origin)
      );
    } catch {
      return false;
    }
  };
  partition.setPermissionRequestHandler((_w, _p, callback) => callback(false));
  partition.setPermissionCheckHandler(() => false);
  partition.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !permitted(details.url) }),
  );
  partition.on("will-download", (event) => event.preventDefault());
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      session: partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      disableDialogs: true,
    },
  });
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("will-navigate", (event, url) => {
    if (!permitted(url)) event.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (!permitted(url)) event.preventDefault();
  });
  let timer;
  const bounded = async (operation) => {
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            contents.stop();
            reject(new Error("浏览器操作超时"));
          }, 20000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    navigate: async (url) => {
      if (!permitted(url)) throw new Error("未授权来源");
      await bounded(window.loadURL(url));
      return { url: contents.getURL(), title: contents.getTitle() };
    },
    snapshot: () =>
      bounded(
        contents.executeJavaScript(
          `({url:location.href,title:document.title,text:document.body.innerText.slice(0,20000),elements:[...document.querySelectorAll('a,button,input,textarea,select')].slice(0,150).map((e,index)=>({index,tag:e.tagName,text:(e.innerText||e.getAttribute('aria-label')||'').slice(0,100),id:e.id,name:e.getAttribute('name'),type:e.getAttribute('type'),href:e.getAttribute('href')}))})`,
        ),
      ),
    act: async (args) =>
      bounded(
        contents.executeJavaScript(
          `(()=>{const a=${JSON.stringify(args)};const matches=document.querySelectorAll(a.selector);if(matches.length!==1)throw new Error('选择器必须只匹配一个元素');const e=matches[0];if(a.action==='fill'){if(!['INPUT','TEXTAREA'].includes(e.tagName)||['password','file'].includes(e.type))throw new Error('不支持此输入类型');const proto=e.tagName==='INPUT'?HTMLInputElement.prototype:HTMLTextAreaElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,a.value);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}else if(a.action==='click')e.click();else throw new Error('不支持此操作');return {url:location.href};})()`,
        ),
      ),
    screenshot: async () => ({
      mimeType: "image/png",
      data: (await contents.capturePage()).toPNG().toString("base64"),
    }),
    close: async () => {
      if (!window.isDestroyed()) window.destroy();
      await partition.clearStorageData();
    },
  };
};
