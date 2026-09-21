import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { join, dirname, relative, posix } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import tar from "tar-stream";
import { isUtf8 } from "node:buffer";
import { WorkspaceFiles, hashText } from "./workspace-files.mjs";
import { check } from "../errors.mjs";
import { scopeKey } from "./write-scope.mjs";

export async function readOutputArchive(buffer) {
  check(buffer.length <= 20_000_000, "TERMINAL_OUTPUT", "文件输出超过 20MB");
  const files = [],
    binaries = [],
    skipped = [],
    extract = tar.extract();
  let count = 0;
  await new Promise((resolve, reject) => {
    extract.on("error", reject);
    extract.on("finish", resolve);
    extract.on("entry", (header, stream, next) => {
      if (++count > 1000) {
        extract.destroy(new Error("终端输出超过 1000 项"));
        return;
      }
      const name = header.name.replace(/^\.\//, "");
      const valid =
        header.type === "file" &&
        header.size <= 10000000 &&
        !name.includes("\0") &&
        !name.includes("\\") &&
        !posix.isAbsolute(name) &&
        !name.split("/").includes("..") &&
        name.length <= 2000;
      const chunks = [];
      stream.on("data", (chunk) => {
        if (valid) chunks.push(chunk);
      });
      stream.on("error", reject);
      stream.on("end", () => {
        if (valid) {
          const data = Buffer.concat(chunks);
          if (
            data.includes(0) ||
            !isUtf8(data) ||
            /\.(pdf|png|jpe?g|gif|webp|xlsx|docx|pptx|zip|parquet|mp3|mp4)$/i.test(
              name,
            )
          )
            binaries.push({ path: name, data });
          else if (data.length <= 512000)
            files.push({ path: name, content: data.toString("utf8") });
          else skipped.push(name + "：文本超过 500KB");
        } else if (header.type !== "directory")
          skipped.push(name + "：链接、非文本或过大");
        next();
      });
      stream.resume();
    });
    extract.end(buffer);
  });
  return { files, binaries, skipped };
}
export class TerminalTools {
  constructor(service, runner) {
    this.service = service;
    this.runner = runner;
  }
  async start(
    id,
    {
      command,
      paths = [],
      timeoutMs = 60000,
      snapshot = false,
      approvalIds = [],
      artifactIds = [],
    },
    context = {},
  ) {
    check(
      typeof command === "string" &&
        command.length > 0 &&
        command.length <= 12000,
      "INVALID_INPUT",
      "命令不能为空或过长",
    );
    check(
      Array.isArray(paths) &&
        paths.length <= 500 &&
        paths.every((p) => typeof p === "string"),
      "INVALID_INPUT",
      "最多选择 500 个文本文件",
    );
    check(
      Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 300000,
      "INVALID_INPUT",
      "终端时限为 1–300 秒",
    );
    const w = this.service.store.get(id);
    check(Array.isArray(artifactIds) && artifactIds.length <= 20 &&
      new Set(artifactIds).size === artifactIds.length && artifactIds.every((v) => typeof v === "string"),
    "ARTIFACT_INPUT", "最多选择 20 个不同成果");
    const network = w.extensions?.terminalNetwork === true;
    check(
      !network || w.permissions.grants.network === true,
      "PERMISSION_DENIED",
      "终端联网授权已撤销",
      403,
    );
    check(
      w.extensions?.image,
      "SANDBOX_IMAGE",
      "请先选择已导入的运行时镜像",
      412,
    );
    check(
      Array.isArray(approvalIds) &&
        approvalIds.length <= 20 &&
        new Set(approvalIds).size === approvalIds.length,
      "APPROVAL_INPUT",
      "最多选择 20 个不同提案",
    );
    const proposals = approvalIds.map((aid) => {
      const proposal = w.approvals.find((a) => a.id === aid);
      check(
        proposal?.status === "pending",
        "APPROVAL_STATE",
        "只能测试当前待审批提案",
        409,
      );
      check(
        w.permissions.grants["filesystem.write"],
        "PERMISSION_DENIED",
        "未授权文件修改",
        403,
      );
      return proposal;
    });
    check(
      new Set(proposals.map((p) => p.path)).size === proposals.length,
      "APPROVAL_INPUT",
      "同一文件只能选择一个提案",
    );
    const staging = join(
      homedir(),
      ".open-medical-workbench",
      "sandbox-staging",
    );
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const files = new WorkspaceFiles(w.root),
      before = new Map(),
      directory = await mkdtemp(join(staging, "omw-terminal-"));
    await chmod(directory, 0o755);
    try {
      const selected = snapshot ? files.snapshot() : { paths, skipped: [] };
      paths = [
        ...new Set([
          ...selected.paths,
          ...proposals
            .filter((p) => p.expectedHash !== null)
            .map((p) => p.path),
        ]),
      ];
      let inputBytes = 0;
      for (const path of paths) {
        const file = files.bytes(path),
          canonical = relative(files.root, files.path(path));
        inputBytes += file.data.length;
        check(inputBytes <= 10000000, "SNAPSHOT_LIMIT", "终端输入超过 10MB");
        before.set(canonical, file.hash);
        const dest = join(directory, canonical);
        await mkdir(dirname(dest), { recursive: true, mode: 0o755 });
        await writeFile(dest, file.data, { mode: 0o644 });
      }
      const occupied = new Set([...before.keys(), ...proposals.map((p) =>
        relative(files.root, files.path(p.path, { create: true, parents: true })))].map((path) => scopeKey(path)));
      for (const artifactId of artifactIds) {
        const { item, data } = this.service.artifacts.read(id, artifactId);
        const canonical = relative(files.root, files.path(item.name, { create: true, parents: true }));
        check(!occupied.has(scopeKey(canonical)),
          "ARTIFACT_INPUT", "成果输入不能覆盖快照或提案中的同名文件");
        occupied.add(scopeKey(canonical));
        inputBytes += data.length;
        check(inputBytes <= 10000000, "SNAPSHOT_LIMIT", "终端输入超过 10MB");
        const dest = join(directory, canonical);
        await mkdir(dirname(dest), { recursive: true, mode: 0o755 });
        await writeFile(dest, data, { mode: 0o644 });
        before.set(canonical, item.hash);
      }
      const stagedHashes = new Map(before);
      for (const proposal of proposals) {
        files.path(proposal.path, { create: true, parents: true });
        if (proposal.kind === "file.delete")
          files.deletion(proposal.path, proposal.expectedHash);
        else
          files.proposal(
            proposal.path,
            proposal.content,
            proposal.expectedHash,
          );
        const canonical = relative(
          files.root,
          files.path(proposal.path, { create: true, parents: true }),
        );
        const dest = join(directory, canonical);
        if (proposal.kind === "file.delete") {
          await rm(dest, { force: true });
          stagedHashes.delete(canonical);
        } else {
          inputBytes += Buffer.byteLength(proposal.content);
          check(inputBytes <= 10000000, "SNAPSHOT_LIMIT", "终端输入超过 10MB");
          await mkdir(dirname(dest), { recursive: true, mode: 0o755 });
          await writeFile(dest, proposal.content, { mode: 0o644 });
          stagedHashes.set(canonical, hashText(proposal.content));
        }
      }
      const marker = "\nOMW_OUTPUT_" + randomUUID() + "\n";
      let pending = "",
        archive = "",
        collecting = false,
        session;
      const endInput = () => {
        // The wrapper emits this marker only after the interactive command has
        // exited. Half-close Docker attach stdin, while continuing to drain the
        // artifact stream and requiring the real child exit/status below.
        if (collecting && session?.status === "running" &&
            !session.child.stdin.destroyed && !session.child.stdin.writableEnded)
          this.runner.write(id, session.id, "", true);
      };
      const stdoutTransform = (data) => {
        if (collecting) {
          archive += data.toString();
          check(
            archive.length <= 27_000_000,
            "TERMINAL_OUTPUT",
            "输出文件超过 20MB，请缩小任务",
          );
          return "";
        }
        pending += data.toString();
        const index = pending.indexOf(marker);
        if (index >= 0) {
          const output = pending.slice(0, index);
          archive = pending.slice(index + marker.length);
          pending = "";
          collecting = true;
          endInput();
          return output;
        }
        let keep = Math.min(pending.length, marker.length - 1);
        while (keep > 0 && !marker.startsWith(pending.slice(-keep))) keep--;
        const length = pending.length - keep,
          output = pending.slice(0, length);
        pending = pending.slice(length);
        return output;
      };
      // All writes stay in size-limited container tmpfs. Never extract archives to the host.
      const wrapper =
        'cp -R /input/. /work/ || exit 125; chmod -R u+w /work; /bin/sh -c "$1"; status=$?; printf "%s" "$2"; if [ "$status" -eq 0 ]; then tar -C /work --exclude=node_modules --exclude=.git --exclude=.venv --exclude=__pycache__ -cf /tmp/omw-output.tar . || exit 126; base64 /tmp/omw-output.tar || exit 126; fi; exit "$status"';
      const authority = JSON.stringify(w.permissions);
      const started = this.runner.start(
        id,
        {
          image: w.extensions.image,
          runId: context.runId,
          mounts: [{ source: directory, target: "/input", readonly: true }],
          command: ["/bin/sh", "-c", wrapper, "omw", command, marker],
          timeoutMs,
          resources: "code",
          network,
          // User terminal sessions accept input; generated document/archive
          // commands explicitly close stdin at launch.
          interactive: context.interactive !== false,
        },
        {
          signal: context.signal,
          stdoutTransform,
          onSettled: (session) => {
            // The runner's final status includes cancellation and bounded
            // cleanup failure, which can happen after archive validation.
            this.service.store.update(id, (current) => {
              const receipt = current.verifications?.find((item) => item.id === session.id);
              if (receipt) {
                receipt.status = session.status;
                receipt.outputComplete = session.outputComplete;
                receipt.execution = session.child.execution ? { ...session.child.execution } : undefined;
                receipt.lifecycle = session.lifecycle.map((event) => ({ ...event }));
              }
            });
          },
          onExit: async (session) => {
            try {
              if (pending) session.output += pending;
              const verification = {
                id: session.id,
                runId: context.runId || "terminal",
                command,
                execution: session.child.execution ? { ...session.child.execution } : undefined,
                exitCode: session.exitCode,
                outputComplete: session.outputComplete,
                lifecycle: session.lifecycle.map((event) => ({ ...event })),
                status:
                  session.status === "cancelled"
                    ? "cancelled"
                    : session.exitCode === 0 && session.outputComplete && !session.error
                      ? "finalizing"
                      : "failed",
                approvalIds,
                inputs: [...stagedHashes].map(([path, hash]) => ({
                  path,
                  hash,
                })),
                skipped: selected.skipped,
                completedAt: Date.now(),
                environment: "isolated-container",
              };
              this.service.store.update(id, (current) => {
                current.verifications = [
                  ...(current.verifications || []).slice(-49),
                  verification,
                ];
              });
              if (session.exitCode !== 0 || session.status === "cancelled" || !session.outputComplete || session.error)
                return {
                  proposals: [],
                  message: "执行失败或已取消，不生成文件提案",
                };
              const acceptVerification = () => {
                session.finalizationController.signal.throwIfAborted();
                context.signal?.throwIfAborted();
                // Keep the durable receipt provisional until onSettled has
                // also observed staging/container cleanup completion.
              };
              if (context.discardOutputs) {
                acceptVerification();
                return {
                  verificationId: session.id,
                  testedApprovals: approvalIds,
                  proposals: [],
                  message: "只验证任务，不导出容器修改",
                };
              }
              check(collecting, "TERMINAL_OUTPUT", "进程未完成文件输出协议");
              const output = await readOutputArchive(
                  Buffer.from(archive, "base64"),
                ),
                changes = [];
              session.finalizationController.signal.throwIfAborted();
              context.signal?.throwIfAborted();
              acceptVerification();
              const current = this.service.store.get(id);
              if (
                JSON.stringify(current.permissions) !== authority ||
                !current.permissions.grants["filesystem.write"]
              )
                return {
                  proposals: [],
                  message: "未授权文件写入或授权已变化，容器文件已丢弃",
                };
              const artifacts = [];
              for (const binary of output.binaries) {
                if (stagedHashes.get(binary.path) === hashText(binary.data))
                  continue;
                try {
                  // Reuse the same protected-name checks. Artifacts never overwrite workspace files.
                  files.path(binary.path, { create: true, parents: true });
                  this.service.assertWriteScope(id, binary.path, context.runId);
                  artifacts.push(
                    this.service.artifacts.save(
                      id,
                      binary.path,
                      binary.data,
                      context.runId || "terminal",
                    ),
                  );
                } catch (error) {
                  output.skipped.push(binary.path + "：" + error.message);
                }
              }
              for (const file of output.files) {
                if (stagedHashes.get(file.path) === hashText(file.content))
                  continue;
                try {
                  this.service.assertWriteScope(id, file.path, context.runId);
                  const proposal = files.proposal(
                    file.path,
                    file.content,
                    before.get(file.path) ?? null,
                  );
                  proposal.runId = context.runId || "terminal";
                  proposal.terminalId = session.id;
                  const previous = proposals.find((p) => p.path === file.path);
                  if (previous) proposal.replaces = previous.id;
                  changes.push(proposal);
                } catch (e) {
                  output.skipped.push(file.path + "：" + e.message);
                }
              }
              const outputPaths = new Set(
                [...output.files, ...output.binaries].map((f) => f.path),
              );
              // 二进制输出只会成为可下载成果，不会写回宿主文件；若它的内容
              // 与某个已消失的输入文件一致（容器内被移动/改名），保留宿主
              // 原文件，避免「批准移动」实际变成删除原件。
              const binaryHashes = new Map(
                output.binaries.map((b) => [hashText(b.data), b.path]),
              );
              for (const [path] of stagedHashes) {
                if (
                  outputPaths.has(path) ||
                  output.skipped.some((item) => item.startsWith(path + "："))
                )
                  continue;
                // New files that disappear do not delete anything on the host.
                if (!before.has(path)) continue;
                const movedTo = binaryHashes.get(before.get(path));
                if (movedTo && movedTo !== path) {
                  output.skipped.push(
                    `${path}：二进制文件被移动为成果 ${movedTo}，宿主原文件保留；如需在宿主上移动请手动处理`,
                  );
                  continue;
                }
                try {
                  this.service.assertWriteScope(id, path, context.runId);
                  const proposal = files.deletion(path, before.get(path));
                  proposal.runId = context.runId || "terminal";
                  proposal.terminalId = session.id;
                  const previous = proposals.find((p) => p.path === path);
                  if (previous) proposal.replaces = previous.id;
                  changes.push(proposal);
                } catch (e) {
                  output.skipped.push(path + "：" + e.message);
                }
              }
              const available = Math.max(
                0,
                20 -
                  current.approvals.filter((a) => a.status === "pending")
                    .length,
              );
              this.service.store.update(id, (value) => {
                for (const proposal of changes.slice(0, available)) {
                  if (proposal.replaces) {
                    const previous = value.approvals.find(
                      (p) => p.id === proposal.replaces,
                    );
                    if (previous?.status !== "pending") continue;
                    previous.status = "revoked";
                    previous.replacedBy = proposal.id;
                  }
                  value.approvals.push(proposal);
                }
              });
              const applied = [];
              if (this.service.store.get(id).approvalPolicy !== "review")
                for (const proposal of changes.slice(0, available)) {
                  const result = this.service.applyAutomatic(id, proposal.id);
                  applied.push({ id: proposal.id, path: proposal.path, ...result });
                }
              this.service.store.event(
                id,
                context.runId || "terminal",
                "terminal.finished",
                {
                  id: session.id,
                  exitCode: session.exitCode,
                  proposals: changes.slice(0, available).map((a) => a.id),
                },
              );
              return {
                verificationId: session.id,
                testedApprovals: approvalIds,
                artifacts,
                applied,
                proposals: changes
                  .slice(0, available)
                  .filter((a) => !applied.some((item) => item.id === a.id))
                  .map((a) => ({ id: a.id, path: a.path })),
                skipped: output.skipped,
                truncated: changes.length > available,
                message: applied.length ? "已按工作区自动写入策略应用文件变更；版本与测试结果已保存" : "文件写入和删除均需逐项批准；测试结果已保存",
              };
            } catch (error) {
              // A successful command is not a successful export. Archive
              // validation/cancellation failures must invalidate its receipt.
              this.service.store.update(id, (current) => {
                const receipt = current.verifications?.find((item) => item.id === session.id);
                if (receipt) receipt.status = session.status === "cancelled" ? "cancelled" : "failed";
              });
              throw error;
            } finally {
              await rm(directory, { recursive: true, force: true });
            }
          },
        },
      );
      session = this.runner.get(id, started.id);
      endInput();
      return started;
    } catch (e) {
      await rm(directory, { recursive: true, force: true });
      throw e;
    }
  }
}
