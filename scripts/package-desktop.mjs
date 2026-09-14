import {
  bundleRuntimeDependencies,
  runtimeDependencies,
} from "./runtime-dependencies.mjs";
import { packager } from "@electron/packager";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const arg = (name) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=")[1];
const targetPlatform =
  arg("platform") || process.env.TARGET_PLATFORM || process.platform;
const targetArch = arg("arch") || process.env.TARGET_ARCH || process.arch;
const stage = await mkdtemp(join(tmpdir(), "open-medical-package-"));
try {
  // Icons are deterministic; regenerate rather than trusting a stale build/.
  execFileSync(process.execPath, [join(root, "scripts/build-icons.mjs")], {
    stdio: "inherit",
  });
  // Explicit allowlist: never copy patient databases, .env, screenshots or tests.
  for (const entry of ["dist", "desktop", "shared", "skills", "examples", "build/icons"])
    await cp(join(root, entry), join(stage, entry), { recursive: true });
  await cp(join(root, "server"), join(stage, "server"), {
    recursive: true,
    filter: (source) => !source.startsWith(join(root, "server/data")),
  });
  await cp(join(root, ".env.example"), join(stage, ".env.example"));
  await mkdir(join(stage, "scripts"));
  await cp(
    join(root, "scripts/workspace-cli.mjs"),
    join(stage, "scripts/workspace-cli.mjs"),
  );
  for (const script of ["agent-daemon.mjs", "daemon-supervisor.mjs"]) await cp(join(root,"scripts",script),join(stage,"scripts",script));
  await mkdir(join(stage, "node_modules"), { recursive: true });
  await bundleRuntimeDependencies(root, stage);
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const electron = JSON.parse(
    await readFile(join(root, "node_modules/electron/package.json"), "utf8"),
  );
  await writeFile(
    join(stage, "package.json"),
    JSON.stringify(
      {
        name: "open-medical-desktop",
        productName: "Open Medical Workbench",
        version: pkg.version,
        description: "本地单用户医疗资料工作台",
        main: "desktop/main.cjs",
        type: "module",
        dependencies: Object.fromEntries(
          runtimeDependencies.map((name) => [name, pkg.dependencies[name] || pkg.optionalDependencies?.[name]]),
        ),
      },
      null,
      2,
    ),
  );
  const zipDirectory = join(root, "output/desktop-build");
  const cachedApp = join(root, "node_modules/electron/dist/Electron.app");
  let apps;
  if (
    targetPlatform === "darwin" &&
    process.platform === "darwin" &&
    targetArch === process.arch &&
    existsSync(cachedApp)
  ) {
    // APFS copy-on-write avoids extracting another 300MB runtime on low-disk Macs.
    const output = join(root, `release/Open Medical-darwin-${targetArch}`);
    const bundle = join(output, "Open Medical.app");
    await mkdir(output, { recursive: true });
    await rm(bundle, { recursive: true, force: true });
    execFileSync("/bin/cp", ["-cR", cachedApp, bundle]);
    await cp(stage, join(bundle, "Contents/Resources/app"), {
      recursive: true,
    });
    await rm(join(bundle, "Contents/Resources/default_app.asar"), {
      force: true,
    });
    execFileSync("/bin/mv", [
      join(bundle, "Contents/MacOS/Electron"),
      join(bundle, "Contents/MacOS/Open Medical"),
    ]);
    const plist = join(bundle, "Contents/Info.plist");
    for (const [key, value] of Object.entries({
      CFBundleDisplayName: "Open Medical Workbench",
      CFBundleName: "Open Medical",
      CFBundleExecutable: "Open Medical",
      CFBundleIdentifier: "local.openmedical.workbench",
      CFBundleIconFile: "app-icon.icns",
      CFBundleShortVersionString: pkg.version,
      CFBundleVersion: pkg.version,
    }))
      execFileSync("/usr/bin/plutil", [
        "-replace",
        key,
        "-string",
        value,
        plist,
      ]);
    await cp(
      join(stage, "build/icons/icon.icns"),
      join(bundle, "Contents/Resources/app-icon.icns"),
    );
    // Local ad-hoc signing, no developer credentials or notarization required.
    execFileSync(
      "/usr/bin/codesign",
      [
        "--force",
        "--deep",
        "--sign",
        "-",
        "--preserve-metadata=entitlements,flags,runtime",
        bundle,
      ],
      { stdio: "pipe" },
    );
    apps = [output];
  } else
    apps = await packager({
      dir: stage,
      out: join(root, "release"),
      name: "Open Medical",
      appBundleId: "local.openmedical.workbench",
      platform: targetPlatform,
      arch: targetArch,
      electronVersion: electron.version,
      icon: join(stage, "build/icons/icon"),
      ...(existsSync(
        join(
          zipDirectory,
          `electron-v${electron.version}-${targetPlatform}-${targetArch}.zip`,
        ),
      )
        ? { electronZipDir: zipDirectory }
        : {}),
      overwrite: true,
      asar: false,
      prune: false,
      appCategoryType: "public.app-category.productivity",
    });
  // The packaged directory is the offline install unit: it contains Electron,
  // Node, the UI, runtime, skills and an empty data directory is created on first launch.
  if (targetPlatform === "win32") {
    await cp(
      join(stage, "desktop", "install-win.cmd"),
      join(
        root,
        "release",
        `Open Medical-win32-${targetArch}`,
        "install-open-medical.cmd",
      ),
    );
  }
  console.log(apps.join("\n"));
} finally {
  await rm(stage, { recursive: true, force: true });
}
