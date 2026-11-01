// Data for the medication reminder engine (med-safety.mjs). Pure data, no
// Node dependencies: the patient page imports it in the browser.
//
// Coverage is broad but never complete. Every result carries MISSED_ALERT_NOTE
// and lists drugs the dictionary did not recognise, so a missing reminder is
// never read as "no risk".

export const REMINDER_NAME = "用药辅助提醒";
export const MISSED_ALERT_NOTE =
  "规则覆盖常见高风险情形，但不是完整药品知识库，可能漏报：没有提醒不代表没有风险。未识别的药物没有参与核对。请以说明书、药师审方和医生临床判断为准。";

// Drug classes. `members` are canonical generic names; `patterns` match any
// name containing the fragment (only fragments that no unrelated drug shares).
// `duplicate`: two different drugs of the class flag 重复用药.
// `allergy`: the class is an allergy cross-reactivity group. An allergy entry
// naming the class (`allergyTerms`) matches every member as critical; an
// allergy to one member flags other members at `allergy` severity.
export const DRUG_CLASSES = {
  penicillin: {
    label: "青霉素类",
    members: ["青霉素", "阿莫西林", "氨苄西林", "哌拉西林", "苯唑西林", "氯唑西林", "苄星青霉素", "美洛西林", "阿洛西林", "替卡西林"],
    patterns: ["西林"],
    allergy: "critical",
    allergyTerms: ["青霉素", "西林", "盘尼西林", "penicillin"],
  },
  cephalosporin: {
    label: "头孢菌素类",
    members: ["头孢氨苄", "头孢拉定", "头孢唑林", "头孢呋辛", "头孢克洛", "头孢丙烯", "头孢曲松", "头孢噻肟", "头孢他啶", "头孢哌酮", "头孢吡肟", "头孢克肟", "头孢地尼", "头孢泊肟", "头孢唑肟", "头孢美唑", "头孢西丁"],
    patterns: ["头孢"],
    allergy: "warning",
    allergyTerms: ["头孢"],
  },
  carbapenem: {
    label: "碳青霉烯类",
    members: ["亚胺培南", "美罗培南", "厄他培南", "比阿培南", "帕尼培南"],
    patterns: ["培南"],
    allergy: "warning",
    allergyTerms: ["培南", "碳青霉烯"],
  },
  sulfaAntibiotic: {
    label: "磺胺类抗菌药",
    members: ["复方磺胺甲噁唑", "磺胺甲噁唑", "磺胺嘧啶", "柳氮磺吡啶"],
    patterns: ["磺胺"],
    allergy: "critical",
    allergyTerms: ["磺胺", "sulfa"],
  },
  sulfaNonAntibiotic: {
    label: "含磺酰胺结构的非抗菌药",
    members: ["呋塞米", "氢氯噻嗪", "吲达帕胺", "布美他尼", "塞来昔布", "乙酰唑胺", "格列本脲", "格列齐特", "格列吡嗪", "格列美脲", "格列喹酮"],
  },
  quinolone: {
    label: "喹诺酮类",
    members: ["左氧氟沙星", "莫西沙星", "环丙沙星", "诺氟沙星", "氧氟沙星", "依诺沙星", "西他沙星"],
    patterns: ["沙星"],
    allergy: "warning",
    allergyTerms: ["喹诺酮", "沙星"],
  },
  macrolide: {
    label: "大环内酯类",
    members: ["阿奇霉素", "克拉霉素", "红霉素", "罗红霉素", "地红霉素"],
    allergy: "warning",
    allergyTerms: ["大环内酯"],
  },
  tetracycline: {
    label: "四环素类",
    members: ["四环素", "多西环素", "米诺环素", "替加环素"],
    patterns: ["环素"],
    allergy: "warning",
    allergyTerms: ["四环素类"],
  },
  aminoglycoside: {
    label: "氨基糖苷类",
    members: ["庆大霉素", "阿米卡星", "妥布霉素", "链霉素", "依替米星", "奈替米星"],
    allergy: "warning",
    allergyTerms: ["氨基糖苷"],
  },
  nitroimidazole: { label: "硝基咪唑类", members: ["甲硝唑", "替硝唑", "奥硝唑"] },
  linezolid: { label: "利奈唑胺", members: ["利奈唑胺"] },

  strongCyp3a4Inhibitor: {
    label: "强效 CYP3A4 抑制剂",
    members: ["克拉霉素", "伊曲康唑", "酮康唑", "伏立康唑", "泊沙康唑", "利托那韦", "奈玛特韦"],
  },
  strongInducer: {
    label: "强效肝药酶诱导剂",
    members: ["利福平", "卡马西平", "苯妥英", "苯巴比妥", "利福喷丁"],
  },
  azoleAntifungal: {
    label: "唑类抗真菌药",
    members: ["氟康唑", "伊曲康唑", "酮康唑", "伏立康唑", "泊沙康唑"],
  },

  vka: { label: "维生素 K 拮抗剂", members: ["华法林"] },
  doac: {
    label: "直接口服抗凝药",
    members: ["利伐沙班", "阿哌沙班", "艾多沙班", "达比加群"],
    patterns: ["沙班"],
  },
  heparin: {
    label: "肝素类",
    members: ["肝素", "依诺肝素", "低分子肝素", "那屈肝素", "达肝素", "磺达肝癸钠"],
  },
  anticoagulant: {
    label: "抗凝药",
    members: ["华法林", "利伐沙班", "阿哌沙班", "艾多沙班", "达比加群", "肝素", "依诺肝素", "低分子肝素", "那屈肝素", "达肝素", "磺达肝癸钠"],
    patterns: ["沙班"],
    duplicate: "warning",
  },
  antiplatelet: {
    label: "抗血小板药",
    members: ["阿司匹林", "氯吡格雷", "替格瑞洛", "普拉格雷", "西洛他唑", "吲哚布芬", "双嘧达莫"],
  },
  p2y12: { label: "P2Y12 抑制剂", members: ["氯吡格雷", "替格瑞洛", "普拉格雷"], duplicate: "warning" },
  nsaid: {
    label: "非甾体抗炎药",
    members: ["布洛芬", "双氯芬酸", "吲哚美辛", "塞来昔布", "依托考昔", "美洛昔康", "萘普生", "洛索洛芬", "氟比洛芬", "酮咯酸", "尼美舒利", "艾瑞昔布", "萘丁美酮", "醋氯芬酸"],
    duplicate: "warning",
  },
  nsaidHypersensitivity: {
    label: "非甾体抗炎药（含阿司匹林）",
    members: ["阿司匹林", "布洛芬", "双氯芬酸", "吲哚美辛", "塞来昔布", "依托考昔", "美洛昔康", "萘普生", "洛索洛芬", "氟比洛芬", "酮咯酸", "尼美舒利", "艾瑞昔布", "萘丁美酮", "醋氯芬酸"],
    allergy: "warning",
    allergyTerms: ["非甾体", "nsaid", "解热镇痛"],
  },
  systemicSteroid: {
    label: "全身用糖皮质激素",
    members: ["泼尼松", "泼尼松龙", "甲泼尼龙", "地塞米松", "氢化可的松", "倍他米松"],
  },

  acei: {
    label: "ACEI（普利类）",
    // No "普利" pattern: 依普利酮 is an aldosterone antagonist.
    members: ["卡托普利", "依那普利", "贝那普利", "培哚普利", "雷米普利", "福辛普利", "赖诺普利", "咪达普利", "西拉普利"],
    duplicate: "warning",
    allergy: "critical",
    allergyTerms: ["acei", "普利类"],
  },
  arb: {
    label: "ARB（沙坦类）",
    members: ["氯沙坦", "缬沙坦", "厄贝沙坦", "替米沙坦", "坎地沙坦", "奥美沙坦", "阿利沙坦", "沙库巴曲缬沙坦"],
    patterns: ["沙坦"],
    duplicate: "warning",
  },
  arni: { label: "ARNI", members: ["沙库巴曲缬沙坦"], patterns: ["沙库巴曲"] },
  raas: {
    label: "RAAS 抑制剂",
    members: ["卡托普利", "依那普利", "贝那普利", "培哚普利", "雷米普利", "福辛普利", "赖诺普利", "咪达普利", "西拉普利", "阿利吉仑"],
    patterns: ["沙坦"],
  },
  potassiumSparing: {
    label: "保钾利尿剂 / 醛固酮拮抗剂",
    members: ["螺内酯", "依普利酮", "阿米洛利", "氨苯蝶啶", "非奈利酮"],
  },
  potassiumSupplement: { label: "补钾制剂", members: ["氯化钾", "枸橼酸钾", "门冬氨酸钾镁"] },
  loopDiuretic: { label: "袢利尿剂", members: ["呋塞米", "托拉塞米", "布美他尼"] },
  thiazide: { label: "噻嗪类利尿剂", members: ["氢氯噻嗪", "吲达帕胺", "氯噻酮"] },
  potassiumWasting: {
    label: "排钾利尿剂",
    members: ["呋塞米", "托拉塞米", "布美他尼", "氢氯噻嗪", "吲达帕胺", "氯噻酮"],
  },
  betaBlocker: {
    label: "β 受体阻滞剂",
    members: ["美托洛尔", "比索洛尔", "阿替洛尔", "普萘洛尔", "卡维地洛", "拉贝洛尔", "索他洛尔", "艾司洛尔", "阿罗洛尔", "奈必洛尔"],
    patterns: ["洛尔"],
    duplicate: "warning",
  },
  nonselectiveBetaBlocker: { label: "非选择性 β 受体阻滞剂", members: ["普萘洛尔", "索他洛尔", "卡维地洛", "拉贝洛尔", "阿罗洛尔"] },
  ndhpCcb: { label: "非二氢吡啶类钙拮抗剂", members: ["维拉帕米", "地尔硫䓬"] },
  dhpCcb: {
    label: "二氢吡啶类钙拮抗剂",
    members: ["氨氯地平", "左氨氯地平", "硝苯地平", "非洛地平", "尼群地平", "拉西地平", "贝尼地平", "尼莫地平", "乐卡地平", "西尼地平"],
    patterns: ["地平"],
    duplicate: "warning",
  },
  nitrate: { label: "硝酸酯类及尼可地尔", members: ["硝酸甘油", "单硝酸异山梨酯", "硝酸异山梨酯", "尼可地尔"] },
  pde5: { label: "PDE5 抑制剂", members: ["西地那非", "他达拉非", "伐地那非", "阿伐那非"] },
  statin: {
    label: "他汀类",
    members: ["阿托伐他汀", "辛伐他汀", "瑞舒伐他汀", "普伐他汀", "洛伐他汀", "氟伐他汀", "匹伐他汀"],
    patterns: ["他汀"],
    duplicate: "warning",
  },
  cyp3a4Statin: { label: "经 CYP3A4 代谢的他汀", members: ["辛伐他汀", "洛伐他汀"] },
  fibrate: { label: "贝特类", members: ["吉非罗齐", "非诺贝特", "苯扎贝特"] },
  digoxin: { label: "地高辛", members: ["地高辛"] },
  digoxinRaiser: {
    label: "升高地高辛浓度的药物",
    members: ["胺碘酮", "维拉帕米", "决奈达隆", "普罗帕酮", "克拉霉素", "红霉素", "环孢素", "伊曲康唑"],
  },
  qtProlonging: {
    label: "延长 QT 间期的药物",
    members: ["胺碘酮", "索他洛尔", "决奈达隆", "克拉霉素", "红霉素", "阿奇霉素", "左氧氟沙星", "莫西沙星", "环丙沙星", "氟哌啶醇", "氯丙嗪", "齐拉西酮", "喹硫平", "西酞普兰", "艾司西酞普兰", "昂丹司琼", "美沙酮", "多潘立酮", "氟康唑", "伏立康唑", "三氧化二砷"],
  },

  ssri: {
    label: "SSRI",
    members: ["氟西汀", "帕罗西汀", "舍曲林", "西酞普兰", "艾司西酞普兰", "氟伏沙明"],
    duplicate: "warning",
  },
  snri: { label: "SNRI", members: ["文拉法辛", "度洛西汀", "去甲文拉法辛"], duplicate: "warning" },
  serotonergic: {
    label: "5-羟色胺能药物",
    members: ["氟西汀", "帕罗西汀", "舍曲林", "西酞普兰", "艾司西酞普兰", "氟伏沙明", "文拉法辛", "度洛西汀", "去甲文拉法辛", "曲马多", "哌替啶", "芬太尼", "美沙酮", "利奈唑胺", "阿米替林", "氯米帕明", "米氮平", "曲唑酮", "舒马曲坦", "佐米曲坦", "利扎曲坦", "亚甲蓝", "圣约翰草"],
    patterns: ["曲坦"],
  },
  serotoninReuptake: {
    label: "SSRI / SNRI",
    members: ["氟西汀", "帕罗西汀", "舍曲林", "西酞普兰", "艾司西酞普兰", "氟伏沙明", "文拉法辛", "度洛西汀", "去甲文拉法辛"],
  },
  maoi: { label: "MAOI", members: ["苯乙肼", "司来吉兰", "雷沙吉兰", "吗氯贝胺", "反苯环丙胺"] },
  benzodiazepine: {
    label: "苯二氮䓬类",
    members: ["地西泮", "劳拉西泮", "阿普唑仑", "艾司唑仑", "咪达唑仑", "三唑仑", "氯硝西泮", "奥沙西泮", "硝西泮"],
    patterns: ["西泮", "唑仑"],
    duplicate: "warning",
  },
  sedative: {
    label: "镇静催眠药",
    members: ["地西泮", "劳拉西泮", "阿普唑仑", "艾司唑仑", "咪达唑仑", "三唑仑", "氯硝西泮", "奥沙西泮", "硝西泮", "唑吡坦", "佐匹克隆", "右佐匹克隆", "扎来普隆"],
    patterns: ["西泮", "唑仑"],
  },
  opioid: {
    label: "阿片类",
    members: ["吗啡", "羟考酮", "芬太尼", "舒芬太尼", "瑞芬太尼", "哌替啶", "曲马多", "可待因", "美沙酮", "丁丙诺啡", "氢吗啡酮", "他喷他多", "地佐辛", "布托啡诺"],
  },
  aromaticAntiepileptic: {
    label: "芳香族抗癫痫药",
    members: ["卡马西平", "奥卡西平", "苯妥英", "苯巴比妥", "拉莫三嗪"],
    allergy: "warning",
    allergyTerms: ["芳香族抗癫痫"],
  },
  valproate: { label: "丙戊酸", members: ["丙戊酸", "丙戊酸钠", "丙戊酸镁"] },
  lithium: { label: "锂盐", members: ["碳酸锂"] },
  methotrexate: { label: "甲氨蝶呤", members: ["甲氨蝶呤"] },
  thiopurine: { label: "硫嘌呤类", members: ["硫唑嘌呤", "巯嘌呤"] },
  xanthineOxidaseInhibitor: { label: "黄嘌呤氧化酶抑制剂", members: ["别嘌醇", "非布司他"] },
  colchicine: { label: "秋水仙碱", members: ["秋水仙碱"] },
  calcineurinInhibitor: { label: "钙调磷酸酶抑制剂", members: ["他克莫司", "环孢素"] },
  theophylline: { label: "茶碱类", members: ["茶碱", "氨茶碱", "多索茶碱"] },
  theophyllineRaiser: { label: "升高茶碱浓度的药物", members: ["环丙沙星", "依诺沙星", "红霉素", "克拉霉素", "氟伏沙明"] },
  levothyroxine: { label: "甲状腺素", members: ["左甲状腺素"] },
  polyvalentCation: {
    label: "含钙/铁/铝/镁/铋制剂",
    members: ["碳酸钙", "葡萄糖酸钙", "醋酸钙", "硫酸亚铁", "琥珀酸亚铁", "多糖铁复合物", "蔗糖铁", "铝碳酸镁", "氢氧化铝", "硫糖铝", "枸橼酸铋钾", "氧化镁"],
  },
  sulfonylurea: {
    label: "磺脲类",
    members: ["格列美脲", "格列齐特", "格列吡嗪", "格列本脲", "格列喹酮"],
    duplicate: "warning",
  },
  insulin: { label: "胰岛素", members: ["胰岛素"], patterns: ["胰岛素"] },
  hypoglycemic: {
    label: "易致低血糖的降糖药",
    members: ["格列美脲", "格列齐特", "格列吡嗪", "格列本脲", "格列喹酮", "瑞格列奈", "那格列奈"],
    patterns: ["胰岛素"],
  },
  metformin: { label: "二甲双胍", members: ["二甲双胍"] },
  sglt2: { label: "SGLT2 抑制剂", members: ["达格列净", "恩格列净", "卡格列净", "艾托格列净"], patterns: ["格列净"], duplicate: "warning" },
  dpp4: { label: "DPP-4 抑制剂", members: ["西格列汀", "沙格列汀", "维格列汀", "利格列汀", "阿格列汀"], patterns: ["列汀"], duplicate: "warning" },
  ppi: {
    label: "质子泵抑制剂",
    members: ["奥美拉唑", "埃索美拉唑", "兰索拉唑", "泮托拉唑", "雷贝拉唑", "艾普拉唑"],
    patterns: ["拉唑"],
    duplicate: "warning",
  },
  cyp2c19Ppi: { label: "强效抑制 CYP2C19 的 PPI", members: ["奥美拉唑", "埃索美拉唑"] },
  h2Blocker: { label: "H2 受体拮抗剂", members: ["法莫替丁", "雷尼替丁", "西咪替丁"], patterns: ["替丁"], duplicate: "warning" },
  firstGenAntihistamine: { label: "第一代抗组胺药", members: ["苯海拉明", "氯苯那敏", "异丙嗪", "赛庚啶", "羟嗪"] },
  tricyclic: { label: "三环类抗抑郁药", members: ["阿米替林", "多塞平", "氯米帕明", "丙米嗪"] },
  antipsychotic: { label: "抗精神病药", members: ["氟哌啶醇", "氯丙嗪", "奥氮平", "喹硫平", "利培酮", "阿立哌唑", "齐拉西酮", "氯氮平"] },
  muscleRelaxant: { label: "中枢性肌松药", members: ["环苯扎林", "美索巴莫", "替扎尼定", "巴氯芬"] },
  gabapentinoid: { label: "加巴喷丁类", members: ["加巴喷丁", "普瑞巴林"] },
  antiviralRenal: { label: "经肾排泄的抗病毒药", members: ["阿昔洛韦", "伐昔洛韦", "更昔洛韦", "奥司他韦"] },
  teratogen: {
    label: "明确致畸药物",
    members: ["异维A酸", "阿维A", "沙利度胺", "来氟米特", "吗替麦考酚酯", "米索前列醇", "利巴韦林", "丙戊酸", "丙戊酸钠", "丙戊酸镁"],
  },
};

// Interaction rules. `a` / `b` are lists of "class:<key>" or generic names.
// When a and b overlap (e.g. two QT drugs), two different drugs are required.
export const INTERACTION_RULES = [
  // 出血
  { key: "int_anticoag_antiplatelet", a: ["class:anticoagulant"], b: ["class:antiplatelet"], severity: "warning", title: "抗凝与抗血小板联用", message: "出血风险明显增加。请核对联用适应证、疗程和胃肠保护。" },
  { key: "int_anticoag_nsaid", a: ["class:anticoagulant"], b: ["class:nsaid"], severity: "warning", title: "抗凝药与 NSAIDs 联用", message: "消化道及其他部位出血风险增加，尽量避免联用。" },
  { key: "int_antiplatelet_nsaid", a: ["class:antiplatelet"], b: ["class:nsaid"], severity: "warning", title: "抗血小板药与 NSAIDs 联用", message: "出血风险增加；布洛芬等还可能削弱阿司匹林的抗血小板作用。" },
  { key: "int_dual_antiplatelet", a: ["阿司匹林"], b: ["class:p2y12"], severity: "info", title: "双联抗血小板", message: "常为有意治疗。请核对适应证、计划疗程和胃肠保护。" },
  { key: "int_nsaid_steroid", a: ["class:nsaid"], b: ["class:systemicSteroid"], severity: "warning", title: "NSAIDs 与糖皮质激素联用", message: "消化道溃疡和出血风险增加，考虑胃肠保护。" },
  { key: "int_ssri_bleeding", a: ["class:serotoninReuptake"], b: ["class:anticoagulant", "class:nsaid"], severity: "warning", title: "SSRI/SNRI 与抗凝药或 NSAIDs 联用", message: "出血风险增加，注意消化道出血征象。" },
  // 华法林与 DOAC
  { key: "int_warfarin_potentiator", a: ["华法林"], b: ["胺碘酮", "甲硝唑", "替硝唑", "氟康唑", "伏立康唑", "复方磺胺甲噁唑", "克拉霉素", "红霉素", "class:quinolone"], severity: "warning", title: "华法林作用增强", message: "可使 INR 升高、出血风险增加，联用或调整期间加强 INR 监测。" },
  { key: "int_warfarin_inducer", a: ["华法林"], b: ["class:strongInducer"], severity: "warning", title: "华法林作用减弱", message: "肝药酶诱导剂可使 INR 降低；停用诱导剂时 INR 可能回升。请加强监测。" },
  { key: "int_doac_inducer", a: ["class:doac"], b: ["class:strongInducer"], severity: "warning", title: "DOAC 与强效诱导剂联用", message: "抗凝药浓度明显下降，血栓风险增加，一般应避免联用。" },
  { key: "int_doac_inhibitor", a: ["class:doac"], b: ["酮康唑", "伊曲康唑", "伏立康唑", "泊沙康唑", "利托那韦", "决奈达隆"], severity: "warning", title: "DOAC 与强效抑制剂联用", message: "抗凝药浓度升高，出血风险增加，请核对说明书中的联用限制。" },
  // 心血管
  { key: "int_dual_raas", a: ["class:acei"], b: ["class:arb", "阿利吉仑"], severity: "warning", title: "双重 RAAS 阻断", message: "高钾、低血压和急性肾损伤风险增加，一般不推荐联用。" },
  { key: "int_arni_acei", a: ["class:arni"], b: ["class:acei"], severity: "critical", title: "沙库巴曲缬沙坦与 ACEI 联用", message: "血管性水肿风险，禁止联用；两者转换须间隔至少 36 小时。" },
  { key: "int_raas_potassium", a: ["class:raas"], b: ["class:potassiumSparing", "class:potassiumSupplement"], severity: "warning", title: "RAAS 抑制剂与保钾药或补钾联用", message: "高钾血症风险增加，请监测血钾和肾功能。" },
  { key: "int_ksparing_potassium", a: ["class:potassiumSparing"], b: ["class:potassiumSupplement"], severity: "warning", title: "保钾利尿剂与补钾联用", message: "高钾血症风险增加，请监测血钾。" },
  { key: "int_raas_nsaid", a: ["class:raas"], b: ["class:nsaid"], severity: "warning", title: "RAAS 抑制剂与 NSAIDs 联用", message: "降压作用减弱，肾功能损害风险增加；同时使用利尿剂时风险更高。" },
  { key: "int_beta_ndhp", a: ["class:betaBlocker"], b: ["class:ndhpCcb"], severity: "warning", title: "β 阻滞剂与维拉帕米/地尔硫䓬联用", message: "心动过缓、房室传导阻滞和心衰加重风险，请监测心率和心电图。" },
  { key: "int_pde5_nitrate", a: ["class:pde5"], b: ["class:nitrate"], severity: "critical", title: "PDE5 抑制剂与硝酸酯类联用", message: "可致严重低血压，禁止联用。" },
  { key: "int_digoxin_raiser", a: ["地高辛"], b: ["class:digoxinRaiser"], severity: "warning", title: "地高辛浓度升高", message: "可致地高辛中毒，联用时考虑减量并监测地高辛浓度。" },
  { key: "int_digoxin_kwasting", a: ["地高辛"], b: ["class:potassiumWasting"], severity: "warning", title: "地高辛与排钾利尿剂联用", message: "低钾会增加洋地黄中毒风险，请监测血钾和地高辛浓度。" },
  { key: "int_qt_qt", a: ["class:qtProlonging"], b: ["class:qtProlonging"], severity: "warning", title: "多种延长 QT 间期的药物联用", message: "尖端扭转型室速风险增加，请评估心电图 QTc 和电解质。" },
  // 他汀
  { key: "int_statin3a4_strong", a: ["class:cyp3a4Statin"], b: ["class:strongCyp3a4Inhibitor"], severity: "critical", title: "辛伐/洛伐他汀与强效 CYP3A4 抑制剂联用", message: "他汀浓度大幅升高，横纹肌溶解风险高，禁止联用。" },
  { key: "int_atorva_strong", a: ["阿托伐他汀"], b: ["class:strongCyp3a4Inhibitor"], severity: "warning", title: "阿托伐他汀与强效 CYP3A4 抑制剂联用", message: "他汀浓度升高，肌病风险增加，考虑限制剂量或换药。" },
  { key: "int_simva_moderate", a: ["class:cyp3a4Statin"], b: ["胺碘酮", "维拉帕米", "地尔硫䓬", "红霉素", "氟康唑"], severity: "warning", title: "辛伐/洛伐他汀与中效抑制剂联用", message: "肌病风险增加，需限制他汀剂量。" },
  { key: "int_statin_fibrate", a: ["class:statin"], b: ["吉非罗齐"], severity: "warning", title: "他汀与吉非罗齐联用", message: "横纹肌溶解风险增加，如需联用贝特类优先考虑非诺贝特。" },
  { key: "int_statin_cyclosporine", a: ["class:statin"], b: ["环孢素"], severity: "warning", title: "他汀与环孢素联用", message: "他汀浓度明显升高，肌病风险增加，请核对剂量限制。" },
  // 神经精神
  { key: "int_maoi_serotonergic", a: ["class:maoi"], b: ["class:serotonergic"], severity: "critical", title: "MAOI 与 5-羟色胺能药物联用", message: "5-羟色胺综合征风险，原则上禁止联用，换药需足够洗脱期。" },
  { key: "int_serotonergic_pair", a: ["class:serotonergic"], b: ["class:serotonergic"], severity: "warning", title: "多种 5-羟色胺能药物联用", message: "5-羟色胺综合征风险增加，注意激越、震颤、高热等表现。" },
  { key: "int_opioid_sedative", a: ["class:opioid"], b: ["class:sedative", "class:gabapentinoid"], severity: "critical", title: "阿片类与镇静催眠药联用", message: "可致严重呼吸抑制，尽量避免联用；必须联用时使用最低剂量并密切监测。" },
  { key: "int_lithium_nsaid", a: ["碳酸锂"], b: ["class:nsaid"], severity: "warning", title: "锂盐与 NSAIDs 联用", message: "锂浓度升高，增加锂中毒风险，请监测血锂。" },
  { key: "int_lithium_raas", a: ["碳酸锂"], b: ["class:raas"], severity: "warning", title: "锂盐与 ACEI/ARB 联用", message: "锂浓度升高，增加锂中毒风险，请监测血锂。" },
  { key: "int_lithium_diuretic", a: ["碳酸锂"], b: ["class:thiazide", "class:loopDiuretic"], severity: "warning", title: "锂盐与利尿剂联用", message: "锂清除减少，噻嗪类影响尤其明显，请监测血锂。" },
  { key: "int_carbapenem_valproate", a: ["class:carbapenem"], b: ["class:valproate"], severity: "critical", title: "碳青霉烯类与丙戊酸联用", message: "丙戊酸浓度快速大幅下降，可诱发癫痫发作，应避免联用。" },
  // 免疫、痛风、其他
  { key: "int_xo_thiopurine", a: ["class:xanthineOxidaseInhibitor"], b: ["class:thiopurine"], severity: "critical", title: "别嘌醇/非布司他与硫唑嘌呤/巯嘌呤联用", message: "硫嘌呤蓄积，可致严重骨髓抑制；非布司他禁止联用，别嘌醇须大幅减量。" },
  { key: "int_mtx_smx", a: ["甲氨蝶呤"], b: ["复方磺胺甲噁唑", "磺胺甲噁唑"], severity: "critical", title: "甲氨蝶呤与复方磺胺甲噁唑联用", message: "骨髓抑制风险显著增加，应避免联用。" },
  { key: "int_mtx_nsaid", a: ["甲氨蝶呤"], b: ["class:nsaid"], severity: "warning", title: "甲氨蝶呤与 NSAIDs 联用", message: "甲氨蝶呤清除减少，高剂量时毒性风险尤其高，请监测血象和肾功能。" },
  { key: "int_colchicine_inhibitor", a: ["秋水仙碱"], b: ["class:strongCyp3a4Inhibitor", "环孢素"], severity: "critical", title: "秋水仙碱与强效 CYP3A4/P-gp 抑制剂联用", message: "秋水仙碱中毒风险高，肝肾功能不全者禁止联用，其他患者须大幅减量。" },
  { key: "int_cni_azole_macrolide", a: ["class:calcineurinInhibitor"], b: ["class:azoleAntifungal", "克拉霉素", "红霉素"], severity: "warning", title: "他克莫司/环孢素浓度升高", message: "肾毒性和神经毒性风险增加，请监测血药浓度。" },
  { key: "int_cni_inducer", a: ["class:calcineurinInhibitor"], b: ["class:strongInducer"], severity: "warning", title: "他克莫司/环孢素浓度降低", message: "排斥风险增加，请监测血药浓度。" },
  { key: "int_theophylline_raiser", a: ["class:theophylline"], b: ["class:theophyllineRaiser"], severity: "warning", title: "茶碱浓度升高", message: "可致茶碱中毒（心律失常、抽搐），请监测茶碱浓度。" },
  { key: "int_clopidogrel_ppi", a: ["氯吡格雷"], b: ["class:cyp2c19Ppi"], severity: "warning", title: "氯吡格雷与奥美拉唑/埃索美拉唑联用", message: "可能削弱氯吡格雷的抗血小板作用，如需 PPI 优先考虑泮托拉唑或雷贝拉唑。" },
  { key: "int_chelation_antibiotic", a: ["class:quinolone", "class:tetracycline"], b: ["class:polyvalentCation"], severity: "info", title: "抗菌药与含金属离子制剂同服", message: "吸收明显减少，需要间隔服用（通常抗菌药提前 2 小时或推后 4–6 小时）。" },
  { key: "int_levothyroxine_cation", a: ["左甲状腺素"], b: ["class:polyvalentCation"], severity: "info", title: "左甲状腺素与钙/铁/铝镁制剂同服", message: "吸收减少，建议间隔至少 4 小时。" },
  { key: "int_hypoglycemic_beta", a: ["class:hypoglycemic"], b: ["class:nonselectiveBetaBlocker"], severity: "info", title: "降糖药与非选择性 β 阻滞剂联用", message: "可能掩盖低血糖的心悸等表现，并延缓血糖恢复。" },
];

// Cross-reactivity between allergy groups.
export const CROSS_REACTIVITY = [
  { from: "penicillin", to: "cephalosporin", severity: "warning", message: "青霉素过敏者使用头孢菌素存在交叉过敏可能（多与侧链结构相似有关），请核对既往过敏反应的类型和严重程度。" },
  { from: "penicillin", to: "carbapenem", severity: "warning", message: "青霉素过敏者使用碳青霉烯类交叉过敏率低但不为零，请核对既往过敏反应类型。" },
  { from: "cephalosporin", to: "penicillin", severity: "warning", message: "头孢菌素过敏者使用青霉素类存在交叉过敏可能，请核对既往过敏反应类型。" },
  { from: "sulfaAntibiotic", to: "sulfaNonAntibiotic", severity: "info", message: "磺胺类抗菌药过敏与非抗菌类磺酰胺药物的交叉过敏证据有限，严重过敏史者仍请谨慎。" },
];

// Brand / colloquial names -> canonical generic.
export const DRUG_ALIASES = [
  ["拜阿司匹灵", "阿司匹林"], ["巴米尔", "阿司匹林"], ["拜阿司匹林", "阿司匹林"],
  ["芬必得", "布洛芬"], ["美林", "布洛芬"],
  ["扶他林", "双氯芬酸"], ["戴芬", "双氯芬酸"], ["消炎痛", "吲哚美辛"],
  ["泰诺", "对乙酰氨基酚"], ["必理通", "对乙酰氨基酚"], ["散利痛", "对乙酰氨基酚"], ["扑热息痛", "对乙酰氨基酚"],
  ["西乐葆", "塞来昔布"], ["安康信", "依托考昔"], ["乐松", "洛索洛芬"], ["莫比可", "美洛昔康"],
  ["络活喜", "氨氯地平"], ["施慧达", "左氨氯地平"], ["拜新同", "硝苯地平"], ["波依定", "非洛地平"],
  ["倍他乐克", "美托洛尔"], ["康忻", "比索洛尔"], ["博苏", "比索洛尔"], ["心得安", "普萘洛尔"], ["络德", "卡维地洛"],
  ["科素亚", "氯沙坦"], ["代文", "缬沙坦"], ["安博维", "厄贝沙坦"], ["美卡素", "替米沙坦"], ["傲坦", "奥美沙坦"], ["诺欣妥", "沙库巴曲缬沙坦"],
  ["开博通", "卡托普利"], ["洛汀新", "贝那普利"], ["雅施达", "培哚普利"], ["蒙诺", "福辛普利"], ["悦宁定", "依那普利"],
  ["立普妥", "阿托伐他汀"], ["阿乐", "阿托伐他汀"], ["舒降之", "辛伐他汀"], ["可定", "瑞舒伐他汀"], ["普拉固", "普伐他汀"],
  ["力平之", "非诺贝特"],
  ["波立维", "氯吡格雷"], ["泰嘉", "氯吡格雷"], ["倍林达", "替格瑞洛"],
  ["拜瑞妥", "利伐沙班"], ["艾乐妥", "阿哌沙班"], ["泰毕全", "达比加群"], ["克赛", "依诺肝素"], ["速碧林", "那屈肝素"], ["法安明", "达肝素"],
  ["可达龙", "胺碘酮"], ["异搏定", "维拉帕米"], ["合心爽", "地尔硫䓬"], ["地尔硫卓", "地尔硫䓬"],
  ["速尿", "呋塞米"], ["安体舒通", "螺内酯"], ["双氢克尿噻", "氢氯噻嗪"], ["寿比山", "吲达帕胺"], ["纳催离", "吲达帕胺"],
  ["补达秀", "氯化钾"], ["潘南金", "门冬氨酸钾镁"],
  ["格华止", "二甲双胍"], ["拜唐苹", "阿卡波糖"], ["亚莫利", "格列美脲"], ["达美康", "格列齐特"], ["优降糖", "格列本脲"], ["糖适平", "格列喹酮"], ["诺和龙", "瑞格列奈"],
  ["安达唐", "达格列净"], ["欧唐静", "恩格列净"], ["捷诺维", "西格列汀"], ["佳维乐", "维格列汀"],
  ["优甲乐", "左甲状腺素"], ["雷替斯", "左甲状腺素"],
  ["洛赛克", "奥美拉唑"], ["耐信", "埃索美拉唑"], ["泮立苏", "泮托拉唑"], ["波利特", "雷贝拉唑"], ["达喜", "铝碳酸镁"],
  ["开瑞坦", "氯雷他定"], ["仙特明", "西替利嗪"], ["扑尔敏", "氯苯那敏"], ["非那根", "异丙嗪"],
  ["希刻劳", "头孢克洛"], ["罗氏芬", "头孢曲松"], ["凯福隆", "头孢噻肟"], ["西力欣", "头孢呋辛"], ["世福素", "头孢克肟"],
  ["阿莫仙", "阿莫西林"], ["奥格门汀", "阿莫西林"], ["安灭菌", "阿莫西林"], ["联邦阿莫仙", "阿莫西林"], ["他唑仙", "哌拉西林"],
  ["泰能", "亚胺培南"], ["美平", "美罗培南"],
  ["可乐必妥", "左氧氟沙星"], ["拜复乐", "莫西沙星"], ["希普欣", "环丙沙星"],
  ["希舒美", "阿奇霉素"], ["克拉仙", "克拉霉素"], ["严迪", "罗红霉素"],
  ["大扶康", "氟康唑"], ["斯皮仁诺", "伊曲康唑"], ["威凡", "伏立康唑"],
  ["复方新诺明", "复方磺胺甲噁唑"], ["SMZ", "复方磺胺甲噁唑"],
  ["强的松", "泼尼松"], ["美卓乐", "甲泼尼龙"], ["甲强龙", "甲泼尼龙"],
  ["鲁南欣康", "单硝酸异山梨酯"], ["依姆多", "单硝酸异山梨酯"], ["消心痛", "硝酸异山梨酯"], ["喜格迈", "尼可地尔"],
  ["万艾可", "西地那非"], ["伟哥", "西地那非"], ["希爱力", "他达拉非"],
  ["百忧解", "氟西汀"], ["赛乐特", "帕罗西汀"], ["左洛复", "舍曲林"], ["喜普妙", "西酞普兰"], ["来士普", "艾司西酞普兰"], ["兰释", "氟伏沙明"],
  ["怡诺思", "文拉法辛"], ["欣百达", "度洛西汀"], ["瑞美隆", "米氮平"],
  ["安定", "地西泮"], ["佳静安定", "阿普唑仑"], ["舒乐安定", "艾司唑仑"], ["氯硝安定", "氯硝西泮"], ["思诺思", "唑吡坦"], ["忆梦返", "佐匹克隆"],
  ["奇曼丁", "曲马多"], ["舒敏", "曲马多"], ["美施康定", "吗啡"], ["奥施康定", "羟考酮"], ["多瑞吉", "芬太尼"], ["杜冷丁", "哌替啶"],
  ["得理多", "卡马西平"], ["德巴金", "丙戊酸钠"], ["大仑丁", "苯妥英"], ["曲莱", "奥卡西平"],
  ["乐瑞卡", "普瑞巴林"], ["派汀", "加巴喷丁"],
  ["再宁平", "别嘌醇"], ["优立通", "非布司他"], ["依木兰", "硫唑嘌呤"],
  ["新山地明", "环孢素"], ["普乐可复", "他克莫司"], ["骁悉", "吗替麦考酚酯"], ["爱若华", "来氟米特"],
  ["舒弗美", "茶碱"], ["葆乐辉", "多索茶碱"],
  ["钙尔奇", "碳酸钙"], ["速力菲", "琥珀酸亚铁"], ["力蜚能", "多糖铁复合物"], ["丽珠得乐", "枸橼酸铋钾"],
  ["吗丁啉", "多潘立酮"], ["思密达", "蒙脱石散"],
  ["拜糖平", "阿卡波糖"],
  ["泰瑞沙", "奥希替尼"], ["Paxlovid", "奈玛特韦"], ["帕罗韦德", "奈玛特韦"],
];

// Special-population cautions. `match` uses the same refs as interaction
// rules. Indicative only: thresholds and exceptions are on the label.
export const SPECIAL_POPULATION_RULES = [
  // 妊娠
  { match: ["华法林"], population: "pregnancy", caution: "妊娠期一般禁用（致畸、胎儿出血），需换用低分子肝素等方案。" },
  { match: ["class:acei", "class:arb", "阿利吉仑"], population: "pregnancy", caution: "妊娠期禁用（胎儿肾损害、羊水过少、致畸）。" },
  { match: ["class:statin"], population: "pregnancy", caution: "妊娠期原则上停用。" },
  { match: ["class:teratogen", "甲氨蝶呤", "碳酸锂"], population: "pregnancy", caution: "明确或高度可疑致畸，妊娠期禁用或须严格权衡；育龄女性需落实避孕。" },
  { match: ["class:aromaticAntiepileptic"], population: "pregnancy", caution: "有致畸风险，须由专科权衡用药与发作风险，补充叶酸。" },
  { match: ["class:tetracycline"], population: "pregnancy", caution: "妊娠中晚期影响胎儿牙齿和骨骼发育，应避免。" },
  { match: ["class:quinolone"], population: "pregnancy", caution: "妊娠期一般避免使用。" },
  { match: ["class:nsaid"], population: "pregnancy", caution: "妊娠 20 周后避免（羊水过少），妊娠晚期禁用（动脉导管早闭）。" },
  { match: ["胺碘酮"], population: "pregnancy", caution: "影响胎儿甲状腺，妊娠期避免使用。" },
  // 儿童
  { match: ["class:quinolone"], population: "pediatric", caution: "18 岁以下一般避免（可能影响软骨发育）。" },
  { match: ["阿司匹林"], population: "pediatric", caution: "儿童病毒感染发热时避免使用（Reye 综合征风险）。" },
  { match: ["class:tetracycline"], population: "pediatric", caution: "8 岁以下避免使用（牙齿黄染、牙釉质发育不全）。" },
  { match: ["可待因", "曲马多"], population: "pediatric", caution: "12 岁以下禁用（可致严重呼吸抑制）。" },
  { match: ["尼美舒利"], population: "pediatric", caution: "12 岁以下禁用。" },
  { match: ["class:aminoglycoside"], population: "pediatric", caution: "耳、肾毒性，需按体重给药并监测血药浓度。" },
  // 肾功能不全
  { match: ["二甲双胍"], population: "renal", caution: "eGFR<30 禁用，30–45 减量并评估（乳酸酸中毒风险）。" },
  { match: ["地高辛"], population: "renal", caution: "肾功能下降时蓄积，需减量并监测浓度。" },
  { match: ["碳酸锂"], population: "renal", caution: "经肾排泄，需减量并监测血锂。" },
  { match: ["class:nsaid"], population: "renal", caution: "可加重肾功能损害，慢性肾病患者尽量避免。" },
  { match: ["达比加群"], population: "renal", caution: "主要经肾排泄，肌酐清除率<30 mL/min 禁用。" },
  { match: ["利伐沙班", "艾多沙班", "阿哌沙班"], population: "renal", caution: "需按肌酐清除率调整剂量，重度肾功能不全时避免或慎用。" },
  { match: ["依诺肝素", "低分子肝素", "那屈肝素", "达肝素", "磺达肝癸钠"], population: "renal", caution: "肌酐清除率<30 mL/min 时需减量或换药。" },
  { match: ["class:aminoglycoside"], population: "renal", caution: "肾毒性，须调整剂量并监测血药浓度和肾功能。" },
  { match: ["class:gabapentinoid"], population: "renal", caution: "经肾排泄，需按肌酐清除率减量。" },
  { match: ["别嘌醇"], population: "renal", caution: "需按肾功能减量（剂量与超敏反应风险相关）。" },
  { match: ["秋水仙碱"], population: "renal", caution: "需减量；严重肾功能不全时避免使用。" },
  { match: ["class:potassiumSparing", "class:potassiumSupplement"], population: "renal", caution: "高钾血症风险高，需监测血钾。" },
  { match: ["格列本脲"], population: "renal", caution: "活性代谢物蓄积致严重低血糖，肾功能不全时避免。" },
  { match: ["class:antiviralRenal", "class:quinolone"], population: "renal", caution: "需按肌酐清除率调整剂量。" },
  { match: ["甲氨蝶呤"], population: "renal", caution: "清除减少、毒性增加，需减量或避免。" },
  { match: ["class:sglt2"], population: "renal", caution: "启用与继续使用的 eGFR 阈值随适应证不同，请核对说明书。" },
  // 肝功能不全
  { match: ["对乙酰氨基酚"], population: "hepatic", caution: "需减量并限制每日总量（肝毒性）。" },
  { match: ["class:statin"], population: "hepatic", caution: "活动性肝病或不明原因转氨酶持续升高时禁用。" },
  { match: ["甲氨蝶呤", "来氟米特"], population: "hepatic", caution: "肝毒性，肝功能不全时避免使用。" },
  { match: ["胺碘酮", "酮康唑", "异烟肼", "利福平", "class:valproate"], population: "hepatic", caution: "存在肝毒性，需评估并监测肝功能。" },
  { match: ["class:benzodiazepine", "class:opioid"], population: "hepatic", caution: "代谢减慢，可诱发或加重肝性脑病，需减量慎用。" },
  { match: ["class:nsaid"], population: "hepatic", caution: "严重肝功能不全时避免（出血、肾损害风险）。" },
  // 老年（参考 Beers 标准）
  { match: ["class:sedative"], population: "elderly", caution: "跌倒、骨折和认知损害风险，尽量避免或短期低剂量使用。" },
  { match: ["class:firstGenAntihistamine", "class:tricyclic", "class:muscleRelaxant"], population: "elderly", caution: "抗胆碱作用强，可致谵妄、便秘、尿潴留和跌倒，尽量避免。" },
  { match: ["格列本脲", "格列美脲"], population: "elderly", caution: "长效磺脲类低血糖风险高，老年人尽量避免。" },
  { match: ["地高辛"], population: "elderly", caution: "易蓄积中毒，每日剂量一般不超过 0.125 mg。" },
  { match: ["class:loopDiuretic"], population: "elderly", caution: "注意脱水、电解质紊乱与体位性低血压。" },
  { match: ["class:nsaid"], population: "elderly", caution: "长期使用增加消化道出血、肾损害和心衰风险，尽量避免。" },
  { match: ["class:ppi"], population: "elderly", caution: "避免无明确指征使用超过 8 周（艰难梭菌感染、骨折风险）。" },
  { match: ["class:antipsychotic"], population: "elderly", caution: "用于痴呆相关行为症状时卒中和死亡风险增加。" },
  { match: ["硝苯地平"], population: "elderly", caution: "速释剂型可致低血压和心肌缺血，避免使用。" },
  { match: ["阿司匹林"], population: "elderly", caution: "不建议老年人新启用阿司匹林作心血管一级预防。" },
  { match: ["甲氧氯普胺"], population: "elderly", caution: "锥体外系反应风险，尽量避免。" },
];

export const POPULATION_LABELS = {
  pregnancy: "妊娠",
  pediatric: "儿童",
  renal: "肾功能不全",
  hepatic: "肝功能不全",
  elderly: "老年",
};
