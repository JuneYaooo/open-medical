import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "medical-desktop-test-"));
const targetPlatform = process.env.TARGET_PLATFORM || process.platform;
const targetArch = process.env.TARGET_ARCH || process.arch;
const binary =
  targetPlatform === "darwin"
    ? join(
        root,
        `release/Open Medical-darwin-${targetArch}/Open Medical.app/Contents/MacOS/Open Medical`,
      )
    : join(
        root,
        `release/Open Medical-${targetPlatform}-${targetArch}/Open Medical.exe`,
      );
try {
  await new Promise((resolve, reject) => {
    const child = spawn(binary, ["--smoke-test"], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "",
        MEDICAL_DESKTOP_TEST_DIR: directory,
      },
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 90000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`Desktop exited with ${code}`));
    });
  });
  const report = JSON.parse(
    await readFile(join(directory, "desktop-report.json"), "utf8"),
  );
  await mkdir(join(root, "output/desktop-build/verification"), {
    recursive: true,
  });
  await cp(
    join(directory, "desktop-report.json"),
    join(root, "output/desktop-build/verification/report.json"),
  );
  if (!report.passed) throw new Error(report.error);
  await cp(
    join(directory, "desktop.png"),
    join(root, "output/desktop-build/verification/desktop.png"),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
