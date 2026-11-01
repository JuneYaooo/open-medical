import { defineConfig } from "@playwright/test";

const BASE_URL = "http://127.0.0.1:18787";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.mjs",
  outputDir: "test-results/e2e-output",
  globalSetup: "./tests/e2e/global-setup.mjs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    colorScheme: "light",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node tests/e2e/start-server.mjs",
    url: `${BASE_URL}/api/agent/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PORT: "18787",
      TZ: "Asia/Shanghai",
    },
  },
});
