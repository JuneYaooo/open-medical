import {execFileSync} from "node:child_process";
import { cp, mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync, constants } from "node:fs";
import { dirname, join, relative } from "node:path";

export const runtimeDependencies = [
  "ws",
  "wecom",
  "@wecom/crypto",
  "fast-xml-parser",
  "exceljs",
  "mammoth",
  "jszip",
  "js-yaml",
  "node-pty",
  "@modelcontextprotocol/sdk",
  "zod",
  "ajv",
  "ajv-formats",
  "playwright-core",
  "ml-matrix",
  "tar-stream",
  "cron-parser",
  "@lancedb/lancedb",
  "apache-arrow",
];
export async function bundleRuntimeDependencies(root, target) {
  const copied = new Set();
  const locate = (name, from) => {
    let cursor = from;
    while (true) {
      const candidate = join(cursor, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) return candidate;
      if (cursor === root || dirname(cursor) === cursor)
        throw new Error(`Missing runtime dependency: ${name}`);
      cursor = dirname(cursor);
    }
  };
  const copy = async (name, from = root) => {
    const source = locate(name, from);
    if (copied.has(source)) return;
    copied.add(source);
    const destination = join(target, relative(root, source));
    await mkdir(dirname(destination), { recursive: true });
    if (process.platform === "darwin") {
      // Node's COPYFILE_FICLONE may fall back to full copies on macOS. cp -c
      // uses clonefile directly and preserves symlinks like fs.cp's default.
      await mkdir(destination, {recursive:true});
      for (const entry of await readdir(source)) if (entry !== "node_modules")
        execFileSync("/bin/cp",["-cR",join(source,entry),join(destination,entry)]);
    } else await cp(source, destination, {
      recursive: true,
      // Copy-on-write on supporting filesystems; normal-copy fallback elsewhere.
      mode: constants.COPYFILE_FICLONE,
      filter: (path) => path !== join(source, "node_modules"),
    });
    const pkg = JSON.parse(
      await readFile(join(source, "package.json"), "utf8"),
    );
    for (const dependency of Object.keys(pkg.dependencies || {}))
      await copy(dependency, source);
    // Present optional dependencies are included; platform-inapplicable native packages are not fetched.
    for (const dependency of Object.keys(pkg.optionalDependencies || {})) {
      let present = false;
      try {
        locate(dependency, source);
        present = true;
      } catch {}
      if (present) await copy(dependency, source);
    }
  };
  for (const name of runtimeDependencies) await copy(name);
  return [...copied].map((path) => relative(root, path));
}
