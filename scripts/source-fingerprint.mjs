import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";

export function sourceFingerprint(root = resolve(import.meta.dirname, "..")) {
  const paths = [];
  const visit = (path) => {
    if (statSync(path).isDirectory()) for (const name of readdirSync(path).sort()) { if (!["__pycache__", "bin"].includes(name)) visit(join(path, name)); }
    else paths.push(path);
  };
  for (const name of ["server/core", "server/platform.mjs", "server/domains", "shared", "src", "scripts", "desktop", "package.json", "package-lock.json"])
    visit(join(root, name));
  const hash = createHash("sha256");
  for (const path of paths.sort()) hash.update(relative(root, path)).update("\0").update(readFileSync(path)).update("\0");
  return hash.digest("hex");
}
