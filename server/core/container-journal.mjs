import { randomUUID, createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const execute = promisify(execFile);
const failure = (code) => Object.assign(new Error(code), { code });
function machineIdentity() {
  try {
    const value = process.platform === "linux" ? readFileSync("/etc/machine-id", "utf8")
      : process.platform === "darwin" ? execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeout: 2000, encoding: "utf8" }).match(/"IOPlatformUUID" = "([^"]+)"/)?.[1]
      : execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { timeout: 2000, encoding: "utf8", windowsHide: true }).match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1];
    return value?.trim() ? digest(value.trim()) : null;
  } catch { return null; }
}
const localMachine = machineIdentity();
const absent = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === "ESRCH"; }
};

// SQLite is authoritative; Docker labels only corroborate an existing record.
// No commands, environment values, credentials, or file content are stored here.
export class ContainerJournal {
  constructor(db, { machine = localMachine, processId = randomUUID(), pid = process.pid,
    isAbsent = absent, now = Date.now } = {}) {
    Object.assign(this, { db, machine, processId, pid, isAbsent, now });
    db.exec(`CREATE TABLE IF NOT EXISTS container_installation (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS container_executions (nonce TEXT PRIMARY KEY, data TEXT NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0, lease_owner TEXT);
      CREATE INDEX IF NOT EXISTS container_recovery_lease ON container_executions(lease_until);`);
    db.prepare("INSERT OR IGNORE INTO container_installation VALUES(1, ?)").run(randomUUID());
    this.installation = db.prepare("SELECT id FROM container_installation WHERE singleton=1").get().id;
  }
  create({ owner, runId, sessionId, name, endpoint, deadline }) {
    const record = { version: 1, installation: this.installation, processId: this.processId,
      pid: this.pid, machine: this.machine, owner, runId, sessionId, name, endpoint,
      nonce: randomUUID(), createdAt: this.now(), deadline, phase: "creating", attempts: 0 };
    this.db.prepare("INSERT INTO container_executions(nonce,data) VALUES(?,?)").run(record.nonce, JSON.stringify(record));
    return record;
  }
  get(nonce) { const row = this.db.prepare("SELECT data FROM container_executions WHERE nonce=?").get(nonce); return row && JSON.parse(row.data); }
  update(nonce, patch) {
    const record = this.get(nonce);
    if (!record) throw failure("CONTAINER_RECORD_MISSING");
    const next = { ...record, ...patch, updatedAt: this.now() };
    this.db.prepare("UPDATE container_executions SET data=? WHERE nonce=?").run(JSON.stringify(next), nonce);
    return next;
  }
  async recover({ endpoint, cli, totalMs = 15000 }) {
    const end = this.now() + totalMs, results = [];
    // Page through a bounded candidate batch; durable rows are never silently
    // dropped when cleanup is unresolved. Resolved history remains auditable.
    const rows = this.db.prepare("SELECT nonce FROM container_executions WHERE lease_until <= ? AND json_extract(data, '$.phase') != 'removed' AND COALESCE(json_extract(data, '$.nextRetryAt'),0) <= ? ORDER BY rowid LIMIT 100").all(this.now(), this.now());
    for (const { nonce } of rows) {
      if (this.now() >= end) break;
      let r = this.get(nonce);
      if (r.phase === "removed" || r.processId === this.processId || r.endpoint !== endpoint ||
          !this.machine || r.machine !== this.machine || !this.isAbsent(r.pid) ||
          r.attempts >= 8 || (r.nextRetryAt || 0) > this.now()) continue;
      const claimed = this.db.prepare("UPDATE container_executions SET lease_until=?,lease_owner=? WHERE nonce=? AND lease_until<=?")
        .run(this.now() + 30000, this.processId, nonce, this.now());
      if (!claimed.changes) continue;
      const call = async (args) => {
        if (this.now() >= end) throw failure("RECOVERY_DEADLINE");
        return cli(args, Math.min(2000, end - this.now()));
      };
      try {
        r = this.get(nonce);
        if (!this.isAbsent(r.pid)) continue;
        this.update(nonce, { phase: "cleanup_pending", interrupted: true, attempts: r.attempts + 1 });
        const inspected = await call(["inspect", "--format", '{{json .}}', r.containerId || r.name]);
        if (inspected.missing === true && r.containerId) {
          this.update(nonce, { phase: "removed", removalConfirmedAt: this.now() });
          results.push({ nonce, phase: "removed" }); continue;
        }
        if (inspected.code !== 0) throw failure("RECOVERY_INSPECT_UNCONFIRMED");
        const info = JSON.parse(inspected.stdout), labels = info.Config?.Labels;
        if (!/^[a-f0-9]{64}$/.test(info.Id) || (r.containerId && info.Id !== r.containerId) ||
            labels?.["omw.installation"] !== r.installation || labels?.["omw.execution"] !== nonce ||
            labels?.["omw.protocol"] !== "1") throw failure("RECOVERY_OWNERSHIP_MISMATCH");
        this.update(nonce, { containerId: info.Id, interrupted: true, exitCode: info.State?.ExitCode });
        if (!this.isAbsent(r.pid)) throw failure("RECOVERY_OWNER_AMBIGUOUS");
        // Delete by immutable ID only. Recovery never starts or exports work.
        const removed = await call(["rm", "-f", info.Id]);
        if (removed.code !== 0) throw failure("RECOVERY_REMOVE_UNCONFIRMED");
        const confirmed = await call(["inspect", "--format", "{{.Id}}", info.Id]);
        if (confirmed.missing !== true) throw failure("RECOVERY_REMOVE_UNCONFIRMED");
        this.update(nonce, { phase: "removed", removalConfirmedAt: this.now() });
        results.push({ nonce, phase: "removed" });
      } catch (error) {
        this.update(nonce, { phase: "cleanup_pending", lastRecoveryCode: error.code || "RECOVERY_FAILED",
          nextRetryAt: this.now() + Math.min(3600000, 1000 * 2 ** (r.attempts + 1)) });
        results.push({ nonce, phase: "cleanup_pending" });
      } finally {
        this.db.prepare("UPDATE container_executions SET lease_until=0,lease_owner=NULL WHERE nonce=? AND lease_owner=?").run(nonce, this.processId);
      }
    }
    return results;
  }
}

export function dockerEndpoint(docker, environment) {
  // Daemon ID binds the actual endpoint even when a named context is repointed.
  const value = execFileSync(docker, ["info", "--format", "{{.ID}}"], {
    env: environment, timeout: 2000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
  }).trim();
  if (!value || value.length > 1024) throw failure("DOCKER_ENDPOINT_UNKNOWN");
  return digest(value);
}
export async function recoveryCli(docker, environment, args, timeout) {
  try {
    const result = await execute(docker, args, { env: environment, timeout, maxBuffer: 131072, windowsHide: true });
    return { code: 0, stdout: result.stdout };
  } catch (error) {
    // A transport failure is never absence. Require Docker's explicit response
    // naming the exact inspected immutable ID.
    const target = args.at(-1);
    const missing = args[0] === "inspect" && /^[a-f0-9]{64}$/.test(target) &&
      error.code === 1 && !error.killed && String(error.stderr).toLowerCase().includes(`no such object: ${target}`);
    return { code: error.code, stdout: error.stdout || "", missing };
  }
}

// The interactive Docker CLI retains stdin and --rm. Its cidfile captures the
// immutable ID even when the process is cancelled before returning any output.
export function bindInteractiveExecution(child, { journal, execution, docker, environment, cidfile, cleanupFile, timeoutMs = 2000 }) {
  child.execution = execution;
  const persist = (patch) => { child.execution = journal.update(execution.nonce, patch); };
  let cleanup;
  child.cleanup = () => cleanup ||= (async () => {
    const end = Date.now() + timeoutMs;
    const call = (args) => {
      if (Date.now() >= end) throw failure("DOCKER_CLEANUP_UNCONFIRMED");
      return recoveryCli(docker, environment, args, Math.min(1000, end - Date.now()));
    };
    persist({ phase: "cleanup_pending" });
    let id = child.execution.containerId;
    if (!id) {
      try {
        const value = readFileSync(cidfile, "utf8").trim();
        if (/^[a-f0-9]{64}$/.test(value)) { id = value; persist({ containerId: id }); }
      } catch { /* Unknown create outcome requires exact-name ownership proof. */ }
    }
    const inspected = await call(["inspect", "--format", "{{json .}}", id || execution.name]);
    if (!(id && inspected.missing)) {
      if (inspected.code !== 0) throw failure("DOCKER_CLEANUP_UNCONFIRMED");
      const info = JSON.parse(inspected.stdout), labels = info.Config?.Labels;
      if (!/^[a-f0-9]{64}$/.test(info.Id) || (id && info.Id !== id) ||
          labels?.["omw.installation"] !== execution.installation || labels?.["omw.execution"] !== execution.nonce ||
          labels?.["omw.protocol"] !== "1") throw failure("DOCKER_OWNERSHIP_MISMATCH");
      id = info.Id; persist({ containerId: id });
      if ((await call(["rm", "-f", id])).code !== 0) throw failure("DOCKER_CLEANUP_UNCONFIRMED");
      if (!(await call(["inspect", "--format", "{{.Id}}", id])).missing) throw failure("DOCKER_CLEANUP_UNCONFIRMED");
    }
    persist({ phase: "removed", removalConfirmedAt: Date.now() });
    cleanupFile();
  })();
}
