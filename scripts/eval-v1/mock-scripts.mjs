// mock 冒烟脚本:按模型调用序号给出确定性的工具调用/回答。
// 只覆盖冒烟任务(C02/F01/R03);真实模型任务由 provider 驱动,不走这里。
import { lastToolHash, markerFrom } from "./mock-model.mjs";

const FIXED_INTERVALS = [
  "export const merge = (rows) => {",
  "  if (!Array.isArray(rows) || rows.length === 0) return [];",
  "  const sorted = rows.map((r) => [...r]).sort((a, b) => a[0] - b[0]);",
  "  const out = [];",
  "  for (const [s, e] of sorted) {",
  "    const last = out[out.length - 1];",
  "    if (last && s <= last[1]) last[1] = Math.max(last[1], e);",
  "    else out.push([s, e]);",
  "  }",
  "  return out;",
  "};",
  "",
].join("\n");

export const SMOKE_SCRIPTS = new Map([
  [
    "C02",
    ({ call, messages }) => {
      if (call === 1) return { toolCalls: [{ name: "read_file", args: { path: "intervals.mjs" } }] };
      if (call === 2)
        return {
          toolCalls: [
            {
              name: "propose_file_write",
              args: {
                path: "intervals.mjs",
                content: FIXED_INTERVALS,
                expectedHash: lastToolHash(messages),
              },
            },
          ],
        };
      return {
        content:
          "已修复并验证:merge([[5,7],[1,3],[2,4],[7,8]]) 返回 [[1,4],[5,8]];空数组返回 [];实现先复制再排序,原输入保持不变。",
      };
    },
  ],
  [
    "F01",
    ({ call, userText }) => {
      const marker = markerFrom(userText);
      if (call === 1) {
        const list = [
          "# 整理清单",
          "",
          "| 原件 | 分类 | 副本 |",
          "| --- | --- | --- |",
          "| inbox/a.txt | 发票 | 发票/a.txt(INV-01,金额100元) |",
          "| inbox/b.txt | 会议 | 会议/b.txt(周一讨论发布) |",
          "| inbox/c.txt | 发票 | 发票/c.txt(INV-02,金额200元) |",
          "",
          `运行标记:${marker || "EVAL-MISSING"}`,
          "",
        ].join("\n");
        return {
          toolCalls: [
            { name: "propose_file_write", args: { path: "发票/a.txt", content: "发票:INV-01,金额100元" } },
            { name: "propose_file_write", args: { path: "发票/c.txt", content: "发票:INV-02,金额200元" } },
            { name: "propose_file_write", args: { path: "会议/b.txt", content: "会议纪要:周一讨论发布" } },
            { name: "propose_file_write", args: { path: "整理清单.md", content: list } },
          ],
        };
      }
      return { content: "整理完成:三份材料按内容分类,原件保留在 inbox/,副本分别在 发票/ 与 会议/,清单见 整理清单.md。" };
    },
  ],
  [
    "R03",
    ({ call, userText }) => {
      const urlA = /http:\/\/127\.0\.0\.1:\d+\/a\.html/.exec(userText)?.[0];
      const urlB = /http:\/\/127\.0\.0\.1:\d+\/b\.html/.exec(userText)?.[0];
      if (call === 1 && urlA) return { toolCalls: [{ name: "web_fetch", args: { url: urlA } }] };
      if (call <= 2 && urlB) return { toolCalls: [{ name: "web_fetch", args: { url: urlB } }] };
      return {
        content:
          `摘要:合成项目公告于 2026-01-01 发布,预算500元(来源:${urlA});` +
          `2026-01-03 发布修订公告,预算修订为600元(来源:${urlB})。以最新修订为准,当前预算600元。`,
      };
    },
  ],
  [
    // A02(X04/X12 基础):先读记录(给控制器一个可中断的 tool.complete
    // 边界),恢复/取消语义由控制器注入;恢复后写汇总(合计60+运行标记)。
    "A02",
    ({ call, userText }) => {
      const marker = markerFrom(userText);
      if (call === 1)
        return { toolCalls: [{ name: "read_file", args: { path: "records.csv" } }] };
      if (call === 2)
        return {
          toolCalls: [
            {
              name: "propose_file_write",
              args: {
                path: "汇总.md",
                content: `# 记录汇总\n\n| id | value |\n| --- | --- |\n| 1 | 10 |\n| 2 | 20 |\n| 3 | 30 |\n\n合计:60\n\n运行标记:${marker || "EVAL-MISSING"}\n`,
              },
            },
          ],
        };
      return { content: "已完成汇总:三条记录合计 60,过程文件已保留,见 汇总.md。" };
    },
  ],
]);
