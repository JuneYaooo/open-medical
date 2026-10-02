import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleRuntimeDependencies } from "../scripts/runtime-dependencies.mjs";

test("desktop dependency refresh removes stale packages and keeps nested versions and available native dependencies", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "medical-bundle-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "source"),
    target = join(dir, "staged");
  const pkg = async (base, name, metadata) => {
    const path = join(base, "node_modules", name);
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, "package.json"),
      JSON.stringify({ name, ...metadata }),
    );
    return path;
  };
  const parent = await pkg(root, "parent", {
    version: "2.0.0",
    dependencies: { leaf: "2.0.0" },
    optionalDependencies: { native: "1.0.0", unavailable: "1.0.0" },
  });
  await pkg(parent, "leaf", { version: "2.0.0" });
  await pkg(root, "leaf", { version: "1.0.0" });
  await pkg(root, "native", { version: "1.0.0" });
  await pkg(target, "obsolete", { version: "0.1.0" });
  await pkg(join(target, "node_modules/parent"), "leaf", { version: "0.1.0" });
  await bundleRuntimeDependencies(root, target, {
    dependencies: ["parent"],
    clean: true,
  });
  await assert.rejects(access(join(target, "node_modules/obsolete")), {
    code: "ENOENT",
  });
  await assert.rejects(access(join(target, "node_modules/leaf")), {
    code: "ENOENT",
  });
  const nested = JSON.parse(
    await readFile(
      join(target, "node_modules/parent/node_modules/leaf/package.json"),
    ),
  );
  assert.equal(nested.version, "2.0.0");
  await access(join(target, "node_modules/native/package.json"));
  await assert.rejects(bundleRuntimeDependencies(root, root, { clean: true }));
  await access(join(parent, "package.json"));
});
