---
name: knowledge-base
description: 医学知识库搭建与使用：自动体检嵌入环境，云端免费 Key 或本地 Ollama 二选一，指南入库确认制，向量化自动索引。
---

# 医学知识库

用户想建知识库、上传指南、或问"为什么检索不到语义结果"时，按本技能执行。

## 第一步：能力体检（必做）
调用 `knowledge_base_status` 查看当前环境，然后按结果分派：

**A. 已配置云端 Key（mode=cloud）** → 直接进入入库流程，无需提醒。
**B. 本地 Ollama 可用（mode=local）** → 提醒："本机 Ollama 运行 bge-m3 约需 1–2GB 可用内存、下载约 1.2GB；如不想占用本机资源，可改用硅基流动免费 Key（BAAI/bge-m3 永久免费，siliconflow.cn 注册），设置 MEDICAL_EMBEDDING_KEY 即可切换云端。"
**C. 什么都没有（无 Key 且 Ollama 不可达）** → 给用户两个选项：
1. **云端免费（推荐，零占用）**：到 siliconflow.cn 免费注册并创建 API Key，把 Key 填入 .env 的 `MEDICAL_EMBEDDING_KEY`（桌面版填 model.env）后重启服务；仅公开指南文本与检索词会上云，患者资料永不外发。
2. **本地 Ollama（完全离线）**：确认电脑有约 2GB 可用内存，安装 Ollama 后 `ollama pull bge-m3`；优点是全程离线，缺点是占内存。
3. 说明：都不选也能用（全文匹配兜底），只是没有语义检索。

## 第二步：入库流程（确认制）
1. **用户上传指南文件**：读取全文，向用户复述将入库的标题/机构/年份；确认后调用 `guideline_ingest` 入库。
2. **用户要求联网找指南**：用 `literature_search` 或 web 工具找候选，展示标题/机构/年份/摘要供用户挑选；用户确认后获取全文，`guideline_ingest` 入库。
3. 入库成功后告知："已自动分块并向量化索引，之后医学问题会先检索知识库。" 入库失败如实说明原因（如文本过短）。

## 第三步：检索使用
- 回答医学问题前先 `guideline_search` 检索知识库（混合检索：向量语义 + 全文）。
- 引用必须带指南名 + 行号（工具返回的 matches/startLine）。
- 检索结果 rag.stale=true 时提示"嵌入模型已更换，建议重建索引"，并说明重建方法（指南库界面按钮或 `POST /api/guidelines/reindex`）。

## 边界
- 只有公开的指南/知识文本与检索词会进入嵌入服务；**患者资料永远不进知识库、不上云**——患者信息的存储走 patient_record_propose 提案确认流程。
- 不承诺检索结果的临床正确性；指南条文以原文为准。
