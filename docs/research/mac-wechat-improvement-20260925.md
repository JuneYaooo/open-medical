# Mac 微信读取改进

调研日期：2026-09-25。

参考项目与取舍：

- [WeChatBridge](https://github.com/freestylefly/WeChatBridge)：参考微信原生导出文件进入本地工作流的设计，以及 `Sources/WeChatBridgeCore/WeChatNativeArchive.swift` 的内存解压边界。工作台实现独立的 ZIP/TXT 预览和确认导入，不复制该项目源码；当前没有安装 Share Extension。
- [wechat-mac-rpa](https://github.com/wq19901103wq/wechat-mac-rpa)：参考视觉观察与状态核验。工作台继续使用本地 Apple Vision，不接入该项目的自动重连、可选数据库读取或截图上传模型流程。
- [Wirkflow/wechat-desktop-mcp](https://github.com/Wirkflow/wechat-desktop-mcp)：参考独占操作与身份不明即停止的原则。[真实兼容问题 #2](https://github.com/Wirkflow/wechat-desktop-mcp/issues/2)说明单元测试通过和权限可用不足以证明可读取微信聊天控件，因此不以 AX 树完整为前提。

实现：当前会话精确标题核验、双帧文字复核、登录/安全验证拦截、读取互斥与取消、单会话定时读取、原生导出 ZIP/TXT 的本机预览和确认导入。旧 AppleScript 整窗归档与盲发实现已移除。

可见窗口读取仍无法证明账号身份、同名联系人的唯一身份或消息完整性。重复短消息、导出批次部分重叠、未加载历史与媒体内容需要人工核验。导入时保留原文而不猜测消息时间或发送人。任何界面自动化变化都不构成不会被微信限制的保证。

验证记录：见 `output/wechat-improvement-tests.log`（后端行为、真实浏览器合成流程、本地 Apple Vision）与 `output/wechat-improvement-build.log`。真实账号自动收发未通过验收，不作为本次交付能力。
