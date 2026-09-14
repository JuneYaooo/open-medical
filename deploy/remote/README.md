# 私有远程队列与 Worker

这个部署使用独立的队列进程和 Worker。协调器只保留任务/租约/结果；模型密钥放在 Worker 主机。默认监听回环地址，公网入口必须由 HTTPS 反向代理提供，不得把本地工作台的 bootstrap API 暴露到公网。

## 启动

需要 Node.js 22.13+、本项目依赖。Worker 还需要 Docker 和 `npm run build:runtime` 生成的 `open-medical-runtime:0.8-full` 镜像。先在受信任的服务器上保存项目并运行 `npm ci`。

生成两个不同的随机令牌，分别配置在进程管理器的私有环境文件中，不要提交到仓库：

```sh
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

协调器环境：`REMOTE_CLIENT_TOKEN`、`REMOTE_WORKER_TOKEN`、`REMOTE_DATABASE`（绝对 SQLite 路径）、`PORT=8795`。运行 `npm run remote:coordinator`。

Worker 环境：`REMOTE_URL=https://你的私有队列域名/`、`REMOTE_WORKER_TOKEN`、`REMOTE_WORK_DIR`（绝对工作目录）。用已有模型环境变量配置 provider，或令 `REMOTE_MODEL_CONFIG` 指向权限为 0600 的 JSON 文件：`{"provider":"openai","baseUrl":"https://api.openai.com/v1","model":"你的模型","apiKey":"你的密钥"}`。运行 `npm run remote:worker`。

仅需文件读写、无需运行终端的 Worker 可明确设置 `REMOTE_TERMINAL=0`；此模式不要求 Docker 镜像，也不会注册可用的终端权限。默认仍启用隔离终端，必须先构建镜像。普通集成测试使用文件模式；设置 `TEST_REMOTE_DOCKER=1` 可验证默认终端模式。

默认软件源网络较慢时，构建支持 `AGENT_DEBIAN_MIRROR`（仅 HTTPS origin）与 `AGENT_PYPI_INDEX_URL`（无凭据的 HTTPS 索引 URL）。设置后运行 `npm run build:runtime`，未设置时继续使用 Debian 与 PyPI 默认地址。镜像源覆盖不会禁用 TLS 或 apt 签名校验。

可启动多个 Worker 进程，使用不同工作目录。队列以事务发放租约，每 15 秒续约，90 秒失联后标为 interrupted。中断任务不会自动重新执行；在工作台明确点击重新执行后才排队。

## 接入本地工作台

工作区设置 → 远程执行与云端 Worker，保存队列 HTTPS URL 与客户端令牌。填写任务说明和逐行列出的文件路径，再授权上传。模型在远端执行，文件快照不包含本地密钥和 Git 历史。

查询完成后点击导入结果：远程修改生成本地待审批提案，先核对原始文件哈希；冲突时拒绝覆盖。任务结果 JSON 保留消息和成果内容。远程任务不直接推送仓库。

## 运维边界

单租户部署；客户端令牌持有者可查看该协调器所有任务，因此不同用户/组织必须使用独立队列数据库与令牌。队列最多 1000 项，文件快照最多 500 文件/10MB，结果最多 12MB；Worker 项目保留七天。需要磁盘监控及备份。SQLite 数据库只允许一个协调器进程持有，可部署多个 Worker。

HTTP 协议测试与本机 Worker 闭环在 `tests/remaining-platform.test.mjs` 中，使用测试模型响应；不代表真实云部署或模型验收已通过。

## systemd 示例

复制 `coordinator.service`、`worker.service`，按实际安装路径和服务用户修改。环境文件须由管理员创建，权限 0600；Worker 服务用户需要 Docker 权限。用 Caddy/Nginx 为回环端口配置 TLS，客户端和 Worker 都使用 HTTPS 地址。
