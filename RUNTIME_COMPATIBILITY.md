> 0.6 当前接口与通用能力以 [通用平台设计](docs/GENERIC_PLATFORM_06.md) 和 [验收记录](docs/PLATFORM_ACCEPTANCE.md) 为准。下方为历史兼容范围。

> **0.5 更新（2026-09-10）：** 当前实现已增加 MCP、受控离线插件生命周期、Docker 隔离终端、独立浏览器审批、持久语义记忆和单机分级扩展授权。本文其余旧表格是历史验收快照，不代表当前缺口。

# 接口与兼容范围

0.4 补充：已新增独立通用内核、工作区、文件审批、历史分支、子任务与计划 API；详细能力与限制以 [GENERIC_RUNTIME.md](docs/GENERIC_RUNTIME.md) 为准。下面的表格与医疗接口说明保留历史参考，不能将其中的未实现项或实现项直接当作最新全量验收。

本项目运行的是自研 `MedicalRuntime`。Pi、Hermes、DeepSeek Harness 是设计参考，不是被完整嵌入的产品。没有“切换到 Pi/Hermes 内核”的伪开关，也没有全量 SDK、CLI、扩展或协议兼容承诺。

| 参考      | 已采用                                                               | 未实现 / 未验证                                   |
| --------- | -------------------------------------------------------------------- | ------------------------------------------------- |
| WorkBuddy | 三栏工作区、会话、材料、产物、执行记录                               | 专有界面逐像素复刻、全部插件及医疗产品功能        |
| Pi        | 服务端会话、上下文预算、工具循环、取消                               | Pi SDK / 事件格式 / 扩展生态 / 会话树全兼容       |
| Hermes    | JSON-RPC 请求和事件通知分离、WS 网关                                 | 完整 Hermes Gateway RPC、通用终端、技能市场       |
| DeepSeek  | Chat Completions SSE、工具片段聚合、reasoning_content 续轮、有限重试 | DeepSeek Harness 完整产品复刻；真实服务需单独验证 |

## HTTP

所有会话接口需要 `X-Medical-Token`。本地页面从 `GET /api/bootstrap` 获取每次启动随机生成的令牌；同时检查 Host、Origin 和 Fetch Metadata。该机制防止浏览器跨站访问，不抵御已控制本机的程序。

| 接口                                                  | 用途                                         |
| ----------------------------------------------------- | -------------------------------------------- |
| `GET /api/agent/health`                               | 运行时存活与模型是否配置，不代表真实模型探活 |
| `GET /api/bootstrap`                                  | 本地页面配置及短期运行时令牌                 |
| `GET/POST /api/sessions`                              | 会话列表 / 创建                              |
| `GET/PATCH/DELETE /api/sessions/:id`                  | 读取 / 改名 / 删除                           |
| `POST /api/sessions/:id/files`                        | 导入文本或浏览器提取的 PDF 文本              |
| `DELETE /api/sessions/:id/files/:fileId`              | 删除未被引用的材料                           |
| `GET /api/sessions/:id/search?q=…`                    | 本会话材料的字面检索                         |
| `POST /api/sessions/:id/copy-materials`               | 复制所选材料到无历史的新会话                 |
| `PATCH /api/sessions/:id/artifacts/:artifactId`       | 乐观版本检查后的产物修改                     |
| `POST /api/sessions/:id/artifacts/:artifactId/review` | 本地人工复核记录                             |
| `GET /api/sessions/:id/audit`                         | 最近 200 条本地审计                          |
| `GET /api/sessions/:id/events`                        | append-only 运行轨迹分页读取                 |
| `GET /api/skills`                                     | 可发现的医疗技能元数据                       |
| `GET /api/sessions/:id/export?format=md\|json`        | 脱离运行时的会话导出                         |
| `POST /api/chat/:id`                                  | 提交任务，响应 SSE                           |
| `POST /api/chat/:id/cancel`                           | 取消当前执行                                 |
| `POST /api/agent/run`                                 | 同步兼容入口，共用医疗策略和运行内核         |

任务示例（`sessionRevision` 从读取会话获得，`requestId` 每次新请求唯一）：

```json
{
  "message": "请整理本次材料的时间线",
  "mode": "local",
  "fileIds": [],
  "sessionRevision": 0,
  "requestId": "unique-request-id"
}
```

模型模式须 `mode: "model"` 与 `externalConsent: true`；未配置模型返回 503，未确认返回 412。会话版本冲突、重复请求、同会话并发返回 409。上下文预算超限不静默裁剪病历。

SSE 每帧为 `event: message`，JSON 含 `seq`、`type`、`session_id`、`run_id`、`payload`、`time`。终态为 `message.complete`、`error`、`run.cancelled`。连接终止但没有终态时，客户端须视为未完成。非增量事件和部分文本会持久化；不提供 `Last-Event-ID` 自动流重放。

## WebSocket 子集

连接 `ws://127.0.0.1:8787/api/ws?token=…`，接收 `gateway.ready` 通知。支持 `session.create`、`session.get`、`prompt.submit`、`prompt.cancel`，只覆盖本工作台所需子集。

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "prompt.submit",
  "params": {
    "session_id": "existing-session-id",
    "text": "整理病历时间线",
    "mode": "local",
    "fileIds": []
  }
}
```

提交只产生一次 RPC 确认；后续执行通过 `method: "event"` 通知返回。断开连接会取消该连接发起且仍在执行的任务。SSE、WebSocket 和兼容同步接口共用策略、作用域和工具注册表，不能绕过模型外发确认。

详细参数以 `server/agent.mjs` 为准；本项目没有发布稳定公共协议版本，外部集成应固定项目版本并运行协议测试。

## Codex 参考范围

OpenAI 的 [Codex CLI](https://github.com/openai/codex) 是 Apache-2.0 开源项目，包含本地 agent 和 app-server；Codex Desktop/App 本身不是开源项目。当前技能和插件例子在 [openai/plugins](https://github.com/openai/plugins)，旧的 `openai/skills` 仓库已标记为 deprecated。

本项目现在支持医疗版的 `SKILL.md` 发现、元数据列表和受限只读说明读取（`skills/`、`GET /api/skills`、`list_skills`、`read_skill`）。这不是 Codex Skills 的完整实现：尚未支持 `.codex-plugin/plugin.json`、marketplace、agents、commands、hooks、MCP surfaces、技能安装器、技能评测器、资源/脚本执行、skill 输入注入协议或 Codex app-server 协议。医疗版支持受限 Python OS 沙箱和同 Provider 的医疗子代理，不提供任意文件编辑、任意联网或外部代理协议。

## 医疗编排扩展

新增 `delegate_medical_task`、`sandbox_python` 模型工具和 `/api/sessions/:id/schedules` 持久计划接口。任务请求支持 `delegations: ["timeline", "observations", "medication"]`；本地请求可传 `sandboxCode` 执行隔离计算。具体字段、取消语义、资料绑定与平台限制见 [docs/ORCHESTRATION.md](docs/ORCHESTRATION.md)。
