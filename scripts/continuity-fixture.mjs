import { randomInt, createHash } from "node:crypto";

export function continuityFixture() {
  const records = Array.from({ length: 16 }, (_, i) => {
    const units = randomInt(101, 990);
    const text = `Record ${i + 1}. Units=${units}.\n` +
      "Background: synthetic warehouse record for continuity acceptance. ".repeat(28);
    return { path: `record-${i + 1}.txt`, units, text, hash: createHash("sha256").update(text).digest("hex") };
  });
  return { records, total: records.reduce((sum, record) => sum + record.units, 0),
    prompt: "读取 record-1.txt 到 record-16.txt 的全部内容，逐份读取 Units 数值。生成 summary.md，使用两列 Markdown 表格（文件、Units），每份来源一行，最后一行为 Total 和实际合计。不要使用终端或脚本代替 read_file 阅读，不要根据文件名猜数值。运行可能中断并续接；以工具真实结果和后续追加要求为准。" };
}

// Only raw, same-run observation archives count as evidence; model-written
// summaries and filenames alone cannot establish that a source was read.
export function verifyContinuity(fixture, summary, observations) {
  if (!summary.includes("CONTINUITY_ACCEPTED")) throw new Error("Recovered output lost steering");
  const rows = summary.split(/\r?\n/).filter((line) => line.trim().startsWith("|"))
    .map((line) => line.trim().split("|").slice(1, -1).map((cell) => cell.trim().replace(/[`*]/g, "")));
  for (const record of fixture.records) {
    if (!observations.some((value) => value && !Array.isArray(value) && value.path === record.path &&
      value.hash === record.hash && value.text === record.text)) throw new Error(`Missing full source observation: ${record.path}`);
    const matches = rows.filter((row) => row[0] === record.path);
    if (matches.length !== 1 || matches[0][1] !== String(record.units)) throw new Error(`Wrong source Units: ${record.path}`);
  }
  const totals = rows.filter((row) => row[0] === "Total");
  if (totals.length !== 1 || totals[0][1] !== String(fixture.total)) throw new Error("Recovered output has wrong total");
}
