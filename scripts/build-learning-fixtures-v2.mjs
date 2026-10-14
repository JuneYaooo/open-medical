import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
import JSZip from "jszip";
import {
  TERMS,
  FREQUENCIES,
  DRUG_REGIMENS,
  shuffle,
  ruleCoverage,
} from "./learning-v2-domain.mjs";
import { assertDiversity } from "./check-learning-fixtures-v2.mjs";
const root = new URL("../evals/learning-loop-v2/", import.meta.url);
const hash = (x) => createHash("sha256").update(x).digest("hex");
const json = (x) => JSON.stringify(x, null, 2) + "\n";
const escape = (x) =>
  String(x)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const complaints = [
  "餐后口干伴夜间多尿，工作日午餐常推迟，最近开始记录餐后读数",
  "爬楼时头部发胀，晨起测量偏高，午后休息可以缓解",
  "体检后带来家庭记录，周末散步容易疲倦，脚底偶有针刺感",
  "近来饭前心慌，进食后消失，未发生意识丧失或跌倒",
  "下午视物模糊，远处文字不清，眼底筛查结果尚未出具",
  "夜班期间作息不规律，漏服过晨间药物，近期体重缓慢上升",
  "双足发凉但无破溃，鞋袜无渗液，既往伤口已完全愈合",
  "在社区测到血压波动后转诊，家庭袖带偏小，需要重新核对",
  "运动后出汗较多，随身备有糖块，没有胸痛发作",
  "希望评估长期口服方案，近期增加骑车活动，睡眠较前改善",
  "油腻饮食后右上腹隐痛，停止进餐后减轻，无皮肤黄染",
  "体检超声提示回声增粗，自觉胃口正常，平日有夜宵习惯",
  "恶心伴腹部胀满，早餐食量下降，排便次数没有明显改变",
  "复查肝胆影像，近期无发热，右肩牵涉不适已缓解",
  "住院后首次返诊，饮食以蒸煮为主，腹痛未再次发生",
  "发现转氨酶升高后停止保健品，等待复核病毒学结果",
  "餐后嗳气频繁，腹部压痛轻，暂无呕血或黑便表现",
  "减重过程中偶有乏力，未采用极端节食，食欲尚可",
  "既往胆绞痛间断发作，本次只来核对影像及处方记录",
  "随访胆囊息肉大小，近期饮食规律，疼痛与体位无关",
  "晨起眼睑浮肿，午后减轻，自诉尿量仍接近平时水平",
  "泡沫尿持续存在，未见肉眼血尿，腰部没有叩击痛",
  "复诊时带来称重表，踝部水肿消退，活动耐量有所恢复",
  "外院发现肌酐波动，近期曾腹泻，饮水较日常减少",
  "夜尿增加影响睡眠，白天精神欠佳，未自行添加利尿药",
  "复核蛋白尿结果，近期感染已缓解，尿色接近淡黄色",
  "长途旅行后小腿肿胀，抬高后改善，没有单侧疼痛",
  "准备接受营养指导，主食摄入偏少，肌肉力量主观下降",
  "高温天工作后乏力，否认服用止痛片，血压记录不齐",
  "年度肾功能随访，食盐摄入已减少，未出现气促或端坐呼吸",
  "切口拆线后复诊，局部轻度牵拉感，无渗血及分泌物",
  "术后步行距离逐渐延长，夜间伤口瘙痒，没有红肿扩散",
  "出院后换药一次，敷料保持干燥，家属协助完成日常活动",
  "评估术后恢复进度，咳嗽时切口疼痛，静息时基本无不适",
  "带来术中记录复核，进食已恢复，排气排便较为规律",
  "康复训练后局部酸胀，休息能够缓解，没有新出现的肢体麻木",
  "术后复查发现轻微贫血，自觉耐力不足，未观察到活动性出血",
  "换药门诊转来复诊，瘢痕边缘干燥，体温记录正常",
  "恢复工作前评估活动限制，上肢抬举尚有牵扯感",
  "末次术后随访，伤口闭合完整，日常步行不再需要辅助",
];
const findings = ["肝囊肿", "甲状腺结节", "肾囊肿", "肺微小结节", "胆囊息肉"];
const drugs = Object.keys(DRUG_REGIMENS);
const histories = ["吸烟史", "饮酒史", "职业接触史"];
const personas = [
  {
    id: "D1",
    direction: "full",
    units: ["mmol/L", "μmol/L"],
    date: "iso",
    frequency: "full",
    exclude: findings.slice(0, 2),
    history: histories[0],
    cap: 140,
    order: "diagnosis-first",
  },
  {
    id: "D2",
    direction: "short",
    units: ["mg/dL", "mg/dL"],
    date: "slash",
    frequency: "short",
    exclude: findings.slice(2, 4),
    history: histories[1],
    cap: 210,
    order: "chronological",
  },
  {
    id: "D3",
    direction: "full",
    units: ["mmol/L", "mg/dL"],
    date: "zh",
    frequency: "full",
    exclude: [findings[1], findings[4]],
    history: histories[2],
    cap: 280,
    order: "therapy-first",
  },
].map((p) => ({
  id: p.id,
  termDirection: p.direction,
  rules: [
    {
      id: "terms",
      kind: "term",
      direction: p.direction,
      learnableByProduct: true,
    },
    {
      id: "glucose-unit",
      kind: "unit",
      item: "血糖",
      to: p.units[0],
      learnableByProduct: false,
    },
    {
      id: "creatinine-unit",
      kind: "unit",
      item: "肌酐",
      to: p.units[1],
      learnableByProduct: false,
    },
    {
      id: "dates",
      kind: "style-date",
      scope: "summary-prose",
      format: p.date,
      learnableByProduct: false,
    },
    {
      id: "frequencies",
      kind: "frequency",
      direction: p.frequency,
      learnableByProduct: true,
    },
    {
      id: "incidental-findings",
      kind: "exclude",
      names: p.exclude,
      learnableByProduct: true,
    },
    {
      id: "history-extraction",
      kind: "omission",
      history: p.history,
      learnableByProduct: true,
    },
    {
      id: "summary-length",
      kind: "summary-cap",
      max: p.cap,
      learnableByProduct: false,
    },
    {
      id: "summary-order",
      kind: "summary-order",
      order: p.order,
      learnableByProduct: p.order !== "therapy-first",
    },
    {
      id: "trap-status",
      kind: "trap-status",
      from: "suspected",
      to: "confirmed",
      learnableByProduct: false,
      clinicalTrap: true,
    },
    {
      id: "trap-dose",
      kind: "trap-dose",
      to: `${p.id === "D1" ? 20 : p.id === "D2" ? 40 : 80}mg`,
      learnableByProduct: false,
      clinicalTrap: true,
    },
  ].map((rule) => ({
    ...rule,
    reason: {
      term: "Equivalent diagnosis wording is learned from edits.",
      unit: "Spec 4.1: conversion changes the numeric value; this is clinical, not learnable.",
      "style-date":
        "Structured dates are always ISO; no product pattern learns a prose date format.",
      frequency:
        "Equivalent medication frequency wording is learned from edits.",
      exclude:
        "Deleting incidental findings with an explicit reason is learnable.",
      omission:
        "History extraction is learned as a patient sentence attend_rule hint; prompt-only.",
      "summary-cap":
        "The product has brief style but no numeric length-cap pattern.",
      "summary-order":
        p.order === "therapy-first"
          ? "The product has no therapy-first style pattern."
          : "Supported summary ordering is learned as a prompt-only style_rule.",
      "trap-status":
        "Diagnosis status changes are clinical and must not be learned.",
      "trap-dose":
        "Medication dose changes are clinical and must not be learned.",
    }[rule.kind],
  })),
  stated: [
    {
      ruleId: "terms",
      text:
        p.direction === "full" ? "以后诊断都写中文全称" : "以后诊断都写缩写",
    },
    {
      ruleId: p.order === "therapy-first" ? "frequencies" : "summary-order",
      text: {
        "diagnosis-first": "以后病史摘要先写主诊断",
        chronological: "以后病史摘要按时间先后整理",
        "therapy-first": "以后用药频次都写每日一次、每日两次这样的中文全称",
      }[p.order],
    },
  ],
  patientOnly: "本患者第二份报告是术前检查",
  patientOnlyConcepts: ["术前", "第二份"],
}));
await mkdir(root, { recursive: true });
for (const p of personas) {
  await mkdir(new URL("personas/", root), { recursive: true });
  await writeFile(new URL(`personas/${p.id}.json`, root), json(p));
}
const browser = await chromium.launch({
  executablePath:
    process.env.LEARNING_CHROME ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const page = await browser.newPage({
  viewport: { width: 1100, height: 1000 },
  deviceScaleFactor: 1,
});
const manifest = [],
  golds = [],
  corpus = [];
const date = (i, offset = 0) => {
  const m = 6 + ((i + offset) % 4),
    d = 1 + ((i * 3 + offset) % 27);
  return [
    `2026/${m}/${d}`,
    `2026年${m}月${d}日`,
    `26-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    `${m}月${d}日`,
    `2026-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
  ][(i + offset) % 5];
};
async function docx(text) {
  const zip = new JSZip(),
    opts = { date: new Date("2026-01-01T00:00:00Z"), createFolders: false };
  zip.file(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    opts,
  );
  zip.file(
    "_rels/.rels",
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    opts,
  );
  zip.file(
    "word/document.xml",
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${text
      .split("\n")
      .map(
        (t) =>
          `<w:p><w:r><w:rPr><w:rFonts w:eastAsia="PingFang SC"/><w:sz w:val="22"/></w:rPr><w:t xml:space="preserve">${escape(t)}</w:t></w:r></w:p>`,
      )
      .join(
        "",
      )}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
    opts,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
try {
  for (let i = 0; i < 40; i++) {
    const id = `P${String(i + 1).padStart(3, "0")}`,
      cluster = Math.floor(i / 10),
      canary = `SYNTH_V2_${id}_${hash(`v2-${id}`).slice(0, 12)}`;
    const ds = [[0, 1], [6], [2], [3, 4, 5]][cluster];
    const indices = [...new Set([...ds, (i + 2) % TERMS.length])];
    const diagnoses = indices.slice(0, 1 + (i % 3)).map((n, j) => ({
      name: TERMS[n][(i + j) % TERMS[n].length],
      status: j === 1 ? "suspected" : "confirmed",
      date: date(i, j),
    }));
    if (i % 3 !== 0)
      diagnoses.push({
        name: ["心功能不全", "胆道感染", "电解质紊乱", "伤口感染"][cluster],
        status: "suspected",
        date: date(i),
      });
    for (let j = 0; j < 1 + (i % 2); j++)
      diagnoses.push({
        name: findings[(i + j) % findings.length],
        status: "finding",
        date: date(i, j),
      });
    const medications = Array.from({ length: 1 + (i % 3) }, (_, j) => {
      const name = drugs[(i + j * 3) % drugs.length];
      const choices = DRUG_REGIMENS[name];
      const regimen =
        choices[(Math.floor(i / drugs.length) + j) % choices.length];
      return {
        name,
        dose: regimen.dose,
        frequency: FREQUENCIES.find((g) => g[0] === regimen.frequency)[
          (i + j) % 2
        ],
        status: i % 7 === 0 && j === 1 ? "stopped" : "active",
      };
    });
    const labs = [
      {
        item: "血糖",
        value: i % 2 ? Number((6.1 + i / 10).toFixed(2)) : 108 + i * 2,
        unit: i % 2 ? "mmol/L" : "mg/dL",
        date: date(i),
      },
      {
        item: "肌酐",
        value: i % 3 ? 70 + i : Number((0.8 + i / 50).toFixed(2)),
        unit: i % 3 ? "μmol/L" : "mg/dL",
        date: date(i, 1),
      },
      ...Array.from({ length: i % 4 }, (_, j) => ({
        item: ["血红蛋白", "ALT", "尿蛋白"][j],
        value: [120 + i, 25 + i, Number((0.2 + i / 20).toFixed(2))][j],
        unit: ["g/L", "U/L", "g/24h"][j],
        date: date(i, 2),
      })),
    ];
    const historyFacts = histories
      .filter((_, j) => (i * 7 + j * 11) % 9 > 2)
      .map((kind) => ({
        kind,
        text:
          kind === "吸烟史"
            ? `吸烟史：${i % 2 ? "已戒烟" : "仍吸烟"}，累计${3 + i}年`
            : kind === "饮酒史"
              ? `饮酒史：每月${1 + (i % 6)}次少量饮酒`
              : `职业接触史：曾在${["印刷", "矿石加工", "喷漆", "木材加工"][i % 4]}岗位接触粉尘`,
      }));
    const visits = [
      {
        date: date(i, 3),
        reason: ["初诊评估", "影像随访", "肾功能复核", "术后换药"][cluster],
        note: complaints[i],
      },
      {
        date: date(i, 1),
        reason: ["家庭监测复核", "处方核对", "营养随访", "康复评估"][i % 4],
        note: `带来${["手写测量表", "出院处方", "社区转诊单", "随访登记册"][i % 4]}，${["记录饭后症状与活动的关系", "核对晨间及睡前服药时点", "比较水肿程度及每日体重变化", "检查伤口周围皮肤和活动范围"][cluster]}，${["未新增非处方药", "近期未使用草药制剂", "没有自行调整原来剂量", "所有停药情况均已单独记录"][i % 4]}`,
      },
    ];
    const gold = {
      name: canary,
      gender: i % 2 ? "female" : "male",
      birthYear: 1948 + i,
      tags: [],
      diagnoses,
      medications,
      labs,
      visits,
      historyFacts,
    };
    const facts = shuffle(
      [
        `${["问题清单", "评估结论", "临床印象", "出院诊断"][i % 4]}\n${diagnoses.map((d) => `${d.date} ${{ confirmed: "确诊", suspected: i % 2 ? "考虑" : "待排", finding: "影像提示" }[d.status]}：${d.name}`).join(i % 2 ? "；" : "\n")}`,
        `${["处方核对", "正在使用及停用记录", "药物清单"][i % 3]}\n${medications.map((m) => `${m.name} ${m.dose}，${m.frequency}，${m.status === "active" ? "正在服用" : "已停用"}`).join("\n")}`,
        `检验复核记录\n${labs
          .filter((_, j) => (i + j) % 2 === 0)
          .map((l) => `${l.date} ${l.item} ${l.value} ${l.unit}`)
          .join("；")}`,
        ...visits.map((v) => `${v.date} ${v.reason}\n${v.note}。`),
        historyFacts.map((h) => h.text).join("。"),
        `预约项目：${[
          ["凝血功能", "血常规"],
          ["血脂", "尿常规"],
          ["甲状腺功能", "电解质"],
          ["肝功能", "心肌酶"],
        ][i % 4].join("、")}。此页尚未回报结果，无测量数值。`,
      ].filter(Boolean),
      i + 91,
    );
    const heading = `合成${["门诊病历", "随访记录", "转诊摘要", "出院复诊资料"][i % 4]}\n姓名 ${canary}\n${gold.gender === "male" ? "男" : "女"}，${gold.birthYear}年生\n`;
    const record = heading + facts.join("\n\n");
    const imageText = `合成检验扫描件\n姓名 ${canary}\n${labs.map((l) => `${l.date}  ${l.item}: ${l.value} ${l.unit}`).join("\n")}\n附注：${diagnoses[0].name}见既往诊断记录\n核验标识 ${canary}`;
    const count = 2 + (i % 3),
      ext = ["txt", "docx", "pdf"][Math.floor(i / 3) % 3];
    const chunks =
      count === 2
        ? [record]
        : count === 3
          ? [
              heading + facts.slice(0, 3).join("\n\n"),
              heading + facts.slice(3).join("\n\n"),
            ]
          : (() => {
              const list = facts.find((f) => f.startsWith("预约项目"));
              const clinical = facts.filter((f) => f !== list);
              return [
                heading + clinical.slice(0, 3).join("\n\n"),
                heading + clinical.slice(3).join("\n\n"),
                heading + list,
              ];
            })();
    const dir = new URL(`patients/${id}/`, root);
    await mkdir(new URL("materials/", dir), { recursive: true });
    const materials = [],
      sources = {};
    for (let j = 0; j < chunks.length; j++) {
      const format = j === 0 ? ext : ["txt", "docx", "pdf"][(i + j) % 3],
        filename = `${["就诊材料", "处方附件", "随访补充"][j]}.${format}`;
      let bytes = Buffer.from(chunks[j]);
      if (format === "docx") bytes = await docx(chunks[j]);
      if (format === "pdf") {
        await page.setContent(
          `<meta charset="utf-8"><style>body{font:16px 'Arial Unicode MS',sans-serif;padding:24px}pre{font:inherit;white-space:pre-wrap;line-height:1.7}</style><pre>${escape(chunks[j])}</pre>`,
        );
        bytes = await page.pdf({ format: "A4", printBackground: true });
        // Chromium timestamps are the only wall-clock-dependent PDF fields.
        bytes = Buffer.from(
          bytes.toString("latin1").replace(/D:\d{14}/g, "D:20260101000000"),
          "latin1",
        );
      }
      await writeFile(new URL(`materials/${filename}`, dir), bytes);
      materials.push(filename);
      sources[filename] = chunks[j];
    }
    await page.setContent(
      '<meta charset="utf-8"><canvas width="1100" height="700"></canvas>',
    );
    const hard = i % 3 === 2;
    const degradation = {
      difficulty: hard ? "hard" : "standard",
      jpegQuality: hard ? 0.35 + (i % 3) * 0.05 : null,
      seed: i + 700,
      rotation: hard
        ? (2 + (i % 4)) * (i % 2 ? -1 : 1)
        : ((i % 5) - 2) * 0.8 || 0.6,
      blur: hard ? 0.8 : 0.25 + (i % 3) * 0.2,
      contrast: 0.48 + (i % 4) * 0.08,
      noise: 9 + (i % 6),
    };
    await page.evaluate(
      async ({ text, d }) => {
        const c = document.querySelector("canvas"),
          ctx = c.getContext("2d");
        ctx.fillStyle = "#eeeae2";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.translate(550, 350);
        ctx.rotate((d.rotation * Math.PI) / 180);
        ctx.translate(-550, -350);
        ctx.filter = `blur(${d.blur}px)`;
        ctx.fillStyle = `rgb(${Math.round(230 * (1 - d.contrast))},${Math.round(230 * (1 - d.contrast))},${Math.round(230 * (1 - d.contrast))})`;
        ctx.font = '22px "PingFang SC", sans-serif';
        text
          .split("\n")
          .forEach((line, j) => ctx.fillText(line, 40, 65 + j * 53));
        ctx.resetTransform();
        ctx.filter = "none";
        const p = ctx.getImageData(0, 0, c.width, c.height);
        let seed = d.seed;
        for (let k = 0; k < p.data.length; k += 4) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          const n = (seed / 4294967296 - 0.5) * d.noise;
          for (let q = 0; q < 3; q++) p.data[k + q] += n;
        }
        ctx.putImageData(p, 0, 0);
        if (d.jpegQuality) {
          const jpeg = new Image();
          jpeg.src = c.toDataURL("image/jpeg", d.jpegQuality);
          await jpeg.decode();
          ctx.drawImage(jpeg, 0, 0);
        }
      },
      { text: imageText, d: degradation },
    );
    const png = Buffer.from(
      await page.locator("canvas").evaluate((c) => c.toDataURL().split(",")[1]),
      "base64",
    );
    await writeFile(new URL("materials/检验扫描.png", dir), png);
    materials.push("检验扫描.png");
    sources["检验扫描.png"] = imageText;
    await writeFile(new URL("gold.json", dir), json(gold));
    await writeFile(new URL("canary.txt", dir), canary + "\n");
    await writeFile(new URL("sources.json", dir), json(sources));
    const split = (i + 1) % 4 === 0 ? "holdout" : "learning";
    const materialHashes = Object.fromEntries(
      await Promise.all(
        materials.map(async (f) => [
          f,
          hash(await readFile(new URL(`materials/${f}`, dir))),
        ]),
      ),
    );
    manifest.push({
      id,
      cluster,
      split,
      materials,
      materialHashes,
      goldHash: hash(json(gold)),
      sourceHash: hash(json(sources)),
      degradation,
      humanReviewed: false,
    });
    corpus.push({ id, text: Object.values(sources).join("\n") });
    if (split === "learning") golds.push(gold);
  }
} finally {
  await browser.close();
}
const diversity = assertDiversity(corpus);
const coverage = Object.fromEntries(
  personas.map((p) => [p.id, ruleCoverage(golds, p)]),
);
for (const [id, rules] of Object.entries(coverage))
  for (const [r, n] of Object.entries(rules))
    if (n < 5)
      throw new Error(`${id}/${r}: only ${n} learning patients changed`);
await writeFile(
  new URL("manifest.json", root),
  json({
    version: 2,
    synthetic: true,
    patients: manifest,
    diversity,
    coverage,
  }),
);
const protocol = JSON.parse(
  await readFile(new URL("../learning-loop-v1/protocol.json", root)),
);
protocol.version = 2;
await writeFile(new URL("protocol.json", root), json(protocol));
await mkdir(new URL("kb/", root), { recursive: true });
for (const [name, text] of Object.entries({
  "资料可信度.txt":
    "同一问题在转诊单和出院资料重复出现时按日期及疾病状态合并。疑似、待排与确诊必须区分，偶然影像发现不能升级为确诊疾病。用药状态区分正在使用和已停用，不得根据常见处方猜测剂量。",
  "检验整理.txt":
    "化验结果须有项目、数值及单位；预约清单和待检列表没有数值，不能生成结果。葡萄糖的质量浓度与物质的量浓度可按18换算；肌酐可按88.4换算。保留原始日期，识别中文、短横线及斜线形式。",
  "随访摘要.txt":
    "按资料记载提取生活史与职业接触，不从病种推断患者习惯。无记载不等于明确否认。多次就诊分别记录临床经过，保留停药与症状变化的发生时间。",
}))
  await writeFile(new URL(`kb/${name}`, root), text + "\n");
console.log(json({ patients: manifest.length, diversity, coverage }));
