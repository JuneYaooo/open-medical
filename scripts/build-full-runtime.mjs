import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const image = process.argv[2] || "open-medical-runtime:0.8-full";
if (!/^[a-z0-9][a-z0-9._/-]*:[a-zA-Z0-9._-]+$/.test(image))
  throw new Error("Invalid image tag");
const mirror = process.env.AGENT_DEBIAN_MIRROR;
const pythonIndex = process.env.AGENT_PYPI_INDEX_URL;
if (pythonIndex) {
  const url = new URL(pythonIndex);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("AGENT_PYPI_INDEX_URL must be HTTPS without credentials, query or fragment");
}
if (mirror) {
  const url = new URL(mirror);
  if (url.protocol !== "https:" || url.origin !== mirror || url.username || url.password)
    throw new Error("AGENT_DEBIAN_MIRROR must be an HTTPS origin without credentials");
}
execFileSync(
  "docker",
  [
    "build",
    ...(mirror ? ["--build-arg", `DEBIAN_MIRROR=${mirror}`] : []),
    ...(pythonIndex ? ["--build-arg", `PYPI_INDEX_URL=${pythonIndex}`] : []),
    "-t",
    image,
    resolve(import.meta.dirname, "../desktop/full-runtime"),
  ],
  { stdio: "inherit" },
);
console.log(`Runtime ready: ${image}`);
