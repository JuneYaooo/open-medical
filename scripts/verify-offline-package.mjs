import { access, readdir, lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function verifyOfflinePackage(dir, platform = process.platform) {
  const packageRoot =
    platform === "darwin"
      ? join(dir, "Open Medical.app/Contents/Resources/app")
      : join(dir, "resources/app");
  const binary =
    platform === "darwin"
      ? "Open Medical.app/Contents/MacOS/Open Medical"
      : "Open Medical.exe";
  await access(join(dir, binary));
  for (const file of [
    "dist/index.html",
    "desktop/main.cjs",
    "server/agent.mjs",
    "server/core/agent-runtime.mjs",
    "node_modules/ws/index.js",
  ])
    await access(join(packageRoot, file));
  let files = 0;
  async function scan(directory) {
    for (const item of await readdir(directory)) {
      if (
        item === ".env" ||
        /\.(sqlite|db)(-wal|-shm)?$/i.test(item) ||
        [".cache", ".git", "model.env"].includes(item)
      )
        throw new Error(`Package contains local state or secrets: ${item}`);
      const path = join(directory, item),
        stat = await lstat(path);
      if (stat.isSymbolicLink())
        throw new Error(
          "Application resources contain an unexpected symbolic link",
        );
      if (stat.isDirectory()) await scan(path);
      else files++;
    }
  }
  await scan(packageRoot);
  const pkg = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  return {
    passed: true,
    platform,
    package: dir,
    version: pkg.version,
    checkedResourceFiles: files,
    scope: "runtime assets and recursive local-state exclusion",
    disconnectedInstallationTested: false,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = resolve(import.meta.dirname, "..");
  const platform = process.env.TARGET_PLATFORM || process.platform;
  const arch = process.env.TARGET_ARCH || process.arch;
  console.log(
    JSON.stringify(
      await verifyOfflinePackage(
        join(root, `release/Open Medical-${platform}-${arch}`),
        platform,
      ),
      null,
      2,
    ),
  );
}
