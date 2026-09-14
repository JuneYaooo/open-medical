import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
if (process.platform !== "win32") {
  try {
    const require = createRequire(import.meta.url),
      root = dirname(require.resolve("node-pty/package.json"));
    for (const folder of [
      "build/Release",
      `prebuilds/${process.platform}-${process.arch}`,
    ]) {
      const file = join(root, folder, "spawn-helper");
      if (existsSync(file)) chmodSync(file, 0o755);
    }
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
  }
}
