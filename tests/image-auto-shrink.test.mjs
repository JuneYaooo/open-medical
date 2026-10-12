// 超限图片自动压缩：医生不再被"请压缩后导入"推回来手动干活。
// 客户端——建档/附件的单张大图走扫描页同一降档梯子重编码；
// 服务端——inspect_image 对目录大图用 nativeImage 就地缩图（桌面端），
// 纯 Node 没有 nativeImage 时如实降级。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { WorkspaceDatabase, WorkspaceService } from '../server/core/index.mjs';
import { hashText } from '../server/core/workspace-files.mjs';
import { shrinkImage } from '../server/core/image-shrink.mjs';
import { importMaterial, uploadProgressText } from '../src/import-material.js';

const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x84, 0x00, 0x43]);
// Windows 上 Defender 可能瞬时锁住刚写入的大文件，EPERM 时放弃清理
// （目录在 gitignored 的 output/ 下），不让环境抖动掩盖真实断言。
const cleanup = (t, dir) =>
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    } catch (error) {
      if (error.code !== 'EPERM') throw error;
    }
  });

test('shrinkImage 无 nativeImage（纯 Node）时降级返回 null', () => {
  assert.equal(shrinkImage(JPEG_HEAD, 1000), null);
});

test('shrinkImage 注入 resizer 后按宽度档位压到上限内，压不进返回 null', () => {
  const seen = [];
  const resizer = {
    decode: (data) => (data.length > 100 ? { getSize: () => ({ width: 8000 }) } : null),
    encode: (image, width) => {
      seen.push(width);
      return Buffer.alloc(width * 100);
    },
  };
  const jpeg = shrinkImage(Buffer.alloc(101), 4_000_000, resizer);
  assert.equal(seen[0], 5600, '第一档取原图宽度的 0.7');
  assert.ok(jpeg.length <= 4_000_000);
  // 最低档 1600px 仍超限时如实失败，而不是交出超限或不可读的结果。
  seen.length = 0;
  assert.equal(shrinkImage(Buffer.alloc(101), 100_000, resizer), null);
  assert.deepEqual(seen, [5600, 4000, 2800, 1600]);
  // 保底宽度：小图不再缩到 480px 以下。
  const widths = [];
  const small = {
    decode: () => ({ getSize: () => ({ width: 500 }) }),
    encode: (image, width) => {
      widths.push(width);
      return Buffer.alloc(10);
    },
  };
  shrinkImage(Buffer.alloc(101), 4_000_000, small);
  assert.deepEqual(widths, [480], '500px 小图取第一档 0.7 后触底 480px 保底');
});

test('inspect_image 对超过 4MB 的目录图片自动缩图后分析，原图哈希保留', async (t) => {
  const dir = mkdtempSync(join(process.cwd(), 'output/image-shrink-'));
  cleanup(t, dir);
  const root = join(dir, 'project');
  mkdirSync(root);
  const db = new WorkspaceDatabase(join(dir, 'workspace.sqlite'));
  t.after(() => db.close());
  const sent = [];
  const provider = {
    vision: true,
    complete: async (messages) => {
      const image = messages[1].content.find((part) => part.type === 'input_image');
      sent.push(image.image_url);
      return { message: { role: 'assistant', content: '已读取图片' }, usage: { total_tokens: 1 } };
    },
  };
  const shrunk = Buffer.concat([JPEG_HEAD, Buffer.alloc(64)]);
  const service = new WorkspaceService(db.db, provider, {
    imageShrink: (data, maxBytes) => (data.length > maxBytes ? shrunk : null),
  });
  const w = service.create({ root, directoryConsent: true });
  t.after(async () => service.extensions.close());
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71]), Buffer.alloc(5 * 1024 * 1024)]);
  writeFileSync(join(root, 'photo.png'), bytes);
  const originalHash = hashText(bytes);
  // 伪造已授权运行以满足 inspect_image 的同意门。
  service.active.set(w.id, { controller: new AbortController() });
  t.after(() => service.active.delete(w.id));
  const { PermissionEngine } = await import('../server/core/permissions.mjs');
  const output = await service
    .registry(w.id, 'test-run')
    .execute('inspect_image', { path: 'photo.png', question: '读取文字' }, {}, new PermissionEngine({ profile: 'standard', grants: {} }));
  assert.equal(output.analysis, '已读取图片');
  assert.equal(output.compressedFromBytes, 5 * 1024 * 1024 + 4, '结果标明原图字节数');
  assert.equal(output.hash, originalHash, 'hash 仍指向原图字节');
  const sentData = Buffer.from(sent[0].split(',')[1], 'base64');
  assert.ok(sentData.equals(shrunk), '视觉模型收到的是压缩后的 JPEG');
  assert.ok(sent[0].startsWith('data:image/jpeg;base64,'));
});

test('inspect_image 缩图失败时给出可行动的错误而不是笼统拒绝', async (t) => {
  const dir = mkdtempSync(join(process.cwd(), 'output/image-shrink-'));
  cleanup(t, dir);
  const root = join(dir, 'project');
  mkdirSync(root);
  const db = new WorkspaceDatabase(join(dir, 'workspace.sqlite'));
  t.after(() => db.close());
  const service = new WorkspaceService(db.db, { vision: true }, { imageShrink: () => null });
  const w = service.create({ root, directoryConsent: true });
  t.after(async () => service.extensions.close());
  writeFileSync(join(root, 'photo.tiff'), Buffer.alloc(5 * 1024 * 1024));
  service.active.set(w.id, { controller: new AbortController() });
  t.after(() => service.active.delete(w.id));
  const { PermissionEngine } = await import('../server/core/permissions.mjs');
  await assert.rejects(
    service.registry(w.id, 'test-run').execute(
      'inspect_image',
      { path: 'photo.tiff', question: '读取文字' },
      {},
      new PermissionEngine({ profile: 'standard', grants: {} }),
    ),
    (error) => error.code === 'IMAGE_LIMIT' && /自动压缩未能/.test(error.message) && /PNG 或 JPEG/.test(error.message),
  );
});

// 浏览器端 importMaterial 的画布逻辑在 Node 里以桩件驱动：toDataURL 按调用
// 次序返回递减的 base64 长度，模拟降档梯子。
function stubCanvas(dataUrlSizes) {
  let call = 0;
  const ops = [];
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: '',
        fillRect: (...args) => ops.push(['fill', ...args]),
        drawImage: (...args) => ops.push(['draw', ...args]),
      }),
      toDataURL: (type, quality) => {
        ops.push(['encode', quality]);
        const size = dataUrlSizes[Math.min(call++, dataUrlSizes.length - 1)];
        return 'data:image/jpeg;base64,' + 'A'.repeat(size);
      },
    }),
  };
  globalThis.createImageBitmap = async () => ({ width: 4000, height: 3000, close: () => ops.push(['close']) });
  return ops;
}

test('超限单图在导入时自动降档压缩并改名 .jpg，不再要求医生手动压缩', async (t) => {
  t.after(() => { delete globalThis.document; delete globalThis.createImageBitmap; });
  const ops = stubCanvas([6_000_000, 1_000_000]);
  const big = { name: 'photo.png', size: 6_000_000, arrayBuffer: async () => new Uint8Array(6_000_000).buffer };
  const result = await importMaterial(big);
  assert.equal(result.name, 'photo.jpg', '重编码为 JPEG 后扩展名如实变化');
  assert.ok(result.image.length <= 5333336);
  assert.equal(ops[0][0], 'fill', '先铺白底，透明 PNG 不压成黑底');
  assert.equal(ops[1][0], 'draw');
  assert.ok(ops.some(([kind, quality]) => kind === 'encode' && quality === 0.65), '第一档超限后降到第二档质量');
  assert.deepEqual(ops.at(-1), ['close']);
  assert.match(uploadProgressText({ stage: 'compress', index: 0, files: 1, name: 'photo.png' }), /自动压缩/);
});

test('预算内的单图保持原始字节不重压；解码失败与压不进都如实报错', async (t) => {
  t.after(() => { delete globalThis.document; delete globalThis.createImageBitmap; });
  const raw = new Uint8Array(100).fill(7);
  const small = { name: 'tiny.png', size: 100, arrayBuffer: async () => raw.buffer };
  const kept = await importMaterial(small);
  assert.equal(kept.name, 'tiny.png');
  assert.equal(kept.image, Buffer.from(raw).toString('base64'), '预算内不做有损重编码');

  const ops = stubCanvas([6_000_000]);
  globalThis.createImageBitmap = async () => { throw new Error('bad image'); };
  await assert.rejects(importMaterial({ name: 'broken.png', size: 6_000_000, arrayBuffer: async () => new Uint8Array(6_000_000).buffer }), /无法解码/);

  stubCanvas([6_000_000]);
  await assert.rejects(
    importMaterial({ name: 'huge.jpg', size: 6_000_000, arrayBuffer: async () => new Uint8Array(6_000_000).buffer }),
    /压缩后仍超过单张图片上限/,
  );
});
