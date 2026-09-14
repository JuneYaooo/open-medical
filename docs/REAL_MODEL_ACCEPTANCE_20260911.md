# 2026-09-11 通用工作流真实模型验收

模型：DeepSeek `deepseek-v4-pro`，通过 Anthropic 兼容接口。只读复用了用户明确授权的 Claude Code 保存配置；本项目自己的 AgentRuntime 执行模型循环、工具、团队与恢复，未把任务交给 Claude Code 完成。全部材料为独立合成工作区，不加载患者库或医疗适配器。

## 首轮重复验收

命令：`npm run verify:agent -- --claude-code-provider=default --repeat=3 --directory=output/deepseek-generic-acceptance`。

| 任务 | 结果 | 实际断言 |
| --- | --- | --- |
| 陌生仓库修复，逐项审批 | 3/3 | 先复现失败；最小源码提案；隔离测试通过；测试文件不变；审批后再次运行测试并本地提交 |
| 陌生仓库自动修复 | 3/3 | 自动写入与 Git 分别授权；模型实际修复、验证、提交；工作树干净 |
| PDF、Excel、Markdown | 3/3 | 可下载成果；Excel 精确单元格；PDF 内容回读；Markdown 总数；模型实际以 artifactId 回读六份文档 |
| 多 Agent 团队 | 3/3 | 两个 reader；依赖它们的 writer；后续 verifier；提案测试通过；父任务收齐结果 |
| 压缩、追加要求与恢复 | 0/3 | 发现运行时对一次16个工具调用直接终止的缺陷，不能算通过 |
| MCP 外部数据流程 | 3/3 | 真实本机 HTTP MCP；工具发现；临时错误后重试；随机批次号和数据精确落盘 |

首轮为 **15/18**。失败记录保留在 `output/deepseek-generic-acceptance/report.json`，不覆盖为通过。MCP 服务器使用合成业务数据，不能替代真实供应商 OAuth/兼容验收。

## 根据真实失败完成的修复

1. 成果链路：生成的文档是独立成果，原先 `document_read` 只能读取宿主路径，模型会收到 ENOENT。增加 `artifactId` 回读及终端 `artifactIds` 输入；校验工作区归属、哈希、路径、大小，并拒绝同名输入冲突。修复后文档三轮无此类错误；另一次最终源码文档任务也通过，报告位于 `output/deepseek-artifact-final/report.json`。
2. 工具批次：保持每轮8次执行预算。9–128次请求整批不执行，为每个调用返回协议完整的 `TOOL_BATCH_LIMIT`，让模型拆批重试；超过128仍终止。未知工具与权限拒绝仍不能绕过。新增回归覆盖零副作用、重试、协议对应关系和权限边界。
3. 验收脚本：早期 continuity 单次已完成全部16份原文读取、两次压缩与最终产物，但统计阶段请求了不合法的事件页大小。改为按运行 ID 的数据库计数；原失败报告保留，未据此宣称成功。
4. 压缩可观测性：父任务和子 Agent 的每个摘要片段记录独立模型请求/响应、token、耗时、错误及原文归档 ID；只读重放保留 compaction 阶段。该补充由实际调用路径上的回归检查验证，不依赖医疗领域日志。

修复后的三次 continuity 重验：`npm run verify:agent -- --claude-code-provider=default --case=continuity --repeat=3 --directory=output/deepseek-continuity-fixed`，结果为 **3/3 通过**，每次实际读取全部16份来源、完成两次压缩、沿用原 run ID、保留追加要求并交付正确的逐行数值。耗时分别为370.627秒、306.970秒、295.041秒；token分别为46061、43074、49297。独立逐行与工具轨迹核查保存在同目录 `evidence-audit.json`。

因此六类工作流各有三次成功记录；这不是一次全绿的18任务报告，而是保留了首轮15/18及修复后3/3的完整历史。

## 证据范围

每份报告包含源码指纹、模型、平台、运行ID、token、耗时、轮次和每项检查。测试过程中代码改动分别由新报告或回归覆盖，不能把旧指纹报告说成同一版本的全部验收。

最终本地检查：lint、生产构建通过；`TEST_DOCKER_IMAGE=open-medical-runtime:0.8-full TEST_FULL_RUNTIME_IMAGE=open-medical-runtime:0.8-full npm test` 为179通过、1跳过、0失败。跳过项是旧的宿主 Python 办公助手测试；完整 Docker 办公读写测试实际执行并通过。

旧版本 soak 在源码升级时正常停止，保留7.386小时、443任务、17次服务重启、4次强杀恢复且无失败的基线；`durationTargetMet=false`。当前源码的独立48小时 soak 在 `output/soak-48h-current-20260911/report.json`，启动 PID 17086，仍在运行。脚本额外检查长时间调度间断/时钟跳变，不能把暂停后的墙上时间直接当作持续负载通过；短110次当前源码检查已通过，但不能替代48小时。

恢复任务注入的是服务中断与 SQLite 关闭/重开，并检查相同 run ID、累计预算和待消费指令。进程强杀另由 Docker/进程回归与长时 soak 验证。此任务集规模小、代码夹具简单；还不足以推断任意复杂仓库成功率，或宣布跨模型、多平台、完整48小时与全部 G0–G6 达标。
