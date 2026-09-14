import { readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  WorkspaceDatabase,
  WorkspaceService,
  createProvider,
  PythonSandbox,
} from "../server/core/index.mjs";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    database: { type: "string" },
    root: { type: "string" },
    workspace: { type: "string" },
    title: { type: "string" },
    message: { type: "string" },
    "allow-model": { type: "boolean", default: false },
    write: { type: "boolean", default: false },
    approval: { type: "string" },
    revision: { type: "string" },
    profile: { type: "string", default: "standard" },
    decision: { type: "string" },
    "run-id": { type: "string" },
    after: { type: "string" },
    tool: { type: "string" },
    arguments: { type: "string", default: "{}" },
    "config-file": { type: "string" },
    "max-rounds": { type: "string" },
    "timeout-minutes": { type: "string" },
    "resume-run-id": { type: "string" },
    branch: { type: "string" },
    "expected-head": { type: "string" },
    files: { type: "string" },
    "allow-git": { type: "boolean", default: false },
  },
});
const command = positionals[0];
if (
  ![
    "create",
    "list",
    "show",
    "run",
    "permissions",
    "approve",
    "fork",
    "events",
    "extensions",
    "tool",
    "capabilities",
    "worktree",
    "commit",
  ].includes(command)
) {
  console.log(
    `Generic workspace CLI 0.6 (independent of the medical server)\n\ncreate --root=/absolute/directory [--title=name]\nlist\nshow --workspace=id\npermissions --workspace=id --profile=standard [--write]\nrun --workspace=id --message=task --allow-model [--max-rounds=32] [--timeout-minutes=30] [--resume-run-id=id]\napprove --workspace=id --approval=id --revision=N --decision=approve|reject\nfork --workspace=id [--run-id=id]\nevents --workspace=id [--after=N]\nextensions --workspace=id [--config-file=reviewed-config.json]\ntool --workspace=id --tool=memory_search --arguments=JSON\n\ncapabilities --workspace=id\nworktree --workspace=id --branch=agent/name --expected-head=SHA --allow-git\ncommit --workspace=id --expected-head=SHA --message=summary --files=JSON --allow-git\n\nAll commands accept --database=/absolute/path.sqlite. Models use AI_PROVIDER and provider environment variables. File writes always require approval.`,
  );
} else {
  let database, service;
  try {
    const file = resolve(
      values.database ||
        join(homedir(), ".open-medical-workbench", "agent.sqlite"),
    );
    database = new WorkspaceDatabase(file);
    service = new WorkspaceService(database.db, createProvider(), {
      sandbox: command === "run" ? new PythonSandbox() : undefined,
    });
    const id = values.workspace;
    let result;
    if (command === "create")
      result = service.create({
        root: values.root,
        title: values.title,
        directoryConsent: true,
      });
    if (command === "list") result = service.list();
    if (command === "show") result = service.get(id);
    if (command === "capabilities") result = service.capabilities(id);
    if (command === "worktree")
      result = await service.createWorktree(id, {
        revision: service.get(id).revision,
        branch: values.branch,
        expectedHead: values["expected-head"],
        consent: values["allow-git"],
      });
    if (command === "commit")
      result = await service.commit(id, {
        revision: service.get(id).revision,
        expectedHead: values["expected-head"],
        message: values.message,
        files: JSON.parse(values.files || "[]"),
        consent: values["allow-git"],
      });
    if (command === "permissions")
      result = service.update(id, {
        revision: service.get(id).revision,
        profile: values.profile,
        allowWrite: values.write,
      });
    if (command === "approve")
      result = service.decide(id, values.approval, {
        revision: Number(values.revision),
        decision: values.decision,
      });
    if (command === "fork")
      result = service.store.fork(id, {
        revision: service.get(id).revision,
        runId: values["run-id"],
      });
    if (command === "events")
      result = service.store.events(id, Number(values.after || 0));
    if (command === "extensions") {
      if (!values["config-file"]) result = service.extensions.status(id);
      else {
        const path = resolve(values["config-file"]);
        if (statSync(path).size > 64000) throw new Error("扩展配置超过 64KB");
        result = await service.extensions.operation(id, {
          revision: service.get(id).revision,
          ...JSON.parse(readFileSync(path, "utf8")),
        });
      }
    }
    if (command === "tool") {
      result = await service.tool(id, {
        tool: values.tool,
        arguments: JSON.parse(values.arguments),
      });
      if (result?.id && service.extensions.runner.sessions.has(result.id)) {
        const session = service.extensions.runner.get(id, result.id);
        let cursor = 0;
        const input = (chunk) => {
          try {
            service.extensions.runner.write(id, session.id, chunk.toString());
          } catch {}
        };
        const eof = () => {
          try {
            service.extensions.runner.write(id, session.id, "", true);
          } catch {}
        };
        const stop = () => service.extensions.runner.stop(id, session.id);
        const timer = setInterval(() => {
          const output = service.extensions.runner.read(id, session.id, cursor);
          cursor = output.cursor;
          if (output.output) process.stderr.write(output.output);
        }, 100);
        process.stdin.on("data", input);
        process.stdin.once("end", eof);
        process.once("SIGINT", stop);
        try {
          result = await session.done;
        } finally {
          clearInterval(timer);
          process.stdin.removeListener("data", input);
          process.stdin.removeListener("end", eof);
          process.stdin.pause();
          process.removeListener("SIGINT", stop);
        }
        if (result.exitCode !== 0) process.exitCode = 1;
      }
    }
    if (command === "run") {
      const handle = service.prepare(id, {
        message: values.message,
        revision: service.get(id).revision,
        externalConsent: values["allow-model"],
        resumeRunId: values["resume-run-id"],
        limits: {
          ...(values["max-rounds"]
            ? { maxRounds: Number(values["max-rounds"]) }
            : {}),
          ...(values["timeout-minutes"]
            ? { timeoutMs: Number(values["timeout-minutes"]) * 60000 }
            : {}),
        },
      });
      const stop = () => service.cancel(id);
      process.once("SIGINT", stop);
      try {
        result = await service.execute(handle, (event) =>
          process.stderr.write(JSON.stringify(event) + "\n"),
        );
      } finally {
        process.removeListener("SIGINT", stop);
      }
      if (result.status !== "completed") process.exitCode = 1;
    }
    // show is the explicit history export command; normal command results omit provider-private transcripts.
    if (result?.runs) result = service.get(result.id);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(
      error.code ? `${error.code}: ${error.message}` : error.message,
    );
    process.exitCode = 1;
  } finally {
    await service?.extensions.close();
    database?.close();
  }
}
