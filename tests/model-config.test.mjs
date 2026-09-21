// N5 统一模型配置发现(任务书 8.3):
// 全部用临时目录与合成键值,禁止读取测试机真实秘密。
// 覆盖:仅桌面配置 / 仅 .env / 完整环境覆盖 / 仅provider环境+保存配置 /
// 冲突提供方 / 损坏配置 / 无配置 / 本地无密钥模型 / 脱敏。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverModelConfig,
  parseEnvFile,
  describeModelConfig,
} from "../server/core/model-config.mjs";

function sandbox(t) {
  const home = mkdtempSync(join(tmpdir(), "omw-n5-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "omw-n5-cwd-"));
  const appdata = process.platform === "darwin" ? join(home, "Library", "Application Support")
    : process.platform === "win32" ? join(home, "AppData", "Roaming") : join(home, ".config");
  mkdirSync(appdata, { recursive: true });
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
  const saveDesktop = (dirName, content) => {
    const dir = join(appdata, dirName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "model.env"), content);
  };
  const saveRepo = (content) => writeFileSync(join(cwd, ".env"), content);
  return {
    home,
    cwd,
    appdata,
    saveDesktop,
    saveRepo,
    discover: (env = {}) =>
      discoverModelConfig({
        env,
        cwd,
        platform: process.platform,
        home,
      }),
  };
}

test("仅临时桌面配置:发现并判定 configured,来源为 desktop", (t) => {
  const s = sandbox(t);
  s.saveDesktop("Open Medical Workbench", "DEEPSEEK_API_KEY=sk-test-desktop-1\n");
  const cfg = s.discover();
  assert.equal(cfg.ok, true);
  assert.equal(cfg.provider, "deepseek");
  assert.equal(cfg.apiKey, "sk-test-desktop-1");
  assert.equal(cfg.sourceCategory, "desktop");
});

test("仅仓库 .env:来源为 repo", (t) => {
  const s = sandbox(t);
  s.saveRepo("OPENAI_API_KEY=sk-repo-1\nOPENAI_BASE_URL=http://127.0.0.1:9/v1\n");
  const cfg = s.discover();
  assert.equal(cfg.ok, true);
  assert.equal(cfg.provider, "openai");
  assert.equal(cfg.apiKey, "sk-repo-1");
  assert.equal(cfg.baseUrl, "http://127.0.0.1:9/v1");
  assert.equal(cfg.sourceCategory, "repo");
});

test("完整环境覆盖:环境优先于保存配置", (t) => {
  const s = sandbox(t);
  s.saveDesktop("Open Medical Workbench", "DEEPSEEK_API_KEY=sk-desktop-older\n");
  const cfg = s.discover({ DEEPSEEK_API_KEY: "sk-env-newer", AI_PROVIDER: "deepseek" });
  assert.equal(cfg.ok, true);
  assert.equal(cfg.sourceCategory, "environment");
  assert.equal(cfg.apiKey, "sk-env-newer");
});

test("仅 provider 环境 + 保存配置:不因只有 AI_PROVIDER 而忽略保存配置", (t) => {
  const s = sandbox(t);
  s.saveDesktop("Open Medical Workbench", "DEEPSEEK_API_KEY=sk-saved-1\n");
  const cfg = s.discover({ AI_PROVIDER: "openai" });
  assert.equal(cfg.ok, true);
  assert.equal(cfg.provider, "deepseek", "回退到保存的完整配置");
  assert.equal(cfg.apiKey, "sk-saved-1");
  assert.ok(cfg.notes.some((n) => /AI_PROVIDER=openai/.test(n)));
});

test("冲突提供方:绝不把不同提供方的 key/baseURL/model 拼在一起", (t) => {
  const s = sandbox(t);
  s.saveDesktop(
    "Open Medical Workbench",
    "DEEPSEEK_API_KEY=sk-deepseek-1\nDEEPSEEK_BASE_URL=https://api.deepseek.example/v1\n",
  );
  const cfg = s.discover({
    AI_PROVIDER: "openai",
    OPENAI_API_KEY: "sk-openai-1",
  });
  assert.equal(cfg.ok, true);
  assert.equal(cfg.provider, "openai");
  assert.equal(cfg.apiKey, "sk-openai-1");
  assert.equal(cfg.baseUrl, undefined, "openai 环境凭据不得带上 deepseek 的 baseUrl");
  // 环境只有 provider 名而无凭据时,反向也不拼接:
  const cfg2 = s.discover({ AI_PROVIDER: "openai", OPENAI_BASE_URL: "https://openai.example/v1" });
  assert.equal(cfg2.ok, true);
  assert.equal(cfg2.provider, "deepseek");
  assert.equal(cfg2.baseUrl, "https://api.deepseek.example/v1", "使用保存的 deepseek 完整配置");
  assert.equal(cfg2.apiKey, "sk-deepseek-1");
});

test("损坏配置:报告错误,不静默切换到其他来源", (t) => {
  const s = sandbox(t);
  s.saveDesktop("Open Medical Workbench", "this line is broken\n");
  s.saveRepo("OPENAI_API_KEY=sk-repo-2\n");
  const cfg = s.discover();
  assert.equal(cfg.ok, false);
  assert.match(cfg.error, /损坏|格式无效/);
});

test("无配置:ok=false 且列出全部搜索位置", (t) => {
  const s = sandbox(t);
  const cfg = s.discover();
  assert.equal(cfg.ok, false);
  assert.ok(cfg.searched.length >= 4);
  assert.match(cfg.error, /未找到模型凭据配置/);
});

test("本地无密钥模型:合法 configured", (t) => {
  const s = sandbox(t);
  const cfg = s.discover({
    AI_PROVIDER: "local",
    LOCAL_MODEL_BASE_URL: "http://127.0.0.1:11434/v1",
    LOCAL_MODEL_NAME: "qwen-local",
  });
  assert.equal(cfg.ok, true);
  assert.equal(cfg.provider, "local");
  assert.equal(cfg.model, "qwen-local");
});

test("脱敏摘要:只有 provider/model/来源与 origin,绝无密钥", (t) => {
  const s = sandbox(t);
  s.saveDesktop(
    "Open Medical Workbench",
    "DEEPSEEK_API_KEY=sk-secret-value\nDEEPSEEK_BASE_URL=https://user:pass@api.deepseek.example/v1\n",
  );
  const summary = describeModelConfig(s.discover());
  assert.equal(summary.configured, true);
  assert.equal(summary.provider, "deepseek");
  assert.equal(summary.baseUrlHost, "https://api.deepseek.example", "URL 内凭据必须剥离");
  assert.equal(JSON.stringify(summary).includes("sk-secret-value"), false);
  assert.equal(JSON.stringify(summary).includes("user:pass"), false);
});

test("parseEnvFile:注释/引号/export 前缀/坏行", () => {
  const good = parseEnvFile(
    "# comment\nexport A=1\nB=\"quoted value\"\nC='single'\n\nD=with spaces\n",
  );
  assert.equal(good.ok, true);
  assert.deepEqual(good.values, {
    A: "1",
    B: "quoted value",
    C: "single",
    D: "with spaces",
  });
  const bad = parseEnvFile("A=1\nNOT_A_PAIR\n");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /第 2 行/);
});
