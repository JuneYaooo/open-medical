# 最新代码及安装包收尾验收 · 2026-09-24

本轮接续真实样本Excel修复，完成新源码回归、独立桌面包和安装后真实资料验证。历史报告中的候选包不包含Excel修复，应以本轮新包为准。

## 已完成

- 最新全量 `npm run check`：864项，835通过、29条件跳过、0失败，lint与生产构建通过（`check.log`，约309秒）。跳过的真实模型、Docker、资料专项证据见此前两轮报告，不能把跳过本身算作通过。
- 全量构建后再校验本轮候选包仍与当前源码一致（`final-integrity.json`）。

- 新打包目录：`output/playwright/final-acceptance-20260924/candidate/Open Medical-darwin-arm64`。
- 候选包源码一致性、完整性及隔离用户目录下Electron启动冒烟通过：`candidate-verification.json`。
- 发现并修复安装包缺少服务端Office依赖的问题：`scripts/runtime-dependencies.mjs` 增加ExcelJS、Mammoth和JSZip。原开发环境可正常解析，旧包中这三项均不存在。
- 使用实际安装脚本，将新包安装到项目目录之外的临时Applications。使用安装包自带Electron/Node和包内依赖，成功解析16份非空真实Office文件，未借用开发目录模块。
- 通过安装后的桌面UI上传存在特殊批注路径的真实Excel，材料保存与页面刷新后内容保留通过。日志 `installed-office.log` 只记录状态及文本长度，未输出真实病历正文。
- 1,000名合成患者、文件型SQLite的单次本机容量验证通过：列表24条分页、下一页、唯一编号搜索、打开正确档案、数据库完整性均正常。首屏约201ms、搜索约30ms、生成数据约41.4秒。这是本次环境基线，不是并发性能承诺（`capacity.log`）。
- 打包资源排查通过（`package-resources.json`）；修改后独立lint通过（`lint-final.log`）。

全部证据位于 `output/playwright/final-acceptance-20260924/`。本轮未对用户已安装应用执行覆盖更新，测试安装及测试用户数据已清理，候选包保留供复验。

## 稳定性测试后续更新

旧版本稳定性测试因2026-09-25长输入修复在约2.85小时后正常停止，684轮、34次重启，无错误，但未达到5小时目标。修复版已重新启动独立5小时测试，进度见 `output/playwright/long-input-20260925/frozen-soak/report.json`。详见[长输入修复报告](LONG_INPUT_FIX_20260925.md)。

## 仍需资源或授权

- Windows连接方式、另一台干净Mac；不能用当前Mac模拟代替实机验收。
- 微信/企业微信测试账号及指定联系人、OAuth/媒体服务、GitHub测试仓库。
- 真实病历向当前外部模型发送的明确授权，或先脱敏并由用户确认。此前真实资料只做本地解析、OCR和受控模型协议验证。
- 外层断网沙箱与Chromium冲突仍存在，前轮断网安装失败未转为通过。
- 睡眠唤醒、跨日真实时钟和多设备并发，不包含在本轮短时容量测试中。

已通过异步问题集中请求上述资源，尚无回复。不能把未取得资源、仍在运行或受阻项目标记为完成。
