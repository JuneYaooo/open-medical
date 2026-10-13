import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { WechatExpService, wechatExpApi } from '../server/wechat-exp.mjs';
import { AppError } from '../server/errors.mjs';

const CONTACTS_CSV = [
  'wxid,display_name,remark,nick_name,alias,phone,sex,region,signature,description,msg_count,last_msg_time,is_group,labels',
  'filehelper,文件传输助手,,,,,,47,,,2,1791603194,N,',
  'wxid_zhang,张三,张三家属,,,,,, ,,,5,1791600000,N,',
].join('\n');
const CHAT_TXT = [
  '联系人: 文件传输助手',
  '微信号: filehelper',
  '导出时间: 2026-10-10 12:11:55',
  '消息数: 2',
  '======================================================================',
  '',
  '[2026-10-10 10:24:59] [链接/应用] 我: [链接] 群聊的聊天记录',
  '[2026-10-10 11:33:14] 我: https://github.com/sunhanaix/pc_wechat_exp',
].join('\n');

function makeService({ backupOutput = '备份完成' } = {}) {
  const service = new WechatExpService({
    dataDir: 'output/test-wechat-exp-data', log: () => {},
    spawnTool: async args => {
      const outputIndex = args.indexOf('-o');
      const o = outputIndex >= 0 ? args[outputIndex + 1] : null;
      if (o) {
        mkdirSync(o, { recursive: true });
        if (args.includes('contacts')) writeFileSync(join(o, 'contacts.csv'), CONTACTS_CSV);
        else writeFileSync(join(o, 'chat.txt'), CHAT_TXT);
      }
      return backupOutput;
    },
    fetchImpl: async () => { throw new Error('不应触发下载'); },
  });
  Object.defineProperty(service, 'toolReady', { get: () => true });
  return service;
}

test('backup captures the single account and multi-account ambiguity asks the user', async () => {
  const single = makeService({ backupOutput: '备份账号: wxid_one\n...\n备份完成' });
  const r1 = await single.backup({ days: 30 });
  assert.equal(r1.needAccount, false);
  assert.equal(r1.account, 'wxid_one');
  const multi = makeService({ backupOutput: '检测到 2 个微信账号，请用 --wxid 指定要备份的账号：\nwxid_a  6\nwxid_b  3' });
  const r2 = await multi.backup({ days: 30 });
  assert.equal(r2.needAccount, true);
  assert.deepEqual(r2.accounts, ['wxid_a', 'wxid_b']);
  rmSync('output/test-wechat-exp-data', { recursive: true, force: true });
});

test('embedded wx-cli bridge serves sessions and messages parsed from export text', async () => {
  const service = makeService({});
  service.account = 'wxid_me';
  service.contactsCache = { at: Date.now(), rows: [
    { wxid: 'filehelper', display_name: '文件传输助手', remark: '', nick_name: '' },
    { wxid: 'wxid_zhang', display_name: '张三', remark: '', nick_name: '' },
  ] };
  const sessions = await service.api('sessions', new URLSearchParams({ limit: '10', offset: '0' }));
  assert.equal(sessions.items.length, 2);
  assert.equal(sessions.items[0].username, 'filehelper');
  assert.equal(typeof sessions.paging.has_more, 'boolean');
  assert.equal(sessions.paging.limit, 10);
  assert.equal(sessions.paging.offset, 0);
  const messages = await service.api('messages', new URLSearchParams({ contact: 'filehelper', limit: '100', offset: '0', order: 'asc', since: '0', until: '2000000000' }));
  assert.equal(messages.items.length, 2);
  assert.equal(messages.items[0].sender, 'wxid_me'); // "我:" 重写为账号
  assert.equal(messages.items[1].content.Text, 'https://github.com/sunhanaix/pc_wechat_exp');
  assert.ok(messages.items.every(m => m.talker === 'filehelper' && Number.isInteger(m.create_time)));
  rmSync('output/test-wechat-exp-data', { recursive: true, force: true });
});

test('api endpoints reject unknown paths and unconfigured accounts', async () => {
  const service = makeService({});
  service.account = '';
  await assert.rejects(() => service.api('health', new URLSearchParams()), AppError);
  await assert.rejects(() => service.api('nope', new URLSearchParams()), AppError);
  rmSync('output/test-wechat-exp-data', { recursive: true, force: true });
});

test('wechat-exp api routes: status reflects tool and backup readiness', async () => {
  const service = makeService({});
  const sent = [];
  const ctx = { body: async () => ({}), send: (status, value) => { sent.push({ status, value }); return true; } };
  const url = path => new URL(`http://127.0.0.1/api/wechat-exp/${path}`);
  await wechatExpApi(service, { method: 'GET' }, url('status'), ctx);
  assert.equal(sent.at(-1).value.toolReady, true);
  assert.equal(sent.at(-1).value.job, null);
  rmSync('output/test-wechat-exp-data', { recursive: true, force: true });
});
