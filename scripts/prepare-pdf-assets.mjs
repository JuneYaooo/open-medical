import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve("public/pdfjs");
mkdirSync(root, { recursive: true });
for (const folder of ["standard_fonts", "cmaps"])
  cpSync(resolve("node_modules/pdfjs-dist", folder), resolve(root, folder), {
    recursive: true,
  });
