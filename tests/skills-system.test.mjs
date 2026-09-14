import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRegistry } from "../server/core/skills.mjs";

test("Skills parse standard YAML and progressively read bounded resources without expanding scope", (t) => {
  const root = mkdtempSync(join(tmpdir(), "omw-skills-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "research"); mkdirSync(join(directory, "references"), { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), '---\r\nname: "research"\r\ndescription: >-\r\n  Read sources\r\n  and verify facts.\r\n---\r\nUse references/guide.md.\r\n');
  writeFileSync(join(directory, "references/guide.md"), "first\nsecond\nthird");
  writeFileSync(join(directory, ".env"), "SECRET");
  writeFileSync(join(root, "outside.txt"), "PRIVATE");
  const registry = new SkillRegistry([root]);
  assert.equal(registry.list()[0].description, "Read sources and verify facts.");
  const resources = registry.resources("research");
  assert.equal(resources.files.length, 2);
  assert.equal(resources.files.some((f) => f.path.includes(".env")), false);
  const result = registry.readResource("research", "references/guide.md", { startLine: 2, endLine: 2 });
  assert.equal(result.text, "second");
  assert.match(result.skillHash, /^[a-f0-9]{64}$/);
  assert.throws(() => registry.readResource("research", "../outside.txt"));
  assert.throws(() => registry.readResource("research", ".env"));
  if (process.platform !== "win32") {
    symlinkSync(join(root, "outside.txt"), join(directory, "references/link.md"));
    assert.throws(() => registry.readResource("research", "references/link.md"));
  }
  writeFileSync(join(directory, "SKILL.md"), '---\nname: research\ndescription: !!js/function "function(){}"\n---\nbad');
  assert.deepEqual(registry.list(), []);
});
