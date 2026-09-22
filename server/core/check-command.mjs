import { check } from "../errors.mjs";

export function checkCommand(argv) {
  check(Array.isArray(argv) && argv.length > 0 && argv.length <= 40 && argv.every((value) => typeof value === "string" && value.length <= 2000 && !value.includes("\0")), "CHECK_COMMAND", "检查命令须为程序与参数数组");
  check(argv[0].trim().length > 0, "CHECK_COMMAND", "请指定检查程序");
  check(!/^(?:ba|da|z|k|fi)?sh$|^(?:cmd|powershell|pwsh)(?:\.exe)?$/i.test(argv[0].split(/[\\/]/).at(-1)), "CHECK_COMMAND", "检查请直接指定测试程序（如 npm、node、pytest）；复杂 shell 工作使用 terminal_run 并保留真实退出码");
  return argv.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" ");
}
