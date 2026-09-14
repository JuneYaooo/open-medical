import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceDatabase, WorkspaceService } from "../server/core/index.mjs";
const exec = promisify(execFile), helper = resolve("desktop/full-runtime/document.py");
function root(t) {
  const directory = mkdtempSync(join(tmpdir(), "omw-documents-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const python = process.env.TEST_PYTHON || "python3";
let pythonAvailable = true;
try { await exec(python, ["--version"]); } catch { pythonAvailable = false; }
test("structured input and ZIP round trip preserve data without path escapes", { skip: !pythonAvailable }, async (t) => {
  const directory = root(t);
  const invoke = async (request) => JSON.parse((await exec(python, [helper, "--base64", Buffer.from(JSON.stringify(request)).toString("base64")], { cwd: directory })).stdout).result;
  writeFileSync(join(directory, "rows.csv"), 'item,quantity\n"Alpha, quoted",4\nBeta,6\n');
  assert.deepEqual((await invoke({ action: "read", path: "rows.csv" })).rows,
    [["item", "quantity"], ["Alpha, quoted", "4"], ["Beta", "6"]]);
  writeFileSync(join(directory, "data.json"), '{"number":0,"text":"中文"}');
  assert.deepEqual((await invoke({ action: "read", path: "data.json" })).data, { number: 0, text: "中文" });
  await invoke({ action: "archive_create", path: "data.zip", paths: ["rows.csv", "data.json"] });
  const manifest = await invoke({ action: "archive_list", path: "data.zip" });
  assert.equal(manifest.entries.length, 2);
  await invoke({ action: "archive_extract", path: "data.zip", destination: "extracted" });
  assert.equal(readFileSync(join(directory, "extracted/rows.csv"), "utf8"), readFileSync(join(directory, "rows.csv"), "utf8"));
  await assert.rejects(invoke({ action: "archive_extract", path: "data.zip", destination: "extracted" }));
});
test("ZIP traversal, links and excessive entries are rejected before extraction", { skip: !pythonAvailable }, async (t) => {
  const directory = root(t);
  await exec(python, ["-c", `import zipfile,stat
with zipfile.ZipFile('traversal.zip','w') as z: z.writestr('../escape','bad')
with zipfile.ZipFile('link.zip','w') as z:
 i=zipfile.ZipInfo('link'); i.external_attr=(stat.S_IFLNK|0o777)<<16; z.writestr(i,'../../escape')
with zipfile.ZipFile('many.zip','w') as z:
 for i in range(2001): z.writestr(str(i),'x')
`], { cwd: directory });
  for (const path of ["traversal.zip", "link.zip", "many.zip"]) {
    await assert.rejects(exec(python, [helper, JSON.stringify({ action: "archive_extract", path, destination: "extracted" })], { cwd: directory }));
    assert.equal(existsSync(join(directory, "extracted")), false);
  }
});

test("real full Docker runtime creates, downloads and reads Office/PDF/ZIP through Agent tools", { skip: !process.env.TEST_FULL_RUNTIME_IMAGE }, async (t) => {
  const directory = root(t), project = join(directory, "project"); mkdirSync(project);
  const db = new WorkspaceDatabase(join(directory, "state.sqlite"));
  const service = new WorkspaceService(db.db, { model: "unused" });
  t.after(async () => { await service.extensions.close(); db.close(); });
  const w = service.create({ root: project, directoryConsent: true });
  service.update(w.id, { revision: w.revision, profile: "standard", allowWrite: true });
  await service.extensions.operation(w.id, { action: "configure", revision: service.get(w.id).revision,
    consent: true, terminal: true, image: process.env.TEST_FULL_RUNTIME_IMAGE, origins: [],
    browser: false, plugins: false, mcp: false, memoryRead: false, memoryWrite: false, memory: { provider: "lsa" } });
  const tool = async (name, args) => {
    let result = await service.tool(w.id, { tool: name, arguments: args });
    while (["running", "finalizing"].includes(result.status))
      result = await service.tool(w.id, { tool: "terminal_wait", arguments: { id: result.id, timeoutMs: 30000 } });
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.exitCode, 0, result.output);
    return result;
  };
  const environment = await tool("terminal_run", { command: "python -c 'import sys; print(sys.executable)'" });
  assert.match(environment.output, /\/opt\/agent-python\/bin\/python/);
  for (const extension of ["docx", "xlsx", "pptx", "pdf"]) {
    const content = extension === "xlsx" ? { sheets: [{ name: "Data", rows: [["Item", "Value"], ["SYNTHETIC", 10]] }] } :
      extension === "pptx" ? { slides: [{ title: "SYNTHETIC", paragraphs: ["Value 10"] }] } : { title: "SYNTHETIC", paragraphs: ["Value 10"] };
    const output = await tool("document_create", { path: `report.${extension}`, contentJson: JSON.stringify(content) });
    const item = output.result.artifacts.find((a) => basename(a.name) === `report.${extension}`);
    assert.ok(item, JSON.stringify(output));
    const artifactRead = await tool("document_read", { artifactId: item.id });
    assert.match(artifactRead.output, /SYNTHETIC/);
    assert.equal(existsSync(join(project, `report.${extension}`)), false);
    const other = service.create({ root: project, directoryConsent: true });
    assert.throws(() => service.artifacts.read(other.id, item.id), (e) => e.code === "NOT_FOUND");
    await assert.rejects(service.tool(w.id, { tool: "document_read", arguments: { artifactId: item.id, path: "report.pdf" } }),
      (e) => e.code === "DOCUMENT_INPUT");
    writeFileSync(join(project, `report.${extension}`), service.artifacts.read(w.id, item.id).data);
    const read = await tool("document_read", { path: `report.${extension}` });
    assert.match(read.output, /SYNTHETIC/);
    assert.match(read.output, /10/);
    await assert.rejects(service.tool(w.id, { tool: "terminal_run",
      arguments: { command: "true", paths: [`report.${extension}`], artifactIds: [item.id] } }),
    (e) => e.code === "ARTIFACT_INPUT");
  }
  const zipped = await tool("archive_create", { path: "deliverables.zip", paths: ["report.pdf", "report.xlsx"] });
  const zip = zipped.result.artifacts.find((a) => a.name === "deliverables.zip");
  assert.ok(zip);
  writeFileSync(join(project, "deliverables.zip"), service.artifacts.read(w.id, zip.id).data);
  assert.match((await tool("archive_list", { path: "deliverables.zip" })).output, /report.pdf/);
  const extracted = await tool("archive_extract", { path: "deliverables.zip", destination: "unpacked" });
  assert.equal(extracted.result.artifacts.length, 2);
  assert.equal(existsSync(join(project, "unpacked")), false);
});
