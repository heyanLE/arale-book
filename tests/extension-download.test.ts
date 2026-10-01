import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { downloadToFile, DownloadCancelledError } from '../src/main/extensions/download';

test('下载器：真实流式落盘、重定向上限、断流和空闲取消', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-download-'));
  const dest = path.join(root, 'asset.zip');
  const https = require('node:https') as typeof import('node:https');
  let createResponse: () => Readable;
  const stub = mock.method(https, 'get', () => {
    const request = new EventEmitter() as EventEmitter & { abort(): void };
    request.abort = () => request.emit('abort');
    setImmediate(() => request.emit('response', createResponse()));
    return request;
  });
  const response = (chunks: Buffer[], status = 200, headers = {}): Readable => {
    return Object.assign(Readable.from(chunks), { statusCode: status, headers });
  };
  try {
    await t.test('未知 Content-Length 的完整流也能成功并校验 SHA', async () => {
      const payload = Buffer.from('downloaded OCR archive');
      createResponse = () => response([payload]);
      const result = await downloadToFile({ url: 'https://example.com/archive', dest });
      assert.equal(result.bytes, payload.length);
      assert.equal(result.sha256, createHash('sha256').update(payload).digest('hex'));
      assert.deepEqual(fs.readFileSync(dest), payload);
    });
    await t.test('重定向循环拒绝且不把重定向响应当作 ZIP', async () => {
      createResponse = () => response([], 302, { location: '/loop' });
      await assert.rejects(downloadToFile({ url: 'https://example.com/archive', dest }), /重定向次数过多/);
    });
    await t.test('HTTPS 重定向不能降级到 HTTP', async () => {
      createResponse = () => response([], 302, { location: 'http://example.com/archive' });
      await assert.rejects(downloadToFile({ url: 'https://example.com/archive', dest }), /只允许 HTTPS/);
    });
    await t.test('响应提前关闭必须结束任务并清理半份文件', async () => {
      createResponse = () => {
        const stream = Object.assign(new Readable({ read() {} }), { statusCode: 200, headers: {} });
        setImmediate(() => { stream.push(Buffer.from('partial')); stream.destroy(); });
        return stream;
      };
      await assert.rejects(downloadToFile({ url: 'https://example.com/archive', dest }), /下载中断/);
      assert.equal(fs.existsSync(dest), false);
    });
    await t.test('服务器不发送数据时仍可取消', async () => {
      let cancelled = false;
      createResponse = () => Object.assign(new Readable({ read() {} }), { statusCode: 200, headers: {} });
      const timer = setTimeout(() => { cancelled = true; }, 50);
      try {
        await assert.rejects(downloadToFile({ url: 'https://example.com/archive', dest, isCancelled: () => cancelled }), DownloadCancelledError);
        assert.equal(fs.existsSync(dest), false);
      } finally { clearTimeout(timer); }
    });
  } finally { stub.mock.restore(); fs.rmSync(root, { recursive: true, force: true }); }
});
