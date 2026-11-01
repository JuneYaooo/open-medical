import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { createServer as createViteServer } from "vite";
import { createElement } from "react";
import { renderToPipeableStream, renderToStaticMarkup } from "react-dom/server";

// Real settings-shell render, not just the resolver. Plugin panels are lazy
// chunks that named-export their component; a direct `() => import()` loader
// makes React.lazy receive the module instead of the component. That mistake
// produces an empty content area while the URL and subnav still look correct,
// which is exactly how screenshots 24/25 regressed.
globalThis.window = {
  location: { search: "", href: "http://localhost/?view=settings" },
  history: { state: null, replaceState() {} },
  omwDesktop: null,
  addEventListener() {},
  removeEventListener() {},
};
globalThis.sessionStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {},
};

function render(element) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    const stream = renderToPipeableStream(element, {
      onAllReady() { stream.pipe(output); },
      onShellError: reject,
      onError(error) { reject(error); },
    });
    output.once("finish", () => resolve(Buffer.concat(chunks).toString()));
  });
}

test("设置：六个 settingsTab 深链接都渲染对应页签", async (t) => {
  const vite = await createViteServer({
    appType: "custom",
    // Server-side rendering only: skip browser dependency pre-bundling, which
    // leaves a temp copy in node_modules/.vite each time the server closes.
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());
  const slots = await vite.ssrLoadModule("/src/plugin-slots.jsx");
  const registry = await vite.ssrLoadModule("/src/plugin-registry.js");
  const { AppSettingsView, resolveSettingsSection } = await vite.ssrLoadModule("/src/app-settings.jsx");
  const modules = await registry.loadUiPluginModules();
  const ids = Object.values(modules)
    .map((module) => (module.default ?? module)?.id)
    .filter(Boolean);
  slots.registerUiPlugins(modules, ids, ids);
  const config = {
    capabilities: { medical: true },
    modelConfigured: true,
    provider: "test",
    model: "test",
    demoEntryHidden: false,
  };
  const cases = [
    ["knowledge-bot", /<h2>医生分身<\/h2>/, "医生分身"],
    ["notifications", /<h2>医生待办提醒<\/h2>/, "医生提醒"],
    ["followup", /<h2>患者随访<\/h2>/, "患者随访"],
    ["workbench", null, "自动化规则"],
    ["learning", /<h2>学习与记忆<\/h2>/, "学习与记忆"],
    ["skills", null, "技能"],
  ];
  let registered = [];
  function CapturePanels() {
    registered = slots.useActiveSlot("settings.panels");
    return null;
  }
  renderToStaticMarkup(createElement(CapturePanels));
  for (const [tab] of cases) {
    assert.equal(
      resolveSettingsSection(tab, []),
      tab === "skills" ? "skills" : "general",
      `${tab} 在插件面板注册前必须安全回退`,
    );
    assert.equal(resolveSettingsSection(tab, registered), tab);
  }
  for (const [tab, title, subnav] of cases) {
    globalThis.window.location.search = `?view=settings&settingsTab=${tab}`;
    globalThis.window.location.href = `http://localhost/?view=settings&settingsTab=${tab}`;
    const html = await render(createElement(AppSettingsView, {
      config,
      onModel() {},
      onDoctor() {},
      onProjects() {},
      onAsk() {},
      demoPreferenceBusy: false,
      onDemoEntryHiddenChange() {},
      onPluginsChanged() {},
    }));
    if (title) assert.match(html, title, `${tab} 必须渲染标题`);
    assert.match(
      html,
      new RegExp(`aria-pressed="true"[^>]*>${subnav}<`),
      `${tab} 必须选中对应子页签`,
    );
  }
});
