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
  unlinkSync,
} = require("node:fs");
const { parseEnv } = require("node:util");
const { randomBytes } = require("node:crypto");
const desktopAccessToken = randomBytes(32).toString("hex");

const productName = "Open Medical Workbench";
app.setName(productName);
// 界面永远加载自本机回环地址；系统代理开启（如本机代理客户端）时会把
// 127.0.0.1 的请求转发给代理并整窗 ERR_FAILED，这里对渲染进程禁用代理。
// 模型/文献等外联走主进程 Node，不经过这条通道。
app.commandLine.appendSwitch("no-proxy-server");
const testDirectory = process.env.MEDICAL_DESKTOP_TEST_DIR;
const smokeTest =
  process.argv.includes("--smoke-test") && Boolean(testDirectory);
// 自动化端到端模式：与 smoke 一样使用隔离数据目录与数据库，
// 但保持交互窗口不自动退出，供 Playwright 驱动跑场景。
const e2eMode =
  !smokeTest && process.argv.includes("--e2e") && Boolean(testDirectory);
// 测试 userData 目录在设置环境变量后隔离；数据库隔离还必须
// 同时指定 --e2e 或 --smoke-test，后者额外运行内建冒烟流程。
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
  quitting = false,
  relaunchRequested = false,
  shuttingDown = false,
  shutdownComplete = false,
  pendingRestore = null;

function requestRelaunch() {
  if (quitting) return;
  relaunchRequested = true;
  app.quit();
}

function openWindow() {
  // Windows 上隐藏系统标题栏和菜单条，改用页面顶栏作为标题栏（可拖拽），
  // 只保留系统绘制的最小化/最大化/关闭按钮（titleBarOverlay）。
  // 颜色取自 .topbar 的背景（#fcfdfb）与文字色，按钮区与页面融为一体。
  const overlayTitleBar = process.platform === "win32";
  window = new BrowserWindow({
    title: `${productName} · 工作台`,
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 650,
    // 背景与页面同色，渲染完成前的空白不再是突兀的黑屏；
    // 窗口等首次绘制完成（ready-to-show）才显示，用户看到的就是可用界面。
    backgroundColor: "#fcfdfb",
    show: false,
    titleBarStyle: overlayTitleBar ? "hidden" : "default",
    titleBarOverlay: overlayTitleBar
      ? { color: "#fcfdfb", symbolColor: "#263831", height: 44 }
      : undefined,
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
  // 首帧就绪再亮窗：跳过「黑屏/白屏等加载」阶段；加载失败由 start() 的
  // 错误弹窗兜底，不会出现永远不可见的窗口。
  if (!smokeTest)
    window.once("ready-to-show", () => window.show());
  // 首帧之前锁住窗口标题，避免渲染进程把「新建任务」等页面标题提前顶上来，
  // 让加载中的窗口看起来像已经打开了一个空任务。
  let firstPaint = false;
  window.webContents.on("did-finish-load", () => {
    firstPaint = true;
  });
  window.on("page-title-updated", (event) => {
    if (!firstPaint) event.preventDefault();
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
  window.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(window, {
      type: "question",
      buttons: ["继续编辑", quitting ? relaunchRequested ? "放弃并重启" : "放弃并退出" : "放弃并继续"],
      defaultId: 0,
      cancelId: 0,
      message: "有尚未保存的内容",
      detail: "关闭、刷新或重启后，未保存的内容将丢失。",
    });
    if (choice === 1) event.preventDefault();
    else { quitting = false; relaunchRequested = false; pendingRestore = null; }
  });
  // Windows/Linux 去掉应用菜单后，刷新与开发者工具的原生快捷键随菜单消失，
  // 这里手动补上；macOS 保留系统菜单栏，由菜单角色负责，不重复注册。
  if (process.platform !== "darwin")
    window.webContents.on("before-input-event", (_event, input) => {
      if (input.type !== "keyDown") return;
      const key = input.key.toLowerCase();
      const devtools =
        input.key === "F12" || (input.control && input.shift && key === "i");
      const reload =
        input.key === "F5" ||
        ((input.control || input.metaKey) && key === "r" && !input.shift);
      if (devtools) window.webContents.toggleDevTools();
      else if (reload) window.webContents.reload();
      if (devtools || reload) event.preventDefault();
    });
  window.on("closed", () => {
    window = null;
  });
  window.on("close", (event) => {
    if (process.platform !== "darwin" && tray && !quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  return window.loadURL(origin);
}

async function verify() {
  const reportPath = join(testDirectory, "desktop-report.json");
  try {
    const browserDenied = await fetch(origin + "/api/bootstrap");
    if (browserDenied.status !== 403) throw new Error("Desktop bootstrap accessible outside the app");
    const bootstrap = await window.webContents.executeJavaScript(
      'fetch("/api/bootstrap").then(r => r.json())',
    );
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
    // 对话只由模型执行。smoke test 在未配置模型的离线环境运行：提交任务
    // 必须被明确拒绝（503 MODEL_NOT_CONFIGURED），不能返回规则生成的回答。
    if (!bootstrap.modelConfigured) {
      const response = await request(`/api/chat/${created.id}`, "POST", {
        message: "合成测试 时间线 2026-01-02 首诊 Hb 98 g/L",
      });
      const rejected = await response.json().catch(() => ({}));
      if (response.status !== 503 || rejected.code !== "MODEL_NOT_CONFIGURED")
        throw new Error("Packaged agent accepted a task without a model");
    }
    if (bootstrap.sandbox.available) {
      const response = await request(`/api/chat/${created.id}`, "POST", {
        message: "合成沙箱验证",
        mode: "code",
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
          browserAccessBlocked: true,
          app: app.isPackaged,
          platform: process.platform,
          arch: process.arch,
          electron: process.versions.electron,
          node: process.versions.node,
          renderer: state,
          modelRequired: !bootstrap.modelConfigured,
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
    /^(AI_PROVIDER|AI_REASONING_EFFORT|MODEL_PROVIDER|AI_API_KEY|AI_TIMEOUT_MS|AI_MAX_TOKENS|DEEPSEEK_(API_KEY|BASE_URL|MODEL|THINKING|MAX_TOKENS|TIMEOUT_MS)|OPENAI_(API_KEY|BASE_URL|MODEL)|OPENROUTER_(API_KEY|MODEL)|ANTHROPIC_(API_KEY|BASE_URL|MODEL|TIMEOUT_MS|MAX_TOKENS|THINKING|PROMPT_CACHE)|LOCAL_MODEL_(BASE_URL|NAME)|MEDICAL_SANDBOX_PYTHON|AGENT_DOCKER_EXECUTABLE|MCP_[A-Z0-9_]+_(TOKEN|API_KEY)|MEDICAL_EMBEDDING_(PROVIDER|URL|MODEL|KEY)|MEDICAL_PRIVACY_SERVICE_(URL|KEY)|MEDICAL_WECOM_(CORP_ID|SECRET|CALLBACK_TOKEN|AES_KEY))$/;
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
  // local server only; external model calls follow the configured permissions.
  {
    const { createServer } = await import(
      pathToFileURL(join(root, "server/agent.mjs"))
    );
    runtime = createServer({
      desktopAccessToken,
      onNotification: ({ status, kind, title, body }) => {
        if ((!window || !window.isFocused()) && Notification.isSupported())
          new Notification({
            title:
              kind === "pending-proposal"
                ? title || "有待你确认的提案"
                : "Agent 任务",
            body:
              kind === "pending-proposal"
                ? body || "打开工作台顶栏「待确认」核对。"
                : status === "completed"
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
    // Keep the launch credential in the main process. Never attach it to tool
    // browser windows, external sites, or a different local service.
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders };
      for (const key of Object.keys(headers))
        if (key.toLowerCase() === "x-omw-desktop") delete headers[key];
      const target = new URL(details.url);
      if (target.protocol === "ws:") target.protocol = "http:";
      if (target.origin === origin && details.webContentsId === window?.webContents.id)
        headers["X-OMW-Desktop"] = desktopAccessToken;
      callback({ requestHeaders: headers });
    });
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
  // 工作记录导出走页面里的 blob 下载。没有 will-download 处理时，Electron
  // 对这类下载的落盘名不稳定（会出现随机 UUID 的 .tmp 文件），用户无法辨认；
  // 这里固定用页面建议的文件名（如「标题.md」）直接保存到「下载」文件夹。
  session.defaultSession.on("will-download", (_event, item) => {
    if (!item.getURL().startsWith("blob:")) return;
    const suggested = item.getFilename() || "export.md";
    const downloads = app.getPath("downloads");
    const dot = suggested.lastIndexOf(".");
    const stem = dot > 0 ? suggested.slice(0, dot) : suggested;
    const ext = dot > 0 ? suggested.slice(dot) : "";
    let target = join(downloads, suggested);
    for (let n = 1; existsSync(target); n += 1) {
      target = join(downloads, `${stem} (${n})${ext}`);
    }
    item.setSavePath(target);
  });
  ipcMain.handle("omw:choose-directory", async () => {
    const result = await dialog.showOpenDialog(window, {
      title: "选择授权工作文件夹",
      properties: ["openDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  // 脱敏分享 PDF：渲染进程把脱敏后的结构化记录交上来，这里用共享模板
  // 生成打印页，隐藏窗口 printToPDF 后让医生选保存位置。内容全部来自本机
  // 数据，模板对全部字段做 HTML 转义。
  ipcMain.handle("omw:share-report", async (_event, report) => {
    if (!report || !Array.isArray(report.sections))
      return { ok: false, error: "分享内容无效" };
    let printWindow;
    const tempPath = join(app.getPath("temp"), `omw-share-${Date.now()}.html`);
    try {
      const { renderShareHtml } = await import(
        pathToFileURL(join(root, "shared/share-report.mjs"))
      );
      writeFileSync(tempPath, renderShareHtml(report), "utf8");
      printWindow = new BrowserWindow({
        show: false,
        webPreferences: { sandbox: true },
      });
      await printWindow.loadFile(tempPath);
      const pdf = await printWindow.webContents.printToPDF({
        printBackground: true,
        pageSize: "A4",
      });
      const target = await dialog.showSaveDialog(window, {
        title: "保存脱敏病历（PDF）",
        defaultPath: join(
          app.getPath("downloads"),
          `${report.fileName || "脱敏病历"}.pdf`,
        ),
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (target.canceled || !target.filePath) return { ok: false, canceled: true };
      writeFileSync(target.filePath, pdf);
      return { ok: true, path: target.filePath };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      if (printWindow) printWindow.destroy();
      try {
        unlinkSync(tempPath);
      } catch {}
    }
  });
  // 菜单栏迁入「设置 → 桌面应用」后的窄接口：只暴露固定动作，不传任意路径。
  require('./backup-directory.cjs').registerBackupDirectory({ipcMain,shell,getWindow:()=>window,getOrigin:()=>origin,databasePath:sharedDatabase});
  // shell.openPath reports failure as a returned message, not a rejection.
  const openDirectory = async (path) => {
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
    return { opened: true };
  };
  ipcMain.handle("omw:open-data-directory", () => openDirectory(dirname(sharedDatabase)));
  ipcMain.handle("omw:open-config-directory", () => openDirectory(dataDirectory));
  ipcMain.handle("omw:login-item", () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle("omw:set-login-item", (_event, open) => {
    app.setLoginItemSettings({
      openAtLogin: Boolean(open),
      path: process.execPath,
      args: app.isPackaged ? [] : [join(root, "desktop/main.cjs")],
    });
    return app.getLoginItemSettings().openAtLogin;
  });
  ipcMain.handle("omw:relaunch", requestRelaunch);
  // 一键恢复：只接受备份清单中的文件名；数据库关闭后在 will-quit 中替换，再重启。
  ipcMain.handle("omw:restore-backup", (event, name) => {
    if (!require("./permission-help.cjs").trustedFrame(event, window, origin)) throw Error("仅工作台主页面可请求此操作");
    if (quitting) throw Error("应用正在退出，请稍后重试");
    require("./backup-restore.cjs").resolveBackup(sharedDatabase, name);
    pendingRestore = { databasePath: sharedDatabase, name };
    requestRelaunch();
    return { restarting: true };
  });
  const showWorkspace = () => {
    if (quitting) return;
    if (window) {
      window.show();
      window.focus();
    } else if (origin) openWindow();
  };
  // 渲染进程的到期待办提醒（随访到期、新检验结果等）：窗口不在前台时也由
  // 主进程弹系统通知，点击通知把窗口带回前台并切到对应视图。文案只取字符
  // 串字段并截断，内容全部来自本机数据。
  ipcMain.handle("omw:show-notification", (_event, options) => {
    if (!Notification.isSupported()) return false;
    const title = typeof options?.title === "string" && options.title ? options.title.slice(0, 80) : "Open Medical";
    const body = typeof options?.body === "string" ? options.body.slice(0, 180) : "";
    const view = typeof options?.view === "string" && options.view ? options.view.slice(0, 40) : "";
    const notification = new Notification({ title, body });
    notification.on("click", () => {
      showWorkspace();
      if (view && window) window.webContents.send("omw:open-view", view);
    });
    notification.show();
    return true;
  });
  // The app hosts its own runtime; will-quit shuts it down after edits are resolved. The generic
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
            label: "隐藏窗口（后台任务继续）",
            click: () => window?.hide(),
          },
        ]),
      );
      tray.on("click", showWorkspace);
    } catch {}
  }
  // macOS 的应用菜单在屏幕顶部系统菜单栏里，是标准体验，保留完整菜单；
  // Windows 上同样的菜单会渲染成窗口里一条灰色菜单条（观感差且功能入口
  // 已迁入「设置 → 桌面应用」），这里不再注册。编辑快捷键由 Chromium 在
  // 可编辑区域内原生处理，刷新/DevTools 由 before-input-event 兜底。
  if (process.platform === "darwin")
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
            { label: "打开数据目录", click: () => shell.openPath(dirname(sharedDatabase)) },
            { label: "打开配置目录", click: () => shell.openPath(dataDirectory) },
            {
              label: "重启以应用配置",
              click: requestRelaunch,
            },
            { type: "separator" },
            { role: "reload", label: "重新加载工作台" },
            { role: "toggleDevTools", label: "开发者工具" },
          ],
        },
        {
          label: "窗口",
          submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }],
        },
      ]),
    );
  else Menu.setApplicationMenu(null);
  await session.defaultSession.setProxy({ mode: "direct" });
  await openWindow();
  if (smokeTest) await verify();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (quitting) return;
    if (window) {
      window.show();
      window.focus();
    } else if (origin) openWindow();
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
          `${error.message}\n请重新启动应用；仍无法打开时请保留此提示以便排查。`,
        );
      app.quit();
    });
  app.on("activate", () => {
    if (!quitting && origin && !window) openWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
    /* macOS keeps scheduled jobs alive until explicit Quit. */
  });
  app.on("before-quit", () => { quitting = true; });
  // A window may cancel quitting to preserve a draft. Keep its API alive until
  // every window has accepted closing, and schedule relaunch only after shutdown.
  app.on("will-quit", (event) => {
    if (shutdownComplete || !runtime) return;
    event.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    runtime.shutdown().then(() => {
      // Restore only after a clean shutdown has closed the database.
      if (!pendingRestore || !relaunchRequested) return;
      try { require("./backup-restore.cjs").restoreBackup(pendingRestore); }
      catch (error) { dialog.showErrorBox("恢复备份失败", error.message); }
    }).catch(error => console.error("Runtime shutdown failed:", error)).finally(() => {
      shutdownComplete = true;
      if (relaunchRequested) app.relaunch();
      // Let Electron finish cancelling this will-quit event before trying again.
      setImmediate(() => app.quit());
    });
  });
}
