import { check, string } from "../errors.mjs";
import { WxCliClient } from "./wx-cli.mjs";
import { WecomArchiveClient } from "./wecom-archive.mjs";

const ID = /^[a-z][a-z0-9-]{0,39}$/;
export class ChatConnectorRegistry {
  constructor({ wechat, archive, wxcli, plugins = [] } = {}) {
    this.entries = new Map();
    this.register({
      id: "wechat",
      name: "微信桌面",
      protocol: "desktop",
      builtin: true,
      client: wechat,
    });
    this.register({
      id: "wecom",
      name: "企业微信存档",
      protocol: "archive-v1",
      builtin: true,
      client: archive || new WecomArchiveClient(),
    });
    this.register({
      id: "wx-cli",
      name: "微信 · wx-cli",
      protocol: "wx-cli",
      builtin: true,
      client: wxcli || new WxCliClient(),
      defaultEndpoint: "http://127.0.0.1:9100",
    });
    for (const plugin of plugins) this.register(plugin);
  }
  register(entry) {
    check(
      typeof entry.id === "string" &&
        ID.test(entry.id) &&
        !this.entries.has(entry.id),
      "CHAT_PLUGIN",
      "插件 ID 无效或已存在",
    );
    check(
      entry.builtin ||
        (typeof entry.protocol === "string" && entry.protocol !== "desktop"),
      "CHAT_PLUGIN",
      "自定义插件需要服务协议",
    );
    check(
      entry.client &&
        (entry.builtin ||
          [
            "status",
            ...(entry.protocol === "desktop" ? [] : ["read", "conversations"]),
          ].every((key) => typeof entry.client[key] === "function")),
      "CHAT_PLUGIN",
      "插件缺少必要的连接接口",
    );
    this.entries.set(entry.id, {
      ...entry,
      name: string(entry.name, "插件名称", 80),
    });
  }
  manifest(input) {
    check(
      input &&
        input.manifestVersion === 1 &&
        typeof input.id === "string" &&
        ID.test(input.id) &&
        !["constructor", "prototype", "__proto__"].includes(input.id),
      "CHAT_PLUGIN",
      "连接插件需要 manifestVersion: 1 和有效 id",
    );
    check(
      Object.keys(input).every((k) =>
        ["manifestVersion", "id", "name", "protocol"].includes(k),
      ),
      "CHAT_PLUGIN",
      "连接清单只支持 manifestVersion、id、name、protocol",
    );
    check(
      ["wx-cli", "archive-v1"].includes(input.protocol),
      "CHAT_PLUGIN",
      "连接清单支持 wx-cli 或 archive-v1 协议",
    );
    return {
      manifestVersion: 1,
      id: input.id,
      name: string(input.name, "插件名称", 80),
      protocol: input.protocol,
    };
  }
  install(input) {
    const manifest = this.manifest(input);
    this.register({
      ...manifest,
      client:
        manifest.protocol === "wx-cli"
          ? new WxCliClient()
          : new WecomArchiveClient(),
    });
    return manifest;
  }
  get(id) {
    const entry = this.entries.get(id);
    check(entry, "CHAT_CHANNEL", "连接插件未安装", 404);
    return entry;
  }
  ids() {
    return [...this.entries.keys()];
  }
  describe(id) {
    const e = this.get(id);
    return {
      id: e.id,
      name: e.name,
      protocol: e.protocol,
      builtin: Boolean(e.builtin),
      defaultEndpoint: e.defaultEndpoint || "",
      capabilities: {
        conversations: e.protocol !== "desktop",
        history: e.protocol !== "desktop",
        send: e.protocol === "desktop",
      },
    };
  }
}
