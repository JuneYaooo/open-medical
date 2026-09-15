# AI Agent 桌面产品调研：ZCode · Codex · WorkBuddy

> 调研日期：2026-09-15 ｜ 方法：官方文档/官网/官方公告 + 第三方评测交叉验证（来源附各节）
> 用途：为 open-medical-workbench 的通用 agent 体验设计提供对标参考

## TL;DR

- **ZCode**（Z.ai/智谱）：GLM-5.3 官方 Harness，定位"Agentic Development Environment"。Electron 桌面端为核心（无官方 CLI），围绕**任务**而非对话组织，特色是 Goal 目标模式（证据式自动校验迭代）与对 Claude Code 生态的全面兼容。
- **Codex**（OpenAI）：定位"一个覆盖所有编码场景的 agent"。形态最全（开源 CLI + 桌面 App + IDE + Web 云端 + 移动遥控 + GitHub/Slack），特色是**线程多形态迁移**（本地↔云端互移、手机遥控桌面）、best-of-N 并行方案与代码审查产品化。
- **WorkBuddy**（腾讯，2026-03 上线）：面向**非技术职场人群**的全场景 AI 办公工作台，MAU 658 万居赛道第一。特色是"**交付可验收产物**而非聊天回复"、专家/专家团角色体系、腾讯生态深度集成（微信/企微/腾讯文档）。
- 三者共性 = 当前 agent 产品的"标配范式"：桌面三栏工作台、任务（而非会话）为一等工作单元、Skills/MCP/Plugins/Hooks 扩展体系、自动压缩+持久记忆+知识库的三层上下文、分档权限与沙箱、自动化定时任务、积分制订阅。

---

## 一、总览对比

| 维度 | ZCode | OpenAI Codex | WorkBuddy |
|---|---|---|---|
| 厂商 | Z.ai / 智谱 | OpenAI | 腾讯（CodeBuddy 团队） |
| 定位 | Agentic Development Environment（编程） | "One agent for everywhere you code"（编程） | 全场景 AI 办公工作台（通用办公） |
| 目标用户 | 订阅 GLM Coding Plan 的工程师 | 个人开发者→工程团队→企业 | **非技术职场人群**为主 |
| 主形态 | Electron 桌面端（无官方 CLI） | 开源 CLI + 桌面 App + IDE + Web 云端 | 桌面客户端（Win/macOS） |
| 其他入口 | 手机 Remote 扫码、微信/飞书/TG Bot、SSH/Docker 远程 | 移动端 ChatGPT 内置、Codex Remote、GitHub、Slack、Chrome 扩展、SDK | 移动 App + 微信小程序、微信/企微/QQ/钉钉/飞书机器人、开放平台 |
| 开源 | 闭源 | CLI 开源（Apache-2.0，Rust） | 闭源 |
| 模型 | GLM-5.3 系为主（1M），可接第三方 | GPT-6 Astra / GPT-5.x 系 | 多模型聚合：混元+GLM+Kimi+MiniMax+DeepSeek，支持自定义 API/Ollama 本地 |
| 定价 | GLM Coding Plan 积分制（¥118/538/1078 月） | 含在 ChatGPT 订阅（Plus $20 起），可购 credits | 积分制（免费 500 分；¥70/140/700 连续包月档） |
| 长任务机制 | Goal 模式（证据式校验自动迭代） | goal mode + automations + 额度银行 | 定时自动化 + 结果推送到小程序/企微 |
| 数据策略 | 国内直连、人民币付费 | 需海外账号 | **文件默认本地处理，原始数据不上云** |

---

## 二、ZCode（Z.ai / 智谱）

### 2.1 定位

- 官方定位 **"Agentic Development Environment（ADE，智能体开发环境）"**——"不以手动编写代码为核心，而是让 AI Agent 成为开发主角"；口号"GLM-5.3 官方 Harness""新一代氛围编程工具"。（[Welcome 文档](https://zcode.z.ai/cn/docs/welcome)、[官网](https://zcode.z.ai/)）
- 目标场景：新功能开发、Bug 修复、legacy 代码理解、代码评审、发布准备。2026-08 官宣用户破 100 万。

### 2.2 产品形态

1. **桌面应用（主形态）**：Electron，macOS/Windows/Linux 全平台，当前 v3.11.x。**官方无 CLI、无 Web 端**（社区有第三方非官方 CLI，GitHub 有官方 CLI 的请求 issue）。
2. **手机 Remote**：扫码接入，远程查看/发指令/中止任务（"Vibeworking"）；同一时间限一台手机。
3. **Bot Channel**：微信、飞书、Telegram @ 机器人远程触发任务。
4. **远程开发**：SSH 主机或 Docker 容器作为工作区。
5. 不开源；zai-org 在 GitHub 仅有 feedback 等仓库。

### 2.3 核心功能

**任务与长任务**
- **Goal 目标模式（/goal）**：设定可校验目标后，每轮结束自动独立校验，未达成自动开新一轮直到完成；**只认可"实据"（改动文件、命令输出、测试结果）**；目标卡片展示每轮清单/累计时间/Token。解决长任务不停打"继续"的痛点。
- **任务驱动工作流**：以"任务"而非对话为基本工作单元；任务视图有分组/工作区/时间线三种，颜色标记、拖拽排序、按 3/7/14/30 天归档。
- **Subagents**：内置 general-purpose（全工具）与 Explore（只读检索）；自定义子智能体为 Markdown+frontmatter（可指定模型/思考强度/工具白名单/maxTurns/MCP）；支持前台并行与后台执行；子智能体不可再派发。
- **闲时任务**：订阅用户免费、不耗套餐额度，算力富余时排队执行。
- **Automations**：每小时/每天/每周定时任务（上限 20 条），带晨会动态等模板。

**上下文与记忆**
- **自动压缩**：触发点 ≈ 窗口 − 输出预留(≤21K) − 13K 缓冲；`[1m]` 模型自动识别 1M 窗口。
- **Memory 持久记忆**（默认关闭）：每轮结束后台提炼事实写 Markdown，按项目隔离存本机（`~/.zcode/cli/memories/`），分用户/反馈/项目/参考四类，可对话式增删。
- **AGENTS.md** 两级指令（全局+工作区）；CLAUDE.md 仅 onboarding 一次性迁移。
- **Wiki**：基于仓库自动生成结构化项目文档。

**扩展体系（对 Claude Code 生态全面兼容）**
- Skills（`$` 调用）、Commands（`/` 调用）、MCP（stdio/HTTP/SSE，可导入 Claude Code/Codex 配置）、Hooks（7 种事件，字段同时兼容 camelCase 与 Claude Code 的 snake_case；项目级 hooks 因安全被禁用）、Plugin（技能+命令+子智能体+MCP+Hook 打包；清单兼容 `.claude-plugin/plugin.json`，预置 Claude Code 插件市场）。

**权限与安全**
- **四档执行模式（Shift+Tab 循环）**：变更前确认（默认）/自动编辑/计划模式（只出方案不执行）/完全访问。
- 高危命令确认支持"始终允许/拒绝"按会话/项目记忆；文件写入删除前展示 diff。
- **Browser Use / Computer Use**：内置浏览器点选页面元素即采集标题/URL/选择器入上下文，支持前端验证闭环。

**会话管理**：会话持久化、编辑历史对话、从历史消息 fork 派生新会话、侧栏并行对话（/side、/btw）。

### 2.4 界面与交互

- **主界面四区域**：任务进度 / 终端输出 / 文件变更 / Git 状态——"持续反馈执行链路，避免黑盒"。
- 官网演示布局：左任务列表（耗时/变更行数）｜中 Bot 对话区（探索→写文件→验证的步骤流）｜Goal 进度面板（如 GoalComplete 5/5 步、89K tokens）｜底部终端与 Git 提交。
- **输入框符号体系**：`@` 文件、`#` 关联历史会话、`/` 命令、`$` 技能、`+` 附件；支持拖拽文件入输入框。
- **快捷键**（16 组高频）：Cmd+N 新任务、Cmd+B 侧栏、Cmd+J 终端、Cmd+K 命令中心（命令/对话/文件三合一搜索）、Shift+Tab 切模式、Cmd+M 选模型、Cmd+T 思考档位。
- 细节：Mermaid 自动渲染、表格导出 CSV、PDF 预览、**思考轨迹可搜索**、回合结束显示执行摘要与耗时、中英双语。

### 2.5 模型与定价

- 模型：GLM-5.3（1M 上下文，思考 low/high/max）、GLM-5.3-Flash（多模态/视觉编程）、GLM-5.2、GLM-5-Turbo；支持接入 Anthropic/OpenAI/DeepSeek/Moonshot 等第三方。
- GLM Coding Plan（积分制）：Lite ¥118/月（每周 1 万积分）、Pro ¥538、Max ¥1078；5 小时窗口+每周双窗口；非高峰时段半价扣积分；国际版 $18/月起。新用户 5 天免费体验。
- 套餐兼容 Claude Code、Cline 等 20+ 工具（不强制绑定 ZCode）；工具本身免费需自备 Key。
- 注意：Coding Plan 端点为 `/api/coding/paas/v4`，与资源包端点不同。

### 2.6 设计亮点

1. 定义"ADE"新品类：界面围绕任务而非文件树组织。
2. Goal 的**证据式校验**是"自主跑到完成"的工程化关键。
3. 桌面+手机+IM Bot 多端共推同一任务，"人不在电脑前"纳入设计。
4. 全面兼容 Claude Code 生态（插件/hooks/MCP/技能导入），迁移成本极低。
5. 四区域布局+可搜索思考轨迹+回合摘要，系统性对抗黑盒感。
6. 闲时任务/闲时重置把订阅额度与算力富余时段绑定，商业设计差异化。

来源：[Welcome](https://zcode.z.ai/cn/docs/welcome)、[Goal](https://zcode.z.ai/cn/docs/goal)、[Subagents](https://zcode.z.ai/cn/docs/subagents)、[Memory](https://zcode.z.ai/cn/docs/memory)、[Plugin](https://zcode.z.ai/cn/docs/plugin)、[Hooks](https://zcode.z.ai/cn/docs/hooks)、[快捷键](https://zcode.z.ai/cn/docs/keyboard-shortcuts)、[ADE-tools](https://zcode.z.ai/cn/docs/ADE-tools)、[Q&A](https://zcode.z.ai/cn/docs/qa)、[七牛云指南](https://news.qiniu.com/archives/1785117449028)、[博客园上手评测](https://www.cnblogs.com/youring2/p/21143184)、[z.ai/subscribe](https://z.ai/subscribe)

---

## 三、OpenAI Codex

### 3.1 定位

- **"One agent for everywhere you code"**，从"轻量级终端编码智能体"演进为"软件开发的命令中心"。开源 CLI 起 2025-04，云端 agent 2025-05，桌面 App 2026-02，现覆盖终端/IDE/桌面/网页/移动全形态。CLI 仓库约 12.4 万 star。
- 目标用户：个人开发者（ChatGPT 订阅）→ 团队（Business/Enterprise 含管理后台）→ 学生/开源维护者专项计划。

### 3.2 产品形态

| 形态 | 说明 |
|---|---|
| CLI（开源） | Rust，Apache-2.0；`npm i -g @openai/codex`；稳定版 0.154.0（2026-09-09），近乎每日发版 |
| 桌面 App | macOS 2026-02-02、Windows 2026-03-04（原生沙箱）；`codex app` 启动 |
| IDE 扩展 | VS Code / Cursor / Windsurf / JetBrains(beta) |
| Codex Web | chatgpt.com/codex，云端容器并行跑任务，产出 commit/PR |
| 移动端 | ChatGPT iOS 内任务管理；**Codex Remote** 手机 QR 配对遥控桌面主机（GA 2026-06） |
| GitHub | PR 自动审查、`@codex review` / `@codex fix this please`、处理 Issue、PR 徽章、官方 Action |
| 其他 | Slack/Linear 集成、Chrome 扩展（2026-05）、Codex SDK（TS/Python）、App Server、MCP Server |

### 3.3 核心功能

- **执行与沙箱**：本地 macOS Seatbelt / Linux Landlock / Windows 原生沙箱；云端每任务独立容器。审批三档 Read Only / Auto / Full Access；**auto-review**（2026-04）由独立模型在 agent 每次执行动作前复查审批，压缩上下文后保持授权语境。
- **代码审查一等公民**：CLI `/review`（diff/commit/branch/PR）→ GitHub 全自动 PR 审查 → 自定义 review guidelines → PR 徽章，覆盖个人到团队。
- **规划与并行**：`/plan` plan mode；**Subagents**（2026-03 正式，显式 spawn 专用子 agent 并行）；**best-of-N** 同一任务并行多方案供挑选；CLI 实验性 `/worktree` 隔离检出并行会话。
- **长时任务**：`codex resume`、会话/历史消息 fork、rollout 会话文件；goal mode（小时/天级任务，GA 2026-05）；Automations 定时/触发式任务；**额度银行**（未用完限额重置可累积，2026-06）。
- **上下文工程**：AGENTS.md；Skills（`$skill-name`）；Hooks（GA 2026-05）；Plugins（2026-03，技能+应用集成+MCP 打包，有市场）；Team Config 团队共享配置；MCP 全面支持（config.toml、`/mcp`、OAuth）；**Memories/Chronicle** 跨会话记忆；Record & Replay 把录制操作转成 skill；Web 访问 cached/live 两档。
- **Computer Use / Sites**：操控本机应用（macOS/Windows）+ 应用内浏览器（接 Chrome DevTools）；Sites 从任务直接建站部署。

### 3.4 界面与交互

- **CLI TUI**：`/` 斜杠命令全集（`/init` 生成 AGENTS.md、`/plan`、`/review`、`/compact`、`/resume`、`/fork`、`/worktree`、`/mcp`、`/skills`、`/hooks`、`/plugins`、`/subagents`、`/approvals`、`/voice` 等）；`@` 文件模糊补全；`!` 直接执行 shell；双 Esc 回看编辑历史；vim 键位；多主题；目录信任提示。
- **IDE 扩展**：侧栏对话面板+@引用；推理力度 low/medium/high；**本地↔云端任务互移**（本地跑一半委派云端继续）。
- **桌面 App**："命令中心"三栏（项目侧栏+线程列表+Review 面板）；多 agent 并行、Git worktree 管理、浮动 Composer 输入条、**Appshots（Cmd+Cmd 随时截屏喂 agent）**、语音输入、内置浏览器、菜单栏常驻、多窗口、artifact 查看器、SSH 远程。
- **Web 端**：任务列表（进行中/已完成）；创建任务选环境/分支/best-of-N 数量/是否自动建 PR；环境配置页（容器镜像、setup 脚本、互联网访问开关）。
- **通知**：云端完成→移动推送；审查结果→Slack；PR 徽章+行内评论。

### 3.5 模型与定价

- 模型演进：GPT-5-Codex（2025-09）→ 5.1-Codex/-Max → 5.2-Codex → 5.3-Codex/-Spark（1000+ tok/s）→ 5.4（原生 computer-use、实验 1M）→ 5.5 → **GPT-6 Astra（2026-09-03 旗舰，09-09 进 Codex model picker）**。推理力度 low→high→xhigh→max/ultra。
- 定价：**包含在 ChatGPT Free/Go/Plus($20)/Pro/Business/Enterprise 订阅内**，账号登录即用；API key 按 token 计费（GPT-5-Codex $1.25/$10 每百万）；可另购 credits；额度银行可累积。各档具体用量数值未公开完整明细。

### 3.6 设计亮点

1. **线程（thread）而非窗口是一等公民**：本地/IDE/App/云端任务互移接力，手机遥控桌面主机。
2. 并行做进产品骨架：worktree 隔离、best-of-N、subagents。
3. 安全分层：三档沙箱 + auto-review 独立模型复查 + 目录信任。
4. 配置即分发：AGENTS.md/Skills/Plugins/Hooks/MCP/Team Config + 市场。
5. 把 agent 当"异步同事"设计：goal mode、automations、额度银行、完成推送。
6. 交互细节：`@` 引用、任务中内联提问不打断、浮动 Composer、截图交互、处处 resume/fork。

来源：[Codex 文档](https://developers.openai.com/codex)（[Changelog](https://developers.openai.com/codex/changelog)/[Pricing](https://developers.openai.com/codex/pricing)/[CLI](https://developers.openai.com/codex/cli)/[App](https://developers.openai.com/codex/app)/[Models](https://developers.openai.com/codex/models)）、[openai/codex](https://github.com/openai/codex)、[Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)、[GPT-6 Astra](https://openai.com/index/gpt-6-astra/)、[Simon Willison: subagents](https://simonwillison.net/2026/Mar/16/codex-subagents/)

---

## 四、WorkBuddy（腾讯）

### 4.0 消歧说明

调研确认本语境下的 WorkBuddy = **腾讯（腾讯云 CodeBuddy 团队）的全场景 AI Agent 办公桌面工作台**，官网 [workbuddy.cn](https://www.workbuddy.cn/)，2026-03 上线，2026-05 全球化发布。已排除澳大利亚技工排班 SaaS 等同名产品；字节对应产品为 TRAE Work、阿里为 QoderWork。

### 4.1 定位

- 官方定位"AI Agent 办公新范式"："说出要求、开始执行任务、交付完整成果"；"不仅能听懂人话，还能带脑子思考并实际操作本地文件，真正帮您干活"。
- **面向非技术职场人群**的"职场智能桌面工作站"，覆盖日常办公、代码开发、设计创意三场景。
- 战略地位：腾讯寄予厚望的战略级产品（财联社称"继 QQ、微信之后"）；负责人刘毅："面向 Agent 时代的操作系统——承载所有工具的平台。"QuestMobile 2026-07 数据：**MAU 658.2 万居 AI 效率办公赛道第一**（TRAE Work 190 万、QoderWork 23 万）。

### 4.2 产品形态

1. **桌面客户端（主形态）**：Windows/macOS，本地+云上双模式。
2. **移动 App + 微信小程序**：与桌面同步，接收定时任务推送。
3. **IM 远程入口（"助理"）**：微信/企业微信/QQ/钉钉/飞书机器人远程操控电脑上的 WorkBuddy。
4. **企业版**：SaaS 版 ¥198/人/月、专有云版 ¥316/人/月。
5. **开放平台**（2026-09 上线）：Buddy 应用入口（首批超百家伙伴，覆盖金融/法律/医疗/教育等 20+ 领域，**腾讯健康为共建伙伴**）+ 9 款联名硬件 + 开发者三大能力（Skill/Expert/Connector）。

### 4.3 核心功能

1. **一句话任务+自主执行**：自然语言→自动拆解/规划/交付；多任务并行、Worktree 式并行开发。
2. **多模态文书交付**：报告/技术文档/会议纪要、数据分析可视化、PPT、深度研究、邮件周报、批量文件整理——**产物直接验收使用**。
3. **专家中心（Expert）**："专家 = 人设+方法论+工具链"的角色机制；**专家团（Team）**由团长自动拆解、多专家并行执行并整合交付（积分为单专家 3–5 倍）。
4. **技能市场（Skills）**：封装可执行脚本与工作流（发邮件/读写文件/调 API），一键安装、描述任务自动查找或创建；官方精选 10 个零成本技能（Agent Browser、办公文档四件套、Local Whisper、Web Search、Obsidian 等）。
5. **资料库/知识库**：侧边栏集成腾讯文档（搜索/预览/引用/回写一站式，语义搜索，任务产物回写云端）、ima 知识库、乐享；任务可直接引用资料库文档/空间作参考。
6. **自动化/定时任务**：每日简报、周报汇总等周期任务；支持模板、指定模型/技能/专家，**结果推送到小程序或企微**。
7. **记忆**：**每晚整理当天会话**，提取事实/偏好/人物关系/跟进事项注入系统提示词；对话式增删、可导入其他 AI 的使用习惯；提炼成本官方承担。
8. **连接器（Connector）**：MCP 与 CLI 双方案；企微聊天记录转发可自动读取文档/微盘/日程/待办。
9. **创意设计**：图片生成、视频生成（Kling V3）、品牌设计。

### 4.4 界面与交互

**三栏桌面工作台**（与 open-medical-workbench 结构最接近）：

- **左侧栏**：任务列表按文件夹分组，搜索管理；底部头像（设置/记忆/助理）。
- **中间对话区（核心）**：纯对话式非表单——输入需求→补充上下文→看执行过程→继续追问；顶部对话内搜索、任务分享（公开链接）、历史提问跳转；**执行过程透明**：阶段说明（"正在分析数据"）、结果摘要、可展开中间步骤；支持中断续跑，强调"连续对话而非每次重来"。
- **右侧结果区**：产物/全部文件/变更/预览 + **内置浏览器**；产物可回写腾讯文档。

- **多模态输入**：@ 引用文件/文档/规则、粘贴截图、拖拽上传；PDF/Word/Excel/CSV/PPT/图片/压缩包/代码。
- **工作空间**：任务绑定本地目录，基于该目录读写文件。
- **安全权限**：**所有文件处理默认本地完成，原始数据不上云**；服务端仅处理数据片段用后即弃、不用于训练；只访问主动勾选授权的文件夹；敏感目录自动拦截；高危操作二次确认；权限分"默认/完全访问"两档。近期版本加入计划看板、锁屏运行、模型档位跨会话记忆。

### 4.5 模型与定价

- **多模型聚合**（内置 14 款）：腾讯混元 Hy4/Hy3、智谱 GLM-5.3(1M)/5.3-Flash/5.2/5.1/5v-Turbo、MiniMax-M3、Kimi-K3/K2.7-Code、DeepSeek-V4-Flash/V4-Pro；三档调度（快速/均衡/极致）；可视化配置第三方 API，**支持 Ollama 本地部署**（内网合规场景），自定义仅存本地。
- 定价（2026-07 体系，与 CodeBuddy 积分共享）：体验版免费 500 分/月；标准 ¥99（连续包月 ¥70，4,000 分）；高级 ¥199/¥140（9,000 分）；旗舰 ¥999/¥700（50,000 分）；加量包 1,000 分/¥50。

### 4.6 设计亮点

1. **"交付可验收结果"而非聊天回复**——直接操作本地文件、产物落在工作空间，是赛道从"谁能生成"到"谁能把活干完"的代表。
2. **三层开放生态**（Skill/Expert/Connector + 不排他硬件 + 应用伙伴）对抗竞品"全家桶"。
3. 专家/专家团/技能的角色化 Agent 体系，接近"数字员工"组织。
4. 腾讯生态深度集成：IM 多入口远程操控 + 腾讯文档/ima 原生打通（"入口+Harness"护城河）。
5. 模型中立：以工作台而非模型为中心。
6. 上线半年 50+ 次迭代（至 5.5.6）。

来源：[官网](https://www.workbuddy.cn/)、[简介/快速开始/创建任务](https://www.workbuddy.cn/docs/workbuddy/Overview)、[定价](https://www.workbuddy.cn/docs/workbuddy/Pricing)、[模型配置](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model)、[专家中心](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Expert-Center)、[技能市场](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market)、[记忆](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Memory)、[财联社报道](https://www.cls.cn/detail/2472437)、[CodeBuddy 博客](https://www.codebuddy.ai/genie/blog/34)、[Forbes](https://www.forbes.com/sites/viviantoh/2026/05/28/why-workbuddy-going-global-marks-a-reversal-in-the-ai-agent-race/)

---

## 五、横向观察：共性趋势（2026 年 agent 产品"标配范式"）

1. **桌面三栏工作台是收敛后的主流形态**：任务列表｜对话执行区｜结果/产物区（ZCode 四区域、Codex App 三栏、WorkBuddy 三栏高度一致）。
2. **"任务"取代"会话"成为一等工作单元**：任务有状态/分组/归档/时间线，会话只是任务内的一条线程。
3. **扩展体系标准化**：Skills + 斜杠命令 + MCP + Hooks + Plugins（+市场）五件套，且互相兼容（ZCode 直接兼容 Claude Code 的插件清单/hooks 字段；各家都有从竞品迁移的工具）。
4. **三层上下文管理**：自动压缩（ZCode 有明确触发公式、Codex `/compact`）+ 跨会话持久记忆（三家都有，均为本地 Markdown 提炼事实）+ 知识库/资料库挂载。
5. **权限分档 + 沙箱 + 高危二次确认**：档位 3–4 档（只读→自动→完全访问），plan mode 普遍作为其中一档。
6. **长任务自主化**：Goal/goal mode（证据式校验自动迭代）+ 定时自动化 + 结果推送 + 额度银行。
7. **多入口同一工作区**：桌面为主，手机遥控 + IM Bot（微信/飞书/Slack）远程触发已成双向标配。
8. **商业模型趋同**：订阅积分制 + 非高峰/闲时折扣 + 加量包。

## 六、对 open-medical-workbench 的启示

结合本项目方向（通用 agent 体验：咨询直接答、文书才走草稿；上限=预算+压缩+检索）：

1. **WorkBuddy 是最直接的对标**：同为"对话驱动 + 文书交付"的桌面工作台，其"产物直接验收使用 + 右侧结果区（产物/文件/变更/预览）"正好对应"文书才走草稿"的验收环节——草稿应有独立的验收视图（预览、diff、回写），而不是埋在对话流里。
2. **咨询直接答 = ZCode/WorkBuddy 的"透明执行"**：阶段说明、可展开中间步骤、回合执行摘要，是把"直接答"做出可信感的关键；WorkBuddy 的"连续对话而非每次重来"也值得借鉴。
3. **上限三层上下文可直接对齐行业做法**：预算（积分制对应 token 预算）→ 自动压缩（参考 ZCode 的显式触发公式：窗口−输出预留−安全缓冲）→ 检索（WorkBuddy 的"任务直接引用资料库文档"= 本项目知识库检索的交互形态；其语义搜索+引用回写闭环可参考）。
4. **本地数据策略是医疗场景的加分项而非负担**：WorkBuddy 以"文件默认本地处理、不上云"为卖点，与本项目"患者数据留在本地"完全同构——这应写进产品主张，而不是藏在文档里。
5. **权限分档照行业惯例做**：默认确认/自动/计划/完全访问四档 + 高危操作（涉及患者数据的写入/删除）二次确认 + diff 预览。
6. **Goal 式证据校验可用于文书流水线**：长文书任务（如完整病历/报告）可借鉴"每轮只认可实据（已写入的章节、通过的校验）"的完成判定。
7. **扩展体系不必自创**：Skills/MCP 已是事实标准，直接兼容可复用现成生态（如文档处理类 skill），降低自研成本。
8. **多入口可后置但预留**：微信/企微 Bot 远程触发在 WorkBuddy/ZCode 已验证需求，医疗场景对应"值班时手机审批/触发任务"。

> 未找到公开资料的部分（如需可再查）：ZCode 官方 Web 端与官方 CLI（不存在）、Codex 各档位具体用量数值与 credits 单价、WorkBuddy 用户留存与付费转化、国际版详细定价。
