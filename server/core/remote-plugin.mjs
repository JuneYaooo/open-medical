import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname, posix } from "node:path";
import { gunzipSync } from "node:zlib";
import tar from "tar-stream";
import { check } from "../errors.mjs";

export async function fetchPlugin(
  packages,
  owner,
  { url, sha256 },
  fetchImpl = fetch,
) {
  const source = new URL(url);
  check(
    source.protocol === "https:" && !source.username && !source.password,
    "PLUGIN_URL",
    "远程插件使用不含凭据的 HTTPS 地址",
  );
  check(
    /^[a-f0-9]{64}$/.test(sha256),
    "PLUGIN_HASH",
    "需要发布方提供的 SHA-256",
  );
  const response = await fetchImpl(source, {
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  check(response.ok && response.body, "PLUGIN_FETCH", "插件下载失败");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    check(size <= 20_000_000, "PLUGIN_LIMIT", "插件压缩包超过 20MB");
    chunks.push(chunk);
  }
  const compressed = Buffer.concat(chunks);
  check(
    createHash("sha256").update(compressed).digest("hex") === sha256,
    "PLUGIN_CHANGED",
    "下载内容与指定 SHA-256 不一致，未解包",
    409,
  );
  const archive =
    compressed[0] === 0x1f && compressed[1] === 0x8b
      ? gunzipSync(compressed, { maxOutputLength: 22_000_000 })
      : compressed;
  const files = new Map(),
    extract = tar.extract();
  let expanded = 0,
    entries = 0;
  await new Promise((resolve, reject) => {
    extract.on("error", reject);
    extract.on("finish", resolve);
    extract.on("entry", (header, stream, next) => {
      stream.on("error", reject);
      const name = header.name.replace(/^\.\//, "");
      if (
        ++entries > 1000 ||
        !["directory", "file"].includes(header.type) ||
        posix.isAbsolute(name) ||
        name.includes("\\") ||
        name.includes("\0") ||
        name.split("/").includes("..") ||
        header.size > 2_000_000
      ) {
        extract.destroy(new Error("插件包含链接、越界路径或过大文件"));
        return;
      }
      const chunks = [];
      stream.on("data", (chunk) => {
        expanded += chunk.length;
        if (expanded > 20_000_000)
          extract.destroy(new Error("插件解包超过 20MB"));
        else chunks.push(chunk);
      });
      stream.on("end", () => {
        if (header.type === "file") {
          if (files.has(name)) {
            extract.destroy(new Error("插件包含重复路径"));
            return;
          }
          files.set(name, Buffer.concat(chunks));
        }
        next();
      });
      stream.resume();
    });
    extract.end(archive);
  });
  let prefix = "";
  if (!files.has("plugin.json")) {
    const manifests = [...files.keys()].filter((p) =>
      /^[^/]+\/plugin\.json$/.test(p),
    );
    check(
      manifests.length === 1,
      "PLUGIN_MANIFEST",
      "压缩包需包含本项目 plugin.json 清单",
    );
    prefix = manifests[0].slice(0, -"plugin.json".length);
    check(
      [...files.keys()].every((p) => p.startsWith(prefix)),
      "PLUGIN_MANIFEST",
      "压缩包根目录存在额外文件",
    );
  }
  const directory = join(packages.directory, owner, ".downloads", randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    for (const [name, data] of files) {
      const path = join(directory, name.slice(prefix.length));
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, data, { flag: "wx", mode: 0o600 });
    }
    const { files: _files, ...inspection } = packages.inspect(directory);
    return {
      ...inspection,
      path: directory,
      source: source.href,
      downloadHash: sha256,
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
