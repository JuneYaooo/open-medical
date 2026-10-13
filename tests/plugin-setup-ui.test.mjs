import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { fixture } from './helpers.mjs';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('plugin setup reports successful activation without a client error', { skip: !existsSync(chrome) }, async t => {
  const f = await fixture(t);
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const connection = { channel: 'wechat-exp', enabled: false, revision: 0, plugin: { name: '微信历史导入' } };
  let activation;
  await page.route('**/api/chat-followups/settings', route => route.fulfill({ json: { connections: [connection] } }));
  await page.route('**/api/wechat-exp/status', route => route.fulfill({ json: { toolReady: true, backupReady: true, account: 'panda-demo', bridgeRunning: true } }));
  await page.route('**/api/chat-followups/connections/wechat-exp/connect', async route => {
    activation = route.request().postDataJSON();
    await route.fulfill({ json: { ...connection, enabled: true, revision: 1 } });
  });
  await page.goto(f.origin + '/?view=settings');
  await page.getByRole('button', { name: '插件', exact: true }).click();
  await page.getByRole('button', { name: /③ 启用微信历史导入/ }).click();
  await page.getByRole('status').filter({ hasText: '微信历史导入已启用' }).waitFor();
  assert.equal(activation.enabled, true);
  assert.equal(activation.accountId, 'panda-demo');
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.deepEqual(errors, []);
});
