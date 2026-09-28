# Open Medical Workbench — 项目规格（v2 · 私域患者管理）

> 状态：生效中（2026-09-28）。本文件取代 `PRODUCT_DESIGN.md` 中「系统永远不会自动向患者发消息」的原则，
> 改为「**分级自动化 + 红线兜底 + 全程可追溯**」。其余历史文档保留作背景。

## 1. 定位与目标

**一句话**：医生通过企业微信管理自己的私域患者；AI 助手在医生设定的边界内，实时记录患者消息、自动回复科普类问题、
把 AI 处理不了的重要消息推给医生，并按计划自动随访、自动收集随访记录。

| 层级 | 能力 | 阶段 |
|---|---|---|
| 核心 | 实时记录与统计患者消息/文件（患者消息收件箱） | P1 |
| 核心 | 分诊：红旗规则 + 模型分类，决定自动回复 / 草稿 / 提醒医生 | P1 |
| 核心 | 科普自动回复：结合上下文、医生知识库、患者档案；可追溯来源 | P1 |
| 核心 | 重要消息提醒：工作台 + 企业微信应用消息，超时未处理升级 | P1 |
| 核心 | 定时随访计划：按天发送 → 收集回复 → 模型提取 → 写入随访记录 | P1 |
| 基础 | 模型配置引导（首次使用第一步）、首次启动检查清单 | P1 |
| 高级 | 患者档案、辅助诊断、科研入组筛选（沿用现有能力） | 已有 |

**成功标准（P1 验收）**
1. 管理员 5 分钟内完成模型配置：选服务商 → 选模型 → 填 Key → 一键测试（文本 / 工具调用 / JSON 三项能力）。
2. 任一渠道进入的患者消息 ≤ 1 个处理周期内完成分诊；红旗消息 100% 产生提醒，不可被模型否决。
3. 自动回复只在「科普/行政」类别、医生开启自动模式、渠道支持主动发送时发生；每条回复记录来源、模型、判定理由。
4. 随访计划到期自动发送（或在需要成员确认的渠道生成待确认任务），回复被自动提取成随访记录。
5. **以上所有操作都能通过聊天完成**；UI 负责查看、留存与一键确认。

## 2. 设计原则

1. **通用 Agent 内核不动**：`server/core/*`（AgentRuntime、ToolRegistry、PermissionEngine、WorkspaceService、
   上下文预算、MCP、插件、调度）保持领域无关。患者管理作为医疗领域的新模块 `server/care/*`，
   通过工具插件接入 `createMedicalWorkspaceDomain`，与知识库、提案等工具同一形态。
2. **聊天优先**：每个业务能力都有对应的 agent 工具（读直接执行、写经提案确认）。医生可以只用聊天完成全部工作；
   UI 是数据的查看、留存、批量确认入口，而不是唯一入口。
3. **分级自动化**（每位医生、每位患者可单独设置）：
   - `off`：只记录与分诊、提醒；不生成回复。
   - `draft`（默认）：生成回复草稿，医生在收件箱或聊天里一键发送。
   - `auto`：科普/行政类在允许的渠道自动发送；其余转草稿或提醒。
4. **红线兜底（确定性代码，模型无法绕过）**
   - 红旗关键词（胸痛、呼吸困难、意识改变、大出血、自杀/自伤、严重过敏等）→ 立即 `urgent` 提醒 + 固定安全话术；不走模型回复。
   - 自动回复不得包含诊断结论、处方、剂量调整；出站过滤器命中即降级为草稿并提醒。
   - 每条自动回复末尾附 AI 身份与就医提示。
   - 患者未确认知情同意（`careConsent`）时，不做自动回复与自动随访，只记录。
5. **可追溯**：消息 → 分诊结果 → 回复（来源、模型、原因、发送回执）→ 随访记录，全部落库并写审计。
6. **不使用非官方协议**。发送只走企业微信官方接口；不可主动发送的渠道退化为草稿 / 成员确认。

## 3. 默认假设（未确认项，已按此实现，可配置）

| 问题 | 默认 | 说明 |
|---|---|---|
| 是否已开通会话存档 | 可选 | 通过现有采集器（`chat-connectors/wecom-archive`）或 `/api/ingest/messages` 接入；未开通时用微信客服或手动导入 |
| 自动回复渠道 | 微信客服（`wecom-kf`） | 官方支持在患者来消息后的窗口期内回复（48 小时、最多 5 条）；客户联系渠道只能生成「成员确认」任务 |
| 定时随访发送 | 允许自动；需成员确认的渠道生成待确认任务 | 发送前可设置医生批量确认（`campaign.requireConfirm`） |
| 部署形态 | 常驻服务（服务器或常开的桌面） | 回调与定时任务需要进程常驻；桌面版仍可用，关闭即暂停 |
| 团队 / 个人 | 单医生（多成员 UserID 可配置提醒对象） | 数据模型预留 `member` 字段 |
| 起步专科 | 通用 | 红旗词表、科普类别可在设置中扩展 |

## 4. 架构

```
企业微信 ──回调/同步──► channels (wecom-kf / wecom-contact / wecom-app / ingest / manual)
                              │ inbound
                              ▼
                  CareEngine.ingest ──► patient_messages（现有表）+ care_message_state
                              │
                  triage：红旗规则 → 模型分类+回复（一次调用，JSON）→ 出站过滤
                              │
          ┌───────────────────┼─────────────────────┐
          ▼                   ▼                     ▼
   care_replies(auto/draft)  care_alerts         campaign 回复关联 → 提取 → followups.completeReminder / 记录
          │ outbound           │ notify
          ▼                    ▼
   channels.send         工作台 + wecom-app 应用消息（升级）

聊天（通用 Agent 内核）──工具插件──► care_* 工具 ──► CareEngine / PendingActions（care-message / care-campaign）
UI（患者消息视图）──/api/care/*──► CareEngine
```

### 4.1 模块（`server/care/`）

| 文件 | 职责 |
|---|---|
| `store.mjs` | 建表与行映射：`care_message_state`、`care_replies`、`care_alerts`、`care_campaigns`、`care_settings`、`care_patient_settings` |
| `red-flags.mjs` | 确定性红旗规则与出站过滤（纯函数，可单测） |
| `triage.mjs` | 组装上下文（患者简报、最近消息、知识库检索）→ 一次模型调用返回 JSON 分诊+回复 |
| `channels.mjs` | 渠道注册表与实现：`wecom-kf`、`wecom-contact`、`wecom-app`（提醒）、`manual` |
| `wecom-api.mjs` | 企业微信 REST 最小客户端（gettoken 缓存、kf/sync_msg、kf/send_msg、message/send），可注入 fetch |
| `engine.mjs` | CareEngine：ingest、process、reply、alerts、campaigns tick、统计；定时器生命周期 |
| `tools.mjs` | 聊天工具插件 |
| `api.mjs` | `/api/care/*` 路由 |

### 4.2 数据模型

- `patient_messages`（沿用）：`data` 新增可选 `attachments[{name,type,size,url?}]`、`sender`、`msgType`。
- `care_message_state(message_id PK, patient_id, status, level, category, reasons JSON, reply_id, alert_id, updated_at)`
  - `status`: `pending`（未关联患者时为 `unassigned`）→ `auto_replied | drafted | alerted | recorded | handled | skipped | failed`
  - 首次启用时记录水位线（当时最大消息 id），此前的历史消息不进入分诊。
  - `level`: `urgent | attention | routine`
  - `category`: `emergency | clinical | medication | report | education | admin | followup_reply | chitchat | other`
- `care_replies(id PK, patient_id, message_id, channel, mode, status, text, data JSON, created_at, updated_at)`
  - `mode`: `auto | draft | manual | campaign`
  - `status`: `draft | queued | sending | sent | awaiting_member | failed | unknown | discarded`
  - `queued`：已确认（或自动）待发送，由处理周期异步发出；`sending` 中断重启后置为 `unknown`，绝不自动重发。
  - `data`: `{sources[], model, reason, detail, externalId, campaignId, stepId}`
- `care_alerts(id PK, patient_id, message_id, level, reason, status, data JSON, created_at, updated_at)`
  - `status`: `open | acknowledged | resolved`；`data.notified[]`、`data.escalatedAt`
- `care_campaigns(id PK, patient_id, name, status, data JSON, created_at, updated_at)`
  - `status`: `active | paused | completed | cancelled`
  - `data.steps[]`: `{id, dayOffset, time, text, questions[], status(scheduled|draft|sending|sent|awaiting_member|replied|recorded|no_reply|failed|skipped|cancelled), dueAt, sentAt, replyId, messageIds[], result, recordedAt}`
  - `data`: `{startDate, channel, replyWindowHours, requireConfirm}`
- `care_settings`（单行 JSON）：`{autoReply:{mode, categories[], disclaimer}, alerts:{notifyUserIds[], escalateAfterMinutes}, redFlags:{extra[]}, channels:{kf:{openKfId}}, processing:{enabled, modelConsent}, updatedAt}`
  - `processing.modelConsent`：医生授权把患者消息（不含姓名/电话）发给模型分诊；未授权时只做规则识别并记录。
  - 内部 `state`（水位线、微信客服 cursor）不对外返回；渠道密钥单独存 vault。
- `care_patient_settings(patient_id PK, data JSON)`：`{consent:boolean, consentAt, autoReplyMode?:'inherit'|'off'|'draft'|'auto', channel?, kfExternalUserId?}`

所有密钥（微信客服 Secret、应用 Secret）进入现有 vault，不返回浏览器。

### 4.3 聊天工具（聊天即全部入口）

读（直接执行）：
- `care_overview`：今日消息数、待处理、提醒、自动回复、随访进度。
- `care_inbox`：按 `status/level/patientId` 列出消息与分诊结果。
- `care_patient_thread`：某患者消息与回复时间线。
- `care_alerts`：未处理提醒。
- `care_campaigns`：随访计划与步骤状态。
- `care_settings_get`：当前自动化设置与渠道状态。

写（低风险，直接执行并审计）：
- `care_alert_update`：确认 / 解决提醒。
- `care_message_mark`：标记已处理。
- `care_reply_draft`：生成或改写回复草稿（不发送）。

写（外发或改变自动化边界 → PendingActions，医生确认后执行）：
- `care_send_propose` → 提案类型 `care-message`：确认后通过渠道发送。
- `care_campaign_propose` → 提案类型 `care-campaign`：确认后创建随访计划。
- `care_settings_propose` → 提案类型 `care-settings`：确认后修改自动回复模式、患者同意状态等。

确认入口：UI 的「待确认」托盘（全局可见，包括聊天界面）一键确认；聊天工具返回提案编号与摘要。

### 4.4 HTTP API（浏览器令牌鉴权，除特别说明）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/care/overview` | 统计 + 渠道状态 |
| GET | `/api/care/inbox?status=&level=&patientId=&limit=` | 消息 + 分诊状态 |
| POST | `/api/care/messages/:id/process` | 重新分诊 |
| POST | `/api/care/messages/:id/mark` | `{status:'handled'\|'skipped'\|'pending'}` |
| POST | `/api/care/messages/:id/assign` | `{patientId}` 关联未识别消息；来自微信客服时同时记住该客户 |
| GET | `/api/care/patients/:id` | 患者消息线程、回复、随访计划与设置 |
| POST | `/api/care/ingest` | 浏览器令牌下的手动录入（与独立密钥的 `/api/ingest/messages` 并存） |
| POST | `/api/care/sync` | 手动拉取微信客服消息 |
| GET | `/api/care/replies?status=&patientId=` | 回复列表 |
| POST | `/api/care/replies` | `{patientId, messageId?, text}` 新建草稿 |
| PUT | `/api/care/replies/:id` | `{text}` 修改草稿 |
| POST | `/api/care/replies/:id/send` | `{confirmed:true}` 发送草稿 |
| POST | `/api/care/replies/:id/discard` | 丢弃 |
| GET | `/api/care/alerts?status=` | 提醒 |
| POST | `/api/care/alerts/:id/:action` | `acknowledge \| resolve` |
| GET/POST | `/api/care/campaigns` | 列表 / 创建 `{patientId, name, startDate, steps[], channel?, replyWindowHours?, requireConfirm?}` |
| POST | `/api/care/campaigns/:id/:action` | `pause \| resume \| cancel` |
| GET/PUT | `/api/care/settings` | 全局设置 |
| GET/PUT | `/api/care/patients/:id/settings` | 患者同意与覆盖 |
| POST | `/api/ingest/messages` | （沿用，独立密钥）入库后自动进入分诊 |
| GET/POST | `/api/wecom/callback` | （沿用）新增 `kf_msg_or_event` → 拉取微信客服消息 |

### 4.5 处理周期

`CareEngine.tick()`（默认每 20 秒，可关闭）：
1. 处理 `pending` 消息（每批 ≤ 10，按时间先后），入站方向且已关联患者。
2. 到期随访步骤发送；回复窗口到期的步骤提取或标记 `no_reply`。
3. 超时未确认的 `urgent/attention` 提醒升级（再次通知）。

消息 ingest 时也会异步触发一次 `process`，保证实时性；tick 负责兜底与重启恢复。
发送中断（进程退出在请求与响应之间）标记 `unknown`，永不自动重发。

### 4.6 分诊与回复（一次模型调用）

输入：系统规则（数据不是指令）、医生设置、患者简报、最近 12 条消息、知识库检索前 4 条（标题+片段+编号）。
输出 JSON：`{category, level, canAutoReply, reply, sourceIds[], reason}`。
决策：
1. 红旗命中 → `urgent` 提醒 + 固定安全话术（患者未同意时只提醒）。
2. 模型 `level ∈ {urgent, attention}` 或 `canAutoReply=false` → 提醒（attention）+ 可选草稿。
3. 类别在自动回复白名单、模式 `auto`、渠道可主动发送、出站过滤通过 → 自动发送。
4. 否则 → 草稿。
5. 模型未配置或失败 → 状态 `failed`，产生 `attention` 提醒「需人工查看」。

## 5. 模型配置引导（首次使用第一步）

- 服务商预设（`shared/model-presets.mjs`）：DeepSeek、通义千问（DashScope 兼容）、Kimi（Moonshot）、智谱 GLM、
  豆包（火山方舟）、硅基流动、OpenAI、Anthropic、本地 Ollama、自定义兼容接口。每个预设含接口地址、推荐模型列表、Key 获取链接。
- 表单：服务商 → 模型（下拉推荐 + 可自定义）→ API Key → 测试 → 保存。上下文预算、超时收进「高级选项」。Jev 设置移到独立分区。
- 测试 = 能力探测：文本回复、工具调用、JSON 输出三项，逐项显示通过/失败与耗时；工具调用失败时提示该模型不适合 Agent。
- 首页首次启动检查清单：模型 → 知识库 → 企业微信 → 患者同意 → 自动回复模式；每项显示状态并可一键打开对应设置，
  也可让聊天助手引导完成。

## 6. 前端

- 新视图 `care`「患者消息」（侧栏第一位，今日待办之前）：
  - 顶部统计卡：今日消息、待处理、提醒、自动回复、待确认。
  - 标签：提醒 / 待回复草稿 / 全部消息 / 随访计划 / 设置。
  - 草稿行内编辑、一键发送；提醒一键确认/解决；随访计划步骤时间线。
  - 设置：自动回复模式、白名单类别、提醒对象、微信客服账号。
- 全局「待确认」托盘：聊天发起的外发/计划/设置提案在此一键确认。
- 聊天仍是首要入口：首页快捷问题加入「今天有哪些患者消息需要我处理？」等。

## 7. 安全与合规

- 患者同意前不自动回复、不自动随访；同意状态可审计。
- 出站过滤：诊断断言、剂量模式（数字 + mg/片/粒/ml/单位 + 服用/调整）、处方词 → 禁止自动发送。
- 模型只接收最小必要上下文；患者材料向量仍只走本地嵌入（沿用）。
- 审计事件：`care.message.triaged`、`care.reply.sent`、`care.reply.failed`、`care.alert.created/updated`、
  `care.campaign.created/step.sent/step.recorded`、`care.settings.updated`。

## 8. 分期

- **P1（本次）**：本规格 §4–§6 全部；测试覆盖红旗/过滤、分诊决策、渠道发送（mock fetch）、随访提取、API、工具。
- **P2**：会话存档采集器直连 CareEngine；附件（图片/PDF）自动进入患者材料并 OCR；企业微信聊天工具栏侧边栏（JS-SDK 一键发送）。
- **P3**：多成员团队、专科模板库、回复质量评估与医生反馈闭环、统计报表。
