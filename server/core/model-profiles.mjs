import { ModelSettings } from "./model-settings.mjs";
import { createProvider } from "./providers.mjs";
import { check } from "../errors.mjs";
import { hashText } from "./workspace-files.mjs";
const key = "platform:model-profiles:v1";
export class ModelProfiles {
  constructor(settings) {
    this.settings = settings;
  }
  all() {
    return this.settings.vault.get(key).profiles || {};
  }
  list() {
    return Object.entries(this.all()).map(([id, config]) => ({
      id,
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      hasKey: Boolean(config.apiKey),
      identity: hashText(JSON.stringify(config)),
    }));
  }
  resolve(id) {
    const config = this.all()[id];
    check(config, "MODEL_PROFILE", "团队模型配置不存在");
    return createProvider(config);
  }
  save(id, body) {
    check(
      /^[a-z0-9][a-z0-9_-]{0,39}$/.test(id),
      "MODEL_PROFILE",
      "配置 ID 需为小写字母、数字、下划线或连字符",
    );
    const profiles = this.all();
    check(
      Object.hasOwn(profiles, id) || Object.keys(profiles).length < 12,
      "MODEL_PROFILE",
      "最多保存 12 个团队模型",
    );
    const candidate = Object.create(ModelSettings.prototype);
    candidate.initial = this.settings.initial;
    candidate.saved = profiles[id] || {};
    profiles[id] = candidate.candidate(body);
    this.settings.vault.set(key, { profiles });
    return this.list();
  }
  remove(id) {
    const profiles = this.all();
    delete profiles[id];
    this.settings.vault.set(key, { profiles });
    return this.list();
  }
}
