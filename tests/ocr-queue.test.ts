/**
 * OCR **任务队列**的单测。
 *
 * 队列是主进程的状态，不需要 Electron、不需要模型、不需要网络——引擎是注入的假实现，
 * 唯一的本事是「按调用方指定的耗时睡一会儿再交结果」。这样可以把并发问题变成
 * 可断言的顺序问题：
 *
 * - 同时点三本书 → 必须**串行**跑（同一时刻只有一本在跑），而不是三个线程抢 CPU；
 * - 连点同一本书 → 不能排进两条一模一样的任务；
 * - 排队中取消 → 从队列里消失，不占位置；
 * - 正在跑时取消 → 已经识别出来的页照样写盘（用户重跑不必从头来）；
 * - 排在队里的书被删了 → 要给出明确的失败，而不是永远「排队中…」。
 *
 * 这一层以前完全没有测试：`jobs` 是个 `Map<bookId, …>`，跑完就删，没有「排队」这个概念，
 * 所以「同时点两本会同时跑」这件事谁也没发现。
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { setUserDataRootForTesting, bookContentDir } from '../src/main/paths';
import { OcrService } from '../src/main/ocr/service';
import type { OcrBookContext, OcrEngine } from '../src/main/ocr/provider';
import { makeBaseRecord } from '../src/main/library/store';
import type {
  BookRecord,
  OcrEngineStatus,
  OcrProviderId,
  OcrQueueState,
  PageText,
} from '../src/shared/types';

let root = '';
let service: OcrService | null = null;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-ocr-queue-'));
  setUserDataRootForTesting(root);
});

after(() => {
  setUserDataRootForTesting(null);
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  service = null;
});

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 造一本有 3 页图的假书（页图内容无所谓，假引擎不读盘）。 */
function makeBook(title: string, pages = 3): BookRecord {
  const id = `bk_${title.replace(/[^a-z0-9]/gi, '')}${Math.random().toString(36).slice(2, 6)}`;
  const dir = path.join(root, 'library', id);
  const content = bookContentDir(id);
  fs.mkdirSync(content, { recursive: true });
  const record = makeBaseRecord({
    id,
    format: 'comic',
    title,
    direction: 'rtl',
    dir,
  });
  record.pages = Array.from({ length: pages }, (_, index) => ({
    url: `p${index + 1}.png`,
    width: 100,
    height: 100,
  }));
  record.pageCount = pages;
  // 页图文件本身不必是真的图片：假引擎不读它。
  for (const page of record.pages) fs.writeFileSync(path.join(content, page.url), 'fake');
  return record;
}

/** 单条任务的观测记录：用来断言「谁在什么时候跑」。 */
interface Run {
  bookId: string;
  provider: OcrProviderId;
  startedAt: number;
  endedAt: number;
}

/**
 * 假引擎：`recognizeBook` 按页回调后睡 `perPageMs`，于是「并行 vs 串行」可以从
 * 时间区间是否重叠直接看出来。
 */
function makeEngine(
  id: OcrProviderId,
  runs: Run[],
  options: {
    perPageMs?: number;
    status?: Partial<OcrEngineStatus>;
    /** 每识别完一页调一次（测试用它观察进度，不必去猜 sleep 时长）。 */
    onPageSeen?: (bookId: string, index: number) => void;
  } = {},
): OcrEngine {
  const perPageMs = options.perPageMs ?? 5;
  return {
    id,
    async status(): Promise<OcrEngineStatus> {
      return {
        id,
        label: id === 'system' ? '系统 OCR' : 'manga-anki',
        available: true,
        ready: true,
        reason: null,
        requirement: '',
        downloadSizeMb: 0,
        extension: null,
        ...options.status,
      };
    },
    async recognizeBook(context: OcrBookContext): Promise<PageText[]> {
      const run: Run = { bookId: context.book.id, provider: id, startedAt: Date.now(), endedAt: 0 };
      runs.push(run);
      const out: PageText[] = [];
      for (const [index, page] of context.pages.entries()) {
        if (context.isCancelled()) break;
        await new Promise((resolve) => setTimeout(resolve, perPageMs));
        const blocks = [
          {
            // Box = [x, y, width, height]（见 shared/types.ts:174）。
            box: [0, 0, 10, 10] as [number, number, number, number],
            vertical: true,
            fontSize: 12,
            lines: [`${context.book.title} 第${index + 1}页`],
          },
        ];
        context.onPage(index, blocks);
        options.onPageSeen?.(context.book.id, index);
        out.push({ url: page.rel, blocks });
      }
      run.endedAt = Date.now();
      return out;
    },
    async dispose(): Promise<void> {
      /* 无资源 */
    },
  };
}

function makeService(
  books: BookRecord[],
  runs: Run[],
  options: { perPageMs?: number; onPageSeen?: (bookId: string, index: number) => void } = {},
): OcrService {
  const byId = new Map(books.map((book) => [book.id, book]));
  const settingsFile = path.join(root, `settings-${Math.random().toString(36).slice(2, 8)}.json`);
  const created = new OcrService({
    getBook: (id) => byId.get(id) ?? null,
    engines: [
      makeEngine('system', runs, options),
      makeEngine('manga-anki', runs, { ...options, status: { label: 'manga-anki (mokuro)' } }),
    ],
    extensionsDir: path.join(root, 'extensions'),
    settingsFile,
  });
  service = created;
  return created;
}

/** 等到队列满足条件；比固定 sleep 稳，也不会在慢机器上假失败。 */
async function until(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`等超时：${label}`);
}

function queueOf(service: OcrService): OcrQueueState {
  return service.queueState();
}

// ---------------------------------------------------------------------------
// 入队
// ---------------------------------------------------------------------------

test('入队即返回 queued，任务在后台跑', async () => {
  const books = [makeBook('A')];
  const runs: Run[] = [];
  const ocr = makeService(books, runs, { perPageMs: 10 });

  const outcome = ocr.start(books[0]!.id);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.queued, true, '现在每次请求都是入队');
  assert.equal(outcome.queuePosition, 1);
  assert.equal(outcome.provider, 'system');

  await ocr.drain();
  assert.equal(runs.length, 1);
  assert.equal(ocr.status(books[0]!.id)?.ok, true);
});

test('同时点三本书 → 串行执行，时间区间不重叠', async () => {
  const books = [makeBook('A'), makeBook('B'), makeBook('C')];
  const runs: Run[] = [];
  const ocr = makeService(books, runs, { perPageMs: 8 });

  for (const book of books) assert.equal(ocr.start(book.id).queued, true);

  // 立刻看队列：1 个在跑 + 2 个排队，顺序就是点击顺序。
  const snapshot = queueOf(ocr);
  assert.equal(snapshot.active?.bookId, books[0]!.id);
  assert.deepEqual(
    snapshot.pending.map((entry) => entry.bookId),
    [books[1]!.id, books[2]!.id],
    'FIFO：先点的先跑',
  );

  await ocr.drain();

  assert.equal(runs.length, 3);
  assert.deepEqual(
    runs.map((run) => run.bookId),
    [books[0]!.id, books[1]!.id, books[2]!.id],
    '执行顺序必须等于入队顺序',
  );
  // 串行的判据：后一条的**开始**不早于前一条的**结束**。
  for (let i = 1; i < runs.length; i += 1) {
    assert.ok(
      runs[i]!.startedAt >= runs[i - 1]!.endedAt,
      `第 ${i + 1} 条与第 ${i} 条重叠了：${JSON.stringify(runs)}`,
    );
  }
  // 队列跑空后 active/pending 都该是空的（右下角胶囊此时消失）。
  assert.deepEqual(queueOf(ocr), { active: null, pending: [] });
});

test('连点同一本书：第二次返回「已在识别中」，不会排进两条', async () => {
  const books = [makeBook('A')];
  const runs: Run[] = [];
  const ocr = makeService(books, runs, { perPageMs: 10 });

  const first = ocr.start(books[0]!.id);
  assert.equal(first.queued, true);
  const second = ocr.start(books[0]!.id);
  assert.equal(second.ok, false);
  assert.match(second.error ?? '', /已在识别中/);

  await ocr.drain();
  assert.equal(runs.length, 1, '同一本书只该跑一次');
});

test('排队中的书再点一次：报出队列位置，不重复入队', async () => {
  const books = [makeBook('A'), makeBook('B')];
  const runs: Run[] = [];
  const ocr = makeService(books, runs, { perPageMs: 10 });

  ocr.start(books[0]!.id); // 立刻开跑
  const queued = ocr.start(books[1]!.id);
  assert.equal(queued.queuePosition, 1);

  const again = ocr.start(books[1]!.id);
  assert.equal(again.ok, false);
  assert.equal(again.queued, true);
  assert.equal(again.queuePosition, 1);
  assert.match(again.error ?? '', /已在队列中/);

  await ocr.drain();
  assert.equal(runs.length, 2);
});

test('没有页图的书直接拒绝，不入队', () => {
  const textBook = makeBook('Text', 0);
  const runs: Run[] = [];
  const ocr = makeService([textBook], runs);

  const outcome = ocr.start(textBook.id);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? '', /没有页图/);
  assert.deepEqual(queueOf(ocr), { active: null, pending: [] });
});

test('已有文字层且未 force → 立刻 skipped，不入队（不必排到队尾才告诉用户）', async () => {
  const books = [makeBook('A')];
  const runs: Run[] = [];
  const ocr = makeService(books, runs, { perPageMs: 10 });

  // 先真跑一次，产出 manga.json。
  ocr.start(books[0]!.id);
  await ocr.drain();
  assert.equal(runs.length, 1);

  const skipped = ocr.start(books[0]!.id);
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, true);
  assert.ok((skipped.blocks ?? 0) > 0, 'skipped 时要报出已有文字块数');
  assert.deepEqual(queueOf(ocr), { active: null, pending: [] }, '跳过不该占队列位置');

  // force 之后就真的重跑。
  ocr.start(books[0]!.id, { force: true });
  await ocr.drain();
  assert.equal(runs.length, 2);
});

// ---------------------------------------------------------------------------
// 引擎固化
// ---------------------------------------------------------------------------

test('引擎在**入队时**定下：排队期间改默认引擎不影响已排队的任务', async () => {
  const books = [makeBook('A'), makeBook('B')];
  const runs: Run[] = [];
  const ocr = makeService(books, runs, { perPageMs: 12 });

  ocr.start(books[0]!.id); // system，立刻开跑
  const second = ocr.start(books[1]!.id, { provider: 'manga-anki' });
  assert.equal(second.provider, 'manga-anki');
  assert.equal(queueOf(ocr).pending[0]?.provider, 'manga-anki');

  // 排队期间用户去设置里换成内置。
  await ocr.selectProvider('system');
  assert.equal(queueOf(ocr).pending[0]?.provider, 'manga-anki', '队列里那条不该跟着变');

  await ocr.drain();
  assert.deepEqual(
    runs.map((run) => run.provider),
    ['system', 'manga-anki'],
  );
});

test('队列快照带书名与总页数（弹层要显示「在识别哪一本」）', async () => {
  const books = [makeBook('吾輩は猫である', 7), makeBook('第二卷', 4)];
  const runs: Run[] = [];
  const ocr = makeService(books, runs, { perPageMs: 10 });

  ocr.start(books[0]!.id);
  ocr.start(books[1]!.id);

  const snapshot = queueOf(ocr);
  assert.equal(snapshot.active?.title, '吾輩は猫である');
  assert.equal(snapshot.active?.total, 7);
  assert.equal(snapshot.pending[0]?.title, '第二卷');
  assert.equal(snapshot.pending[0]?.total, 4);
  assert.ok((snapshot.active?.enqueuedAt ?? 0) > 0);

  await ocr.drain();
});

// ---------------------------------------------------------------------------
// 取消
// ---------------------------------------------------------------------------

test('排队中取消 → 移出队列，后面的书上位', async () => {
  const books = [makeBook('A'), makeBook('B'), makeBook('C')];
  const runs: Run[] = [];
  const ocr = makeService(books, runs, { perPageMs: 10 });

  ocr.start(books[0]!.id);
  ocr.start(books[1]!.id);
  ocr.start(books[2]!.id);

  ocr.cancel(books[1]!.id);
  assert.deepEqual(
    queueOf(ocr).pending.map((entry) => entry.bookId),
    [books[2]!.id],
    '取消的应该从队列里消失',
  );

  // 被取消的那本也要有一个明确的结束态，否则等它的调用方会挂住。
  const result = await ocr.wait(books[1]!.id);
  assert.equal(result?.ok, false);
  assert.match(result?.error ?? '', /已取消（还没开始识别）/);

  await ocr.drain();
  assert.deepEqual(
    runs.map((run) => run.bookId),
    [books[0]!.id, books[2]!.id],
    '被取消的那本不能开始跑',
  );
});

test('正在跑时取消 → 停下、已识别的页照样写盘', async () => {
  const books = [makeBook('A', 40)];
  const runs: Run[] = [];
  // 用「已识别页数」当取消时机，而不是 sleep 一个魔法数字——后者在慢机器上会
  // 要么取消得太早（一页都没识别出来），要么太晚（任务已经跑完）。
  let recognized = 0;
  const ocr = makeService(books, runs, {
    perPageMs: 4,
    onPageSeen: () => {
      recognized += 1;
    },
  });

  ocr.start(books[0]!.id);
  await until(() => recognized >= 3, '至少识别出 3 页');
  // 此刻必须还在跑（否则这个用例就没测到「跑的过程中取消」）。
  assert.equal(ocr.status(books[0]!.id)?.error, '正在识别中…');
  ocr.cancel(books[0]!.id);

  const result = await ocr.wait(books[0]!.id);
  assert.equal(result?.ok, false);
  assert.match(result?.error ?? '', /已取消/);
  assert.ok(recognized < 40, `取消应该让它提前停下，实际识别了 ${recognized} 页`);

  // 关键：取消之后**已经识别出来的页必须落盘**。
  // 靠的是 writeTextLayer 把「没识别出的页」保留成原有文字层（这里是空的），
  // 而不是整份文件不写。
  const manga = JSON.parse(
    fs.readFileSync(path.join(bookContentDir(books[0]!.id), 'manga.json'), 'utf8'),
  ) as { pages: Array<{ blocks: unknown[] }> };
  assert.equal(manga.pages.length, 40, '取消不该把文字层文件写残');
  const withBlocks = manga.pages.filter((page) => page.blocks.length > 0).length;
  assert.ok(withBlocks > 0, '已经识别出来的页必须保存下来（重跑不必从第 1 页再来）');
  assert.ok(withBlocks <= recognized, `落盘的页数(${withBlocks}) 不该超过实际识别的页数(${recognized})`);

  // 取消之后队列要能继续推进。
  assert.deepEqual(queueOf(ocr), { active: null, pending: [] });
});

test('取消一本没在跑也没排队的书：什么都不发生', async () => {
  const books = [makeBook('A')];
  const runs: Run[] = [];
  const ocr = makeService(books, runs);
  ocr.cancel(books[0]!.id);
  assert.deepEqual(queueOf(ocr), { active: null, pending: [] });
});

// ---------------------------------------------------------------------------
// 边界
// ---------------------------------------------------------------------------

test('排队中的书被删掉：给出明确失败，队列继续往下走', async () => {
  const books = [makeBook('A'), makeBook('B')];
  const byId = new Map(books.map((book) => [book.id, book]));
  const runs: Run[] = [];
  const ocr = new OcrService({
    getBook: (id) => byId.get(id) ?? null,
    engines: [makeEngine('system', runs, { perPageMs: 8 })],
    extensionsDir: path.join(root, 'extensions'),
    settingsFile: path.join(root, 'settings-deleted.json'),
  });

  ocr.start(books[0]!.id);
  ocr.start(books[1]!.id);
  // B 在队列里时被删。
  byId.delete(books[1]!.id);

  await ocr.drain();
  const gone = await ocr.wait(books[1]!.id);
  assert.equal(gone?.ok, false);
  assert.match(gone?.error ?? '', /书不存在/);
  assert.equal(runs.length, 1, 'B 不该被真的跑');
  assert.equal((await ocr.wait(books[0]!.id))?.ok, true, 'A 仍然要正常跑完');
});

test('引擎抛异常 → 记成失败，队列不卡住', async () => {
  const books = [makeBook('A'), makeBook('B')];
  const runs: Run[] = [];
  const good = makeEngine('manga-anki', runs, { perPageMs: 5 });
  const bad: OcrEngine = {
    id: 'system',
    async status(): Promise<OcrEngineStatus> {
      return {
        id: 'system',
        label: '系统 OCR',
        available: true,
        ready: true,
        reason: null,
        requirement: '',
        downloadSizeMb: 0,
        extension: null,
      };
    },
    async recognizeBook(): Promise<PageText[]> {
      throw new Error('模型文件损坏');
    },
    async dispose(): Promise<void> {
      /* 无资源 */
    },
  };
  const ocr = new OcrService({
    getBook: (id) => books.find((book) => book.id === id) ?? null,
    engines: [bad, good],
    extensionsDir: path.join(root, 'extensions'),
    settingsFile: path.join(root, 'settings-throw.json'),
  });

  ocr.start(books[0]!.id, { provider: 'system' });
  ocr.start(books[1]!.id, { provider: 'manga-anki' });
  await ocr.drain();

  assert.match((await ocr.wait(books[0]!.id))?.error ?? '', /模型文件损坏/);
  assert.equal((await ocr.wait(books[1]!.id))?.ok, true, '前一条失败不能卡死队列');
  assert.deepEqual(queueOf(ocr), { active: null, pending: [] });
});

test('queueState 是快照：拿到之后再改队列不会影响已发出的那份', async () => {
  const books = [makeBook('A'), makeBook('B')];
  const runs: Run[] = [];
  const ocr = makeService(books, runs, { perPageMs: 10 });

  ocr.start(books[0]!.id);
  ocr.start(books[1]!.id);
  const snapshot = queueOf(ocr);
  assert.equal(snapshot.pending.length, 1);

  ocr.cancel(books[1]!.id);
  assert.equal(snapshot.pending.length, 1, '快照不该是活引用');

  await ocr.drain();
});
