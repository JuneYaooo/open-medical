import { mkdir, mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, relative } from "node:path";
import { WorkspaceFiles } from "./workspace-files.mjs";
import { check } from "../errors.mjs";

export async function sourceSnapshot(root, paths = [], { maxFiles = 100 } = {}) {
  check(
    Array.isArray(paths) &&
      paths.length <= maxFiles &&
      paths.every((p) => typeof p === "string"),
    "MCP_SOURCES",
    `最多选择 ${maxFiles} 个文本文件`,
  );
  const staging = join(homedir(), ".open-medical-workbench", "sandbox-staging");
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(staging, "mcp-sources-"));
  await chmod(directory, 0o755);
  const files = new WorkspaceFiles(root),
    manifest = [];
  try {
    let bytes = 0;
    for (const path of paths) {
      const file = files.read(path),
        name = relative(files.root, files.path(path));
      bytes += Buffer.byteLength(file.text);
      check(bytes <= 10_000_000, "MCP_SOURCES", "文件快照超过 10MB");
      const dest = join(directory, name);
      await mkdir(dirname(dest), { recursive: true, mode: 0o755 });
      await writeFile(dest, file.text, { mode: 0o644 });
      manifest.push({ path: name, hash: file.hash });
    }
    return { directory, manifest, createdAt: Date.now() };
  } catch (e) {
    await rm(directory, { recursive: true, force: true });
    throw e;
  }
}
