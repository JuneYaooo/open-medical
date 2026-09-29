import {
  readdirSync,
  readFileSync,
  statSync,
  realpathSync,
  lstatSync,
} from "node:fs";
import { resolve, relative, sep, dirname, join } from "node:path";
import { check, string } from "../errors.mjs";
import yaml from "js-yaml";
import { WorkspaceFiles, hashText } from "./workspace-files.mjs";

const FRONT = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n([\s\S]*)$/;
function containedFile(root, file) {
  const canonicalRoot = realpathSync(root),
    canonicalFile = realpathSync(file);
  const rel = relative(canonicalRoot, canonicalFile);
  check(
    rel &&
      rel !== ".." &&
      !rel.startsWith(".." + sep) &&
      !lstatSync(file).isSymbolicLink(),
    "SKILL_PATH",
    "技能必须位于授权目录内",
  );
  check(statSync(file).size <= 100000, "SKILL_LIMIT", "技能说明超过 100KB");
  return file;
}
function parse(file, id) {
  const raw = readFileSync(file, "utf8");
  check(raw.length <= 100000, "SKILL_LIMIT", "技能说明超过 100KB");
  const match = raw.match(FRONT);
  check(match, "SKILL_FORMAT", `技能 ${id} 缺少有效 frontmatter`);
  const meta = yaml.load(match[1], { schema: yaml.FAILSAFE_SCHEMA, maxDepth: 10, maxTotalMergeKeys: 100 });
  check(
    meta && !Array.isArray(meta) && meta.name === id && typeof meta.description === "string" &&
      meta.description.trim() && meta.description.length <= 4000,
    "SKILL_FORMAT",
    `技能 ${id} 需要 name 和 description`,
  );
  return {
    id,
    name: meta.name,
    title: typeof meta.title === "string" ? meta.title : meta.name,
    description: meta.description,
    body: match[2],
    path: file,
    hash: hashText(raw),
  };
}
export class SkillRegistry {
  constructor(roots = []) {
    this.roots = roots.filter(Boolean).map((root) => resolve(root));
  }
  list() {
    const result = [];
    const seen = new Set();
    for (const root of this.roots) {
      let dirs = [];
      try {
        dirs = readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of dirs) {
        if (
          !entry.isDirectory() ||
          seen.has(entry.name) ||
          !/^[-a-z0-9_]+$/.test(entry.name)
        )
          continue;
        const file = resolve(root, entry.name, "SKILL.md");
        try {
          if (!statSync(file).isFile()) continue;
          const skill = parse(containedFile(root, file), entry.name);
          seen.add(entry.name);
          result.push({
            id: skill.id,
            name: skill.name,
            title: skill.title,
            description: skill.description,
          });
        } catch {
          /* invalid skills are not advertised */
        }
      }
    }
    return result.sort((a, b) => a.id.localeCompare(b.id));
  }
  get(id) {
    string(id, "技能名称", 80);
    check(/^[-a-z0-9_]+$/.test(id), "INVALID_INPUT", "技能名称无效");
    for (const root of this.roots) {
      const file = resolve(root, id, "SKILL.md");
      const rel = relative(root, file);
      if (rel.startsWith(".." + sep) || rel.includes(sep + ".." + sep))
        continue;
      try {
        if (statSync(file).isFile())
          return parse(containedFile(root, file), id);
      } catch {}
    }
    check(false, "SKILL_NOT_FOUND", "技能不存在", 404);
  }
  resources(id) {
    const skill = this.get(id), files = new WorkspaceFiles(dirname(skill.path));
    const pending = [{ path: ".", depth: 0 }], result = [];
    let truncated = false;
    while (pending.length && result.length < 200) {
      const item = pending.pop();
      for (const entry of files.list(item.path)) {
        const path = join(item.path, entry.name);
        if (entry.directory) {
          if (item.depth < 5) pending.push({ path, depth: item.depth + 1 });
          else truncated = true;
        } else if (result.length < 200) {
          result.push({ path, bytes: statSync(files.path(path)).size });
        } else truncated = true;
      }
    }
    return { skillId: id, hash: skill.hash, files: result, truncated: truncated || pending.length > 0 };
  }
  readResource(id, path, range = {}) {
    const skill = this.get(id), files = new WorkspaceFiles(dirname(skill.path));
    return { skillId: id, skillHash: skill.hash, ...files.read(path, range) };
  }
}
