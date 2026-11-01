import { AppError, check } from "../../../server/errors.mjs";

// Sex changes renal formulas; a missing or unknown value must not silently
// default to male.
function sexOf(answers) {
  check(answers?.sex === "男" || answers?.sex === "女", "INVALID_INPUT", "「性别」请选择：男 或 女");
  return answers.sex;
}

// Deterministic medical scales and calculators. Every result is a tool
// output for clinician review — the scales support decisions, they never
// make them. Formulas follow the published versions noted per scale.
const choice = (label, points) => ({ label, points });
const yn = (yesPoints, noPoints = 0) => [
  choice("是", yesPoints),
  choice("否", noPoints),
];

const sumChoiceItems = (items, answers) => {
  let score = 0;
  const detail = [];
  for (const item of items) {
    const answer = answers[item.key];
    const selected = item.choices.find((c) => c.label === answer);
    if (selected === undefined)
      throw new AppError(
        "INVALID_INPUT",
        `「${item.label}」请选择：${item.choices.map((c) => c.label).join("/")}`,
      );
    score += selected.points;
    detail.push({ item: item.label, answer, points: selected.points });
  }
  return { score, detail };
};

const num = (answers, item, min, max) => {
  const value = answers[item.key];
  check(
    typeof value === "number" && Number.isFinite(value) && value >= min && value <= max,
    "INVALID_INPUT",
    `「${item.label}」须为 ${min}–${max} 的数值`,
  );
  return value;
};

export const SCALES = [
  {
    id: "cha2ds2-vasc",
    name: "CHA₂DS₂-VASc 房颤卒中风险",
    category: "心血管",
    desc: "非瓣膜性房颤患者的卒中风险分层，指导抗凝决策。",
    items: [
      { key: "chf", label: "充血性心衰/左心功能不全", type: "select", choices: yn(1) },
      { key: "htn", label: "高血压", type: "select", choices: yn(1) },
      { key: "age", label: "年龄", type: "select", choices: [
        choice("≥75 岁", 2), choice("65–74 岁", 1), choice("<65 岁", 0),
      ] },
      { key: "dm", label: "糖尿病", type: "select", choices: yn(1) },
      { key: "stroke", label: "既往卒中/TIA/血栓栓塞", type: "select", choices: yn(2) },
      { key: "vascular", label: "血管疾病（心梗/外周动脉/主动脉斑块）", type: "select", choices: yn(1) },
      { key: "sex", label: "性别", type: "select", choices: [choice("女", 1), choice("男", 0)] },
    ],
    evaluate(answers) {
      const { score, detail } = sumChoiceItems(this.items, answers);
      const isFemale = answers.sex === "女";
      const level =
        (isFemale && score >= 3) || (!isFemale && score >= 2)
          ? "高风险，建议抗凝（需评估出血风险）"
          : (isFemale && score === 2) || (!isFemale && score === 1)
            ? "中风险，可考虑抗凝"
            : "低风险，一般不需抗凝";
      const annualRates = {
        0: "0.2%", 1: "0.3%", 2: "0.9%", 3: "2.3%", 4: "3.9%",
        5: "6.2%", 6: "9.7%", 7: "14.0%", 8: "21.7%", 9: "22.5%",
      };
      const rateNote = annualRates[score]
        ? `年卒中率约 ${annualRates[score]}（Friberg 2012 瑞典房颤队列，未调整）`
        : "";
      return {
        score,
        level,
        interpretation: `${level}。${rateNote}`.trim(),
        detail,
      };
    },
  },
  {
    id: "has-bled",
    name: "HAS-BLED 出血风险",
    category: "心血管",
    desc: "抗凝治疗患者的出血风险分层（≥3 分为高风险，提示加强监测而非拒绝抗凝）。",
    items: [
      { key: "htn", label: "高血压（SBP>160mmHg 未控制）", type: "select", choices: yn(1) },
      { key: "renal", label: "肾功能异常（透析/移植/血肌酐≥200μmol/L）", type: "select", choices: yn(1) },
      { key: "liver", label: "肝功能异常（肝硬化/胆红素2倍/转氨酶3倍）", type: "select", choices: yn(1) },
      { key: "stroke", label: "既往卒中史", type: "select", choices: yn(1) },
      { key: "bleeding", label: "出血史/出血倾向", type: "select", choices: yn(1) },
      { key: "inr", label: "INR 不稳定", type: "select", choices: yn(1) },
      { key: "elderly", label: "年龄 ≥65 岁", type: "select", choices: yn(1) },
      { key: "drugs", label: "联用抗血小板/NSAIDs", type: "select", choices: yn(1) },
      { key: "alcohol", label: "饮酒（≥8 杯/周）", type: "select", choices: yn(1) },
    ],
    evaluate(answers) {
      const { score, detail } = sumChoiceItems(this.items, answers);
      const level =
        score >= 3 ? "高风险：出血风险高，需加强监测与随访，不是抗凝禁忌" : "低-中风险";
      return { score, level, interpretation: level, detail };
    },
  },
  {
    id: "wells-dvt",
    name: "Wells DVT 评分",
    category: "血管",
    desc: "下肢深静脉血栓形成临床可能性评估。",
    items: [
      { key: "cancer", label: "活动性肿瘤（6个月内治疗或姑息）", type: "select", choices: yn(1) },
      { key: "paralysis", label: "下肢瘫痪/近期下肢石膏固定", type: "select", choices: yn(1) },
      { key: "bedridden", label: "卧床>3天或12周内大手术", type: "select", choices: yn(1) },
      { key: "tenderness", label: "深静脉走行区压痛", type: "select", choices: yn(1) },
      { key: "swollenLeg", label: "整条腿肿胀", type: "select", choices: yn(1) },
      { key: "calf", label: "小腿肿胀比对侧>3cm", type: "select", choices: yn(1) },
      { key: "edema", label: "症状侧凹陷性水肿", type: "select", choices: yn(1) },
      { key: "collateral", label: "浅静脉侧支显现", type: "select", choices: yn(1) },
      { key: "priorDvt", label: "既往DVT病史", type: "select", choices: yn(1) },
      { key: "alternative", label: "其他诊断可能性≥DVT", type: "select", choices: yn(-2, 2) },
    ],
    evaluate(answers) {
      const { score, detail } = sumChoiceItems(this.items, answers);
      const level =
        score <= 0 ? "低可能" : score <= 2 ? "中可能" : "高可能";
      return { score, level, interpretation: `DVT 临床可能性：${level}（低/中可能建议 D-二聚体，高可能建议超声）`, detail };
    },
  },
  {
    id: "child-pugh",
    name: "Child-Pugh 肝功能分级",
    category: "消化",
    desc: "肝硬化肝功能储备分级（A/B/C 级）。",
    items: [
      { key: "bilirubin", label: "总胆红素（μmol/L）", type: "select", choices: [
        choice("<34", 1), choice("34–51", 2), choice(">51", 3),
      ] },
      { key: "albumin", label: "白蛋白（g/L）", type: "select", choices: [
        choice(">35", 1), choice("28–35", 2), choice("<28", 3),
      ] },
      { key: "inr", label: "INR", type: "select", choices: [
        choice("<1.7", 1), choice("1.7–2.3", 2), choice(">2.3", 3),
      ] },
      { key: "ascites", label: "腹水", type: "select", choices: [
        choice("无", 1), choice("轻度", 2), choice("中-重度", 3),
      ] },
      { key: "encephalopathy", label: "肝性脑病", type: "select", choices: [
        choice("无", 1), choice("I–II 级", 2), choice("III–IV 级", 3),
      ] },
    ],
    evaluate(answers) {
      const { score, detail } = sumChoiceItems(this.items, answers);
      const level =
        score <= 6 ? "A 级（代偿良好）" : score <= 9 ? "B 级（功能明显损害）" : "C 级（失代偿）";
      return { score, level, interpretation: `Child-Pugh ${level}，1 年生存率大致：A 80–100%，B 45–80%，C 10–45%（供参考）`, detail };
    },
  },
  {
    id: "curb-65",
    name: "CURB-65 肺炎严重度",
    category: "呼吸",
    desc: "社区获得性肺炎严重程度与处置场所评估。",
    items: [
      { key: "confusion", label: "意识混乱（新发）", type: "select", choices: yn(1) },
      { key: "urea", label: "尿素氮 >7 mmol/L", type: "select", choices: yn(1) },
      { key: "rr", label: "呼吸频率 ≥30 次/分", type: "select", choices: yn(1) },
      { key: "bp", label: "收缩压<90 或 舒张压≤60 mmHg", type: "select", choices: yn(1) },
      { key: "age", label: "年龄 ≥65 岁", type: "select", choices: yn(1) },
    ],
    evaluate(answers) {
      const { score, detail } = sumChoiceItems(this.items, answers);
      const level =
        score <= 1 ? "低危，可考虑门诊治疗" : score === 2 ? "中危，建议住院或密切随访" : "高危，建议住院/ICU 评估";
      return { score, level, interpretation: level, detail };
    },
  },
  {
    id: "gcs",
    name: "GCS 格拉斯哥昏迷评分",
    category: "神经",
    desc: "意识障碍程度评估（睁眼+语言+运动）。",
    items: [
      { key: "eye", label: "睁眼反应", type: "select", choices: [
        choice("自动睁眼 (4)", 4), choice("呼唤睁眼 (3)", 3), choice("刺痛睁眼 (2)", 2), choice("无反应 (1)", 1),
      ] },
      { key: "verbal", label: "语言反应", type: "select", choices: [
        choice("回答切题 (5)", 5), choice("回答错误 (4)", 4), choice("答非所问 (3)", 3),
        choice("只能发音 (2)", 2), choice("无反应 (1)", 1),
      ] },
      { key: "motor", label: "运动反应", type: "select", choices: [
        choice("遵嘱动作 (6)", 6), choice("刺痛定位 (5)", 5), choice("刺痛躲避 (4)", 4),
        choice("刺痛屈曲 (3)", 3), choice("刺痛过伸 (2)", 2), choice("无反应 (1)", 1),
      ] },
    ],
    evaluate(answers) {
      const { score, detail } = sumChoiceItems(this.items, answers);
      const level =
        score <= 8 ? "重度（≤8 分，考虑气道保护）" : score <= 12 ? "中度（9–12 分）" : "轻度（13–15 分）";
      return { score, level, interpretation: level, detail };
    },
  },
  {
    id: "adr-five-point",
    name: "药物不良反应五分法因果评价",
    category: "药物警戒",
    desc: "中国药物警戒常用的因果评价（肯定有关/很可能有关/可能有关/可能无关/无关），依据时间关系、已知反应、去激发与再激发证据确定。",
    items: [
      { key: "time", label: "用药与反应有合理的时间关系", type: "select", choices: [
        choice("是", 0), choice("否", 0), choice("不确定", 0),
      ] },
      { key: "known", label: "反应符合该药已知的作用机制/特性/已知不良反应", type: "select", choices: [
        choice("是", 0), choice("否", 0), choice("不确定", 0),
      ] },
      { key: "dechallenge", label: "去激发（停药或减量后反应好转）", type: "select", choices: [
        choice("阳性（好转）", 0), choice("阴性（未好转）", 0), choice("未做/不确定", 0),
      ] },
      { key: "rechallenge", label: "再激发（再次用药后反应再现）", type: "select", choices: [
        choice("阳性（再现）", 0), choice("阴性（未再现）", 0), choice("未做/不确定", 0),
      ] },
      { key: "otherCause", label: "有其他合理原因可解释该反应", type: "select", choices: [
        choice("是", 0), choice("否", 0), choice("不确定", 0),
      ] },
    ],
    evaluate(answers) {
      const need = (key, label) => {
        const value = answers[key];
        if (value === undefined)
          throw new AppError("INVALID_INPUT", `「${label}」请选择：是/否/不确定 或对应选项`);
        return value;
      };
      const time = need("time", this.items[0].label);
      const known = need("known", this.items[1].label);
      const dechallenge = need("dechallenge", this.items[2].label);
      const rechallenge = need("rechallenge", this.items[3].label);
      const otherCause = need("otherCause", this.items[4].label);
      const dechallengePositive = dechallenge === "阳性（好转）";
      const rechallengePositive = rechallenge === "阳性（再现）";
      const otherNo = otherCause === "否";
      let level;
      if (time === "否") level = "无关";
      else if (
        time === "是" && known === "是" && dechallengePositive &&
        rechallengePositive && otherNo
      )
        level = "肯定有关";
      else if (
        time === "是" && known === "是" && dechallengePositive &&
        !rechallengePositive && otherNo
      )
        level = "很可能有关";
      else if (
        dechallenge !== "阳性（好转）" && !rechallengePositive && otherCause === "是"
      )
        level = "可能无关";
      else level = "可能有关";
      const twoPoint = ["肯定有关", "很可能有关", "可能有关"].includes(level)
        ? "相关"
        : "不相关";
      const detail = [
        { item: "时间关系", answer: time, points: 0 },
        { item: "已知反应", answer: known, points: 0 },
        { item: "去激发", answer: dechallenge, points: 0 },
        { item: "再激发", answer: rechallenge, points: 0 },
        { item: "其他原因", answer: otherCause, points: 0 },
      ];
      return {
        score: level,
        level,
        interpretation: `五分法：${level}；二分法：${twoPoint}。去激发/再激发证据变化会改变分级，请随新证据重新评估。`,
        detail,
      };
    },
  },
  {
    id: "naranjo",
    name: "Naranjo 药物不良反应因果评估",
    category: "药物警戒",
    desc: "判定药物与不良反应的因果关系：≥9 肯定，5–8 很可能，1–4 可能，≤0 可疑。",
    items: [
      { key: "q1", label: "既往是否有该反应的确定性报告", type: "select", choices: yn(1) },
      { key: "q2", label: "反应是否发生在用药之后", type: "select", choices: [
        choice("是", 2), choice("否", -1), choice("不确定", 0),
      ] },
      { key: "q3", label: "停药后反应是否好转", type: "select", choices: yn(1) },
      { key: "q4", label: "再次用药后反应是否再次出现", type: "select", choices: [
        choice("是", 2), choice("否", -1), choice("未再用药/不确定", 0),
      ] },
      { key: "q5", label: "是否存在其他原因可以解释该反应", type: "select", choices: [
        choice("否", 2), choice("是", -1), choice("不确定", 0),
      ] },
      { key: "q6", label: "安慰剂对照时是否也出现该反应", type: "select", choices: [
        choice("否", 1), choice("是", -1), choice("未测/不确定", 0),
      ] },
      { key: "q7", label: "血/体液中是否检测到该药物", type: "select", choices: yn(1) },
      { key: "q8", label: "是否存在剂量-反应关系", type: "select", choices: yn(1) },
      { key: "q9", label: "既往用同一药是否出现过类似反应", type: "select", choices: yn(1) },
      { key: "q10", label: "是否有客观证据确认该反应", type: "select", choices: yn(1) },
    ],
    evaluate(answers) {
      const { score, detail } = sumChoiceItems(this.items, answers);
      const level =
        score >= 9 ? "肯定（definite）" : score >= 5 ? "很可能（probable）" : score >= 1 ? "可能（possible）" : "可疑（doubtful）";
      return { score, level, interpretation: `因果关系：${level}`, detail };
    },
  },
  {
    id: "egfr",
    name: "eGFR 估算肾小球滤过率（CKD-EPI 2021）",
    category: "肾脏",
    desc: "按血肌酐、年龄、性别估算 eGFR（mL/min/1.73m²），用于 CKD 分期与用药调整。",
    items: [
      { key: "creatinine", label: "血肌酐（μmol/L）", type: "number", min: 10, max: 3000 },
      { key: "age", label: "年龄（岁）", type: "number", min: 1, max: 120 },
      { key: "sex", label: "性别", type: "select", choices: [choice("女", 0), choice("男", 0)] },
    ],
    evaluate(answers) {
      const scr = num(answers, this.items[0], 10, 3000) / 88.4; // → mg/dL
      const age = num(answers, this.items[1], 1, 120);
      const female = sexOf(answers) === "女";
      const kappa = female ? 0.7 : 0.9;
      const alpha = female ? -0.241 : -0.302;
      const ratio = scr / kappa;
      const value =
        142 *
        Math.pow(Math.min(ratio, 1), alpha) *
        Math.pow(Math.max(ratio, 1), -1.2) *
        Math.pow(0.9938, age) *
        (female ? 1.012 : 1);
      const egfr = Math.round(value * 10) / 10;
      const stage =
        egfr >= 90 ? "G1（正常或偏高）" : egfr >= 60 ? "G2（轻度下降）"
        : egfr >= 45 ? "G3a（轻-中度下降）" : egfr >= 30 ? "G3b（中-重度下降）"
        : egfr >= 15 ? "G4（重度下降）" : "G5（肾衰竭）";
      return { score: egfr, level: stage, interpretation: `eGFR ${egfr} mL/min/1.73m²，CKD 分期 ${stage}（肾损害标志需结合尿检/影像）`, detail: [{ item: "公式", answer: "CKD-EPI 2021（不需种族系数）", points: 0 }] };
    },
  },
  {
    id: "crcl",
    name: "肌酐清除率 CrCl（Cockcroft-Gault）",
    category: "肾脏",
    desc: "用于经肾排泄药物（如地高辛、抗凝剂、部分抗生素）的剂量调整。",
    items: [
      { key: "age", label: "年龄（岁）", type: "number", min: 1, max: 120 },
      { key: "weight", label: "体重（kg）", type: "number", min: 2, max: 300 },
      { key: "creatinine", label: "血肌酐（μmol/L）", type: "number", min: 10, max: 3000 },
      { key: "sex", label: "性别", type: "select", choices: [choice("女", 0), choice("男", 0)] },
    ],
    evaluate(answers) {
      const age = num(answers, this.items[0], 1, 120);
      const weight = num(answers, this.items[1], 2, 300);
      const scr = num(answers, this.items[2], 10, 3000) / 88.4;
      const female = sexOf(answers) === "女";
      const value = ((140 - age) * weight) / (72 * scr) * (female ? 0.85 : 1);
      const crcl = Math.round(value);
      const level =
        crcl >= 60 ? "≥60：多数药物无需调整" : crcl >= 30 ? "30–59：中度下降，部分药物需减量" : crcl >= 15 ? "15–29：重度下降，多数经肾药物需调整" : "<15：肾衰竭水平";
      return { score: crcl, level, interpretation: `CrCl ≈ ${crcl} mL/min。${level}（具体药物调整请对照说明书）`, detail: [] };
    },
  },
  {
    id: "bmi",
    name: "BMI 体重指数（中国标准）",
    category: "营养",
    desc: "体重(kg) ÷ 身高(m)²；按中国成人标准分级。",
    items: [
      { key: "weight", label: "体重（kg）", type: "number", min: 2, max: 300 },
      { key: "height", label: "身高（cm）", type: "number", min: 40, max: 250 },
    ],
    evaluate(answers) {
      const weight = num(answers, this.items[0], 2, 300);
      const height = num(answers, this.items[1], 40, 250) / 100;
      const bmi = Math.round((weight / (height * height)) * 10) / 10;
      const level =
        bmi < 18.5 ? "偏瘦" : bmi < 24 ? "正常" : bmi < 28 ? "超重" : "肥胖";
      return { score: bmi, level, interpretation: `BMI ${bmi}：${level}（中国成人标准）`, detail: [] };
    },
  },
  {
    id: "bsa",
    name: "体表面积 BSA（Mosteller）",
    category: "营养",
    desc: "√(身高cm × 体重kg / 3600)，用于化疗等按体表面积给药。",
    items: [
      { key: "weight", label: "体重（kg）", type: "number", min: 2, max: 300 },
      { key: "height", label: "身高（cm）", type: "number", min: 40, max: 250 },
    ],
    evaluate(answers) {
      const weight = num(answers, this.items[0], 2, 300);
      const height = num(answers, this.items[1], 40, 250);
      const bsa = Math.round(Math.sqrt((height * weight) / 3600) * 100) / 100;
      return { score: bsa, level: "m²", interpretation: `BSA ≈ ${bsa} m²（Mosteller 公式；按体表面积给药请再核对方案单位）`, detail: [] };
    },
  },
  {
    id: "ecog-ps",
    name: "ECOG 体力状态评分（PS）",
    category: "肿瘤",
    desc: "肿瘤患者活动状态 0–5 分（Oken 1982），常作为化疗/临床试验入排标准。",
    items: [
      { key: "ps", label: "活动状态", type: "select", choices: [
        choice("0 活动能力完全正常，与起病前活动能力无任何差异", 0),
        choice("1 能自由走动及从事轻体力活动，包括一般家务或办公室工作，但不能从事较重的体力活动", 1),
        choice("2 能自由走动及生活自理，但已丧失工作能力，日间不少于一半时间可以起床活动", 2),
        choice("3 生活仅能部分自理，日间一半以上时间卧床或坐轮椅", 3),
        choice("4 卧床不起，生活不能自理", 4),
        choice("5 死亡", 5),
      ] },
    ],
    evaluate(answers) {
      const { score, detail } = sumChoiceItems(this.items, answers);
      const level =
        score <= 1 ? "适合多数细胞毒性化疗与临床试验入组"
          : score === 2 ? "可考虑减量/姑息性化疗，需谨慎评估"
            : score <= 4 ? "通常不宜细胞毒性化疗，以支持/姑息治疗为主"
              : "—";
      return { score, level, interpretation: `ECOG PS = ${score}。${level}（Oken 1982；入组判定以具体试验方案为准）。`, detail };
    },
  },
  {
    id: "kps",
    name: "Karnofsky 功能状态评分（KPS）",
    category: "肿瘤",
    desc: "Karnofsky 行为状态 0–100 分（百分制），用于肿瘤患者功能状态与治疗耐受性评估。",
    items: [
      { key: "kps", label: "功能状态", type: "select", choices: [
        choice("100 正常，无症状及体征", 100),
        choice("90 能进行正常活动，有轻微症状及体征", 90),
        choice("80 勉强可进行正常活动，有一些症状或体征", 80),
        choice("70 生活可自理，但不能维持正常生活或工作", 70),
        choice("60 有时需人扶助，但大多数时间可自理", 60),
        choice("50 常需人照料及医疗护理", 50),
        choice("40 生活不能自理，需特别照顾及护理", 40),
        choice("30 生活严重不能自理，需住院", 30),
        choice("20 病重，需住院积极支持治疗", 20),
        choice("10 病危，临近死亡", 10),
        choice("0 死亡", 0),
      ] },
    ],
    evaluate(answers) {
      const { score, detail } = sumChoiceItems(this.items, answers);
      const level =
        score >= 80 ? "非依赖级：可正常或接近正常生活与工作"
          : score >= 50 ? "半依赖级：需要不同程度帮助，多可考虑减量抗肿瘤治疗"
            : score >= 10 ? "依赖级：以支持/姑息治疗为主"
              : "—";
      return { score, level, interpretation: `KPS = ${score} 分。${level}（Karnofsky 1949）。`, detail };
    },
  },
  {
    id: "nrs-pain",
    name: "NRS 疼痛数字评定量表",
    category: "症状评估",
    desc: "0–10 数字评定疼痛强度（0 无痛，10 能想象的最剧烈疼痛），癌痛滴定与随访常用。",
    items: [
      { key: "pain", label: "过去 24 小时最重疼痛（0–10）", type: "number", min: 0, max: 10 },
    ],
    evaluate(answers) {
      const pain = num(answers, this.items[0], 0, 10);
      const level =
        pain === 0 ? "无痛"
          : pain <= 3 ? "轻度疼痛（一般不影响睡眠）"
            : pain <= 6 ? "中度疼痛（影响睡眠，需处理）"
              : "重度疼痛（剧痛，必须处理）";
      return { score: pain, level, interpretation: `NRS ${pain} 分：${level}。建议结合镇静程度评估（如 PAD）指导镇痛滴定。`, detail: [] };
    },
  },
  {
    id: "rass",
    name: "RASS 镇静躁动评分",
    category: "症状评估",
    desc: "Richmond 躁动-镇静评分（+4 至 −5），镇痛镇静（ICU/姑息）深度监测标准工具。",
    items: [
      { key: "rass", label: "镇静躁动状态", type: "select", choices: [
        choice("+4 有攻击性：明显好斗，有暴力行为，对人员有直接危险", 4),
        choice("+3 非常躁动：拔拽管路或导管，有攻击性", 3),
        choice("+2 躁动：频繁无意义动作，人机对抗", 2),
        choice("+1 不安：焦虑紧张，但动作不剧烈", 1),
        choice("0 清醒平静", 0),
        choice("−1 嗜睡：不完全警觉，呼唤能清醒≥10 秒", -1),
        choice("−2 轻度镇静：呼唤能短暂清醒（<10 秒）", -2),
        choice("−3 中度镇静：呼唤或轻摇有任何反应", -3),
        choice("−4 深度镇静：呼唤或轻摇无反应，物理刺激有反应", -4),
        choice("−5 不能唤醒：物理刺激也无反应", -5),
      ] },
    ],
    evaluate(answers) {
      const { score, detail } = sumChoiceItems(this.items, answers);
      const level =
        score === 0 ? "清醒平静（目标区间）"
          : score === -1 ? "嗜睡，接近目标区间"
            : score <= -2 && score >= -3 ? "镇静偏深，请核对镇静方案与呼吸/循环"
              : score < -3 ? "深镇静/不能唤醒，需立即评估"
                : "躁动，需查找原因并处理";
      return { score, level, interpretation: `RASS ${score > 0 ? "+" + score : score}。${level}（Sessler 2002；一般目标 RASS 0 至 −1，按方案执行）。`, detail };
    },
  },
];

const scaleById = (id) => {
  check(typeof id === "string" && id, "INVALID_INPUT", "量表编号无效");
  const scale = SCALES.find((s) => s.id === id);
  check(scale, "NOT_FOUND", `未找到量表：${id}`, 404);
  return scale;
};

export function listScales() {
  return SCALES.map(({ id, name, category, desc, items }) => ({
    id,
    name,
    category,
    desc,
    items,
  }));
}

export function calculateScale(id, answers = {}) {
  const scale = scaleById(id);
  check(
    answers && typeof answers === "object" && !Array.isArray(answers),
    "INVALID_INPUT",
    "答案须为对象",
  );
  const result = scale.evaluate(answers);
  return {
    scaleId: scale.id,
    scaleName: scale.name,
    ...result,
    note: "工具按公开公式确定性计算，结果供临床参考，需医生结合患者整体情况判断。",
  };
}

export function scaleTools() {
  const definition = (name, description, properties, required = []) => ({
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    },
  });
  return [
    {
      definition: definition(
        "medical_scale_list",
        "列出可用的医学评分量表与计算器（房颤卒中、出血风险、DVT、肝功能、肺炎、昏迷、Naranjo 药物因果评估、ECOG 体力状态、Karnofsky 功能状态、NRS 疼痛、eGFR、肌酐清除率、BMI、体表面积等）。",
        {},
        [],
      ),
      execute: () => ({
        scales: listScales().map(({ id, name, category, desc, items }) => ({
          id,
          name,
          category,
          desc,
          items,
        })),
      }),
    },
    {
      definition: definition(
        "medical_scale_calculate",
        "按量表编号计算医学评分。answers 的键为量表条目 key，选择题填选项文本，数值题填数字。",
        {
          scaleId: { type: "string" },
          answers: { type: "object", additionalProperties: true },
        },
        ["scaleId", "answers"],
      ),
      execute: (args) => {
        const result = calculateScale(args.scaleId, args.answers);
        const scale = scaleById(args.scaleId);
        return {
          ...result,
          formula: scale.desc,
          inputs: scale.items.map((item) => ({
            label: item.label,
            value: args.answers[item.key],
          })),
        };
      },
    },
  ];
}
