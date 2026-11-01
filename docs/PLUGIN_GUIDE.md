# 领域插件开发指南

面向以后给 Open Medical 增加新场景的开发者。目标：**新增一个场景 = 新增一个插件目录**，不修改固定区（`src/main.jsx`、`src/patients.jsx`、`src/doctor-agenda.jsx`、`server/agent.mjs`、`server/store.mjs` 等）。

本指南以当前实现为准：`server/plugin-host/define.mjs`、`server/plugin-host/host.mjs`、`src/plugin-slots.jsx`。方案背景见 [插件化重构方案](refactor/PLUGIN_REFACTOR_PLAN.md)，整体分层见 [架构说明](ARCHITECTURE.md)。

---

## 1. 固定区还是插件：一页判断标准

### 1.1 三条判断线

| 问题 | 固定区 | 插件 |
| :--- | :--- | :--- |
| 医生是否**每天都用**，且离开它整个工作台不成立？ | 是：对话、患者列表/档案、复诊预约、今日待办壳、知识库、知识图谱、设置 | 否：某个专科、某项研究、某个渠道、某个自动化 |
| 是否拥有**自己的数据表**和写入规则？ | 只拥有患者、消息、提醒等核心表 | 是：新表必须带插件前缀；旧表用 `legacyTables` 声明 |
| 是否希望**停用后固定区仍完整可用**？ | 固定区本身 | 是：停用后工具、待办、接口、界面一起消失，数据保留 |

固定区是**壳**：负责统一对话入口、患者上下文、权限/提案、插槽位置和基础布局。插件是**场景**：贡献数据、服务、工具、提示、提案、待办来源、HTTP 路由和前端组件。

### 1.2 什么时候应该做成插件

满足任意一条，优先做插件：

- 只有部分医生/科室需要（DRG、临床试验、科研统计、临床速查）。
- 依赖外部渠道或第三方系统（企业微信、个人微信、飞书）。
- 需要自己的表、自己的迁移、自己的后台任务。
- 会持续增加新的同类场景（每加一个量表、一个渠道、一个统计方法）。
- 停用后不应该影响患者档案、知识库和对话。

### 1.3 什么时候应该留在固定区

- 患者身份、档案、诊断/用药/检验/就诊的读写规则。
- AI 提案引擎、权限、审计、会话/运行生命周期。
- 统一对话、结果卡片容器、提案确认托盘。
- 今日待办的合并、排序、分页、计数（来源可以由插件提供）。
- 知识库的导入、检索、原文引用和版本。
- 设置页的插件管理壳。

### 1.4 不允许的捷径

- **不要**为了一个新场景去改 `src/main.jsx` 的路由三元表达式或 `server/agent.mjs` 的业务分支。
- **不要**在固定区直接 `SELECT/INSERT` 插件表；通过 `ctx.service()`、宿主事件或 `hooks` 跨边界。
- **不要**把插件 CSS 当作固定区基础布局；共享布局样式必须留在固定区静态入口。
- **不要**让插件停用后固定区报错；所有可选能力都要有 404/空数组/默认值的优雅降级。

---

## 2. 插件目录结构

```
plugins/<id>/
  plugin.mjs                 # 服务端入口：export default definePlugin({...})
  migrations/                # 001_init.sql, 002_xxx.sql …（只追加）
  prompt.md                  # 可选：追加到医疗系统提示的片段，≤600 字
  skills/                    # 可选：技能目录，结构同根目录 skills/
  server/                    # 可选：服务端实现（service、workflow、工具）
  api/                       # 可选：HTTP 路由实现
  ui/
    index.jsx                # 前端入口：export default defineUiPlugin({...})
    Tab.jsx / Card.jsx / *.css
  test/
    plugin.test.mjs          # 插件自己的 node:test 测试
```

命名：

- 目录名必须等于插件 `id`。
- `id` 匹配 `/^[a-z][a-z0-9-]{1,39}$/`：小写字母开头，只含小写字母、数字、连字符，2–40 位。
- 新表前缀匹配 `/^[a-z][a-z0-9_]{0,39}$/`，建议用 `id` 把连字符换成下划线，再加 `_`，例如 `pain_score_`。
- 新提案 kind 必须是 `<id>.<name>`，例如 `pain-score.record.create`。
- 自有 HTTP 路由必须是 `/api/p/<id>/...`；旧业务路径用 `legacyApiPaths` 声明。

最小可用插件只需要 `plugin.mjs`；要存数据就加 `migrations/` 和 `tablePrefix`；要界面就加 `ui/index.jsx`。

---

## 3. 服务端：`definePlugin`

```js
import { definePlugin } from "../../server/plugin-host/define.mjs";

export default definePlugin({
  id: "pain-score",
  version: "1.0.0",
  title: "疼痛评分",
  enabledByDefault: true,
  migrations: "./migrations",
  tablePrefix: "pain_score_",
  prompt: "./prompt.md",
  setup(ctx) {
    return { /* 本插件 service */ };
  },
});
```

`definePlugin` 只做校验、归一化和冻结，不执行任何业务逻辑。宿主加载时会再校验一次，坏插件只会被标记为 `unavailable`，不会拖垮整个服务。

### 3.1 字段逐项说明

#### `id`（必填，string）

插件唯一标识，同时是目录名、服务名（`provides.service` 默认同名）、UI `id` 和路由命名空间。必须匹配 `/^[a-z][a-z0-9-]{1,39}$/`。

#### `version`（必填，string）

插件版本，例如 `"1.0.0"`。其它插件可以用 `requires.plugins: { "pain-score": "^1.0.0" }` 约束。支持 `*`、`x`、精确版本、`^`、`~`、比较符和 `||` 组合。

#### `title`（必填，string）

设置页、插件列表和默认提示里显示的中文名称。

#### `requires`（可选，object）

```js
requires: {
  plugins: { "patient-core": "*", "channel": "^1.0.0" }, // 或 ["patient-core"]
  anyOf: [["channel-wecom", "channel-wechat"]],          // 每组至少一个
}
```

- `plugins`：对象 `{ id: 版本范围 }`，或字符串数组（等价于全部 `*`）。依赖必须**存在、已启用、可用且版本满足**。
- `anyOf`：数组的数组。每组是“或”，组与组之间是“且”；`[[a,b],[c]]` 表示 `(a 或 b) 且 c`。
- 缺依赖、版本不满足、依赖环都不会让服务崩溃：该插件变为 `unavailable`，`reason` 说明原因。

#### `enabledByDefault`（可选，boolean，默认 `true`）

首次启动、`plugin_state` 还没有记录时的默认启用状态。测试插件、示例插件通常设为 `false`，避免影响截图基线和默认体验。

#### `keepEnabledOnUpgrade`（可选，boolean，默认 `false`）

和 `enabledByDefault: false` 搭配，用于“原来默认开启、现在改为默认关闭”的插件。全新安装时默认关闭；已有数据的升级用户（有插件迁移记录或已有患者）保持开启。首次判断结果写入 `plugin_state`，之后以医生的设置为准。

#### `migrations`（可选，string）

相对插件目录的迁移目录，例如 `"./migrations"`。宿主按文件名排序执行未应用的 `.sql`，每个文件一个事务，并写入 `plugin_migrations(plugin_id,name,applied_at)`。迁移幂等由宿主保证；SQL 仍应使用 `IF NOT EXISTS`。已应用的迁移不能修改，只能追加新文件。

#### `tablePrefix`（有 `migrations` 时必填，string 或 string[]）

新表必须以此开头。允许一个插件拥有多个历史表族：

```js
tablePrefix: ["follow_", "followup_", "chat_", "care_"],
```

迁移里的 `CREATE TABLE`、`ALTER TABLE`、`CREATE INDEX` 都会被校验；出现不属于任何前缀的表名会让插件 `unavailable`。

#### `legacyTables`（可选，string[]）

声明插件继续读写的**旧表原名**，例如 `["case_library", "risk_alerts"]`。这些表不受前缀校验，也不会被改名；它们只是把归属告诉宿主和表归属测试。固定区不得直接读写它们。

#### `setup(ctx)`（可选，function）

初始化插件，返回本插件的 service 对象；宿主注册为 `services[id]`，同时让 `ctx.plugins[id].service` 可用。

```js
setup(ctx) {
  return {
    list(patientId) {
      return ctx.db.prepare("SELECT ... FROM pain_score_records WHERE patient_id=?")
        .all(patientId);
    },
  };
}
```

- 按依赖拓扑顺序调用。
- 抛错 → 插件 `unavailable`，原因写入 `reason`。
- 声明了 `provides.service` 却没有返回值 → `unavailable`。
- 不要在这里启动长任务；用 `lifecycle.start`。

#### `tools(ctx, { registry, workspace, run })`（可选，function）

注册 Agent 工具。工具定义沿用 `ToolRegistry.register({ definition, execute, permission, capability })`。

```js
tools(ctx, { registry }) {
  registry.register({
    permission: "tools.execute",
    capability: { backend: "local" },
    definition: {
      type: "function",
      function: {
        name: "pain_score_list",
        description: "读取某位患者的疼痛评分记录。",
        parameters: {
          type: "object",
          properties: { patientId: { type: "string" } },
          required: ["patientId"],
          additionalProperties: false,
        },
      },
    },
    execute: ({ patientId }) => ({
      records: ctx.plugins["pain-score"].service.list(patientId),
    }),
  });
}
```

规则：

- **只读工具**直接调用 service；**写入工具**必须生成提案（`*_propose`），不能直接写库。
- 工具名全局唯一；重复会让插件 `unavailable`。
- 停用插件不注册工具；历史会话中的旧产物仍用 fallback 展示。
- 不要依赖 `run` 一定存在：宿主兼容路径可能传 `null`。

#### `prompt`（可选，string）

相对插件目录的提示片段路径，例如 `"./prompt.md"`。只有启用且激活的插件会拼到医疗系统提示末尾。建议 ≤600 字，只写“什么时候用哪个工具、什么时候不要用”。

#### `skills`（可选，string）

相对插件目录的技能目录。只有激活插件会加入技能搜索路径；目录不存在会让插件 `unavailable`。技能只作为模型说明书，没有执行语义。

#### `proposals`（可选，object）

新提案类型。key 必须以 `<id>.` 开头：

```js
proposals: {
  "pain-score.record.create": {
    revisionScoped: true,
    validate(input, ctx) {
      if (!input?.patientId || !input?.score) throw new Error("缺少患者或评分");
      return { patientId: input.patientId, score: Number(input.score) };
    },
    apply(input, ctx, tx) {
      tx.prepare("INSERT INTO pain_score_records(patient_id,score,created_at) VALUES (?,?,?)")
        .run(input.patientId, input.score, ctx.now());
      return { patientId: input.patientId, score: input.score };
    },
  },
}
```

- `validate(input, ctx)`：返回归一化后的 payload；抛错则提案创建失败。
- `apply(normalizedPayload, ctx, tx)`：在确认提案的同一 SQLite 事务内执行；`tx` 是事务连接，抛错整体回滚。
- `revisionScoped`：为 `true` 时，确认阶段仍校验患者 `base_revision`，防止“生成提案后档案被改过”。
- 通过 `ctx.proposals.create({ kind, patientId, input, summary })` 创建；payload 包在 `{ input }` 里。

#### `legacyProposalTypes`（可选，object 或 string[]）

接管历史提案 type，数据库字符串不变。

```js
legacyProposalTypes: {
  "followup-create": {
    revisionScoped: true,
    validate({ type, patientId, payload }, ctx) { return normalizedPayload; },
    apply(normalizedPayload, ctx, tx, { action }) { /* ... */ },
  },
},
// 或
legacyProposalTypes: ["followup-create"],
// 此时 proposals 里要有 "followup.followup-create"
```

- 停用插件后历史提案仍能列表（`knowsProposalType`），但确认返回 409 `PLUGIN_UNAVAILABLE`。
- 旧 type 的 payload 保持原来的顶层形状；新提案才是 `{ input }` 信封。

#### `agendaSources`（可选，array）

今日待办来源。固定区只自带“复诊”和“待阅检验”，其余 kind 全部来自插件。

```js
agendaSources: [{
  kind: "pain-score",
  label: "疼痛评分",
  order: 60,
  read(ctx, { now, patientId }) {
    return ctx.plugins["pain-score"].service.due(now).map((row) => ({
      id: `pain-score:${row.id}`,
      kind: "pain-score",
      patientId: row.patient_id,
      title: `疼痛评分待复评：${row.score}`,
      detail: "上次评分已超过 3 天",
      at: row.created_at,
      weight: 4,
      action: { type: "patient", tab: "p:pain-score:records", label: "去复评" },
    }));
  },
}];
```

返回的每一项至少包含 `id`、`title`；`patientId`、`detail`、`at`、`weight`、`action`、`lane` 可选。宿主会补 `kind` 和 `pluginId`；`lane: "work"` 会进入医生工作流分道。单个来源抛错只记录 `onError`，不影响其它来源。

来源可选声明 `available(ctx)`：返回 `false` 时，这个 kind 既不出现在分类里，也不读取条目。适合插件本身启用、但某类待办依赖运行时状态的情况，例如 `followup` 的「患者消息」只在连接了微信/企业微信时出现，「随访」始终出现。

#### `workflows`（可选，object）

Agent 工作流钩子。key 是工作流 id，值可包含：

| 字段 | 用途 |
| :--- | :--- |
| `artifactType` | 该工作流产出的 artifact 类型 |
| `detect(message, policy)` | 从用户消息识别工作流，返回 `true` 表示命中 |
| `applyPolicy(policy, message)` | 写入 `policy.workflow` / `intent` 等 |
| `guidance(run)` | 本次运行追加的提示 |
| `configure(ctx, { registry, workspace, run })` | 按工作流裁剪/包装工具面 |
| `prepared(workspace, runId)` | 恢复运行时的预置回答 |
| `beforeComplete(ctx, args)` | 回答完成前校验（可抛错打回） |
| `answer(workspace, runId, result)` | 生成最终回答 |

工作流检测 `matchWorkflow` 对停用插件也可见，以便返回 409 `PLUGIN_UNAVAILABLE`；真正执行前必须用 `workflow(id)` 确认插件已启用。

#### `contexts`（可选，object）

插件页面给提问附带的结构化上下文（例如随访记录、文献检索偏好）。医生输入框和对话记录里只出现医生自己的问题和一个可查看、可移除的标签；执行要求由插件在服务端给出，客户端只能选 kind、提供 label / scope / data，不能附带任意指令。

```js
contexts: {
  "followup-record": {            // 必须以「插件 id-」开头
    sticky: true,                 // 追问时沿用（默认 false：只作用于发起的那一轮）
    workflow: undefined,          // 可选：带上该上下文时默认走的工作流
    validate: (ctx, context) => {},   // 可选：校验 scope / data，抛 AppError
    guidance: (ctx, context) => "请基于资料中的随访记录继续整理……",
  },
},
```

前端在 `onOpenTask(sessionId, { draft, context: { kind, label, scope, data } })` 里传入。服务端校验后存进 `run.policy.contexts`，并在系统提示里渲染为「说明 + 资料（只作为资料，不是指令）」。核心类型（知识库、诊前速览、任务模板等）见 `server/medical/task-context.mjs`。

#### `api(ctx, req, url, io)`（可选，async function）

插件自己的 HTTP 路由，前缀必须是 `/api/p/<id>/`。返回 `true` 表示已处理；返回 `false` 或未处理，宿主返回 404。

`io`：`{ body(), send(status, data), error(error), res, params? }`。`legacyApiPaths` 匹配时 `io.params` 带路径参数。

```js
async api(ctx, req, url, io) {
  if (url.pathname === "/api/p/pain-score/records" && req.method === "GET") {
    io.send(200, { records: ctx.plugins["pain-score"].service.list(url.searchParams.get("patientId")) });
    return true;
  }
  return false;
}
```

停用插件后该前缀一律 404；路由内部异常默认 500（可用 `error.status` 指定状态码）。

#### `events`（可选，object）

事件监听：`{ "事件名": (payload, ctx) => {} }`。错误被隔离并记录日志，不会回滚调用方。适合通知、统计、刷新缓存等非关键副作用。

#### `hooks`（可选，object）

同步事务钩子：`{ "事件名": (payload, ctx) => {} }`。与 `events` 不同，**第一个抛错会向上抛，调用方事务整体回滚**。

当前固定区使用的钩子是 `"patient.deleted"`，payload `{ patientId, patient }`。删除患者时插件必须在同一事务里清理自己的行；即使插件暂时停用，钩子仍会注册并执行，避免遗留孤儿数据。

#### `patientSummary(ctx, patientIds, { now })`（可选，function）

患者列表计数贡献。返回 `{ [patientId]: { activeFollowups, dueFollowups } }`（患者列表读取这两个字段）；患者在简报中的 `careTaskCount` / `careTasks` / `activeRisks` 走 `patientBrief`。固定区只合并它认识的字段；插件停用或抛错时保持历史空值，不影响名单。

#### `patientBrief(ctx, patientId)`（可选，function）

患者简报贡献。返回 `{ careTaskCount, careTasks, activeRisks }` 等字段；固定区提供空默认值。

#### `demo`（可选，object）

示例数据由插件自己装卸：

```js
demo: {
  async install(ctx, demo) {
    const patient = demo.patient(1);
    demo.own("pain-score", "pain-score", () =>
      ctx.plugins["pain-score"].service.create(patient.id, { score: 4 }));
  },
  async clear(ctx, demo) { /* 删除本插件示例行 */ },
  exists(ctx, kind, id, demo) { return false; },
}
```

`demo` 由 `DemoPack` 传入，常用 `demo.patient(index)`、`demo.own(key, kind, create)`、`demo.resources()`。`install` 只在激活插件执行；`clear` / `exists` 对可用但停用的插件也执行，保证历史示例可见、可删。

#### `legacyApiPaths`（可选，array）

接管旧业务路由，不改 URL：

```js
legacyApiPaths: [
  { method: "GET", path: "/api/followup-plans" },
  { method: "*", path: "/api/patients/:id/followups/:jobId" },
  { method: "GET", path: "/api/wecom/*" },
],
```

- `method` 支持 `GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS/*`，默认 `GET`。
- `path` 必须以 `/api/` 开头，支持 `:param` 和末尾 `*`；`*` 只能出现在最后一段。
- 多个插件声明同一路径会 **fail fast**（插件 `unavailable`），不会静默覆盖。
- 匹配发生在 token 鉴权之后、固定区业务路由之前；插件停用后该路径回落到固定区（通常是 404）。
- 处理函数仍是同一个 `api(ctx, req, url, io)`，通过 `io.params` 取参数。

#### `lifecycle`（可选，object）

```js
lifecycle: {
  start(ctx) {},   // 建定时器、连 socket、启动轮询
  stop(ctx) {},    // 停止接收新工作
  drain(ctx) {},   // 等待在途工作，默认 5s 超时
}
```

- `startAll()`：按依赖拓扑启动；失败隔离。
- `stopAll()`：逆序停止。
- `drainAll()`：逆序 drain，超时放弃，不阻塞退出。
- 运行时启停插件也会调用 `stop/start`。
- `activation.requiresConnection` 的插件只有在激活后才会启动。

#### `provides`（可选，object）

```js
provides: { service: "pain-score", apiVersion: 1 }
```

声明本插件提供可被其它插件调用的服务。`service` 必须匹配插件 id 规则，`apiVersion` 是正整数（默认 1）。同一个服务只能由一个插件提供；重复会让后加载者 `unavailable`。其它插件用 `ctx.service("pain-score", { apiVersion: 1 })` 调用，取不到时抛 503/409。

#### `status`（可选，function）

向 bootstrap 汇报运行时状态。可返回：

- `true` / `false`；
- `{ connected: boolean }`；
- `{ state: "ready" | "..." }`；
- `{ connected, capabilities }`（capabilities 会与静态 `capabilities` 合并）。

配合 `activation.requiresConnection` 使用。`listWithStatus` 有 5 秒超时；status 抛错只影响连接状态，不影响服务启动。

#### `capabilities`（可选，string[] 或 object）

静态能力声明，例如 `["followup.agenda", "followup.tools"]` 或 `{ backend: "network" }`。会出现在 `/api/plugins` 与 bootstrap 的插件列表里，供前端/其它插件判断。动态能力可由 `status` 返回。

#### `activation`（可选，object）

```js
activation: { requiresConnection: true }
```

插件“已启用但尚未激活”时：不注册工具、不提供待办、不注入提示、不渲染业务插槽；设置页的连接面板仍可通过 `availableWhenDormant` 保持可达。激活条件由 `status` 决定。

只有整个插件都离不开连接时才用它。若只是部分功能需要连接，保持插件激活，在内部按 `status().connected` 分开：工具注册时判断、待办来源用 `available(ctx)`、接口返回 409、界面插槽用 `requiresConnection: true` 或 `usePluginConnected(id)`；服务端可用 `host.isConnected(id)` 读当前连接。`followup` 就是这样：随访计划和医生提醒始终可用，患者消息相关功能等连接后才出现。

### 3.2 `ctx` 全貌

宿主每次调用插件时传入冻结的 context：

```js
{
  db,                  // 同一个 SQLite 连接
  store,               // 固定区 store
  services,            // 固定区服务 + 所有已装载插件服务（{ id: service }，含暂时停用但可用的插件）
  service(id, opts),   // 解析 provides.service；opts 可为 { apiVersion } 或数字
  plugins,             // { [pluginId]: { id, service, apiVersion, available, enabled } }
  events: { emit(name, payload), on(name, listener) },
  now: () => new Date().toISOString(),
  log: (...args) => {},
  config: { get(key), set(key, value) },  // plugin_config 表，JSON 序列化
  proposals: { create({ kind, patientId, input, summary }) },
  plugin: { id, dir }, // 当前插件
  fail(reason),        // 立即把本插件标记为 unavailable
}
```

注意：

- `ctx.services` 同时含固定区和插件服务；固定区服务名不会与插件 id 冲突（冲突时以插件服务为准，加载顺序由宿主保证）。
- `ctx.plugins` 只列出声明了 `provides.service` 的插件；普通插件不要假设自己出现在这里。
- `ctx.config` 的值会 `JSON.stringify`，读取时自动 `JSON.parse`。
- `ctx.now()` 返回 ISO 字符串；需要毫秒时间戳时自己 `Date.parse`。
- 不要在插件里创建第二个 SQLite 连接；用 `ctx.db` 或 `ctx.store.db`，才能共享事务。

### 3.3 宿主扩展点总表

| 扩展点 | 触发时机 | 停用/未激活时 |
| :--- | :--- | :--- |
| `setup` | 加载后、启动前 | 停用仍执行（为了保留服务定义）；不可用跳过 |
| `tools` | 每次注册工具面 | 不注册 |
| `prompt` / `skills` | 每次构造系统提示/技能路径 | 不注入 |
| `proposals` | 创建/确认提案 | 创建报错；确认 409，历史仍可列表 |
| `legacyProposalTypes` | 同上 | 同上 |
| `agendaSources` | 每次读今日待办 | 不返回条目 |
| `workflows` | 消息路由/运行配置/完成校验 | 不执行；检测仍可用于报 409 |
| `contexts` | 校验提问附带的上下文、渲染系统提示 | 提交报 409，已存的上下文不再沿用 |
| `api` / `legacyApiPaths` | HTTP 请求 | 404 / 回落固定区 |
| `events` | `ctx.events.emit` 或宿主事件 | 不注册 |
| `hooks` | 固定区事务点（目前是 `patient.deleted`） | **仍执行**（清理数据） |
| `patientSummary` / `patientBrief` | 患者列表/简报 | 不贡献，返回空默认值 |
| `demo.install` | 装载示例 | 不执行 |
| `demo.clear` / `exists` | 删除/检查示例 | 可用插件仍执行 |
| `lifecycle` | 启动/停止/drain | 不启动 |
| `provides.service` | `ctx.service()` | 解析报 503 |
| `status` | bootstrap/插件列表/激活判断 | 不调用（停用） |
| `activation` | 启停与连接变化 | 保持 dormant |

---

## 4. 前端：`defineUiPlugin` 与插槽

### 4.1 入口

```jsx
// plugins/pain-score/ui/index.jsx
import { defineUiPlugin } from "../../../src/plugin-slots.jsx";

export default defineUiPlugin({
  id: "pain-score",
  slots: {
    "patient.tabs": [
      {
        id: "records",
        label: "疼痛评分",
        order: 60,
        area: "record",
        component: () => import("./PainScoreTab.jsx"),
      },
    ],
    "chat.resultCards": {
      pain_scores: {
        label: "查看疼痛评分",
        component: () => import("./PainScoreCard.jsx"),
      },
    },
  },
});
```

固定区用 `import.meta.glob("../plugins/*/ui/index.jsx", { eager: true })` 收集入口；入口模块可以 eager，**组件本身必须是 `() => import(...)`**，由 `defineUiPlugin` 统一包成 `React.lazy`。

### 4.2 全部插槽

`SLOTS` 当前共 9 个：

| 插槽 | 形态 | 固定区位置/props | 说明 |
| :--- | :--- | :--- | :--- |
| `patient.tabs` | 数组 | 患者页 tab；`{ patient, config, ... }` | 支持 `area`、`legacyTab`、`replacesBuiltin`、`label` 函数、`order` |
| `patient.overviewCards` | 数组 | 患者概览卡片末尾；`{ patient }` | 只读概览卡片 |
| `patient.actions` | 数组 | 患者页“更多”菜单；`{ id, label, run(patient, api) }` | 动作不是组件 |
| `agenda.sources` | 数组 | 今日待办分类元数据 | 通常只声明 `{ id, label, order }`；真正的待办由服务端 `agendaSources` 提供 |
| `chat.resultCards` | 键值对象 | `{ artifact }` | key 是 `artifact.type`；找不到时走固定区 fallback |
| `proposal.renderers` | 键值对象 | `{ action }` | key 是提案 `type`；找不到时走固定区预览 |
| `settings.panels` | 数组 | 设置页；`{ plugin, onDoctor, onAsk }` | 支持 `legacyTab`、`availableWhenDormant`、`order` |
| `tools.directory` | 数组 | “资料与工具”页；`{ onNavigate, config }` | 卡片需要 `meta`（名称/描述/分类/关键词） |
| `legacyViews` | 键值对象 | 旧 `?view=` 页面；`{ view, config, onNavigate, ... }` | 保持旧 URL，不新增路由 |

`patient.tabs` 的字段：

- `id`：tab 标识。没有 `legacyTab` 时 URL 使用 `p:<plugin>:<id>`。
- `label`：字符串，或 **仅 `patient.tabs` 支持函数** `({ patient, counts }) => string`（历史“消息记录 · N 待整理”依赖它）。
- `order`：数字，默认 100；与固定 tab 一起排序。
- `area`：`"record"`（病历）或 `"communication"`（沟通与随访），默认 `record`。
- `legacyTab`：历史 tab 名（`^[a-z][a-z0-9-]*$`），保持旧 URL；同一插件内不能重复。声明后自动 `replacesBuiltin: true`。
- `replacesBuiltin`：布尔值；`legacyTab` 与固定 tab 同名时替换固定 tab，而不是追加两个按钮。
- `meta`：可选对象，供工具目录/卡片使用。

`settings.panels` 额外支持 `availableWhenDormant`：插件因未连接渠道而 dormant 时，连接设置面板仍然可达（否则医生无法重新连接）。

任何插槽都可以声明 `requiresConnection: true`：插件已激活、但 `status().connected` 不为 `true` 时不渲染（例如 `followup` 的「消息记录」tab 和「患者消息」工具卡）。

`chat.resultCards` / `proposal.renderers` / `legacyViews` 是 keyed slot，值必须是 `{ 类型: 加载函数 }`，也可直接写加载函数。`label` 只支持字符串。

### 4.3 注册与 hooks

```js
import {
  registerUiPlugins,
  useSlot,
  useActiveSlot,
  usePluginEnabled,
  usePluginActive,
  Slot,
  SlotItem,
  ResultCard,
  LegacyView,
  mergePatientTabs,
  findPatientTab,
  patientTabLabel,
  findSettingsPanel,
} from "./plugin-slots";
```

- `registerUiPlugins(modules, enabled, active)`：固定区在 bootstrap 变化时调用；只注册 `status === "ready"` 的插件。`enabled` 决定是否注册，`active` 决定业务插槽是否渲染。
- `useSlot(name)`：返回所有已启用插件的贡献（含 dormant 插件的设置面板）。
- `useActiveSlot(name)`：只返回已激活插件的贡献；业务入口（患者 tab、工具卡片、待办）用它。
- `usePluginEnabled(id)` / `usePluginActive(id)`：固定区用来显示/隐藏启动插件的入口。
- `<Slot name="..." />`：列表型插槽，每项独立 `Suspense + ErrorBoundary`，空插槽不产生 DOM。
- `<SlotItem contribution={...} />`：单独渲染一项，供获得 `findPatientTab` 结果的固定区使用。
- `<ResultCard artifact={...} fallback={...} />`：按 `artifact.type` 查找并渲染；缺失时调用 fallback。
- `<LegacyView view="..." fallback={...} />`：旧 `?view=` 的插件实现；缺失时回落固定区。

### 4.4 `plugin-kit`

插件 UI 只能引用：

- `src/plugin-kit/*`（推荐）；
- 插件自己的文件；
- 明确允许的共享模块（例如 `shared/` 中无 UI 副作用的纯函数）。

`src/plugin-kit/index.js` 当前 re-export：

- `IconButton`
- `Badge`
- `Modal`
- `STATUS`
- `CuratedCaseSources`

这样插件不必直接 import `src/components.jsx` 或固定区页面，减少耦合。

### 4.5 懒加载与默认导出

组件文件必须 **default export** React 组件：

```jsx
export default function PainScoreTab({ patient }) { ... }
```

如果组件是命名导出，加载函数必须显式转换：

```js
component: () => import("./Tab.jsx").then((m) => ({ default: m.PainScoreTab })),
```

`defineUiPlugin` 会检查 `component` 是函数，并调用 `lazy(loader)`。**不要**传已经 `lazy()` 过的对象，也不要在 `slots` 里直接写 `<Component />`。

---

## 5. 规则清单（每条都对应一次真实的坑）

### 5.1 表归属

插件只读写自己的迁移表和 `legacyTables`。固定区访问插件数据必须通过 `ctx.service`、`patientSummary/patientBrief`、`agendaSources` 或 `hooks`。

> **坑**：`medical-workspace-domain.mjs` 的提示里混入企业微信工具名后，表归属扫描把它当成固定区直接访问 `wecom_groups`；T11a 只能用一条白名单临时压住。T11c 把提示移进 `channel-wecom/prompt.md`，白名单清零。

### 5.2 写入走提案

任何改变患者数据或对外发送的动作，都必须先创建提案，由医生确认后在事务内 apply。

> **坑**：早期页面直接 `POST` 写表，模型也“看起来保存成功”，但审计、revision 和回滚都不成立。现在固定区和插件都只调用 service 的提案入口。

### 5.3 发给患者必须医生确认

消息、随访、群发、自动回复草稿都不能由插件直接发送；只能生成待确认提案或草稿。

> **坑**：随访插件曾把“生成草稿”和“已发送”混在一句回答里，医生以为已经发出。现在 `care_send_propose` / `care_campaign_propose` 的提示明确要求“告诉医生到待确认面板核对，不要声称已发送”。

### 5.4 CSS 迁移规则

只移动选择器**仅被插件组件使用**的规则。被固定区或共享布局使用的规则必须留在固定区原文件，并由静态入口按原顺序导入。

> **坑**：T9 把共享布局 CSS 跟着 care 页面移进插件，插件异步 chunk 加载顺序变化，知识库布局整体偏移，截图基线失败；T9b 又把共享规则移回固定区。

### 5.5 懒加载组件默认导出

插槽组件必须是 `() => import()`，组件文件 default export；命名导出要显式转换。

> **坑**：`React.lazy` 返回的是对象而不是函数，早期 `Slot` 用 `typeof component === "function"` 判断，导致所有懒加载插槽都被当成“没有贡献”，页面全空。现在用 `$$typeof` 识别 lazy/memo/forwardRef。

### 5.6 停用时的优雅降级

停用插件后：工具不注册、待办不返回、API 404、前端业务插槽不渲染；历史数据、历史提案、旧 artifact 仍可读。

> **坑**：随访插件停用后，患者页仍无条件请求 `/api/patients/:id/followups`，接口 404 让整个患者页打不开。现在固定区先看 `available`/`active`，可选接口失败只隐藏对应区域；历史 artifact 走 fallback。

### 5.7 可选接口失败不能拖垮页面

固定区调用插件接口时必须捕获错误，区分“插件停用/未连接”和“真实失败”。

> **坑**：`/api/extensions/prefs` 返回 500 时，前端把异常静默吞掉，设置页看起来正常但偏好永远不生效；T10 修成显式错误提示 + 可重试。插件接口同理：不要 `catch {}` 后假装成功。

### 5.8 只追加提交

不要 rebase / amend / reset 已推送或已验收的提交；返工用新提交。

> **坑**：重构期间验收者按 commit 逐个对照；改写历史会让验收基线失效。T11c 同样只追加。

### 5.9 不改内核、不改界面

`server/core/**` 不动；除任务明确允许，现有界面的外观、文字、交互不变。

> **坑**：插件化最容易顺手“优化”固定区布局；截图基线会立刻发现。T11c 不改变任何运行时行为和界面。

### 5.10 迁移只增不改

已应用的迁移不能修改；新表必须带前缀；旧表不改名，用 `legacyTables` 声明。

> **坑**：直接改 `001_init.sql` 在开发机看不出问题，已有数据库不会重跑，升级后缺列。升级兼容测试会对比旧库启动后的表结构。

### 5.11 打包必须包含插件目录

插件目录必须包含在所有运行时组装脚本中；新增顶层运行时目录时同步更新打包白名单，并由 `tests/packaging` 守护。

> **坑**：`package-desktop.mjs` 曾用显式白名单逐项复制运行时（dist、desktop、server 等）却漏了 `plugins/`。从源码跑 `npm test` 和 E2E 一切正常，但安装包里所有领域插件都会消失。现在打包与增量更新共用 `scripts/runtime-stage.mjs`，stage 测试会在临时目录组装并启动打包后的 `server/agent.mjs` 验证插件列表。

---

## 6. 测试要求

### 6.1 插件自己的 `test/`

每个插件至少覆盖：

- 正常路径：service/API/工具注册。
- 停用行为：工具消失、API 404、待办不出现、数据仍在。
- 迁移：表存在、重复启动不重复执行。
- 提案：validate 拒绝非法输入；apply 抛错时回滚。

```js
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createScriptedProvider } from "../../../tests/helpers/scripted-provider.mjs";
import { startTestServer } from "../../../tests/helpers/server.mjs";

const PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url));

test("pain-score：加载、迁移、停用", async (t) => {
  const app = await startTestServer({
    provider: createScriptedProvider([]),
    seedDemoPack: false,
    serverOptions: { pluginDirs: [PLUGIN_DIR] },
  });
  t.after(() => app.close());
  const list = await app.request("/api/plugins");
  assert.equal(list.body.plugins.find((p) => p.id === "pain-score").status, "ready");
});
```

### 6.2 停用行为

必须断言“停用后能力消失、数据还在、固定区不崩”。不要只断言 `enabled: false`。

### 6.3 接口快照

接管旧路由的插件（`legacyApiPaths`）要保存响应快照，例如 `test/fixtures/routes.snapshot.json`，逐路径比对 `status` 和 `body`。重构时这是“URL 和响应不变”的证据。

### 6.4 截图基线（严格模式）

涉及界面的插件必须跑 `npm run test:e2e`。用例用断言检查页面关键内容；截图只保存到 `test-results/e2e-screens/` 供人工查看，不做像素对比。新增页面要加对应用例，停用/隐藏状态也要覆盖。

> 本机没有浏览器时不要伪造截图；在报告里如实说明未运行 E2E。

### 6.5 升级兼容测试

`tests/plugin-host/` 中的升级兼容测试会用旧版本数据库启动新代码，断言：

- 旧表/旧数据仍可读；
- 新迁移只补缺失结构；
- 历史提案/旧 artifact 不因插件停用而丢失；
- `/api/bootstrap` 与 `/api/plugins` 的既有字段不变。

### 6.6 全量检查

每个任务结束必须：

```bash
npm run lint
npm run build
npm test
```

有界面变化时再加 `npm run test:e2e`。

---

## 7. 从零开始：虚构的“疼痛评分”插件

目标：患者页新增“疼痛评分”tab；医生可以查看评分；新增评分走提案；今日待办在超过 3 天未复评时提醒；对话里展示评分结果卡片。

目录：

```
plugins/pain-score/
  plugin.mjs
  migrations/001_init.sql
  prompt.md
  ui/index.jsx
  ui/PainScoreTab.jsx
  ui/PainScoreCard.jsx
  test/plugin.test.mjs
```

### 7.1 迁移

```sql
-- plugins/pain-score/migrations/001_init.sql
CREATE TABLE IF NOT EXISTS pain_score_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pain_score_records_patient
  ON pain_score_records(patient_id, created_at);
```

### 7.2 `plugin.mjs`

```js
import { definePlugin } from "../../server/plugin-host/define.mjs";
import { check } from "../../server/errors.mjs";

const TABLE = "pain_score_records";
const DAY = 86400000;

export default definePlugin({
  id: "pain-score",
  version: "1.0.0",
  title: "疼痛评分",
  enabledByDefault: true,
  migrations: "./migrations",
  tablePrefix: "pain_score_",
  prompt: "./prompt.md",
  provides: { service: "pain-score", apiVersion: 1 },

  setup(ctx) {
    return {
      list(patientId) {
        return ctx.db.prepare(
          `SELECT id,patient_id,score,note,created_at FROM ${TABLE}
           WHERE patient_id=? ORDER BY created_at DESC,id DESC`,
        ).all(patientId);
      },
      last(patientId) {
        return ctx.db.prepare(
          `SELECT id,patient_id,score,note,created_at FROM ${TABLE}
           WHERE patient_id=? ORDER BY created_at DESC,id DESC LIMIT 1`,
        ).get(patientId);
      },
      due(now = Date.now()) {
        const cutoff = new Date(now - 3 * DAY).toISOString();
        return ctx.db.prepare(
          `SELECT patient_id,MAX(created_at) AS created_at FROM ${TABLE}
           GROUP BY patient_id HAVING MAX(created_at)<=?`,
        ).all(cutoff);
      },
    };
  },

  tools(ctx, { registry }) {
    registry.register({
      permission: "tools.execute",
      capability: { backend: "local" },
      definition: {
        type: "function",
        function: {
          name: "pain_score_list",
          description: "读取某位患者的疼痛评分记录；只读。",
          parameters: {
            type: "object",
            properties: { patientId: { type: "string" } },
            required: ["patientId"],
            additionalProperties: false,
          },
        },
      },
      execute: ({ patientId }) => ({
        records: ctx.plugins["pain-score"].service.list(patientId),
      }),
    });
    registry.register({
      permission: "tools.execute",
      capability: { backend: "local" },
      definition: {
        type: "function",
        function: {
          name: "pain_score_report",
          description: "生成某位患者的疼痛评分结果卡片；供医生核对。",
          parameters: {
            type: "object",
            properties: { patientId: { type: "string" } },
            required: ["patientId"],
            additionalProperties: false,
          },
        },
      },
      execute: ({ patientId }) => {
        const records = ctx.plugins["pain-score"].service.list(patientId);
        return {
          id: `pain-scores:${patientId}`,
          type: "pain_scores",
          status: "draft",
          readOnly: false,
          patientId,
          records,
          summary: records.length
            ? `最近一次评分 ${records[0].score} / 10`
            : "尚无疼痛评分记录",
        };
      },
    });
  },

  proposals: {
    "pain-score.record.create": {
      revisionScoped: true,
      validate(input) {
        check(input?.patientId, "INVALID_INPUT", "缺少患者");
        check(Number.isInteger(input.score) && input.score >= 0 && input.score <= 10,
          "INVALID_INPUT", "评分必须是 0–10 的整数");
        return {
          patientId: input.patientId,
          score: input.score,
          note: input.note ? String(input.note).slice(0, 500) : null,
        };
      },
      apply(input, ctx, tx) {
        tx.prepare(
          `INSERT INTO ${TABLE}(patient_id,score,note,created_at) VALUES (?,?,?,?)`,
        ).run(input.patientId, input.score, input.note, ctx.now());
        return { patientId: input.patientId, score: input.score };
      },
    },
  },

  agendaSources: [{
    kind: "pain-score",
    label: "疼痛评分",
    order: 60,
    read(ctx, { now }) {
      const current = typeof now === "number" ? now : Date.parse(now) || Date.now();
      return ctx.plugins["pain-score"].service.due(current).map((row) => ({
        id: `pain-score:${row.patient_id}`,
        kind: "pain-score",
        patientId: row.patient_id,
        title: "疼痛评分超过 3 天未复评",
        detail: `上次评分时间 ${row.created_at}`,
        at: row.created_at,
        weight: 4,
        action: { type: "patient", tab: "p:pain-score:records", label: "去复评" },
      }));
    },
  }],

  async api(ctx, req, url, io) {
    if (url.pathname === "/api/p/pain-score/records" && req.method === "GET") {
      io.send(200, {
        records: ctx.plugins["pain-score"].service.list(
          url.searchParams.get("patientId") || "",
        ),
      });
      return true;
    }
    if (url.pathname === "/api/p/pain-score/records" && req.method === "POST") {
      const input = await io.body();
      io.send(201, {
        proposal: ctx.proposals.create({
          kind: "pain-score.record.create",
          patientId: input.patientId,
          input,
          summary: `记录疼痛评分 ${input.score} / 10`,
        }),
      });
      return true;
    }
    return false;
  },

  hooks: {
    "patient.deleted": ({ patientId }, ctx) => {
      ctx.db.prepare(`DELETE FROM ${TABLE} WHERE patient_id=?`).run(patientId);
    },
  },
});
```

`pain_score_report` 返回带 `id`、`type`、`status: "draft"` 的对象，工作区会把它收集为 artifact；`chat.resultCards` 用 `artifact.type` 找到卡片。

### 7.3 `prompt.md`

```md
- 疼痛评分：读取已有评分用 pain_score_list；生成结果卡片用 pain_score_report。新增评分必须用 pain-score.record.create 提案（0–10 整数），由医生在待确认面板核对，不要直接写库，也不要声称已保存。评分只是患者自述，不替代病因判断。
```

### 7.4 前端入口

```jsx
// plugins/pain-score/ui/index.jsx
import { defineUiPlugin } from "../../../src/plugin-slots.jsx";

export default defineUiPlugin({
  id: "pain-score",
  slots: {
    "patient.tabs": [{
      id: "records",
      label: "疼痛评分",
      order: 60,
      area: "record",
      component: () => import("./PainScoreTab.jsx"),
    }],
    "chat.resultCards": {
      pain_scores: {
        label: "查看疼痛评分",
        component: () => import("./PainScoreCard.jsx"),
      },
    },
  },
});
```

### 7.5 患者页 tab

```jsx
// plugins/pain-score/ui/PainScoreTab.jsx
import { useEffect, useState } from "react";
import { api } from "../../../src/agent-runtime";
import { Badge } from "../../../src/plugin-kit/index.js";

export default function PainScoreTab({ patient }) {
  const [records, setRecords] = useState(null);
  const [score, setScore] = useState(0);
  const [note, setNote] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    api(`/api/p/pain-score/records?patientId=${encodeURIComponent(patient.id)}`)
      .then((result) => { if (active) setRecords(result.records); })
      .catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [patient.id]);

  async function submit(event) {
    event.preventDefault();
    setError("");
    try {
      await api("/api/p/pain-score/records", "POST", {
        patientId: patient.id,
        score: Number(score),
        note,
      });
      setNotice("已生成待确认提案，请在「待确认」面板核对后保存。");
      setNote("");
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="detail-panel" aria-label="疼痛评分">
      <h3>疼痛评分</h3>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {notice ? <p className="notice" role="status">{notice}</p> : null}
      {records === null ? <p className="muted">正在读取…</p> : records.length ? (
        <ul>{records.map((row) => (
          <li key={row.id}><Badge status="completed" /> {row.score} / 10
            <small className="muted"> {row.created_at}{row.note ? ` · ${row.note}` : ""}</small>
          </li>
        ))}</ul>
      ) : <p className="muted">还没有评分记录。</p>}
      <form onSubmit={submit}>
        <label>本次评分（0–10）
          <input type="number" min="0" max="10" value={score}
            onChange={(event) => setScore(event.target.value)} />
        </label>
        <label>备注（可选）
          <textarea value={note} maxLength={500}
            onChange={(event) => setNote(event.target.value)} />
        </label>
        <button className="primary" type="submit">生成待确认提案</button>
      </form>
    </section>
  );
}
```

### 7.6 结果卡片

```jsx
// plugins/pain-score/ui/PainScoreCard.jsx
export default function PainScoreCard({ artifact }) {
  return (
    <section className="detail-panel" aria-label="疼痛评分结果">
      <h3>疼痛评分</h3>
      <p>{artifact.summary}</p>
      <ul>
        {(artifact.records || []).map((row) => (
          <li key={row.id}>{row.score} / 10 · {row.created_at}
            {row.note ? ` · ${row.note}` : ""}</li>
        ))}
      </ul>
      <p className="muted">患者自述评分，仅供医生参考。</p>
    </section>
  );
}
```

### 7.7 测试

```js
// plugins/pain-score/test/plugin.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createScriptedProvider } from "../../../tests/helpers/scripted-provider.mjs";
import { startTestServer } from "../../../tests/helpers/server.mjs";

const PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url));

test("pain-score：加载、迁移、注册工具、停用后 404", async (t) => {
  const app = await startTestServer({
    provider: createScriptedProvider([]),
    seedDemoPack: true,
    serverOptions: { pluginDirs: [PLUGIN_DIR] },
  });
  t.after(() => app.close());

  assert.equal(
    app.server.store.db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='pain_score_records'",
    ).get().n,
    1,
  );
  assert.ok(app.server.sessionBridge.toolNames().includes("pain_score_list"));

  const disabled = await app.request("/api/plugins/pain-score", {
    method: "PUT", body: { enabled: false },
  });
  assert.equal(disabled.status, 200);
  assert.equal((await app.request("/api/p/pain-score/records")).status, 404);
  assert.ok(!app.server.sessionBridge.toolNames().includes("pain_score_list"));
});
```

脚手架生成的默认模板已经包含同类的加载/迁移/工具测试；把上面的示例当作扩展模板。
