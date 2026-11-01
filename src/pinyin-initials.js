// 姓名拼音首字母检索（不引入拼音库）。
// 1. 姓氏先查下表：覆盖常见姓氏，并修正多音字姓氏（曾 z、单 s、仇 q 等）。
// 2. 其余汉字借助浏览器自带的中文排序规则（Intl.Collator zh-Hans-CN 按拼音
//    排序）判断首字母；运行环境不支持拼音排序时，只有表内姓氏能按首字母匹配。
// 多音字名字可能取到常见读音以外的字母——匹配不上时仍可用汉字或编号搜索。
const SURNAME_INITIAL = "艾a安a白b包b鲍b毕b卞b蔡c曹c岑c柴c常c陈c程c池c褚c崔c戴d邓d狄d丁d董d窦d杜d段d樊f范f方f房f费f冯f符f傅f付f高g葛g耿g龚g宫g古g谷g顾g关g管g郭g韩h郝h何h贺h洪h侯h胡h花h华h黄h霍h姬j吉j纪j季j贾j简j江j姜j蒋j焦j金j靳j景j康k柯k孔k邝k赖l兰l蓝l郎l雷l冷l黎l李l连l廉l梁l林l凌l刘l柳l龙l娄l卢l鲁l陆l路l吕l罗l骆l马m麦m毛m茅m梅m孟m米m苗m莫m穆m倪n聂n宁n牛n欧o潘p庞p裴p彭p皮p蒲p戚q齐q祁q钱q乔q秦q邱q裘q屈q瞿q冉r饶r任r荣r阮r沙s邵s沈s盛s施s石s时s史s舒s宋s苏s孙s谭t汤t唐t陶t田t童t涂t万w汪w王w危w韦w卫w魏w温w文w闻w翁w吴w伍w武w席x夏x向x项x萧x肖x谢x辛x邢x熊x徐x许x宣x薛x严y颜y晏y杨y阳y姚y叶y易y殷y尹y应y于y余y俞y虞y郁y袁y岳y云y曾z詹z湛z张z章z赵z郑z钟z周z朱z诸z祝z庄z卓z邹z左z单s仇q翟z区o解x查z朴p尉y乐y覃q缪m盖g召s种c员y秘b";
const surnameMap = new Map();
for (let i = 0; i + 1 < SURNAME_INITIAL.length; i += 2)
  if (!surnameMap.has(SURNAME_INITIAL[i])) surnameMap.set(SURNAME_INITIAL[i], SURNAME_INITIAL[i + 1]);

// 每个字母在拼音排序中的第一个汉字（经典边界表）。没有 i、u、v 开头的拼音。
const BOUNDARY = "阿八嚓哒妸发旮哈讥咔垃妈拏噢妑七呥撒它穵夕丫帀";
const LETTERS = "abcdefghjklmnopqrstwxyz";
let collator = null;
try {
  const candidate = new Intl.Collator("zh-Hans-CN");
  // 按拼音排序时「啊(a)」排在「八(b)」前；按码位排序则相反。
  if (candidate.resolvedOptions().locale.startsWith("zh") && candidate.compare("啊", "八") < 0 && candidate.compare("张", "赵") < 0) collator = candidate;
} catch { collator = null; }

const cache = new Map();
function charInitial(char) {
  if (/^[a-z0-9]$/i.test(char)) return char.toLowerCase();
  if (!collator || !/[一-鿿]/.test(char)) return "";
  if (cache.has(char)) return cache.get(char);
  let letter = "";
  for (let i = BOUNDARY.length - 1; i >= 0; i--) if (collator.compare(char, BOUNDARY[i]) >= 0) { letter = LETTERS[i]; break; }
  if (cache.size < 5000) cache.set(char, letter);
  return letter;
}

/** 姓氏首字母；无法判断时返回空串。 */
export function surnameInitial(name) {
  const first = String(name || "").trim().charAt(0);
  return surnameMap.get(first) || charInitial(first);
}

/** 姓名每个字的首字母，例如「张三」→「zs」。无法判断的字记为「?」，不会被匹配。 */
export function nameInitials(name) {
  const chars = [...String(name || "").replace(/\s+/g, "")];
  return chars.map((char, i) => (i === 0 ? surnameInitial(char) : charInitial(char)) || "?").join("");
}

/**
 * 查询是否按拼音首字母命中姓名：
 * - 「zs」「zsf」：姓名首字母前缀；
 * - 「z三」：姓氏首字母 + 名字中的汉字（兼容此前的写法）。
 */
export function matchesNameInitials(name, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q || !name) return false;
  if (/^[a-z]+$/.test(q)) return nameInitials(name).startsWith(q);
  if (/^[a-z]/.test(q) && q.length > 1 && !/[a-z]/.test(q.slice(1))) return surnameInitial(name) === q[0] && String(name).includes(q.slice(1));
  return false;
}
