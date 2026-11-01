import { createServer } from "../../server/agent.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RETRYABLE_TEMP_ERRORS = new Set(["ENOENT", "EROFS", "EACCES", "EPERM"]);

// TMPDIR is occasionally read-only in restricted runners. Prefer it when it
// works, then fall back to the platform temp directory, and finally /tmp.
function createTempRoot() {
  const attempts = [];
  for (const base of [process.env.MEDICAL_TEST_TMP, tmpdir(), "/tmp"]) {
    if (!base) continue;
    try {
      return mkdtempSync(join(base, "omw-baseline-"));
    } catch (error) {
      attempts.push(`${base}: ${error.code || error.message}`);
      if (!RETRYABLE_TEMP_ERRORS.has(error.code)) throw error;
    }
  }
  throw new Error(`无法创建测试临时目录：${attempts.join("；")}`);
}

export async function waitFor(
  predicate,
  { timeoutMs = 15000, intervalMs = 100, description = "条件成立" } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `等待超时（${timeoutMs}ms）：${description}` +
          (lastError ? `；最后一次错误：${lastError.message}` : ""),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function startTestServer({
  provider,
  seedDemoPack = true,
  serverOptions = {},
} = {}) {
  if (!provider) throw new Error("startTestServer 需要注入 provider");
  const tempRoot = createTempRoot();
  const databasePath = join(tempRoot, "medical.sqlite");
  // LanceDB (the vector store used by the knowledge base) creates spill files
  // through the OS temp directory. Point it at the test temp root so restricted
  // runners with a read-only TMPDIR do not emit native panics.
  const previousTmpDir = process.env.TMPDIR;
  const restoreTmpDir = () => {
    if (previousTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpDir;
  };
  process.env.TMPDIR = tempRoot;
  let server;
  try {
    server = createServer({
      database: databasePath,
      provider,
      // 测试不访问内置脱敏服务；需要时由用例注入自己的假 worker。
      privacyBuiltinService: null,
      ...serverOptions,
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    await server?.shutdown().catch(() => {});
    restoreTmpDir();
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }

  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  const token = server.token;
  let closed = false;

  async function request(
    path,
    { method = "GET", body, headers = {}, auth = true } = {},
  ) {
    const init = {
      method,
      headers: {
        ...(auth ? { "x-medical-token": token } : {}),
        ...headers,
      },
    };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    const response = await fetch(new URL(path, url), init);
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      body: parsed,
      text,
    };
  }

  async function loadDemoPack() {
    const response = await request("/api/demo-pack", { method: "POST" });
    if (response.status !== 201) {
      throw new Error(
        `加载示例资料失败：HTTP ${response.status} ${response.text}`,
      );
    }
    return response.body;
  }

  if (seedDemoPack) {
    try {
      await loadDemoPack();
    } catch (error) {
      await close();
      throw error;
    }
  }

  async function patients() {
    const response = await request("/api/patients");
    if (response.status !== 200) {
      throw new Error(`读取患者列表失败：HTTP ${response.status}`);
    }
    return response.body.patients;
  }

  async function close() {
    if (closed) return;
    closed = true;
    try {
      await server.shutdown();
    } finally {
      restoreTmpDir();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  return {
    server,
    url,
    token,
    databasePath,
    tempRoot,
    request,
    seedDemoPack: loadDemoPack,
    patients,
    close,
  };
}
