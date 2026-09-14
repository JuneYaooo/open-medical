const { app } = require("electron");
const { createServer } = require("node:http");
const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const assert = require("node:assert/strict");
const directory = mkdtempSync(join(tmpdir(), "browser-tools-test-"));
app.setPath("userData", join(directory, "electron"));
app
  .whenReady()
  .then(async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { WorkspaceService } =
      await import("../server/core/workspace-service.mjs");
    const db = new DatabaseSync(":memory:");
    let blockedRequests = 0;
    const outside = createServer((_req, res) => {
      blockedRequests++;
      res.end("should not be reached");
    });
    await new Promise((r) => outside.listen(0, "127.0.0.1", r));
    const denied = `http://127.0.0.1:${outside.address().port}`;
    const fixture = createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: denied });
        res.end();
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(
        `<html><head><title>Browser verification</title></head><body><input id="name"><input id="secret" type="password"><button id="action" onclick="document.querySelector('#result').textContent='clicked'">Apply</button><p id="result">untouched</p><p id="isolation"></p><img src="${denied}/pixel"><script>document.querySelector('#isolation').textContent='node:'+typeof process+',require:'+typeof require;fetch('${denied}/fetch').catch(()=>{});</script></body></html>`,
      );
    });
    await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${fixture.address().port}`;
    const service = new WorkspaceService(
      db,
      {},
      {
        extensions: {
          directory: join(directory, "plugins"),
          browserFactory: require("../desktop/browser-driver.cjs"),
        },
      },
    );
    try {
      const w = service.create({ root: directory, directoryConsent: true });
      await service.extensions.configure(w.id, {
        revision: w.revision,
        consent: true,
        terminal: false,
        browser: true,
        plugins: false,
        mcp: false,
        memoryRead: false,
        memoryWrite: false,
        origins: [origin],
        memory: { provider: "lsa" },
      });
      const tool = (tool, arguments_ = {}) =>
        service.tool(w.id, { tool, arguments: arguments_ });
      await tool("browser_open", { url: origin });
      let snapshot = await tool("browser_snapshot");
      assert.match(snapshot.text, /node:undefined,require:undefined/);
      assert.match(snapshot.text, /untouched/);
      const proposal = await tool("browser_action", {
        action: "click",
        selector: "#action",
      });
      assert.match((await tool("browser_snapshot")).text, /untouched/);
      await service.extensions.operation(w.id, {
        action: "browser-decision",
        revision: service.get(w.id).revision,
        approvalId: proposal.id,
        decision: "approve",
      });
      assert.match((await tool("browser_snapshot")).text, /clicked/);
      const fill = await tool("browser_action", {
        action: "fill",
        selector: "#name",
        value: "synthetic input",
      });
      await service.extensions.operation(w.id, {
        action: "browser-decision",
        revision: service.get(w.id).revision,
        approvalId: fill.id,
        decision: "approve",
      });
      const driver = await service.extensions.browser.get(w.id, [origin]);
      await assert.rejects(
        driver.act({ action: "fill", selector: "#secret", value: "blocked" }),
      );
      await assert.rejects(tool("browser_open", { url: denied }));
      await assert.rejects(tool("browser_open", { url: origin + "/redirect" }));
      assert.equal(blockedRequests, 0);
      await tool("browser_open", { url: origin });
      const screenshot = await tool("browser_screenshot");
      const output = resolve("output/extensions");
      mkdirSync(output, { recursive: true });
      writeFileSync(
        join(output, "browser-tools.png"),
        Buffer.from(screenshot.data, "base64"),
      );
      writeFileSync(
        join(output, "browser-verification.json"),
        JSON.stringify(
          {
            passed: true,
            platform: process.platform,
            chromium: process.versions.chrome,
            nodeIsolation: true,
            networkOriginBlocking: true,
            approvedClick: true,
            approvedFill: true,
            passwordFillDenied: true,
            screenshot: true,
          },
          null,
          2,
        ),
      );
      console.log(
        "PASS: real Electron browser, network blocking, isolation, approval and screenshot",
      );
    } catch (e) {
      console.error(e);
      process.exitCode = 1;
    } finally {
      await service.extensions.close();
      db.close();
      fixture.closeAllConnections();
      outside.closeAllConnections();
      await Promise.all([
        new Promise((r) => fixture.close(r)),
        new Promise((r) => outside.close(r)),
      ]);
      rmSync(directory, { recursive: true, force: true });
      app.quit();
    }
  })
  .catch((e) => {
    console.error(e);
    app.exit(1);
  });
