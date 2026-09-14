import { normalizePlugin } from "./plugin-compatibility.mjs";
import {
  mkdirSync,
  readdirSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  rmSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { check } from "../errors.mjs";

export const identifier = (value) =>
  typeof value === "string" && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
export class PluginPackages {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  inspect(source) {
    check(
      typeof source === "string" && isAbsolute(source),
      "PLUGIN_PATH",
      "插件安装源必须是本地文件夹绝对路径",
    );
    const root = realpathSync(source),
      files = new Map();
    let bytes = 0;
    const walk = (dir, depth = 0) => {
      check(depth <= 10, "PLUGIN_LIMIT", "插件目录层级过深");
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort(
        (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      )) {
        check(
          ![".git", "node_modules"].includes(entry.name.toLowerCase()) &&
            !/^\.env(?:\.|$)/i.test(entry.name),
          "PLUGIN_CONTENT",
          "插件不得包含凭证、仓库历史或 node_modules；依赖请预置在隔离镜像中",
        );
        check(
          !/[\\<>:"|?*]/.test(entry.name) &&
            !/[ .]$/.test(entry.name) &&
            !/^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(entry.name),
          "PLUGIN_PATH",
          "插件包含跨平台不兼容的文件名",
        );
        const path = join(dir, entry.name),
          st = lstatSync(path);
        check(!st.isSymbolicLink(), "PLUGIN_SYMLINK", "插件不能包含符号链接");
        if (st.isDirectory()) walk(path, depth + 1);
        else {
          check(
            st.isFile() && st.nlink === 1 && st.size <= 2_000_000,
            "PLUGIN_CONTENT",
            "插件文件过大或不是普通文件",
          );
          bytes += st.size;
          check(
            bytes <= 20_000_000 && files.size < 1000,
            "PLUGIN_LIMIT",
            "插件不得超过 20MB / 1000 个文件",
          );
          files.set(
            relative(root, path).replaceAll("\\", "/"),
            readFileSync(path),
          );
        }
      }
    };
    walk(root);
    const compatibility = normalizePlugin(files);
    check(files.has("plugin.json"), "PLUGIN_MANIFEST", "缺少 plugin.json");
    check(
      files.get("plugin.json").length <= 64000,
      "PLUGIN_MANIFEST",
      "清单过大",
    );
    let manifest;
    try {
      manifest = JSON.parse(files.get("plugin.json"));
    } catch {
      check(false, "PLUGIN_MANIFEST", "plugin.json 格式错误");
    }
    check(
      manifest.manifestVersion === 1 &&
        identifier(manifest.id) &&
        typeof manifest.name === "string" &&
        manifest.name.length <= 100 &&
        /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version),
      "PLUGIN_MANIFEST",
      "需要 manifestVersion:1、有效 id、name 和语义版本号",
    );
    check(
      Object.keys(manifest).every((k) =>
        [
          "manifestVersion",
          "id",
          "name",
          "version",
          "description",
          "skills",
          "commands",
          "mcpServers",
          "hooks",
        ].includes(k),
      ),
      "PLUGIN_MANIFEST",
      "清单含不支持的字段；插件不能注册任意宿主机代码或启动钩子",
    );
    for (const key of ["skills", "commands", "mcpServers", "hooks"]) {
      manifest[key] ||= [];
      check(
        Array.isArray(manifest[key]) && manifest[key].length <= 20,
        "PLUGIN_MANIFEST",
        `${key} 最多 20 项`,
      );
    }
    for (const skill of manifest.skills)
      check(
        identifier(skill.id) &&
          typeof skill.path === "string" &&
          files.has(skill.path) &&
          skill.path.endsWith(".md"),
        "PLUGIN_SKILL",
        "技能必须引用包内 Markdown 文件",
      );
    for (const command of manifest.commands)
      check(
        identifier(command.id) &&
          typeof command.command === "string" &&
          command.command.length <= 12000 &&
          typeof command.description === "string",
        "PLUGIN_COMMAND",
        "命令定义无效",
      );
    for (const hook of manifest.hooks)
      check(
        identifier(hook.id) &&
          ["run_start", "tool_start", "tool_end", "run_end"].includes(
            hook.event,
          ) &&
          typeof hook.command === "string" &&
          hook.command.length > 0 &&
          hook.command.length <= 12000,
        "PLUGIN_HOOK",
        "Hook 需要有效 id、事件和容器命令",
      );
    for (const server of manifest.mcpServers)
      check(
        identifier(server.id) &&
          server.transport === "stdio" &&
          Array.isArray(server.command) &&
          server.command.length > 0 &&
          server.command.length <= 30 &&
          server.command.every(
            (s) => typeof s === "string" && s.length <= 2000,
          ),
        "PLUGIN_MCP",
        "包内 MCP 必须使用隔离 stdio 命令",
      );
    for (const key of ["skills", "commands", "mcpServers", "hooks"])
      check(
        new Set(manifest[key].map((x) => x.id)).size === manifest[key].length,
        "PLUGIN_MANIFEST",
        `${key} 有重复 id`,
      );
    const hash = createHash("sha256");
    for (const [path, data] of [...files].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0))
      hash.update(path).update("\0").update(data).update("\0");
    return { manifest, hash: hash.digest("hex"), bytes, files, compatibility };
  }
  install(owner, source, expectedHash) {
    const pack = this.inspect(source);
    check(
      pack.hash === expectedHash,
      "PLUGIN_CHANGED",
      "插件内容与预览不一致，请重新检查",
      409,
    );
    const parent = join(this.directory, owner);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const target = join(parent, pack.hash),
      staging = join(parent, ".staging-" + randomUUID());
    mkdirSync(staging, { mode: 0o700 });
    try {
      for (const [path, data] of pack.files) {
        const dest = resolve(staging, path);
        mkdirSync(dirname(dest), { recursive: true, mode: 0o755 });
        writeFileSync(dest, data, { mode: 0o644, flag: "wx" });
      }
      // Parent is private to this process/user; installed package contents are immutable by tools.
      chmodSync(staging, 0o755);
      try {
        renameSync(staging, target);
      } catch (e) {
        if (!["EEXIST", "ENOTEMPTY"].includes(e.code)) throw e;
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    return {
      id: pack.manifest.id,
      manifest: pack.manifest,
      hash: pack.hash,
      installedAt: Date.now(),
      enabled: false,
      allowedCommands: [],
      allowedSkills: [],
      allowedHooks: [],
    };
  }
  path(owner, plugin) {
    check(/^[a-f0-9]{64}$/.test(plugin.hash), "PLUGIN_HASH", "插件摘要无效");
    return join(this.directory, owner, plugin.hash);
  }
  verify(owner, plugin) {
    const inspection = this.inspect(this.path(owner, plugin));
    check(
      inspection.hash === plugin.hash,
      "PLUGIN_TAMPERED",
      "安装的插件已被修改，请重新安装",
      409,
    );
    return inspection;
  }
  remove(owner, plugin) {
    rmSync(this.path(owner, plugin), { recursive: true, force: true });
  }
  skill(owner, plugin, id) {
    check(
      plugin.enabled && plugin.allowedSkills.includes(id),
      "PLUGIN_DENIED",
      "插件技能未授权",
      403,
    );
    const pack = this.verify(owner, plugin),
      skill = plugin.manifest.skills.find((s) => s.id === id);
    check(skill, "PLUGIN_SKILL", "技能不存在", 404);
    return { ...skill, body: pack.files.get(skill.path).toString("utf8") };
  }
}
