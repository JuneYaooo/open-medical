// Isolated, offline UI fixture. Never reads the user's model credentials or database.
import { createWorkspaceServer } from "../server/platform.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "workbench-preview-"));
writeFileSync(
  join(root, "README.md"),
  "# 示例项目\n\n这是用于界面验收的本地资料。\n",
);
const server = createWorkspaceServer({
  database: join(root, "preview.sqlite"),
  provider: {
    name: "offline",
    model: "offline",
    stream() {
      throw new Error("离线预览不调用模型");
    },
  },
});
const task = server.service.create({
  root,
  title: "检查项目并整理改动",
  directoryConsent: true,
});
server.service.store.update(task.id, (w) => {
  w.messages = [
    { role: "user", content: "帮我看看项目结构，整理需要改进的地方。" },
    {
      role: "assistant",
      content:
        "已经检查项目。你可以打开 [README.md](README.md) 查看说明。\n\n```js\nconst ready = true;\nconsole.log(ready);\n```\n\n| 检查项 | 结果 |\n| --- | --- |\n| 文档 | 已读取 |\n| 测试 | 等待运行 |",
    },
  ];
});
server.listen(8791, "127.0.0.1", () =>
  console.log("UI fixture: http://127.0.0.1:8791"),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await server.shutdown();
  });
