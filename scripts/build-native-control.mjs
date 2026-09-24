import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
if (process.platform === "darwin") {
  mkdirSync("desktop/bin", { recursive: true });
  for (const name of ["native-control", "native-ocr", "native-media", "native-document"]) execFileSync(
    "swiftc",
    [...(name === "native-media" ? ["-parse-as-library"] : []), `desktop/${name}.swift`, "-o", `desktop/bin/${name}`],
    { stdio: "inherit" },
  );
}
