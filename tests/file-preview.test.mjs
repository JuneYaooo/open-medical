import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WorkspaceDatabase,
  WorkspaceService,
  GenericDomain,
} from "../server/core/index.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "omw-preview-")),
    db = new WorkspaceDatabase(":memory:");
  const service = new WorkspaceService(db.db, {}, { domain: GenericDomain });
  const w = service.create({ root, directoryConsent: true });
  t.after(async () => {
    await service.extensions.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, service, id: w.id };
}

test("preview serves only inline-safe image and PDF types with full path protection", (t) => {
  const f = fixture(t);
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  writeFileSync(join(f.root, "shot.png"), png);
  writeFileSync(join(f.root, "doc.pdf"), Buffer.from("%PDF-1.4"));
  writeFileSync(join(f.root, "page.html"), "<script>x</script>");
  writeFileSync(join(f.root, "vector.svg"), "<svg onload=alert(1)/>");
  writeFileSync(join(f.root, ".env"), "SECRET=1");
  assert.deepEqual(f.service.previewFile(f.id, "shot.png"), {
    data: png,
    mime: "image/png",
  });
  assert.equal(f.service.previewFile(f.id, "doc.pdf").mime, "application/pdf");
  // HTML/SVG are never served inline — they could execute in the app origin.
  assert.throws(() => f.service.previewFile(f.id, "page.html"), {
    code: "PREVIEW_TYPE",
  });
  assert.throws(() => f.service.previewFile(f.id, "vector.svg"), {
    code: "PREVIEW_TYPE",
  });
  assert.throws(() => f.service.previewFile(f.id, ".env"), {
    code: "PATH_DENIED",
  });
  assert.throws(() => f.service.previewFile(f.id, "../../etc/passwd"), {
    code: "PATH_DENIED",
  });
});

test("preview requires the filesystem.read grant", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "shot.png"), Buffer.from([0x89, 0x50]));
  f.service.update(f.id, {
    revision: f.service.get(f.id).revision,
    profile: "minimal",
    allowWrite: false,
  });
  assert.throws(() => f.service.previewFile(f.id, "shot.png"), {
    code: "PERMISSION_DENIED",
  });
});
