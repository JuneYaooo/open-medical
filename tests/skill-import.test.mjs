import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pack } from "tar-stream";
import { Store } from "../server/store.mjs";
import { PendingActions } from "../server/medical/pending-actions.mjs";
import { Extensions } from "../server/medical/extensions.mjs";
import { GenericDomain } from "../server/core/domain-adapter.mjs";
import { SkillRegistry } from "../server/core/skills.mjs";
import { extensionTools } from "../server/medical/extension-tools.mjs";
import { parseGitHubTarget, resolveProxyFor, stageSkillImport } from "../server/medical/skill-import.mjs";
import { fixture } from "./helpers.mjs";

const noProxy = async () => null;

const SKILL_MD = (name, description = "用 gpt-image-2 生成演示文稿。") =>
  `---\nname: ${name}\ntitle: ${name}\ndescription: ${description}\n---\n\n# 步骤\n\n按 styles/ 里的模板生成幻灯片。\n`;

function tarBuffer(entries) {
  return new Promise((resolve, reject) => {
    const archive = pack();
    const chunks = [];
    archive.on("data", (chunk) => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
    for (const entry of entries) archive.entry({ name: entry.name, size: entry.data.length, type: "file" }, entry.data);
    archive.finalize();
  });
}
const fetchServing = (buffer, url = "https://codeload.github.com/o/r/tar.gz/HEAD") => async () =>
  ({ ok: true, status: 200, url, body: Readable.from([buffer]) });

function setup(t, { skillExists, fetchImpl } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omw-import-"));
  const store = new Store(":memory:");
  const extensions = new Extensions({
    store,
    patients: { all: () => [] },
    schedule: {},
    skillsDir: join(dir, "my-skills"),
    skillExists: skillExists || (() => false),
    importer: fetchImpl ? (args) => stageSkillImport({ ...args, fetchImpl, resolveProxy: noProxy }) : undefined,
    proxyResolver: noProxy,
  });
  const pending = new PendingActions(store, { extensions: () => extensions, patients: () => null, followups: () => null, cases: () => null });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, extensions, pending, registry: new SkillRegistry([join(dir, "my-skills")]) };
}

test("GitHub 地址解析支持仓库、分支与子目录", () => {
  assert.deepEqual(parseGitHubTarget("https://github.com/JuneYaooo/gpt-image2-ppt-skills"), { owner: "JuneYaooo", repo: "gpt-image2-ppt-skills", ref: null, subdir: "" });
  assert.deepEqual(parseGitHubTarget("https://github.com/o/r/tree/main/skills/sub"), { owner: "o", repo: "r", ref: "main", subdir: "skills/sub" });
  assert.equal(parseGitHubTarget("http://github.com/o/r"), null);
  assert.equal(parseGitHubTarget("https://gitlab.com/o/r"), null);
  assert.equal(parseGitHubTarget("https://github.com/o/r/blob/main/x"), null);
  assert.equal(parseGitHubTarget("https://github.com/o"), null);
});

test("根级 SKILL.md 的技能包整体安装,文本与二进制文件逐字落盘", async (t) => {
  const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff]);
  const archive = await tarBuffer([
    { name: "gpt-image2-ppt-skills/SKILL.md", data: Buffer.from(SKILL_MD("gpt-image2-ppt-skills")) },
    { name: "gpt-image2-ppt-skills/scripts/render.py", data: Buffer.from("print('hi')\n") },
    { name: "gpt-image2-ppt-skills/styles/morandi.md", data: Buffer.from("# 风格\n") },
    { name: "gpt-image2-ppt-skills/assets/logo.png", data: binary },
    { name: "README.md", data: Buffer.from("仓库说明,不属于技能") },
  ]);
  const { extensions, pending, registry } = setup(t, { fetchImpl: fetchServing(archive) });
  const staged = await extensions.stageImport({ url: "https://github.com/JuneYaooo/gpt-image2-ppt-skills" });
  assert.equal(staged.skills.length, 1);
  const skill = staged.skills[0];
  assert.equal(skill.id, "gpt-image2-ppt-skills");
  assert.equal(skill.files.length, 4);
  assert.equal(skill.files.find((f) => f.path === "assets/logo.png").encoding, "base64");
  assert.equal(skill.files.find((f) => f.path === "scripts/render.py").content, "print('hi')\n");
  assert.match(skill.origin.hash, /^[a-f0-9]{64}$/);
  assert.equal(skill.origin.repo, "JuneYaooo/gpt-image2-ppt-skills");

  const action = pending.propose({ type: "ext-install", payload: { install: { source: staged.source, skills: staged.skills } }, summary: staged.summary });
  assert.equal(action.type, "ext-install");
  const confirmed = pending.confirm(action.id);
  assert.equal(confirmed.applied.ids.length, 1);
  assert.deepEqual(registry.list().map((s) => s.id), ["gpt-image2-ppt-skills"]);
  assert.match(registry.readResource("gpt-image2-ppt-skills", "scripts/render.py").text, /print/);
  assert.deepEqual([...readFileSync(join(extensions.skillsDir, "gpt-image2-ppt-skills", "assets", "logo.png"))], [...binary]);

  // 同包再次导入:版本递增,不重复建行。
  const restaged = await extensions.stageImport({ url: "https://github.com/JuneYaooo/gpt-image2-ppt-skills" });
  assert.equal(restaged.skills[0].previousVersion, 1);
  const second = pending.confirm(pending.propose({ type: "ext-install", payload: { install: { source: restaged.source, skills: restaged.skills } }, summary: restaged.summary }).id);
  assert.equal(second.applied.extensions[0].version, 2);
  assert.equal(extensions.list({ kind: "skill" }).length, 1);
});

test("多技能包按编号选择;重名、内置冲突与坏 frontmatter 跳过并说明", async (t) => {
  const url = "https://github.com/o/pack";
  const archive = await tarBuffer([
    { name: "pack/a/SKILL.md", data: Buffer.from(SKILL_MD("a")) },
    { name: "pack/a/ref.md", data: Buffer.from("A") },
    { name: "pack/b/SKILL.md", data: Buffer.from(SKILL_MD("b")) },
    { name: "pack/README.md", data: Buffer.from("说明") },
  ]);
  const staged = await stageSkillImport({ url, fetchImpl: fetchServing(archive), resolveProxy: noProxy });
  assert.deepEqual(staged.skills.map((s) => s.id), ["a", "b"]);
  const onlyB = await stageSkillImport({ url, select: ["b"], fetchImpl: fetchServing(archive), resolveProxy: noProxy });
  assert.deepEqual(onlyB.skills.map((s) => s.id), ["b"]);
  assert.deepEqual(onlyB.skipped, [{ id: "a", reason: "未选择" }]);
  await assert.rejects(
    () => stageSkillImport({ url, select: ["zzz"], fetchImpl: fetchServing(archive), resolveProxy: noProxy }),
    (error) => error.code === "INVALID_INPUT" && /没有这些技能/.test(error.message),
  );
  const reserved = await stageSkillImport({ url, skillExists: (id) => id === "a", fetchImpl: fetchServing(archive), resolveProxy: noProxy });
  assert.deepEqual(reserved.skills.map((s) => s.id), ["b"]);
  assert.deepEqual(reserved.skipped, [{ id: "a", reason: "与内置技能重名" }]);
  const authored = await stageSkillImport({
    url,
    fetchImpl: fetchServing(archive),
    resolveProxy: noProxy,
    lookupExtension: (id) => (id === "a" ? { id: "a", kind: "skill", name: "a", version: 3 } : null),
  });
  assert.match(authored.skipped[0].reason, /重名/);
  const updatable = await stageSkillImport({
    url,
    fetchImpl: fetchServing(archive),
    resolveProxy: noProxy,
    lookupExtension: (id) => (id === "a" ? { id: "a", kind: "skill", imported: true, name: "a", version: 3 } : null),
  });
  assert.equal(updatable.skills[0].previousVersion, 3);
});

test("超限文件与坏 frontmatter 被跳过;超过 8 个技能必须选择", async (t) => {
  const url = "https://github.com/o/mixed";
  const mixed = await tarBuffer([
    { name: "ok/SKILL.md", data: Buffer.from(SKILL_MD("ok")) },
    { name: "big/SKILL.md", data: Buffer.from(SKILL_MD("big")) },
    { name: "big/huge.bin", data: Buffer.alloc(4_100_000, 97) },
    { name: "bad/SKILL.md", data: Buffer.from("---\nname: bad\ndescription: !!js/function \"x()\"\n---\nnope") },
  ]);
  const staged = await stageSkillImport({ url, fetchImpl: fetchServing(mixed), resolveProxy: noProxy });
  assert.deepEqual(staged.skills.map((s) => s.id), ["ok"]);
  assert.equal(staged.skipped.length, 2);
  assert.match(staged.skipped.find((s) => s.id === "big").reason, /4MB/);

  const many = Array.from({ length: 9 }, (_, i) => ({ name: `s${i}/SKILL.md`, data: Buffer.from(SKILL_MD(`s${i}`)) }));
  const packed = await tarBuffer(many);
  await assert.rejects(() => stageSkillImport({ url, fetchImpl: fetchServing(packed), resolveProxy: noProxy }), /最多安装/);
  const picked = await stageSkillImport({ url, select: ["s0", "s1"], fetchImpl: fetchServing(packed), resolveProxy: noProxy });
  assert.deepEqual(picked.skills.map((s) => s.id), ["s0", "s1"]);
});

test("只接受 HTTPS 地址;404 与坏包错误可读", async (t) => {
  await assert.rejects(() => stageSkillImport({ url: "http://github.com/o/r", fetchImpl: fetchServing(Buffer.alloc(8)), resolveProxy: noProxy }), /GitHub 仓库链接/);
  await assert.rejects(() => stageSkillImport({ url: "https://example.com/pack.zip", fetchImpl: fetchServing(Buffer.alloc(8)), resolveProxy: noProxy }), /压缩包/);
  const missing = async () => ({ ok: false, status: 404, url: "x" });
  await assert.rejects(() => stageSkillImport({ url: "https://github.com/o/missing", fetchImpl: missing, resolveProxy: noProxy }), /不存在/);
  const garbage = await tarBuffer([{ name: "just/a/file.txt", data: Buffer.from("没有技能") }]);
  await assert.rejects(() => stageSkillImport({ url: "https://github.com/o/empty", fetchImpl: fetchServing(garbage), resolveProxy: noProxy }), /没有找到技能/);
});

test("导入技能的停用/回退/删除与磁盘文件同步", async (t) => {
  const v1 = await tarBuffer([
    { name: "flow/SKILL.md", data: Buffer.from(SKILL_MD("flow", "第一版。")) },
    { name: "flow/note.md", data: Buffer.from("v1 备注内容") },
  ]);
  const v2 = await tarBuffer([
    { name: "flow/SKILL.md", data: Buffer.from(SKILL_MD("flow", "第二版。")) },
    { name: "flow/note.md", data: Buffer.from("v2 备注内容") },
  ]);
  let serving = v1;
  const { extensions, pending, registry } = setup(t, { fetchImpl: async () => ({ ok: true, status: 200, url: "https://codeload.github.com/o/r/tar.gz/HEAD", body: Readable.from([serving]) }) });
  const install = async () => {
    const staged = await extensions.stageImport({ url: "https://github.com/o/flow" });
    return pending.confirm(pending.propose({ type: "ext-install", payload: { install: { source: staged.source, skills: staged.skills } }, summary: staged.summary }).id);
  };
  await install();
  serving = v2;
  const second = await install();
  assert.equal(second.applied.extensions[0].version, 2);
  assert.match(readFileSync(join(extensions.skillsDir, "flow", "note.md"), "utf8"), /v2/);

  extensions.rollback("flow", 1);
  assert.match(readFileSync(join(extensions.skillsDir, "flow", "note.md"), "utf8"), /v1/);
  assert.match(extensions.row("flow").description, /第一版/);

  extensions.setStatus("flow", "disabled");
  assert.equal(existsSync(join(extensions.skillsDir, "flow")), false);
  extensions.setStatus("flow", "active");
  assert.equal(registry.get("flow").id, "flow");

  // 过期的安装提案在确认时冲突,不会覆盖已变化的版本。
  const staged = await stageSkillImport({
    url: "https://github.com/o/flow",
    fetchImpl: fetchServing(v1),
    resolveProxy: noProxy,
    lookupExtension: () => null,
  });
  const stale = pending.propose({ type: "ext-install", payload: { install: { source: staged.source, skills: staged.skills } }, summary: staged.summary });
  assert.throws(() => pending.confirm(stale.id), (error) => error.code === "ACTION_CONFLICT");

  extensions.remove("flow");
  assert.throws(() => extensions.row("flow"), (error) => error.code === "NOT_FOUND");
  assert.equal(existsSync(join(extensions.skillsDir, "flow")), false);
});

test("skill_install_propose 工具下载并生成待确认提案", async (t) => {
  const { extensions, pending } = setup(t);
  const tool = extensionTools(() => extensions, pending).find((x) => x.definition.function.name === "skill_install_propose");
  assert.ok(tool);
  const archive = await tarBuffer([{ name: "t/SKILL.md", data: Buffer.from(SKILL_MD("t")) }]);
  const savedFetch = globalThis.fetch;
  globalThis.fetch = fetchServing(archive);
  t.after(() => { globalThis.fetch = savedFetch; });
  const result = await tool.execute({ url: "https://github.com/o/t", reason: "医生提供了链接" });
  assert.equal(result.type, "ext-install");
  assert.equal(result.preview.skills[0].id, "t");
  assert.match(result.note, /待确认/);
  // 确认前不落盘。
  assert.equal(existsSync(join(extensions.skillsDir, "t")), false);
  pending.confirm(result.id);
  assert.equal(existsSync(join(extensions.skillsDir, "t", "SKILL.md")), true);
});

test("HTTP 安装与删除路由端到端;公开形状不携带文件内容", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omw-import-http-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const archive = await tarBuffer([
    { name: "pack/SKILL.md", data: Buffer.from(SKILL_MD("pack")) },
    { name: "pack/ref.md", data: Buffer.from("参考资料") },
  ]);
  const f = await fixture(t, {
    userSkillsDir: join(dir, "my-skills"),
    skillImporter: (args) => stageSkillImport({ ...args, fetchImpl: fetchServing(archive) }),
    skillProxyResolver: noProxy,
  });
  const boot = (await f.json("/api/bootstrap")).data;
  assert.ok(boot.tools.includes("skill_install_propose"));

  const imported = await f.json("/api/extensions/import", "POST", { url: "https://github.com/o/pack" });
  assert.equal(imported.status, 201);
  assert.equal(imported.data.staged.preview.skills[0].id, "pack");
  const confirmed = await f.json(`/api/pending-actions/${imported.data.action.id}/confirm`, "POST", {});
  assert.equal(confirmed.status, 200);
  assert.equal(existsSync(join(dir, "my-skills", "pack", "SKILL.md")), true);

  const overview = (await f.json("/api/extensions")).data;
  const card = overview.extensions.find((e) => e.id === "pack");
  assert.equal(card.imported, true);
  assert.equal(card.origin.url, "https://github.com/o/pack");
  assert.deepEqual(card.files.map((x) => x.path), ["SKILL.md", "ref.md"]);
  assert.equal(card.files[0].content, undefined);

  const detail = (await f.json("/api/extensions/pack")).data;
  assert.equal(detail.versions[0].spec.files[0].content, undefined);

  const removed = await f.json("/api/extensions/pack", "DELETE");
  assert.equal(removed.status, 200);
  assert.equal(existsSync(join(dir, "my-skills", "pack")), false);
});

test("域提示词要求先核实再提案安装技能,而不是拒绝", () => {
  assert.match(GenericDomain.system, /skill_install_propose/);
  assert.match(GenericDomain.system, /不要因为技能来自外部仓库就直接拒绝安装请求/);
});

test("系统代理解析:环境变量优先,本机地址直连,Windows 注册表与 macOS scutil 均可读", async () => {
  assert.equal(await resolveProxyFor("https://codeload.github.com", { env: { HTTPS_PROXY: "http://127.0.0.1:10808" }, platform: "linux" }), "http://127.0.0.1:10808");
  assert.equal(await resolveProxyFor("https://127.0.0.1:8912/pack.tar.gz", { env: { HTTPS_PROXY: "http://127.0.0.1:10808" }, platform: "linux" }), null);
  const registry = (stdout) => async (_command, args, done) => {
    if (args.includes("ProxyEnable")) done(null, stdout.enable);
    else done(null, stdout.server);
  };
  const on = await resolveProxyFor("https://github.com/o/r", { env: {}, platform: "win32", run: registry({ enable: "\nProxyEnable    REG_DWORD    0x1\n", server: "\nProxyServer    REG_SZ    127.0.0.1:10808\n" }) });
  assert.equal(on, "http://127.0.0.1:10808");
  const off = await resolveProxyFor("https://github.com/o/r", { env: {}, platform: "win32", run: registry({ enable: "\nProxyEnable    REG_DWORD    0x0\n", server: "x" }) });
  assert.equal(off, null);
  const perScheme = await resolveProxyFor("https://github.com/o/r", { env: {}, platform: "win32", run: registry({ enable: "ProxyEnable    REG_DWORD    0x1", server: "ProxyServer    REG_SZ    https=127.0.0.1:10809;http=127.0.0.1:10808" }) });
  assert.equal(perScheme, "http://127.0.0.1:10809");
  const mac = await resolveProxyFor("https://github.com/o/r", { env: {}, platform: "darwin", run: (_command, _args, done) => done(null, "<dictionary> {\n  HTTPSEnable : 1\n  HTTPSProxy : 127.0.0.1\n  HTTPSPort : 10808\n}") });
  assert.equal(mac, "http://127.0.0.1:10808");
});
