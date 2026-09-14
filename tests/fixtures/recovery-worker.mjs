import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceDatabase, WorkspaceService } from "../../server/core/index.mjs";
import { GenericDomain } from "../../server/core/domain-adapter.mjs";

const [directory, mode, scenario] = process.argv.slice(2);
const marker = join(directory, "effect-count");
const db = new WorkspaceDatabase(join(directory, "state.sqlite"));
let requests = 0;
const service = new WorkspaceService(db.db, {
  apiKey: "synthetic", model: "fault-test", provider: "fixture",
  async complete(messages) {
    if (mode === "crash") {
      if (requests++) process.kill(process.pid, "SIGKILL");
      return { message: { role: "assistant", content: null, tool_calls: [
        { id: "effect-1", function: { name: "fixture_effect", arguments: "{}" } },
      ] } };
    }
    const output = messages.findLast((m) => m.role === "tool");
    const data = JSON.parse(output.content);
    if (scenario === "unknown" ? data.code !== "TOOL_OUTCOME_UNKNOWN" : data.count !== 1)
      throw new Error("Invalid durable tool result");
    if (Number(readFileSync(marker, "utf8")) !== 1) throw new Error("Effect replayed");
    return { message: { role: "assistant", content: "Recovered with one effect" } };
  },
}, {
  domain: { ...GenericDomain, registerTools({ registry }) {
    registry.register({ permission: "tools.execute", definition: {
      type: "function", function: { name: "fixture_effect", description: "Synthetic effect",
        parameters: { type: "object", properties: {}, additionalProperties: false } },
    }, execute: () => {
      writeFileSync(marker, "1");
      if (scenario === "unknown") process.kill(process.pid, "SIGKILL");
      return { count: 1 };
    } });
  } },
  extensions: { directory: join(directory, "extensions") },
});
if (mode === "crash") {
  const workspace = service.create({ root: directory, directoryConsent: true });
  await service.execute(service.prepare(workspace.id, {
    revision: workspace.revision, message: "Synthetic restart verification",
    externalConsent: true, resumeOnRestart: true,
  }));
  process.exitCode = 9;
} else {
  service.recovery.tick();
  await service.recovery.drain();
  const run = service.store.list()[0].runs.at(-1);
  console.log(JSON.stringify({ status: run.status, attempts: run.recoveryAttempts,
    rounds: run.roundsUsed, count: Number(readFileSync(marker, "utf8")) }));
  if (run.status !== "completed") process.exitCode = 1;
}
await service.extensions.close();
db.close();
