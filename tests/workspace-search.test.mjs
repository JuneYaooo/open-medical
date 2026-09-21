import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceFiles } from "../server/core/workspace-files.mjs";
const fixture = (t, options) => {
  const root = mkdtempSync(join(tmpdir(), "search-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (p, content) => {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), content);
  };
  return { root, put, files: new WorkspaceFiles(root, options) };
};
test("repository search reaches late files and deep paths using real ripgrep", async (t) => {
  const { put, files } = fixture(t);
  for (let i = 0; i < 160; i++)
    put(`f${String(i).padStart(3, "0")}.txt`, i === 159 ? "target" : "none");
  put("a/b/c/d/e/f/g/中文 空格.txt", "before\nTARGET 42\nafter");
  const result = await files.search("target");
  assert.equal(result.engine, "ripgrep");
  assert.equal(result.complete, true);
  assert.equal(result.matches.length, 2);
  const scoped = await files.search({
    regex: "TARGET [0-9]+",
    path: "a",
    glob: "*.txt",
    ignoreCase: false,
    context: 1,
  });
  assert.equal(scoped.matches[0].line, 2);
  assert.deepEqual(scoped.matches[0].before, [{ line: 1, text: "before" }]);
  assert.equal(scoped.matches[0].after[0].text, "after");
});
test("stable pages contain every matching line exactly once and support derived modes", async (t) => {
  const { put, files } = fixture(t);
  for (let i = 0; i < 145; i++)
    put(`f${String(i).padStart(3, "0")}.txt`, "hit\nhit");
  let offset = 0;
  const keys = [];
  do {
    const r = await files.search({ query: "hit", offset, limit: 17 });
    keys.push(...r.matches.map((m) => `${m.path}:${m.line}`));
    offset = r.nextOffset;
  } while (offset !== undefined);
  assert.equal(keys.length, 290);
  assert.equal(new Set(keys).size, 290);
  const counts = await files.search({
    query: "hit",
    outputMode: "count",
    limit: 3,
  });
  assert.deepEqual(
    counts.matches.map((m) => m.count),
    [2, 2, 2],
  );
  const names = await files.search({
    query: "hit",
    outputMode: "files",
    limit: 200,
  });
  assert.equal(names.matches.length, 145);
});
test("protection, ignore rules, hidden paths, symlinks and shell-looking patterns", async (t) => {
  const { root, put, files } = fixture(t);
  put("safe.txt", "needle");
  put(".env", "needle");
  put("x.key", "needle");
  put("node_modules/mod.txt", "needle");
  put(".hidden/data", "needle");
  put("ignored/data", "needle");
  put(".gitignore", "ignored/\n");
  symlinkSync(join(root, ".env"), join(root, "alias.txt"));
  const result = await files.search({ query: "needle", glob: "*" });
  assert.deepEqual(
    result.matches.map((m) => m.path),
    ["safe.txt"],
  );
  for (const path of [".env", ".hidden", "../outside", "alias.txt"])
    await assert.rejects(files.search({ query: "needle", path }), {
      code: "PATH_DENIED",
    });
  assert.equal((await files.search("$(touch injected)")).matches.length, 0);
});
test("fallback is bounded and explicitly refuses unsupported regex and ignore rules", async (t) => {
  const { put, files } = fixture(t, { rgCommand: ["/no/such/rg"] });
  for (let i = 0; i < 600; i++) put(`f${i}.txt`, i === 599 ? "last" : "none");
  const r = await files.search("last");
  assert.equal(r.engine, "fallback");
  assert.equal(r.complete, true);
  assert.equal(r.matches.length, 1);
  const regex = await files.search({ regex: "(a+)+$" });
  assert.equal(regex.complete, false);
  assert.equal(regex.reason, "regex-unavailable");
  put(".gitignore", "f*");
  const ignored = await files.search("last");
  assert.equal(ignored.complete, false);
  assert.equal(ignored.reason, "ignore-rules-unavailable");
  assert.equal(ignored.matches.length, 0);
});
test("abort propagates and child timeout is bounded", async (t) => {
  const { put, files, root } = fixture(t);
  put("file.txt", "hit");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(files.search("hit", { signal: controller.signal }), {
    code: "CANCELLED",
  });
  put("slow.cjs", "setInterval(()=>{},1000)");
  const slow = new WorkspaceFiles(root, {
    rgCommand: [process.execPath, join(root, "slow.cjs")],
  });
  const started = Date.now();
  const result = await slow.search({ query: "hit", timeoutMs: 30 });
  assert.equal(result.reason, "timeout");
  assert.equal(result.complete, false);
  assert.ok(Date.now() - started < 3000);
  const live = new AbortController();
  const pending = slow.search("hit", { signal: live.signal });
  setTimeout(() => live.abort(), 30);
  await assert.rejects(pending, { code: "CANCELLED" });
});
test("ignore metadata symlinks are rejected before ripgrep can read their target", async (t) => {
  const { root, put, files } = fixture(t);
  put("safe.txt", "hit");
  put(".env", "hit");
  symlinkSync(join(root, ".env"), join(root, ".gitignore"));
  const result = await files.search("hit");
  assert.equal(result.complete, false);
  assert.equal(result.reason, "unsafe-ignore-file");
  assert.deepEqual(result.matches, []);
});
test("newline file names survive NUL-delimited listing", async (t) => {
  const { put, files } = fixture(t);
  put("line\nbreak.txt", "target");
  const result = await files.search("target");
  assert.equal(result.matches[0].path, "line\nbreak.txt");
});
test("real rg output budget stops without claiming a complete empty scan or unusable cursor", async (t) => {
  const { put, files } = fixture(t);
  for (let i = 0; i < 8; i++) put(`f${i}.txt`, "hit\n".repeat(100000));
  const result = await files.search({ query: "hit", limit: 3 });
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
  assert.equal(result.reason, "output-budget");
  assert.equal(result.nextOffset, undefined);
  assert.ok(result.matches.length <= 3);
});

test("ripgrep reads private snapshots when original content and ignore files are replaced at spawn", async (t) => {
  const { root, put } = fixture(t);
  const wrapperRoot = mkdtempSync(join(tmpdir(), "search-race-wrapper-"));
  t.after(() => rmSync(wrapperRoot, { recursive: true, force: true }));
  put("victim.txt", "needle safe original");
  put("ignored.txt", "needle excluded original");
  put(".gitignore", "ignored.txt\n");
  put(".env", "needle protected source");
  const wrapper = join(wrapperRoot, "rg-wrapper.mjs");
  const listingMarker = join(wrapperRoot, "listing-cwd");
  const contentMarker = join(wrapperRoot, "content-cwd");
  writeFileSync(wrapper, `
import { unlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('--files')) {
  unlinkSync(${JSON.stringify(join(root, ".gitignore"))});
  symlinkSync(${JSON.stringify(join(root, ".env"))}, ${JSON.stringify(join(root, ".gitignore"))});
  writeFileSync(${JSON.stringify(listingMarker)}, process.cwd());
} else {
  unlinkSync(${JSON.stringify(join(root, "victim.txt"))});
  symlinkSync(${JSON.stringify(join(root, ".env"))}, ${JSON.stringify(join(root, "victim.txt"))});
  writeFileSync(${JSON.stringify(contentMarker)}, process.cwd());
}
const result = spawnSync('rg', args, { stdio: 'inherit' });
process.exit(result.status ?? 2);
`);
  const result = await new WorkspaceFiles(root, { rgCommand: [process.execPath, wrapper] }).search("needle");
  assert.equal(result.complete, true);
  assert.deepEqual(result.matches.map((m) => [m.path, m.text]), [["victim.txt", "needle safe original"]]);
  assert.equal(JSON.stringify(result).includes("protected source"), false);
  const cwd = readFileSync(listingMarker, "utf8");
  assert.notEqual(cwd, root);
  assert.equal(readFileSync(contentMarker, "utf8"), cwd);
  assert.equal(existsSync(cwd), false, "private snapshot removed after subprocess completion");
});
