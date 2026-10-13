# 学习闭环评测集 v1

40 位完全虚构的患者，分为四个病种簇；30 位用于学习、10 位固定留出。每位患者包含文字记录、PNG 检验扫描、事实金标准和唯一金丝雀。三位模拟医生具有冲突的写法规则，以及故意改变确诊状态、药物剂量的不可学陷阱。

当前金标准由生成器产生，`manifest.json` 的 `humanReviewed` 均为 false。尚未完成独立逐份人工审核，不能作为发版效果通过的证据。图片是渲染的合成检验单，不能代表真实医院扫描质量。

## 隔离与冻结

运行器仅把 `materials/` 上传到建档 API。`gold.json`、人设和评审标签仅由评估器读取，不进入建档模型的消息。模拟医生在规定轮次说出的偏好属于实验输入。风格评审与建档运行分开。

每组、人设、种子使用独立的临时 SQLite 和工作区。留出患者的草稿不确认，因此不会写入学习历史或作为范例。云端默认隐私实验检查请求中是否包含其他患者的金丝雀；本地运行不能代替这个检查。

`manifest.json` 固定划分并记录金标准 SHA-256；运行前核对校验值。审核资料、金标准和图片后，记录审核人及日期，再更新 `humanReviewed`。正式比较期间不要重新生成资料或更改人设。需要修改时创建新的数据集版本，并重跑所有对照组。

## 运行

模型配置使用项目 `createProvider` 接受的 JSON 字段：`provider`、`model`、`baseUrl`、`apiKey`。凭据文件不要放进评测目录。

```sh
# 开发档：A/C，各 10 位，1 人设和 1 种子
node scripts/evaluate-learning.mjs --model-config /path/to/private-model.json --max-calls 300

# 小样本连通性检查：不能代替开发档或发版档
node scripts/evaluate-learning.mjs --model-config /path/to/private-model.json --patients 2 --max-calls 40

# 发版档：每种模型分别执行；包括学习序列和留出集
node scripts/evaluate-learning.mjs --release --model-config /path/to/private-model.json --style-calibration /path/to/reviewed-style-labels.json --max-calls 12000 --output output/learning-loop/release-cloud

# 无模型调用的本地协议检查
node --test tests/learning-evaluation.test.mjs
```

调用预算覆盖建档与风格评审。模型未返回用量时，输入 token 指标保持未知，不用字符数冒充 token 数。

风格校准文件结构：`{ "reviewer": "审核人", "examples": [...] }`。至少 20 条，每条包含 `content`、`persona`（对应人设的写法字段）、`expected`（布尔值）和 `expectedUnsafe`（布尔值）。审核标签不发送给评审模型；一致率不足 90% 时，风格判定不得用于放行。

## 结果解释

输出含逐次请求、原始个性化参考、草稿、目标稿、差异、习惯决策、数值统计和 SVG 学习曲线。事实 F1 按键对齐并核对字段；血糖等价单位换算归一后比较。诊断状态与药物剂量仍以原始金标准核对，不能用模拟医生的陷阱目标判定事实正确。摘要距离独立报告，不进入 SER。

`G6b` 使用录制的真实模型草稿，在独立库中注入错误习惯，经正常提案和确认事务重放，测量自动暂停份数。它验证退场机制，不代表模型效果。`G7` 比较实际后处理命中与医生目标，未观察到适用习惯时保持未验证。

进程退出码：0 表示本模型矩阵所有门槛通过且金标准已审核；2 表示缺少条件、未验证或未达标；1 表示运行失败。即使单个模型矩阵通过，仍需另一档模型及真实医生试点，才能完成总体验收。
