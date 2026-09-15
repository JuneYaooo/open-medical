---
name: adr-assessment
description: 药物不良反应评估：知识表筛查 + Naranjo 因果分级，按原等级展示不升级不降级。
---

# 药物不良反应评估

只使用当前会话材料和工具（`assess_adverse_reaction`、`medical_scale_calculate` scaleId=naranjo、`lab_knowledge_search`）。

## 工作流
1. 整理用药清单（含起停时间，如材料有）与可疑临床表现；调用 `assess_adverse_reaction` 做知识表匹配。
2. 区分时间关系：反应是否出现在用药之后、停药是否缓解、有无再暴露——这些是 Naranjo 条目的事实输入，从材料提取，不得假设。
3. 调用 `medical_scale_calculate`（naranjo）完成因果分级：≥9 肯定，5–8 很可能，1–4 可能，≤0 可疑。条目缺事实就选"不确定"，不要猜。
4. 用 `lab_knowledge_search` 补充相关指标的解读提示（如 CK 之于他汀肌病）。

## 展示纪律
- 按知识表原有严重程度展示，不自行升级或降级等级。
- 不回答"该不该停药/换药"，不指示开始、停用、更换或调整药物；只列出关联、建议核查项目和需咨询医生药师的事项。
- 筛查是提示性匹配，不构成因果判定；因果结论以 Naranjo 评分 + 医生判断为准。
- 未查到关联时如实说"内置知识表未查到该药与该表现的关联条目"，不凭记忆断言有或没有。
