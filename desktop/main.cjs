const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  shell,
  session,
  Notification,
  desktopCapturer,
  systemPreferences,
  Tray,
  ipcMain,
  nativeImage,
  clipboard,
} = require("electron");
const { join, resolve, dirname } = require("node:path");
const { homedir } = require("node:os");
const { pathToFileURL } = require("node:url");
const {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
} = require("node:fs");
const { parseEnv } = require("node:util");
const { spawn } = require("node:child_process");

const productName = "Open Medical Workbench";
app.setName(productName);
const testDirectory = process.env.MEDICAL_DESKTOP_TEST_DIR;
const smokeTest =
  process.argv.includes("--smoke-test") && Boolean(testDirectory);
// 自动化端到端模式：与 smoke 一样使用隔离数据目录与数据库，
// 但保持交互窗口不自动退出，供 Playwright 驱动跑场景。
const e2eMode =
  !smokeTest && process.argv.includes("--e2e") && Boolean(testDirectory);
// 数据目录隔离：设置 MEDICAL_DESKTOP_TEST_DIR 即生效（自动化测试用），
// --smoke-test 额外启用内建冒烟流程。
if (testDirectory) app.setPath("userData", resolve(testDirectory));
// 右键菜单：Electron 默认没有，没有它页面文字只能用 Cmd+C 复制。
app.on("web-contents-created", (_event, contents) => {
  contents.on("context-menu", (_e, params) => {
    if (smokeTest) return;
    const items = [];
    if (params.linkURL && !params.hasSelection && params.mediaType === "none")
      items.push({
        label: "复制链接",
        click: () => clipboard.writeText(params.linkURL),
      });
    if (params.isEditable) {
      if (params.hasSelection) items.push({ role: "cut", label: "剪切" });
      items.push({ role: "paste", label: "粘贴" });
      items.push({ role: "selectAll", label: "全选" });
    }
    if (params.hasSelection || params.editFlags?.canCopy)
      items.push({ role: "copy", label: "复制" });
    if (items.length)
      Menu.buildFromTemplate(items).popup({
        window: BrowserWindow.fromWebContents(contents) || undefined,
      });
  });
});
const root = resolve(__dirname, "..");
const icon = (name) => join(root, "build", "icons", name);
let runtime,
  window,
  tray,
  origin,
  quitting = false;

function openWindow() {
  window = new BrowserWindow({
    title: `${productName} · 工作台`,
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: "#191919",
    show: !smokeTest,
    icon: process.platform === "win32" ? icon("icon.ico") : undefined,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      webSecurity: true,
      preload: join(__dirname, "preload.cjs"),
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if ((target.protocol === "https:" || (target.protocol === "http:" && ["127.0.0.1","localhost","[::1]"].includes(target.hostname))) && !target.username && !target.password)
        shell.openExternal(url).catch(() => {});
    } catch {}
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.on("closed", () => {
    window = null;
  });
  return window.loadURL(origin);
}

async function verify() {
  const reportPath = join(testDirectory, "desktop-report.json");
  try {
    const bootstrap = await (await fetch(origin + "/api/bootstrap")).json();
    const request = (url, method, body) =>
      fetch(origin + url, {
        method,
        headers: {
          "content-type": "application/json",
          "x-medical-token": bootstrap.token,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const created = await (
      await request("/api/sessions", "POST", { title: "桌面包合成验收" })
    ).json();
    // 0.9.0 统一内核后 delegations 分诊路径已下线；smoke test 在未配置
    // 模型的离线环境运行，走 mode:"local" 规则路径（消息含"时间线"确定性
    // 命中 extract_clinical_timeline），验证 draft 产物收集契约。
    const response = await request(`/api/chat/${created.id}`, "POST", {
      message: "合成测试 时间线 2026-01-02 首诊 Hb 98 g/L",
    });
    const stream = await response.text();
    if (!stream.includes('"type":"message.complete"'))
      throw new Error("Packaged agent execution failed");
    const saved = await (
      await request(`/api/sessions/${created.id}`, "GET")
    ).json();
    if (
      saved.artifacts.length < 1 ||
      saved.artifacts.some((a) => a.status !== "draft")
    )
      throw new Error("Packaged agent drafts missing");
    if (bootstrap.sandbox.available) {
      const response = await request(`/api/chat/${created.id}`, "POST", {
        message: "合成沙箱验证",
        sandboxCode: "result = 2 + 3",
      });
      if (!(await response.text()).includes('"type":"message.complete"'))
        throw new Error("Packaged OS sandbox failed");
    }
    await window.loadURL(origin + "/?view=home");
    // Wait for the real renderer to finish fetching its initial state.
    const deadline = Date.now() + 15000;
    let state;
    do {
      state = await window.webContents.executeJavaScript(
        '({ready:!!document.querySelector(".hub-composer textarea[aria-label=任务内容]") && !!document.querySelector(".hub-composer button[aria-label=发送任务]"),node:typeof process,require:typeof require,title:document.title})',
      );
      if (state.ready) break;
      await new Promise((r) => setTimeout(r, 100));
    } while (Date.now() < deadline);
    if (
      !state.ready ||
      state.node !== "undefined" ||
      state.require !== "undefined"
    )
      throw new Error("Packaged renderer isolation or initial loading failed");
    writeFileSync(
      join(testDirectory, "desktop.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          passed: true,
          app: app.isPackaged,
          platform: process.platform,
          arch: process.arch,
          electron: process.versions.electron,
          node: process.versions.node,
          renderer: state,
          artifacts: saved.artifacts.length,
          sandbox: bootstrap.sandbox,
          database: existsSync(join(testDirectory, "medical.sqlite")),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    writeFileSync(
      reportPath,
      JSON.stringify({ passed: false, error: error.message }, null, 2),
    );
    process.exitCode = 1;
  }
  app.quit();
}

async function start() {
  const dataDirectory = app.getPath("userData");
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  // One-time move of settings from the pre-rename app folders, so existing
  // local installs keep their model configuration after the product rename.
  if (!smokeTest)
    for (const legacyName of ["Open Agent", "Open Medical"])
      try {
        const legacy = join(dirname(dataDirectory), legacyName);
        for (const name of ["model.env", "medical.sqlite"]) {
          const target = join(dataDirectory, name);
          if (!existsSync(target) && existsSync(join(legacy, name))) {
            copyFileSync(join(legacy, name), target);
            chmodSync(target, name.endsWith(".env") ? 0o600 : 0o640);
          }
        }
      } catch {}
  const configuration = join(dataDirectory, "model.env");
  // The desktop hosts the medical workbench runtime in-process with its own
  // database in the shared directory; the generic daemon (platform.mjs)
  // keeps its platform.sqlite beside it, untouched.
  const sharedDirectory = join(homedir(), ".open-medical-workbench");
  mkdirSync(sharedDirectory, { recursive: true, mode: 0o700 });
  const sharedDatabase =
    smokeTest || e2eMode
      ? join(dataDirectory, "medical.sqlite")
      : join(sharedDirectory, "medical.sqlite");
  const legacyDatabase = join(dataDirectory, "medical.sqlite");
  if (!existsSync(sharedDatabase) && existsSync(legacyDatabase)) {
    require("node:fs").copyFileSync(legacyDatabase, sharedDatabase);
    chmodSync(sharedDatabase, 0o600);
  }
  if (!existsSync(configuration))
    writeFileSync(configuration, readFileSync(join(root, ".env.example")), {
      mode: 0o600,
    });
  chmodSync(configuration, 0o600);
  const allowed =
    /^(AI_PROVIDER|AI_REASONING_EFFORT|MODEL_PROVIDER|AI_API_KEY|AI_TIMEOUT_MS|AI_MAX_TOKENS|DEEPSEEK_(API_KEY|BASE_URL|MODEL|THINKING|MAX_TOKENS|TIMEOUT_MS)|OPENAI_(API_KEY|BASE_URL|MODEL)|OPENROUTER_(API_KEY|MODEL)|ANTHROPIC_(API_KEY|BASE_URL|MODEL|TIMEOUT_MS|MAX_TOKENS)|LOCAL_MODEL_(BASE_URL|NAME)|MEDICAL_SANDBOX_PYTHON|AGENT_DOCKER_EXECUTABLE|MCP_[A-Z0-9_]+_(TOKEN|API_KEY)|MEDICAL_EMBEDDING_(PROVIDER|URL|MODEL|KEY)|MEDICAL_WECOM_(CORP_ID|SECRET|CALLBACK_TOKEN|AES_KEY))$/;
  for (const key of Object.keys(process.env))
    if (allowed.test(key)) delete process.env[key];
  for (const [key, value] of Object.entries(
    parseEnv(readFileSync(configuration, "utf8")),
  ))
    if (allowed.test(key) && value !== "") process.env[key] = value;
  if (!smokeTest && !e2eMode) {
    const browserCandidates =
      process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : [];
    if (!process.env.AGENT_BROWSER_EXECUTABLE)
      process.env.AGENT_BROWSER_EXECUTABLE =
        browserCandidates.find(existsSync) || "";
  }
  // Boot the medical workbench runtime in-process; the window loads this
  // local server only, so patient data never leaves the machine.
  {
    const { createServer } = await import(
      pathToFileURL(join(root, "server/agent.mjs"))
    );
    runtime = createServer({
      onNotification: ({ status }) => {
        if ((!window || !window.isFocused()) && Notification.isSupported())
          new Notification({
            title: "Agent 任务",
            body:
              status === "completed"
                ? "后台任务已完成，返回工作区查看成果。"
                : "任务已停止或失败，返回工作区查看原因。",
          }).show();
      },
      database: sharedDatabase,
      allowedOrigins: [],
      browserFactory: require("./browser-driver.cjs"),
      chooseDirectory: async () => {
        const result = await dialog.showOpenDialog({
          title: "选择授权工作文件夹",
          properties: ["openDirectory"],
        });
        return result.canceled ? null : result.filePaths[0];
      },
    });
    await new Promise((resolve, reject) => {
      runtime.once("error", reject);
      runtime.listen(0, "127.0.0.1", resolve);
    });
    origin = `http://127.0.0.1:${runtime.address().port}`;
  }
  require('./permission-help.cjs').registerPermissionHelp({ipcMain,shell,app,systemPreferences,getWindow:()=>window,getOrigin:()=>origin});
  const trustedMedia = (wc, permission) => wc === window?.webContents && wc?.getURL().startsWith(origin + "/") && ["media", "display-capture"].includes(permission);
  session.defaultSession.setPermissionRequestHandler(async (wc, permission, callback) => {
    if (!trustedMedia(wc, permission)) return callback(false);
    const choice = await dialog.showMessageBox(window, {type:"question", buttons:["允许本次", "取消"], defaultId:1, cancelId:1, message: permission === "media" ? "允许工作台使用麦克风进行实时通话？" : "允许工作台分享你选择的画面？"});
    callback(choice.response === 0);
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => trustedMedia(wc, permission));
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!request.userGesture || request.securityOrigin !== origin) return callback({});
    try {
      const sources = await desktopCapturer.getSources({types:["window","screen"]});
      const choice = await dialog.showMessageBox(window, {message:"选择要共享的窗口或屏幕",buttons:["取消", ...sources.slice(0,15).map(s=>s.name)],cancelId:0,defaultId:0});
      callback(choice.response ? {video:sources[choice.response-1]} : {});
    } catch {callback({});}
  });
  ipcMain.handle("omw:choose-directory", async () => {
    const result = await dialog.showOpenDialog(window, {
      title: "选择授权工作文件夹",
      properties: ["openDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  const showWorkspace = () => {
    if (window) {
      window.show();
      window.focus();
    } else if (origin) openWindow();
  };
  // The app hosts its own runtime; before-quit shuts it down. The generic
  // daemon (platform.mjs), if running, is independent and stays untouched.
  const stopDaemonAndQuit = async () => {
    await app.quit();
  };
  if (!smokeTest && !e2eMode && existsSync(icon(process.platform === "darwin" ? "icon_16.png" : "icon_32.png"))) {
    try {
      tray = new Tray(nativeImage.createFromPath(icon(process.platform === "darwin" ? "icon_16.png" : "icon_32.png")));
      tray.setToolTip(productName);
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "打开工作窗口", click: showWorkspace },
          { type: "separator" },
          { label: "退出并停止后台服务", click: stopDaemonAndQuit },
          {
            label: "退出窗口（后台任务继续）",
            click: () => app.quit(),
          },
        ]),
      );
      tray.on("click", showWorkspace);
    } catch {}
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: productName,
        submenu: [
          { role: "about", label: `关于 ${productName}` },
          { type: "separator" },
          { role: "hide", label: "隐藏" },
          { role: "unhide", label: "显示" },
          { type: "separator" },
          { label: "退出并停止后台服务", click: stopDaemonAndQuit },
          { role: "quit", label: "退出应用" },
        ],
      },
      {
        label: "编辑",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "工作台",
        submenu: [
          {
            label: "打开工作窗口",
            click: () => {
              if (window) window.show();
              else openWindow();
            },
          },
          {
            label: "编辑模型配置…",
            click: () => {
              const editor = spawn(
                process.platform === "win32" ? "notepad.exe" : "/usr/bin/open",
                process.platform === "win32"
                  ? [configuration]
                  : ["-a", "TextEdit", configuration],
                { stdio: "ignore" },
              );
              editor.on("error", () =>
                dialog.showErrorBox(
                  "无法打开配置",
                  `请用文本编辑器打开：${configuration}`,
                ),
              );
            },
          },
          ...(smokeTest
            ? []
            : [
                {
                  label: "登录时自动启动",
                  type: "checkbox",
                  checked: app.getLoginItemSettings().openAtLogin,
                  click: (item) =>
                    app.setLoginItemSettings({
                      openAtLogin: item.checked,
                      path: process.execPath,
                      args: app.isPackaged
                        ? []
                        : [join(root, "desktop/main.cjs")],
                    }),
                },
              ]),
          { label: "打开数据目录", click: () => shell.openPath(dataDirectory) },
          {
            label: "重启以应用配置",
            click: () => {
              app.relaunch();
              app.quit();
            },
          },
          { type: "separator" },
          { role: "reload", label: "刷新页面" },
          { role: "toggleDevTools", label: "开发者工具" },
        ],
      },
      {
        label: "窗口",
        submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }],
      },
    ]),
  );
  await session.defaultSession.setProxy({ mode: "direct" });
  await openWindow();
  if (smokeTest) await verify();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (window) {
      window.show();
      window.focus();
    }
  });
  app
    .whenReady()
    .then(start)
    .catch((error) => {
      if (smokeTest) {
        mkdirSync(testDirectory, { recursive: true });
        writeFileSync(
          join(testDirectory, "desktop-report.json"),
          JSON.stringify({ passed: false, error: error.message }),
        );
      } else
        dialog.showErrorBox(
          `${productName} 启动失败`,
          `${error.message}\n请检查「${join(app.getPath("userData"), "model.env")}」配置。`,
        );
      app.quit();
    });
  app.on("activate", () => {
    if (origin && !window) openWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
    /* macOS keeps scheduled jobs alive until explicit Quit. */
  });
  app.on("before-quit", (event) => {
    if (quitting || !runtime) return;
    event.preventDefault();
    quitting = true;
    runtime.shutdown().finally(() => app.quit());
  });
}
