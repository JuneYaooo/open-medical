import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  WorkspaceDatabase,
  WorkspaceService,
  createProvider,
} from "../server/core/index.mjs";
import { WorkspaceFiles } from "../server/core/workspace-files.mjs";
import { check } from "../server/errors.mjs";
export async function executeRemoteJob(
  job,
  {
    directory,
    provider,
    signal,
    onService = () => {},
    image = "open-medical-runtime:0.8-full",
    terminal = true,
  },
) {
  const root = join(directory, "project");
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const file of job.files) {
    const target = resolve(root, file.path);
    // Containment via relative(): a plain startsWith(root + "/") breaks on
    // Windows where resolve() yields backslash-separated paths.
    const rel = relative(root, target);
    check(
      rel !== "" && !rel.startsWith("..") && !isAbsolute(rel),
      "REMOTE_PATH",
      "越界路径",
    );
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.text, { flag: "wx", mode: 0o600 });
  }
  const db = new WorkspaceDatabase(join(directory, "agent.sqlite"));
  const service = new WorkspaceService(db.db, provider);
  let workspace;
  const cancel = () => {
    if (workspace) service.interrupt(workspace.id);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    workspace = service.create({ root, directoryConsent: true });
    service.update(workspace.id, {
      revision: workspace.revision,
      profile: "code",
      allowWrite: true,
      approvalPolicy: "workspace-write",
      autoApplyConsent: true,
    });
    await service.extensions.operation(workspace.id, {
      action: "configure",
      revision: service.get(workspace.id).revision,
      consent: true,
      origins: [],
      terminal,
      image: terminal ? image : "",
      browser: false,
      plugins: false,
      mcp: false,
      memoryRead: false,
      memoryWrite: false,
      memory: { provider: "lsa" },
    });
    onService(service, workspace.id);
    signal?.throwIfAborted();
    const handle = service.prepare(workspace.id, {
      revision: service.get(workspace.id).revision,
      message: job.prompt,
      externalConsent: true,
      limits: { maxRounds: 48, timeoutMs: 600000, maxContextChars: 60000 },
    });
    const execution = await service.execute(handle, () => {});
    signal?.throwIfAborted();
    const state = service.get(workspace.id),
      files = new WorkspaceFiles(root);
    const outputs = files
      .snapshot()
      .paths.map((path) => ({ path, text: files.read(path).text }));
    const artifacts = (state.artifacts || []).map((item) => ({
      name: item.name,
      data: service.artifacts
        .read(workspace.id, item.id)
        .data.toString("base64"),
    }));
    return {
      status: execution.status,
      messages: state.messages,
      files: outputs,
      artifacts,
    };
  } finally {
    signal?.removeEventListener("abort", cancel);
    await service.extensions.close();
    db.close();
  }
}
export async function runWorker({
  url,
  token,
  directory,
  provider,
  signal,
  once = false,
  terminal = true,
}) {
  const endpoint = new URL(url);
  check(
    endpoint.protocol === "https:" ||
      (endpoint.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(endpoint.hostname)),
    "REMOTE_URL",
    "远程地址必须使用 HTTPS",
  );
  const call = async (path, input) => {
    const res = await fetch(new URL(path, endpoint), {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Coordinator HTTP ${res.status}`);
    return res.json();
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const worker = randomUUID();
  while (!signal?.aborted) {
    const { job } = await call("worker/claim", { worker });
    if (!job) {
      if (once) return;
      await new Promise((resolve) => {
        const timer = setTimeout(done, 3000);
        function done() {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
      });
      continue;
    }
    const controller = new AbortController(),
      abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const heartbeat = setInterval(
      () =>
        call("worker/heartbeat", { id: job.id, lease: job.lease }).catch(() =>
          controller.abort(),
        ),
      15000,
    );
    const jobDirectory = join(directory, job.id + "-" + job.attempt);
    await mkdir(jobDirectory, { recursive: true, mode: 0o700 });
    try {
      const result = await executeRemoteJob(job, {
        terminal,
        directory: jobDirectory,
        provider,
        signal: controller.signal,
      });
      // Keep a durable result before acknowledging; losing an ACK must not repeat model execution.
      await writeFile(
        join(jobDirectory, "result.json"),
        JSON.stringify(result),
        { mode: 0o600 },
      );
      await call("worker/complete", { id: job.id, lease: job.lease, result });
    } catch (e) {
      if (!controller.signal.aborted)
        await call("worker/complete", {
          id: job.id,
          lease: job.lease,
          result: { status: "failed", error: e.message },
        }).catch(() => {});
    } finally {
      clearInterval(heartbeat);
      signal?.removeEventListener("abort", abort);
    }
    // Completed scratch projects are retained for diagnosis, with bounded retention.
    const { readdir, stat } = await import("node:fs/promises");
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      if ((await stat(path)).mtimeMs < Date.now() - 7 * 86400000)
        await rm(path, { recursive: true, force: true });
    }
    if (once) return;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const controller = new AbortController();
  for (const s of ["SIGINT", "SIGTERM"])
    process.once(s, () => controller.abort());
  const provider = createProvider();
  // Optional explicit JSON configuration is read only on this worker host.
  const selected = process.env.REMOTE_MODEL_CONFIG
    ? createProvider(
        JSON.parse(await readFile(process.env.REMOTE_MODEL_CONFIG, "utf8")),
      )
    : provider;
  await runWorker({
    terminal: process.env.REMOTE_TERMINAL !== "0",
    url: process.env.REMOTE_URL,
    token: process.env.REMOTE_WORKER_TOKEN,
    directory: resolve(
      process.env.REMOTE_WORK_DIR || "server/data/remote-worker",
    ),
    provider: selected,
    signal: controller.signal,
  });
}
