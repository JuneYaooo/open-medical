import { dirname } from "node:path";
import { check } from "../errors.mjs";

export class ProjectInstructions {
  constructor(files) {
    this.files = files;
  }
  read(path = ".") {
    // Validate the target, including missing final files, before discovering parent instructions.
    this.files.path(path, { create: true, parents: true });
    const parts = (path === "." ? "" : dirname(path))
      .split(/[\\/]/)
      .filter((p) => p && p !== ".");
    const paths = ["AGENTS.md"];
    for (let i = 0; i < parts.length; i++)
      paths.push(parts.slice(0, i + 1).join("/") + "/AGENTS.md");
    const instructions = [];
    let size = 0;
    for (const candidate of new Set(paths)) {
      try {
        const file = this.files.read(candidate);
        size += file.text.length;
        check(
          size <= 24000,
          "INSTRUCTION_LIMIT",
          "项目指令超过 24000 字符，请缩小 AGENTS.md",
        );
        instructions.push(file);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return instructions;
  }
}
