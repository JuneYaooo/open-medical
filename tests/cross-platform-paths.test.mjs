import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { permittedURL } from "../server/core/browser-tools.mjs";
import { fixture } from "./helpers.mjs";

test("local browser accepts workspace file URLs with spaces and rejects sibling paths", () => {
  const root = resolve("output", "browser workspace");
  const inside = pathToFileURL(resolve(root, "页面 #1.html")).href;
  assert.equal(permittedURL(inside, [], root), inside);
  const outside = pathToFileURL(resolve(root + "-other", "index.html")).href;
  assert.throws(() => permittedURL(outside, [], root), { code: "BROWSER_ORIGIN" });
});

test("built application serves its JavaScript and CSS on the host platform", {
  skip: !existsSync(resolve("dist/index.html")),
}, async (t) => {
  const f = await fixture(t);
  const home = await fetch(f.origin);
  assert.equal(home.status, 200);
  const html = await home.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g)]
    .map((match) => match[1]);
  assert.ok(assets.some((path) => path.endsWith(".js")));
  assert.ok(assets.some((path) => path.endsWith(".css")));
  for (const path of assets) {
    const response = await fetch(f.origin + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type"), /javascript|css/);
  }
});
