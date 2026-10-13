import { fileURLToPath } from "node:url";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
const root = new URL("../evals/learning-loop-v1/", import.meta.url);
const chrome =
  process.env.LEARNING_CHROME ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
});
const page = await browser.newPage({
  viewport: { width: 900, height: 720 },
  deviceScaleFactor: 1,
});
const manifest = [];
const clusters = [
  ["T2DM", "HTN"],
  ["慢性胆囊炎", "脂肪肝"],
  ["CKD", "HTN"],
  ["术后随访", "切口恢复中"],
];
try {
  for (let i = 1; i <= 40; i++) {
    const id = `P${String(i).padStart(3, "0")}`,
      cluster = Math.floor((i - 1) / 10),
      canary = `SYNTH_CANARY_${id}_${createHash("sha256").update(`learning-v1-${id}`).digest("hex").slice(0, 12)}`;
    const name = canary,
      date = `2026-09-${String(((i - 1) % 25) + 1).padStart(2, "0")}`,
      glucose = Number((5 + (i % 9) * 0.4).toFixed(1));
    const glucoseUnit = i % 3 === 0 ? "mg/dL" : "mmol/L",
      glucoseValue = i % 3 === 0 ? Number((glucose * 18).toFixed(2)) : glucose;
    const gold = {
      name,
      gender: i % 2 ? "male" : "female",
      birthYear: 1950 + i,
      phone: "",
      groups: [],
      tags: ["吸烟史"],
      allergyStatus: "unknown",
      allergies: [],
      diagnoses: [
        ...clusters[cluster].map((name, j) => ({
          name,
          status: j === 0 ? "confirmed" : "suspected",
          date,
        })),
        { name: "肝囊肿", status: "finding", date },
      ],
      medications: [
        {
          name: "合成药A",
          dose: `${i % 2 ? 5 : 10}mg`,
          frequency: "bid",
          status: "active",
        },
      ],
      labs: [
        { item: "血糖", value: glucoseValue, unit: glucoseUnit, date },
        { item: "肌酐", value: 65 + i, unit: "μmol/L", date },
      ],
      visits: [{ date, reason: "门诊复查", note: "资料记载吸烟史" }],
      clinicalSummary: {
        text: `${date}门诊复查，主要问题为${clusters[cluster][0]}，${clusters[cluster][1]}待排。记录吸烟史。`,
        source: "门诊记录.txt",
      },
      note: "合成测试资料，清单页未提供的数值不建条目。",
    };
    const record = `合成测试病例 ${id}\n姓名：${name}\n性别：${gold.gender === "male" ? "男" : "女"}，出生年：${gold.birthYear}\n日期：${date.replaceAll("-", "/")}\n诊断：${gold.diagnoses.map((d) => `${d.name}（${d.status === "confirmed" ? "确诊" : d.status === "suspected" ? "疑似待排" : "影像偶然发现"}）`).join("；")}\n用药：合成药A ${gold.medications[0].dose} bid，正在使用。\n吸烟史：资料有记录，具体支数不详。过敏史：未提及。\n就诊事由：门诊复查。\n病史摘要：${gold.clinicalSummary.text}\n清单：血常规（仅预约清单，无检验数值）。\n随访患者：${name}。\n`;
    const labs = `合成检验报告\n姓名：${name}\n日期：${date}\n血糖：${glucoseValue} ${glucoseUnit}\n肌酐：${65 + i} μmol/L\n重复列出的既往问题：${clusters[cluster][0]}\n备注：本报告仅用于软件评测。`;
    const dir = new URL(`patients/${id}/`, root);
    await mkdir(new URL("materials/", dir), { recursive: true });
    await writeFile(
      new URL("gold.json", dir),
      JSON.stringify(gold, null, 2) + "\n",
    );
    await writeFile(new URL("canary.txt", dir), canary + "\n");
    await writeFile(new URL("materials/门诊记录.txt", dir), record);
    await page.setContent(
      `<html lang="zh"><meta charset="utf-8"><body style="padding:40px;background:#f8f7f2;color:#202020;font-family:Arial,'PingFang SC',sans-serif"><pre style="font-family:inherit;font-size:22px;line-height:1.9;white-space:pre-wrap">${labs}</pre></body></html>`,
    );
    await page.screenshot({
      path: fileURLToPath(new URL("materials/检验扫描.png", dir)),
    });
    manifest.push({
      id,
      cluster,
      split: i % 4 === 0 ? "holdout" : "learning",
      materials: ["门诊记录.txt", "检验扫描.png"],
      goldHash: createHash("sha256")
        .update(await readFile(new URL("gold.json", dir)))
        .digest("hex"),
      humanReviewed: false,
    });
  }
} finally {
  await browser.close();
}
for (let i = 1; i <= 3; i++)
  await writeFile(
    new URL(`personas/D${i}.json`, root),
    JSON.stringify(
      {
        id: `D${i}`,
        termDirection: i === 2 ? "short" : "full",
        frequency: i === 2 ? "short" : "full",
        summary: i === 3 ? "chronological" : "brief",
        excludeFindings: i !== 2,
        rules: [
          "term",
          "unit",
          "format",
          "spurious",
          "omission",
          "style",
          "trap-status",
          "trap-dose",
        ],
        stated: [
          i === 2 ? "以后诊断都写缩写" : "以后诊断都写中文全称",
          "以后病史摘要按时间顺序整理",
        ],
        patientOnly: "第二份报告是术前检查",
        traps: { status: "confirmed", dose: "20mg" },
      },
      null,
      2,
    ) + "\n",
  );
await writeFile(
  new URL("manifest.json", root),
  JSON.stringify({ version: 1, synthetic: true, patients: manifest }, null, 2) +
    "\n",
);
await writeFile(
  new URL("kb/合成整理规范.txt", root),
  "合成资料整理规范：HTN 表示高血压，T2DM 表示2型糖尿病，CKD 表示慢性肾脏病。资料中的疑似限定词必须保留。只记录有数值的检验结果，预约清单不能作为检验值。此规范只用于软件评测。\n",
);
console.log(
  `Created ${manifest.length} synthetic patients; 30 learning / 10 holdout. Gold requires independent review.`,
);
