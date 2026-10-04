# 聊天连接插件

在「设置 → 随访连接」管理连接，在「随访 → 聊天随访」关联患者本人或家属的会话。每个插件独立保存账号、服务地址、加密连接密钥、启用状态与同步进度。同步只生成待复核来源草稿，归档仍需核对患者、发言人和联系时间。

## 微信：wx-cli

1. 按 [wx-cli 文档](https://github.com/pandorafuture/wx-cli) 在运行微信的 Mac 上完成安装、账号密钥和数据库准备。当前上游支持 macOS Apple Silicon、微信 4.1.7 及以上；密钥提取有独立的系统前置条件，已有密钥可手动配置。
2. 运行 `wx-cli server run`，默认地址为 `http://127.0.0.1:9100`。
3. 运行 `wx-cli server status --format json`，找到 `current_account.wxid`。在工作台选择「微信 · wx-cli」，填写该账号 ID、地址和已设置的 Bearer token，然后「验证并启用连接」。远程地址须使用 HTTPS 和连接密钥；回环地址上的 wx-cli 未设 token 时可以留空。
4. 进入聊天随访，选择患者，关联会话时选择 wx-cli 渠道并读取会话列表。核对会话 ID、患者关系和联系人称呼。列表最多显示 500 个会话，也可填写准确会话 ID。群聊的内部 ID 为 `room:<原始群 ID>`，例如 `room:123@chatroom`。
5. 点击「同步会话增量」。首次扫描该连接下全部已关联会话的本地历史，每次最多处理 10 页、每页 100 条；提示还有后续页时继续同步。自动同步使用现有的 5–1440 分钟间隔及最长 24 小时授权时段，工作台退出后停止。

每次请求前后都核对上游账号和 worker ID。服务换号或重启时拒绝写入本批数据。数据库分片读取异常时停止同步，不推进这一页的进度。消息 ID 按十进制原文读取，避免 JavaScript 舍入 Rust 的 64 位整数。消息和进度在同一数据库事务中保存，失败重试及历史重扫会去重。

本实现使用 `/api/v1/health`、`/api/v1/sessions` 和 `/api/v1/messages`，读取文本和媒体描述。媒体附件未解码；尚未接入搜索、联系人目录、SSE 或消息发送。它不会启动 wx-cli、提取密钥或修改系统设置。接口结构核对到上游提交 [`2abe708`](https://github.com/pandorafuture/wx-cli/tree/2abe708f55bfe135539a385df856fdc58f97fc74) 的 `crates/wx-cli/src/cmd/serve/handlers.rs`、`schema.rs` 和 `crates/wx-db/src/model.rs`。

历史只覆盖 wx-cli 当前可见的本地数据库。分页固定时间上限，后续轮次回看 5 分钟并去重；晚于这个窗口补入的旧消息，或历史分页期间发生的数据删除和回填，可能需要点击「重新扫描历史」。该按钮重置进度，下次同步重读已关联会话。隐藏配置始终交给 wx-cli 执行，不请求 `show_hidden`。已导入的记录不会随上游隐藏规则变化而自动删除；本实现也不会自动追溯更改已存消息的撤回状态。

群聊和关联多位患者的共享会话进入「待分配消息」，需人工核实归属。插件停用后停止后续读取，原文和草稿保留。

## 微信桌面回复（Windows）

「聊天随访」关联微信桌面会话后，可在会话卡片中回复消息（读取在 macOS 与 Windows 均可用；回复当前支持 Windows 微信 4.x）。要求本机已登录微信桌面版，并在系统「时间和语言 → 语言」中安装中文文本识别（OCR）组件。Windows 紧凑模式顶栏不显示会话名称，因此关联时无需框选标题，改为框选聊天内容区域并点选输入框位置；会话名称以人工填写为准。

回复走「已验证发送」：发送前核验该会话 1 小时内读取过、当前画面与最近读取内容连续；随后点击输入框、清空并粘贴内容，OCR 核验输入框确为待发内容后才按回车；发送后再 OCR 核验会话窗口中出现该内容。任一核验不通过即中止报错，不发送、不重试；失败时输入框可能留有待发内容，请人工检查。发出的消息按 `direction=out` 记入会话来源，不生成草稿。核验对 OCR 形近字与小幅丢字有容差（含 ASCII 锚点词的模糊命中），错误或截断的内容不会通过。

## 安装其他连接

打开「管理连接插件」，粘贴如下清单并安装，再选择新增的连接填写服务地址和账号：

```json
{
  "manifestVersion": 1,
  "id": "clinic-messages",
  "name": "诊所消息系统",
  "protocol": "archive-v1"
}
```

可直接使用 [示例清单](../examples/chat-connectors/connector.json)。`id` 是以小写字母开头、最多 40 字符的小写字母/数字/连字符字符串，不能重复。清单只接受上述四个字段，不执行脚本。支持的协议：

| protocol | 服务要求 |
| --- | --- |
| `wx-cli` | 实现 wx-cli 的 health、sessions、messages 接口；可为另一台 Mac 安装独立连接 |
| `archive-v1` | 实现下述通用消息采集协议，可对接院内系统、CRM 或其他聊天平台 |

安装清单保存在工作台数据库中，重启后恢复。内置插件可以停用，自定义插件可以移除；移除会取消进行中的读取和模型整理、清除连接密钥，保留来源记录。旧关联显示为不可用。重新安装同一个 ID 必须保持原协议，再验证启用。同账号同地址的原关联和去重记录可继续使用。

这是应用级聊天连接接口；工作区「扩展中心」的技能、命令和 MCP 插件仍使用各自的安装格式。

## archive-v1 服务契约

服务接收 `Authorization: Bearer <token>`。所有响应须为 JSON，含 `version: 1` 和 `corpId`，后者必须等于配置的账号 ID。`corpId` 是兼容现有企微采集协议的字段名，其他系统可用它表示租户或账号的稳定标识。

- `GET /v1/status`：返回 `{ "version": 1, "corpId": "tenant-a", "ready": true }`。
- `GET /v1/conversations`：返回相同身份字段，加 `conversations: [{ "id": "conversation-a", "lastMessageAt": "2026-10-01T10:00:00Z" }]` 和布尔 `partial`。最多 500 项，群聊 ID 使用 `room:` 前缀。
- `POST /v1/messages`：请求含 `cursor`（初始 `"0"`）、`limit: 100`、`conversations`（允许同步的会话 ID 列表）。服务按全局递增序号分页并返回：

```json
{
  "version": 1,
  "corpId": "tenant-a",
  "messages": [{
    "id": "source-message-1",
    "seq": "1",
    "conversationId": "conversation-a",
    "senderId": "contact-a",
    "direction": "in",
    "type": "text",
    "text": "已预约复查",
    "sentAt": "2026-10-01T10:00:00Z"
  }],
  "nextCursor": "1",
  "hasMore": false
}
```

`id` 须在账号内唯一且稳定，最长 200 字符。`seq` 和游标必须是 uint64 十进制字符串；本页每条序号严格递增、大于输入游标且不超过 `nextCursor`。有后续页时游标必须前进。每页最多 100 条，单条文本最多 20,000 字符；时间为有效 ISO 字符串或 `null`，方向为 `in`、`out`、`unknown`。不要把不确定发言者标作患者。每次响应最大 4 MB，超时 30 秒，不跟随重定向。工作台只存储已关联会话中的消息。

## 新增传输适配器

对无法转换为上述 HTTP 协议的系统，可在受信任的服务启动代码中注入适配器：

```js
createServer({
  chatFollowups: {
    plugins: [{
      id: 'my-system',
      name: '业务系统',
      protocol: 'my-system-v1',
      client: myConnector
    }]
  }
});
```

`myConnector` 实现以下异步方法：

- `status(config, signal?)` → `{ ready, message }`
- `conversations(config, signal?)` → `{ conversations: [{ id, title?, lastMessageAt }], partial }`
- `read(config, cursor, signal)` → `{ messages, nextCursor, hasMore }`

`config` 包含 `accountId`、`endpoint`、解密后的 `token`，读取时还包含 `conversations`。通用消息结构同上，但适配器自身管理游标，`seq` 非必需。必须验证远端账号、仅查询获准会话、尊重 AbortSignal，并返回稳定 ID。注册后设置、关联、定时同步和草稿流程自动使用该适配器。自定义代码与宿主服务同等可信，不通过清单上传执行；新增适配器后重新启动服务。

## 本地验证

```bash
node --test tests/chat-wx-cli.test.mjs tests/chat-followups.test.mjs
npm run build
node --test tests/chat-followups-ui.test.mjs
```

浏览器测试需要本机 Chrome。测试使用合成账号和消息，不依赖真实微信数据库。
