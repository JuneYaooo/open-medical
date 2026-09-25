# 企业微信会话存档采集器

面向 Open Medical 的独立只读服务。通过官方 Finance C SDK 拉取并解密会话，向工作台提供带鉴权的协议。工作台不接收存档 Secret 或 RSA 私钥。

实现参考了 [WeWorkFinanceSDK](https://github.com/NICEXAI/WeWorkFinanceSDK) 的接口边界和 [WeworkMsg](https://github.com/Hanson/WeworkMsg) 的独立服务形态；这里使用 Python 标准库 `ctypes` 调用官方 SDK，不依赖 Go 运行时。未包含第三方 SDK 二进制。

## 运行条件

- 开通企业微信会话存档，具备对应成员及客户的读取权限。
- Linux 或 Windows 上与系统架构匹配的官方 C SDK 及其运行依赖。SDK 来源见[官方获取会话内容文档](https://developer.work.weixin.qq.com/document/path/91774)。macOS 工作台通过网络连接此服务。
- Python 3.10+、OpenSSL 命令行可用。
- RSA 私钥按公钥版本分别保存，例如独立配置目录中的 `1.pem`、`2.pem`；Unix 权限设为 `0600`，不放进源码或安装包。

配置环境变量：

| 变量 | 用途 |
| --- | --- |
| `WECOM_CORP_ID` | 企业 ID，须与工作台设置一致 |
| `WECOM_ARCHIVE_SECRET` | 会话存档 Secret，不是客户联系 Secret |
| `WECOM_ARCHIVE_TOKEN` | 工作台连接凭据，至少 32 字符的随机值 |
| `WECOM_SDK_LIBRARY` | 官方 SDK 动态库绝对路径 |
| `WECOM_PRIVATE_KEYS` | 私钥目录绝对路径 |
| `WECOM_MEMBERS` | 获准员工 UserID，以逗号分隔 |
| `WECOM_ARCHIVE_PORT` | 回环监听端口，默认 8789 |

在已配置环境的进程中执行：

```sh
python3 integrations/wecom-archive/collector.py
```

服务只监听 `127.0.0.1`。远程使用时在独立服务器配置 HTTPS 反向代理，仅代理下列三个路径并保留 Authorization 请求头；不要暴露工作台的患者 API。限制访问来源、请求体及并发量。停止进程即可停止采集器。

## 工作台配置

在“设置 → 随访连接 → 企业微信存档”填写企业 ID、采集器地址和连接密钥，保存后测试连接。测试会调用一次存档读取验证实际权限，不会把消息写入患者记录。

在“随访 → 聊天随访”选择患者，读取可关联的企微会话，核对联系人与本人/家属关系。个人会话标识为 `private:` 加按字典序排列的两个参与者 ID，群聊为 `room:` 加群 ID。最近会话列表最多扫描 1000 条存档，可能不包含较早会话；可填写已核实的会话标识。

新增关联会重新扫描 SDK 当前可用存档，已保存消息按账号和来源 ID 去重。无法补齐服务端已过期、未授权或从未存档的历史。

## HTTP 协议 v1

每个请求必须含 `Authorization: Bearer <连接密钥>`。响应不包含配置密钥，所有成功响应都有 `version: 1` 和 `corpId`。

- `GET /v1/status`：验证 SDK 读取，返回 `ready` 与能力列表。
- `GET /v1/conversations`：返回近期会话标识与最近消息时间，不返回聊天正文；`partial` 表示扫描不完整。
- `POST /v1/messages`：请求含字符串 `cursor`、1–100 的 `limit`、非空 `conversations` 列表；只返回指定会话且涉及配置成员的消息。

消息字段：`id`、字符串 `seq`、`conversationId`、`senderId`、`direction`、`sentAt`、`type`、`text`、`action`、`revokedMessageId`。响应包括字符串 `nextCursor` 和 `hasMore`。游标表示完整 SDK 页的位置，包括被范围过滤的消息，工作台须在整页事务成功后推进。

当前正文解析仅支持文本。语音、图片及其他消息保留类型和来源信息，不自动转写或下载媒体，不会把未解析内容当作事实。撤回消息关联原始消息 ID，供工作台标记来源变化。

客户端遇到认证、SDK、解密、格式或大小错误应停止并重试该页，不得跳过错误消息后推进游标。日志不记录正文、请求头或密钥。

## 验证范围

本地验证覆盖鉴权、真实回环 HTTP、范围过滤、uint64 游标、消息归一化及错误处理。真实企业凭据、官方动态库的平台依赖和实际会话存档仍需在部署环境联调；合成 SDK 响应不等于真实企业接通。
