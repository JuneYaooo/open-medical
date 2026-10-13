import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { AppError, check } from '../errors.mjs';
const executable = resolve(import.meta.dirname, '../../desktop/bin/native-ocr');
export const localOcrAvailable = () => process.platform === 'darwin' && existsSync(executable);
export async function recognizeImage(data, signal, options = {}) {
  check(localOcrAvailable(), 'OCR_UNAVAILABLE', '此平台未安装本地 OCR，请使用视觉模型读取图片', 503);
  check(data.length <= 4000000, 'IMAGE_LIMIT', '图片超过 4MB');
  return new Promise((done, reject) => {
    const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], signal });
    let output = '', settled = false;
    const timer = setTimeout(() => child.kill(), 45000);
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : done(value); };
    child.on('error', (error) => finish(signal?.aborted ? signal.reason : new AppError('OCR_UNAVAILABLE', `本地识别组件无法启动：${error.message}`, 503)));
    child.stdin.on('error', () => {});
    child.stderr.resume();
    child.stdout.on('data', (part) => { output += part.toString(); if (output.length > (options.includeImage ? 8000000 : 1000000)) child.kill(); });
    child.on('close', (code) => {
      if (signal?.aborted) return finish(signal.reason);
      if (code !== 0) return finish(new AppError('OCR_FAILED', '本地 OCR 未完成，请检查图片格式、清晰度或切换视觉模型', 503));
      try { finish(null, JSON.parse(output)); } catch { finish(new AppError('OCR_FAILED', '本地 OCR 返回格式无效', 503)); }
    });
    child.stdin.end(JSON.stringify({ image: data.toString('base64'), region: options.region, includeImage: options.includeImage === true }));
  });
}
