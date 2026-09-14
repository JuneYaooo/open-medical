import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, createReadStream } from "node:fs";
import { mkdir, writeFile, cp, rm } from "node:fs/promises";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
const root = resolve(import.meta.dirname, ".."),
  out = join(root, "release/offline-tools");
await mkdir(out, { recursive: true });
const base =
  "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32";
const exportOnly = process.argv.includes("--export-only"),
  images = [];
for (const architecture of ["arm64", "amd64"]) {
  const image = `open-medical-runtime:0.5-${architecture}`;
  if (!exportOnly) {
    execFileSync(
      "docker",
      ["pull", "--platform", `linux/${architecture}`, base],
      { stdio: "inherit" },
    );
    const descriptor = JSON.parse(
      execFileSync(
        "docker",
        [
          "image",
          "inspect",
          "--platform",
          `linux/${architecture}`,
          base,
          "--format",
          "{{json .Descriptor}}",
        ],
        { encoding: "utf8" },
      ),
    );
    // Pin the architecture-specific manifest: older builders can ignore --platform on cached multiarch tags.
    const pinned = "node@" + descriptor.digest;
    execFileSync("docker", ["pull", pinned], { stdio: "inherit" });
    execFileSync(
      "docker",
      [
        "build",
        "--build-arg",
        "NODE_BASE=" + pinned,
        "--tag",
        image,
        join(root, "desktop/offline-runtime"),
      ],
      { stdio: "inherit" },
    );
  }
  const info = JSON.parse(
    execFileSync("docker", ["image", "inspect", image], { encoding: "utf8" }),
  )[0];
  if (info.Architecture !== architecture)
    throw new Error("Image architecture mismatch: " + image);
  const file = `runtime-${architecture}.tar.gz`,
    temp = join(out, file + ".partial");
  const child = spawn("docker", ["image", "save", image], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const ended = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error("docker save failed: " + code)),
    );
  });
  try {
    await Promise.all([
      pipeline(child.stdout, createGzip(), createWriteStream(temp)),
      ended,
    ]);
    await cp(temp, join(out, file));
  } finally {
    await rm(temp, { force: true });
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(join(out, file)))
    digest.update(chunk);
  const sha256 = digest.digest("hex");
  await writeFile(
    join(out, `runtime-${architecture}.sha256`),
    `${sha256}  ${file}\n`,
  );
  images.push({ architecture, file, sha256, image, imageId: info.Id });
}
for (const file of ["import-mac.command", "import-win.cmd", "import-win.ps1"])
  await cp(join(root, "desktop/offline-runtime", file), join(out, file));
await cp(
  join(root, "examples/plugins/local-tools"),
  join(out, "local-tools-plugin"),
  { recursive: true },
);
await writeFile(
  join(out, "manifest.json"),
  JSON.stringify(
    {
      version: "0.5.0",
      base,
      images,
      requiresPreinstalledDocker: true,
      includesLanguageModel: false,
    },
    null,
    2,
  ) + "\n",
);
console.log(out);
