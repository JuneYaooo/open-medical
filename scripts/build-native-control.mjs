import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
if (process.platform === "darwin") {
  mkdirSync("desktop/bin", { recursive: true });
  execFileSync(
    "swiftc",
    ["desktop/native-control.swift", "-o", "desktop/bin/native-control"],
    { stdio: "inherit" },
  );
}
