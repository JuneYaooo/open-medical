// Explicit synthetic UI fixture. Never imported by production entry points.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createWorkspaceServer } from "../server/platform.mjs";
const directory = resolve(process.env.AGENT_VERIFICATION_DIRECTORY || "output/playwright/generic-recovery");
const root = join(directory, "project");
mkdirSync(root, { recursive: true });
writeFileSync(join(root, "README.md"), "Synthetic browser acceptance fixture. No patient data.\n");
const server = createWorkspaceServer({ database: join(directory, "fixture.sqlite"),
  instanceId: "synthetic-ui-fixture",
  provider: { apiKey: "synthetic", model: "UI fixture (not a real model)", provider: "fixture",
    async complete(messages, _tools, { signal }) {
      const last = messages.at(-1);
      if (last.role === "user" && last.content.includes("慢速")) await delay(8000, undefined, { signal });
      return { message: { role: "assistant", content: "合成界面验证已完成：" + last.content }, usage: { total_tokens: 10 } };
    } },
});
if (!server.service.list().length) {
  const w = server.service.create({ root, title: "通用恢复验收（合成资料）", directoryConsent: true });
  for (let n = 0; n < 52; n++) await server.service.execute(server.service.prepare(w.id, {
    revision: server.service.get(w.id).revision, message: `合成历史 ${n}`, externalConsent: true,
  }));
}
server.listen(Number(process.env.AGENT_VERIFICATION_PORT || 8798), "127.0.0.1", () => console.log(`Synthetic UI: http://127.0.0.1:${server.address().port}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await server.shutdown(); });
