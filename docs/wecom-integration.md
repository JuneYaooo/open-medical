# 企业微信患者联系接入（0.9.20）

当前入口：患者 → 沟通与随访 → 企业微信患者联系。未配置账号时展示接入状态，原有患者档案仍可使用。真实企业账号、公网回调和真实发送尚未联调；本次只使用合成数据、隔离 SQLite 与模拟企业微信响应。

## 开源选型

- 采用 [witjs/wecom](https://github.com/witjs/wecom)（MIT），精确锁定 npm `wecom@1.0.0-rc.2`。使用其 ExternalContact、Token 管理和原生 fetch 封装；通过适配层隔离候选版本的 API。仓库 README 已描述 rc.3，但本次 npm registry 实际可安装的是 rc.2；没有使用浮动 next 标签。稳定 0.8.3 仍依赖较旧 Axios，未引入。
- 回调加解密使用 [`@wecom/crypto@1.0.1`](https://www.npmjs.com/package/@wecom/crypto)（MIT），XML 使用 `fast-xml-parser@5.11.1`。应用额外校验签名、时间戳、CorpID、XML 类型和大小，拒绝 DTD/实体定义。
- 对比 [wechatpy](https://github.com/wechatpy/wechatpy)：适合 Python 后端，当前项目无需增加 Python 服务。
- 对比 [Wechaty](https://github.com/wechaty/wechaty)：机器人/Puppet 生态不等同于官方客户联系 API，当前未引入登录托管或个人微信自动化路径。
- Node 最低版本提升至 22.18，以满足 SDK 要求。桌面包包含上述运行时依赖与许可证。

## 已实现

1. 通过官方 `/externalcontact/batch/get_by_user` 按负责成员分页同步客户。分页失败保留原快照；同一成员不能并发同步；不按昵称匹配患者。
2. 客户按企业、成员、external_userid 区分。医生明确核实“本人/家属”后关联患者；支持同一家属关联不同患者，解除关系后旧草稿不能发送。
3. 随访草稿独立保存，二次核对收件人与正文后调用 `/externalcontact/add_msg_template`。只创建官方任务，等待成员在企业微信确认发送。
4. 查询 `/externalcontact/get_groupmsg_send_result`，区分待发送、已发送和发送失败。“已发送”不等同于已读。
5. 同一提交只调用一次；断网、超时、缺少任务编号、进程退出时保留“结果待核实”，禁止自动重发。明确 API 拒绝标记未接受，保留草稿正文。SDK 自动重试关闭；失效 Token 清除供下次显式请求更新。
6. 回调 URL 校验和加密事件验签。客户变更按事件内容持久化去重；删除联系关系使其失效。新增/修改通知需手动同步客户列表。回调不被当成患者聊天记录或临床事实。
7. 数据表使用现有 SQLite；删除患者级联删除关联与随访发送任务。客户缓存属于企业通讯录，独立保留。

## 配置

服务端 `.env` 或桌面应用配置目录的 `model.env` 中填写：

```dotenv
MEDICAL_WECOM_CORP_ID=
MEDICAL_WECOM_SECRET=
MEDICAL_WECOM_CALLBACK_TOKEN=
MEDICAL_WECOM_AES_KEY=
```

`SECRET` 应使用有客户联系权限并加入“可调用应用”的自建应用 Secret，配置可见范围、客户联系成员与可信 IP。Token/AESKey 用于客户联系回调；AESKey 为控制台生成的 43 位文本。密钥不返回浏览器、不写入业务数据库、不写入任务错误详情。桌面配置文件权限为 0600，重启后读取。macOS 当前应用配置目录由 Electron userData 决定，当前为 `~/Library/Application Support/Open Medical Workbench/model.env`；以实际安装版本路径为准。

当前配置按一个企业运行，企业切换后列表隔离；不要使用两个进程打开同一个 SQLite 数据库。没有企业账号时不需要填写占位密钥。

## 回调部署

客户端本地服务只监听回环地址。要接收企业微信事件，需要公网 HTTPS 反向代理到运行中的服务，**只开放精确路径 `/api/wecom/callback`**，不代理 bootstrap、患者档案或其他 API。例如服务器上的 nginx：

```nginx
location = /api/wecom/callback {
    client_max_body_size 64k;
    proxy_pass http://127.0.0.1:4318;
    proxy_set_header Host $host;
}
location / { return 404; }
```

端口替换为实际服务端口；TLS 证书与域名由部署环境提供。回调以企业微信签名及密文企业 ID 认证，其余 API 保留本地 Host、Origin 和会话 Token 验证。设置服务器时钟同步；签名时间戳容许 10 分钟偏差。企业微信事件重试使用相同事件键去重。

**当前没有部署全天在线云服务，也没有桌面/云端数据同步。** 桌面退出后回调停止接收。需要离线托管时，应另行部署常驻接入服务并实现独立事件队列和桌面拉取，不能把当前桌面所有 API 暴露到公网。常驻部署是后续真实账号联调时的独立事项。

## API

除回调外，以下接口需要工作台的 `x-medical-token`：

| 接口 | 用途 |
| --- | --- |
| GET `/api/wecom/status` | 无密钥的配置和能力状态 |
| GET `/api/wecom/contacts` | 当前企业客户缓存 |
| POST `/api/wecom/sync` | `{member}` 同步该成员客户 |
| GET `/api/wecom/bindings?patientId=...` | 当前患者关联 |
| POST `/api/wecom/bindings` | `{patientId,member,external,relationship,confirmed:true}` |
| DELETE `/api/wecom/bindings/:id` | 解除关联 |
| GET `/api/wecom/tasks?patientId=...` | 当前患者草稿和发送状态 |
| POST `/api/wecom/tasks` | `{requestId,patientId,bindingId,text}` 幂等保存草稿 |
| POST `/api/wecom/tasks/:id/submit` | `{confirmed:true}` 提交官方发送任务 |
| POST `/api/wecom/tasks/:id/refresh` | 查询官方发送结果 |
| GET/POST `/api/wecom/callback` | 官方 URL 校验/加密客户变更通知 |

## 验证与后续联调

本地验证命令：

```sh
npm run lint
npm run build
node --test tests/wecom.test.mjs
node --test tests/patients.test.mjs tests/patient-privacy.test.mjs tests/wechat-bridge.test.mjs tests/desktop-candidate.test.mjs tests/model-config.test.mjs
```

覆盖：未配置/未认证、分页同步与失败保留、本人/家属确认、草稿幂等、解除关系后阻止提交、取消外发、单次提交、显式拒绝、网络结果不明禁止重发、签名伪造与企业不匹配、回调去重/大小限制、删除患者级联清理、真实浏览器流程及刷新后读取持久化状态。

待有测试企业后验证：应用权限和可信 IP、测试成员真实客户同步、测试家属绑定、公网回调握手及增删事件、成员端确认发送、官方送达状态、频次限制与凭据轮换。先用测试客户，不直接对正式患者群发。

范围外：完整会话内容存档、自动接收患者聊天附件建档、微信客服会话、无人值守随访外发、群运营、自动日程触发发送。客户联系 API 本身不授予这些能力。

官方接口依据：[创建企业群发](https://developer.work.weixin.qq.com/document/path/92135)、[群发记录与成员执行结果](https://developer.work.weixin.qq.com/document/path/93338)、[会话内容存档](https://developer.work.weixin.qq.com/document/path/91360)。
