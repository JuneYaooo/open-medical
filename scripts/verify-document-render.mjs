import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { WorkspaceDatabase, WorkspaceService } from "../server/core/index.mjs";
const directory = await mkdtemp(join(tmpdir(), "document-render-"));
const root = join(directory, "project");
await mkdir(root);
const db = new WorkspaceDatabase(join(directory, "state.sqlite"));
const service = new WorkspaceService(db.db, { model: "unused" });
try {
  const w = service.create({ root, directoryConsent: true });
  service.update(w.id, {
    revision: w.revision,
    profile: "code",
    allowWrite: true,
  });
  await service.extensions.operation(w.id, {
    action: "configure",
    revision: service.get(w.id).revision,
    consent: true,
    terminal: true,
    image: "open-medical-runtime:0.8-full",
    origins: [],
    browser: false,
    plugins: false,
    mcp: false,
    memoryRead: false,
    memoryWrite: false,
    memory: { provider: "lsa" },
  });
  const tool = async (name, args) => {
    let result = await service.tool(w.id, { tool: name, arguments: args });
    while (["running", "finalizing"].includes(result.status))
      result = await service.tool(w.id, {
        tool: "terminal_wait",
        arguments: { id: result.id, timeoutMs: 30000 },
      });
    assert.equal(result.exitCode, 0, result.output);
    return result;
  };
  const content = {
    title: "排版验收",
    header: "Open Agent",
    blocks: [
      { type: "heading", text: "表格与分页" },
      {
        type: "table",
        rows: [
          ["项目", "金额"],
          ["Alpha", 12],
          ["Beta", 24],
        ],
      },
      { type: "pageBreak" },
      { type: "paragraph", text: "第二页 / Second page" },
    ],
    sheets: [
      {
        name: "Data",
        rows: [
          ["Item", "Value"],
          ["Alpha", 12],
          ["Beta", 24],
        ],
        widths: { A: 20, B: 14 },
        charts: [
          { type: "bar", data: "B1:B3", categories: "A2:A3", anchor: "D2" },
        ],
      },
    ],
    slides: [
      {
        title: "图表验收",
        elements: [
          {
            type: "chart",
            categories: ["Alpha", "Beta"],
            series: [{ name: "Value", values: [12, 24] }],
            x: 1,
            y: 1.5,
            width: 10,
            height: 5,
          },
        ],
      },
    ],
  };
  const output = resolve("output/document-layout");
  await mkdir(output, { recursive: true });
  for (const kind of ["docx", "xlsx", "pptx", "pdf"]) {
    const created = await tool("document_create", {
      path: `report.${kind}`,
      contentJson: JSON.stringify(content),
    });
    const artifact = created.result.artifacts.find(
      (a) => a.name === `report.${kind}`,
    );
    assert.ok(artifact);
    const rendered = await tool("document_render", { artifactId: artifact.id });
    const images = rendered.result.artifacts.filter(
      (a) => a.mime === "image/png",
    );
    assert.ok(images.length > 0);
    for (const item of [artifact, ...rendered.result.artifacts])
      await writeFile(
        join(output, kind + "-" + item.name.replaceAll("/", "-")),
        service.artifacts.read(w.id, item.id).data,
      );
    console.log(
      JSON.stringify({ format: kind, pages: images.length, rendered: true }),
    );
  }
} finally {
  await service.extensions.close();
  db.close();
  await rm(directory, { recursive: true, force: true });
}
