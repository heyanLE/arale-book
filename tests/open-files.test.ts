/**
 * 「用本应用打开文件」队列的单测。
 *
 * 这条路径在桌面端很容易被忽略，但它是「双击一个 .epub」能不能工作的全部实现。
 * 尤其要钉住的是**时序**：macOS 的 `open-file` 常在窗口建好之前就到达，
 * 队列必须能先攒后发，而不是当场丢掉。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OpenFileQueue, openFilesFromArgv } from '../src/main/open-files';

test('openFilesFromArgv: 跳过开关与自身路径', () => {
  assert.deepEqual(openFilesFromArgv(['/app/electron', 'book.epub', 'manga.cbz']), ['book.epub', 'manga.cbz']);
  assert.deepEqual(openFilesFromArgv(['/app/electron', '--remote-debugging-port=9333', 'book.epub']), ['book.epub']);
  assert.deepEqual(openFilesFromArgv(['/app/electron', '.']), []);
  assert.deepEqual(openFilesFromArgv(['/app/electron']), []);
  assert.deepEqual(openFilesFromArgv([]), []);
});

test('OpenFileQueue: 渲染进程未就绪时先攒着，就绪后一次性派发', () => {
  const queue = new OpenFileQueue({ exists: () => true });
  const received: string[][] = [];
  queue.setSink((paths) => received.push(paths));

  queue.push(['a.epub']);
  queue.push(['b.cbz']);
  assert.deepEqual(received, [], '还没就绪，不应派发');
  assert.equal(queue.size, 2);

  queue.setReady(true);
  assert.deepEqual(received, [['a.epub', 'b.cbz']]);
  assert.equal(queue.size, 0);
});

test('OpenFileQueue: 就绪后 push 立即派发', () => {
  const queue = new OpenFileQueue({ exists: () => true });
  const received: string[][] = [];
  queue.setSink((paths) => received.push(paths));
  queue.setReady(true);

  queue.push(['x.epub']);
  assert.deepEqual(received, [['x.epub']]);
});

test('OpenFileQueue: 不存在的路径被丢弃（命令行里的开关、已删除的文件）', () => {
  const queue = new OpenFileQueue({ exists: (p) => p === 'real.epub' });
  const received: string[][] = [];
  queue.setSink((paths) => received.push(paths));
  queue.setReady(true);

  queue.push(['ghost.epub', 'real.epub', '', '--flag']);
  assert.deepEqual(received, [['real.epub']]);
});

test('OpenFileQueue: 没有 sink 时不会丢，setSink 之后再派发', () => {
  const queue = new OpenFileQueue({ exists: () => true });
  queue.setReady(true);
  queue.push(['a.epub']);

  const received: string[][] = [];
  queue.setSink((paths) => received.push(paths));
  assert.deepEqual(received, [['a.epub']]);
});

test('OpenFileQueue: 空串被丢弃，不会空派发', () => {
  const queue = new OpenFileQueue({ exists: () => true });
  const received: string[][] = [];
  queue.setSink((paths) => received.push(paths));
  queue.setReady(true);

  queue.push([]);
  queue.push(['', '']);
  assert.deepEqual(received, [], '空串不该产生一次派发');
  assert.equal(queue.size, 0);
});

test('OpenFileQueue 不做 argv 解析：过滤开关是 openFilesFromArgv 的职责', () => {
  // 队列只管「存在性」。开关过滤必须在上游做完，否则这里会误判成一个真实路径
  // （`exists` 是注入的，真实环境里 `--flag` 当然不存在，但职责边界要说清楚）。
  const seen: string[] = [];
  const queue = new OpenFileQueue({
    exists: (p) => {
      seen.push(p);
      return !p.startsWith('--');
    },
  });
  const received: string[][] = [];
  queue.setSink((paths) => received.push(paths));
  queue.setReady(true);

  queue.push(['--only-flags', 'book.epub']);
  assert.deepEqual(received, [['book.epub']]);
  assert.ok(seen.includes('--only-flags'), '队列确实问过存在性');
});
