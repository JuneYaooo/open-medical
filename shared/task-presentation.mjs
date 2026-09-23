export function taskPresentation(text='') {
 if (/(相似|类似|相近).{0,8}(病例|患者|案例)/.test(text)) return 'similar_cases';
 if (/辅助诊断|鉴别诊断|可能是.{0,5}(病|诊断)|治疗方案.{0,8}(合理|评估)/.test(text)) return 'diagnostic';
 if (/(计算|算一下|评分).{0,20}(BMI|eGFR|肌酐|体表|量表|医学|风险|Child|CHA2)|(?:BMI|eGFR|肌酐|体表|医学计算器|量表|Child|CHA2).{0,20}(计算|评分|算一下)/i.test(text)) return 'calculator';
 if (/(文献|论文).{0,15}(检索|搜索|阅读|解读|查找)|(?:检索|搜索|查找|阅读|解读).{0,15}(文献|论文)/.test(text)) return 'literature';
 return 'answer';
}
