# macOS 签名与权限恢复

Mac 桌面读取需要系统辅助功能及录屏授权。权限检测使用真实组件结果；不能以系统设置中显示开启或微信进程存在作为读取成功的依据。

## 稳定更新身份

打包脚本和运行时更新脚本共享签名配置。显式的 `--sign-identity` 或 `MEDICAL_MAC_SIGN_IDENTITY` 优先，其次读取本机 `~/.open-medical-workbench/signing/local-codesign.json`，没有本机配置时寻找唯一的有效 `Developer ID Application` 身份。多个证书时应指定 `security find-identity -v -p codesigning` 返回的证书 SHA-1。签名身份需要证书及其私钥同时可用。不把私钥或证书密码写入仓库。

仅在本机使用的安装包可以沿用专用的自签名代码签名证书，无需 Apple Developer 会员。本机配置包含 `identity`（证书 SHA-1）、`keychain`（钥匙串路径）、`certificate`（DER 格式公钥证书路径）和 `scope: "local-only"`。构建会核对公钥证书指纹、有效期、代码签名用途和钥匙串身份，并在签名后验证代码完整性；证书丢失、过期或被替换时停止，不自动重建身份。固定的本机自签名证书无需加入系统受信任根证书，钥匙串私钥使用授权由用户完成。私钥保存在钥匙串，后续更新复用同一身份；本机信任不会传递到其他电脑，也不构成 Apple 官方签名或公证。参见 [Apple 创建自签名证书](https://support.apple.com/en-ie/guide/keychain-access/kyca8916/mac)。

缺少证书时构建会在复制或修改安装包之前停止。仅本地开发可以显式传入 `--allow-adhoc`；该选项不承诺保留更新前授权。未知证书即使传入临时签名选项也会报错，不静默降级。

应用保持 `local.openmedical.workbench` 标识，签名后执行严格完整性校验。跨版本校验使用 `codesign --verify -R =<原指定要求>`，其中 `=` 表示内联要求表达式；缺失此前缀会被误当成文件路径。运行时更新先在暂存副本中完成修改与签名，成功后替换原包，失败不提交半成品。签名不等于公证；对外分发仍需另行完成对应发布流程。

从临时签名迁移到证书签名时，已有权限可能需要重新授权。固定证书与应用标识能提供跨版本可识别的签名身份，但系统策略、证书变化等仍可能要求重新授权；不得承诺任何更新都永不弹窗。

参考：[Apple TN3127 — Requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)、[Apple TN2206 — Code Signing In Depth](https://developer.apple.com/library/archive/technotes/tn2206/)。临时签名默认使用代码哈希作为指定要求，不应以仅校验 bundle ID 的宽松要求替代可信签名身份。

## 应用内恢复

设置 → 随访连接 → 检查微信与权限。检测失败时提供辅助功能设置、录屏设置、在访达显示当前安装包和重新检测入口。旧条目已开启仍失败时，用户移除旧授权并添加当前安装包，按系统提示重启。

恢复入口只打开固定的系统页面并显示安装包，不修改 TCC 数据库、不重置其他应用权限、不自动开启授权。IPC 仅接受工作台主框架请求，拒绝外部页面及子框架。浏览器模式显示手动操作路径。
