import { randomUUID, createHash } from "node:crypto";
import { WorkspaceFiles } from "./workspace-files.mjs";
import { check } from "../errors.mjs";
const fingerprint = (config) =>
  createHash("sha256").update(JSON.stringify(config)).digest("hex");
export class RemoteClient {
  constructor(service, { fetchImpl = fetch } = {}) {
    this.service = service;
    this.fetch = fetchImpl;
    this.busy = new Set();
    service.store.db.exec(
      "CREATE TABLE IF NOT EXISTS remote_client_jobs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL)",
    );
  }
  config() {
    const config =
      this.service.modelProfiles?.settings.vault.get("platform:remote:v1");
    check(config?.url && config?.token, "REMOTE_CONFIG", "请先配置远程队列");
    return config;
  }
  saveConfig(input) {
    check(input.consent === true, "REMOTE_CONSENT", "请确认远程连接配置", 412);
    const url = new URL(input.url);
    check(
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "localhost"].includes(url.hostname))) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash,
      "REMOTE_URL",
      "使用 HTTPS 地址，不得在 URL 中携带凭据",
    );
    check(
      typeof input.token === "string" &&
        input.token.length >= 32 &&
        input.token.length <= 500,
      "REMOTE_TOKEN",
      "访问令牌至少 32 字符",
    );
    this.service.modelProfiles.settings.vault.set("platform:remote:v1", {
      url: url.href.replace(/\/$/, "") + "/",
      token: input.token,
    });
    return { configured: true };
  }
  list(owner) {
    return this.service.store.db
      .prepare(
        "SELECT data FROM remote_client_jobs WHERE owner=? ORDER BY rowid DESC LIMIT 100",
      )
      .all(owner)
      .map((row) => {
        const {
          hashes: _hashes,
          identity: _identity,
          ...job
        } = JSON.parse(row.data);
        return job;
      });
  }
  save(job) {
    this.service.store.db
      .prepare(
        "INSERT INTO remote_client_jobs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(job.id, job.owner, JSON.stringify(job));
    return job;
  }
  async request(config, path, body) {
    const response = await this.fetch(new URL(path, config.url), {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
    check(
      response.ok && response.body,
      "REMOTE_HTTP",
      `远程队列返回 HTTP ${response.status}`,
    );
    let bytes = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      check(bytes <= 16_000_000, "REMOTE_LIMIT", "远程结果过大");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks));
  }
  async execute(owner, input) {
    this.service.store.get(owner);
    if (input.action === "configure") return this.saveConfig(input);
    if (input.action === "list") {
      let url;
      try {
        url = this.config().url;
      } catch {}
      return { url, jobs: this.list(owner) };
    }
    check(!this.busy.has(owner), "REMOTE_BUSY", "请等待远程操作结束", 409);
    this.busy.add(owner);
    try {
      const config = this.config(),
        w = this.service.store.get(owner),
        files = new WorkspaceFiles(w.root);
      if (input.action === "submit") {
        check(
          input.consent === true && w.permissions.grants["filesystem.read"],
          "REMOTE_CONSENT",
          "请授权上传文件快照与任务说明",
          412,
        );
        check(
          Array.isArray(input.paths) && input.paths.length <= 500,
          "REMOTE_FILES",
          "请指定最多 500 个文件",
        );
        const payload = input.paths.map((path) => {
          const file = files.read(path);
          return { path, text: file.text, hash: file.hash };
        });
        const job = {
          id: randomUUID(),
          owner,
          identity: fingerprint(config),
          hashes: Object.fromEntries(payload.map((f) => [f.path, f.hash])),
          status: "submitting",
          createdAt: Date.now(),
        };
        this.save(job);
        try {
          const remote = await this.request(config, "jobs", {
            requestId: job.id,
            prompt: input.prompt,
            files: payload.map(({ path, text }) => ({ path, text })),
          });
          job.remoteId = remote.id;
          job.status = remote.status;
        } catch (e) {
          job.status = "unknown";
          job.error = "提交结果不确定，使用重新查询恢复，勿重复提交";
          this.save(job);
          throw e;
        }
        this.save(job);
        return { jobs: this.list(owner) };
      }
      const row = this.service.store.db
        .prepare("SELECT data FROM remote_client_jobs WHERE id=? AND owner=?")
        .get(input.id, owner);
      check(row, "REMOTE_JOB", "任务不存在", 404);
      const job = JSON.parse(row.data);
      check(
        job.identity === fingerprint(config),
        "REMOTE_CONFIG",
        "远程连接已改变，请恢复原连接",
      );
      if (!job.remoteId) {
        const all = await this.request(config, "jobs");
        const found = all.jobs.find((j) => j.requestId === job.id);
        check(found, "REMOTE_JOB", "远端尚未找到此请求，请稍后查询");
        job.remoteId = found.id;
      }
      const path = `jobs/${encodeURIComponent(job.remoteId)}`;
      if (["cancel", "retry", "remove"].includes(input.action)) {
        check(input.consent === true, "REMOTE_CONSENT", "请确认远程操作", 412);
        const remote = await this.request(
          config,
          path + "/" + input.action,
          {},
        );
        if (input.action === "remove") {
          this.service.store.db
            .prepare("DELETE FROM remote_client_jobs WHERE id=? AND owner=?")
            .run(job.id, owner);
          return { jobs: this.list(owner) };
        }
        job.status = remote.status;
        if (input.action === "retry") {
          job.imported = false;
          delete job.report;
          delete job.approvalCount;
        }
      } else if (input.action === "refresh" || input.action === "import") {
        const remote = await this.request(config, path);
        job.status = remote.status;
        job.error = remote.result?.error;
        if (input.action === "import") {
          check(
            input.consent === true &&
              remote.result &&
              ["completed", "failed"].includes(remote.status),
            "REMOTE_RESULT",
            "请确认导入已结束任务的结果",
            412,
          );
          check(!job.imported, "REMOTE_RESULT", "结果已经导入");
          check(
            this.service.store.get(owner).permissions.grants[
              "filesystem.write"
            ] && fingerprint(this.config()) === job.identity,
            "REMOTE_CONSENT",
            "本地写入授权或远程连接已变更",
            403,
          );
          check(
            !this.service.active.has(owner),
            "RUN_ACTIVE",
            "请等待本地任务结束",
            409,
          );
          const approvals = [];
          for (const file of remote.result.files || []) {
            check(
              typeof file.text === "string",
              "REMOTE_RESULT",
              "远程文件无效",
            );
            this.service.assertWriteScope(owner, file.path, "manual");
            let existing = null;
            try {
              existing = files.read(file.path);
            } catch (e) {
              if (e.code !== "ENOENT" && e.code !== "FILE_NOT_FOUND") throw e;
            }
            if (existing?.text === file.text) continue;
            check(
              (existing?.hash ?? null) === (job.hashes[file.path] ?? null),
              "REMOTE_CONFLICT",
              `本地 ${file.path} 已改变，不能直接导入`,
            );
            approvals.push(
              files.proposal(file.path, file.text, existing?.hash ?? null),
            );
          }
          // Validate every path and version before creating any proposals. Import is always reviewed locally.
          check(
            approvals.length +
              this.service.store
                .get(owner)
                .approvals.filter((a) => a.status === "pending").length <=
              20,
            "APPROVAL_LIMIT",
            "待审批修改超过 20 项，请先处理已有审批",
          );
          job.report = this.service.artifacts.save(
            owner,
            `远程执行-${job.id}.json`,
            Buffer.from(JSON.stringify(remote.result, null, 2)),
            "remote",
          );
          this.service.store.update(owner, (current) => {
            current.approvals.push(
              ...approvals.map((a) => ({ ...a, runId: "manual" })),
            );
          });
          job.imported = true;
          job.approvalCount = approvals.length;
        }
      } else check(false, "REMOTE_ACTION", "未知远程操作");
      this.save(job);
      return { jobs: this.list(owner) };
    } finally {
      this.busy.delete(owner);
    }
  }
}
