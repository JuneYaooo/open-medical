// Nightly auto-save: commit local work and push to origin.
// Designed for unattended cron execution — every failure is logged, never fatal
// to the working tree, and a failed rebase is aborted rather than resolved.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, existsSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const logDirectory = join(homedir(), ".open-medical-workbench");
const log = join(logDirectory, "autopush.log");
mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
const git = (args, options = {}) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // First connection to github.com must not block on a host-key prompt.
      GIT_SSH_COMMAND:
        process.env.GIT_SSH_COMMAND ||
        "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes",
    },
    ...options,
  }).trim();
function record(message) {
  appendFileSync(log, `[${new Date().toISOString()}] ${message}\n`);
}
try {
  const status = git(["status", "--porcelain"]);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (status) {
    git(["add", "-A"]);
    git(["commit", "-m", `nightly auto-save ${new Date().toISOString().slice(0, 10)}`]);
    record(`committed on ${branch}`);
  } else record(`nothing to commit on ${branch}`);
  // Rebase onto the remote first so diverged history (e.g. web edits) never
  // blocks the push; a brand-new remote branch simply has nothing to rebase on.
  git(["fetch", "origin"]);
  const remoteBranch = `origin/${branch}`;
  let hasRemote = "";
  try {
    hasRemote = git(["rev-parse", "--verify", "--quiet", remoteBranch]);
  } catch {
    hasRemote = ""; // remote branch not created yet
  }
  if (hasRemote) {
    try {
      git(["pull", "--rebase", "--autostash", "origin", branch]);
    } catch (error) {
      git(["rebase", "--abort"]);
      throw new Error(`pull --rebase failed, rebase aborted: ${error.message}`);
    }
  } else record(`no remote branch ${remoteBranch} yet; creating it`);
  git(["push", "-u", "origin", branch]);
  record(`pushed ${branch} -> origin`);
} catch (error) {
  const detail = error.stderr || error.stdout || error.message;
  record(`FAILED: ${detail}`);
  // Cron exit code surfaces in mail/log; the next run retries.
  process.exitCode = 1;
}
if (!existsSync(log)) openSync(log, "a", 0o600);
