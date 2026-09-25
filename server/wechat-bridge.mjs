import { AppError } from './errors.mjs';

// Compatibility shell for old callers. The former whole-window collector and
// blind search/Return sender are deliberately absent, including direct calls.
export class WeChatMacBridge {
  status() {
    return {enabled:false,available:false,retired:true,reason:'旧微信桥接已停用，请使用聊天随访中的会话核验读取或导出文件导入'};
  }
  async readFrontChat() { throw new AppError('WECHAT_LEGACY_RETIRED','旧版整窗读取已停用，请在聊天随访中核验会话后读取',410); }
  async send() { throw new AppError('WECHAT_LEGACY_RETIRED','旧版盲发已停用，请在微信中核对并发送',410); }
}
