> 当前 0.7 实现与验收以 [GENERIC_PLATFORM_07.md](GENERIC_PLATFORM_07.md) 为准。本文保留历史版本记录。

> 0.6 当前通用平台实现、Git/终端新能力与验收边界见 [GENERIC_PLATFORM_06.md](GENERIC_PLATFORM_06.md)。以下保留先前版本设计说明；与 0.6 冲突时以新文档为准。

> **0.5 更新（2026-09-10）：** 当前实现已增加 MCP、受控离线插件生命周期、Docker 隔离终端、独立浏览器审批、持久语义记忆和单机分级扩展授权。本文其余旧表格是历史验收快照，不代表当前缺口。

# Harness / Codex 能力矩阵

**0.4 最新状态：** 新增可独立使用的通用 AgentRuntime、CLI、工作区、文件审批、对话分支、只读子任务和固定间隔调度。下表为 0.3 医疗子集的历史比较，最新验收请看 [通用内核](GENERIC_RUNTIME.md) 与 [重构验收](REFACTOR_ACCEPTANCE.md)。

更新时间：2026-09-09。当前完成度以[验收复核](ACCEPTANCE_AUDIT.md)为准；下表中的参照链接不构成功能等价证明。

| 能力                                      | 当前医疗工作台                                                                 | DeepSeek Harness / Codex 参考           | 决策                       |
| ----------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------- | -------------------------- |
| 模型适配与流式输出                        | DeepSeek / OpenAI-compatible / Claude 原生 SSE                                 | Harness LLM/plugin seam                 | 已实现医疗子集             |
| 工具注册与作用域                          | JSON Schema 子集、当前材料隔离、来源工具                                       | Harness scoped registry                 | 已实现且收紧               |
| 会话持久化                                | SQLite 快照 + append-only trajectory                                           | Harness event-sourced session log       | 已实现本地单用户子集       |
| 恢复、取消、版本冲突                      | 中断标记、检查点、取消、幂等                                                   | Harness resume/lifecycle                | 已实现                     |
| 轨迹检索                                  | `/events` 游标分页                                                             | Harness trajectory search/replay        | 有读取，尚未重放           |
| 分支 / fork                               | `POST /api/sessions/:id/fork` 复制 1–10 份选中材料到空白会话                     | Harness fork inherited event cut        | 部分实现；无对话历史分支       |
| Skill                                     | `SKILL.md` 元数据和只读说明                                                    | Codex skill/plugin bundle               | 部分实现                   |
| Plugin system                             | 服务端受控工具插件注册                                                         | Cordis mount/unmount/dependencies       | 未实现通用插件系统         |
| Standard / Code / Minimal / Creator modes | standard/creator 为 model 别名；minimal 限制工具；code 为受限 Python                     | Harness 四种模式                        | 部分实现；工作流/UI 未齐         |
| Shell / editor / web search               | 医疗运行时未实现                                                                       | Harness Standard/Minimal 工具           | 未满足通用工具需求           |
| Code Mode SDK                             | 无                                                                             | Harness Code mode                       | 未实现                     |
| 子代理                                    | 独立上下文、三种医疗角色、取消联动、限深限并发                                 | Harness subagent providers/continuation | 已实现医疗子集             |
| 调度                                      | SQLite 持久单次/间隔计划、暂停恢复、外发范围绑定                               | Harness scheduling / Hermes Cron        | 已实现固定间隔子集         |
| Sandbox                                   | macOS Seatbelt Python 隔离、拒绝联网/写文件/子进程、超限终止；代码模式强制沙箱 | Harness process sandbox / Codex sandbox | 本机实测；其他 OS 暂未实现 |
| UI composition                            | 医疗三栏 React UI                                                              | Harness UI plugin                       | 独立实现                   |
| JSON-RPC                                  | WebSocket 工作台子集                                                           | Harness SDK stdio/app-server            | 部分兼容，不是协议兼容     |
| Marketplace / plugin install              | 无                                                                             | Codex plugins marketplace               | 未实现                     |
| 审批与外发确认                            | 每轮模型外发确认、人工产物复核                                                 | Codex/Harness permission layers         | 医疗版自研简化版           |

| 离线桌面交付 | macOS arm64 `.app` 本机冒烟通过；Windows 只有配置/脚本 | 单机应用分发 | 部分实现；断网新装、Windows 尚未验收，安装脚本有待修复问题 |

因此，当前准确表述是：**已实现可运行的医疗单机工作台子集，尚未完成用户要求的完整单机产品。通用工具、插件安装、完整模式工作流、历史分支、分级能力授权和跨平台离线安装仍有缺口。不能将未实现解释成用户已接受的医疗范围裁剪。**

官方资料：DeepSeek Harness 说明其能力覆盖 models、tools、skills、sessions、sandboxes、storage、loops、scheduling 和 UI，并提供 Standard/Code/Minimal/Creator 模式；Codex CLI 仓库公开，Codex App 不公开，当前插件示例在 `openai/plugins`。这些结论分别来自 [DeepSeek Harness](https://deepseek.com/harness/en/)、[DeepSeek Harness core](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md)、[Codex CLI](https://github.com/openai/codex)、[OpenAI Plugins](https://github.com/openai/plugins)。

本轮具体设计、API、资源约束与已知限制见 [ORCHESTRATION.md](ORCHESTRATION.md)。
