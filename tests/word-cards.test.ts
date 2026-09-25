/**
 * 词卡存储的单测。
 *
 * 这一层是**用户数据的守门人**：写坏了就是用户白干的活，读崩了就是整页报错。所以测试
 * 重点不在「正常路径能跑」，而在四类容易出事的边界：
 *
 * - 文件缺失/半截 JSON/被手工编辑成乱七八糟的形状 → 只能退化成「还没有词卡」，不能抛；
 * - 排序必须确定（同一毫秒两张卡也要有稳定次序），否则 UI 列表会自己跳；
 * - 落盘/读回的形状要能被 `updateCard` 的**白名单**挡住：渲染进程塞 id/createdAt 进 patch
 *   也不许改到；
 * - 返回值是副本：UI 层随便改返回值，不能污染下一次读。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CARDS_FILE,
  addCard,
  cardsFileFor,
  countCards,
  listCards,
  removeCard,
  updateCard,
} from '../src/main/library/cards';
import { bookDir, setUserDataRootForTesting } from '../src/main/paths';
import { writeJsonAtomic } from '../src/core/util/atomic-json';
import type { WordCard, WordCardDraft } from '../src/shared/types';

let root = '';

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-cards-'));
  setUserDataRootForTesting(root);
});

after(() => {
  setUserDataRootForTesting(null);
  fs.rmSync(root, { recursive: true, force: true });
});

function draft(overrides: Partial<WordCardDraft> = {}): WordCardDraft {
  return {
    word: '食べる',
    context: '毎日ご飯を食べる。',
    offset: 5,
    length: 3,
    dictionaryExpression: '食べる',
    dictionaryId: 'dc_jp',
    dictionaryTitle: '大辞泉',
    dictionaryReading: 'たべる',
    ...overrides,
  };
}

function card(overrides: Partial<WordCard> = {}): WordCard {
  return {
    id: 'bk_seed',
    word: 'w',
    context: '',
    offset: 0,
    length: 0,
    dictionaryExpression: '',
    dictionaryId: '',
    dictionaryTitle: '',
    dictionaryReading: '',
    note: '',
    analyses: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** 直接落一份文件，用来造出 addCard 造不出的状态（时间戳、坏字段、非对象条目）。 */
function seed(bookId: string, cards: unknown[]): void {
  writeJsonAtomic(cardsFileFor(bookId), { version: 1, cards });
}

test('文件不存在：listCards 给空数组、countCards 给 0', () => {
  // 「刚导入、还没存过词卡」是最常见的状态，不该被当成错误。
  const bookId = 'bk_missing';
  assert.deepEqual(listCards(bookId), []);
  assert.equal(countCards(bookId), 0);
});

test('addCard：字段齐、默认值对、写在书目录而不是 content/', () => {
  const bookId = 'bk_add';
  const before = Date.now();
  const created = addCard(bookId, draft({ word: '  食べる  ' }));

  // word 原样保存（不 trim）：只有「是否空白」用于兜底判断。
  assert.equal(created.word, '  食べる  ');
  assert.equal(created.context, '毎日ご飯を食べる。');
  assert.equal(created.offset, 5);
  assert.equal(created.length, 3);
  assert.equal(created.dictionaryExpression, '食べる');
  assert.equal(created.dictionaryId, 'dc_jp');
  assert.equal(created.dictionaryTitle, '大辞泉');
  assert.equal(created.dictionaryReading, 'たべる');
  assert.equal(created.note, '', 'note 默认空串');
  assert.deepEqual(created.analyses, [], 'analyses 默认空数组');
  assert.ok(created.id.length > 0, '主进程必须补一个 id');
  assert.ok(created.createdAt >= before && created.createdAt <= Date.now(), 'createdAt 应是现在');
  assert.equal(created.updatedAt, created.createdAt, '新建时两个时间戳一致');

  // 布局：和 content/ 平级，阅读器不该能通过 arale:// 摸到它。
  assert.equal(cardsFileFor(bookId), path.join(bookDir(bookId), CARDS_FILE));
  assert.ok(!cardsFileFor(bookId).includes(`${path.sep}content${path.sep}`), '词卡不能落在阅读器可读根里');
  assert.ok(fs.existsSync(cardsFileFor(bookId)), '应真的落盘');

  const listed = listCards(bookId);
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0], created, '读回来的应与写入返回的一致');
  assert.equal(countCards(bookId), 1);
});

test('listCards：createdAt 倒序；同一时刻按 id 倒序', () => {
  // 顺序不确定会让 UI 列表在两次读之间跳来跳去，所以时间相同时必须有稳定的次键。
  const bookId = 'bk_order';
  seed(bookId, [
    card({ id: 'bk_a', createdAt: 100, updatedAt: 100 }),
    card({ id: 'bk_c', createdAt: 300, updatedAt: 300 }),
    card({ id: 'bk_b', createdAt: 200, updatedAt: 200 }),
  ]);
  assert.deepEqual(
    listCards(bookId).map((item) => item.id),
    ['bk_c', 'bk_b', 'bk_a'],
  );

  // 同一 createdAt：id 大的在前。三次 add 也很可能落在同一毫秒，所以下面再走一遍真实路径。
  const tie = 'bk_tie';
  seed(tie, [
    card({ id: 'bk_a', createdAt: 500, updatedAt: 500 }),
    card({ id: 'bk_c', createdAt: 500, updatedAt: 500 }),
    card({ id: 'bk_b', createdAt: 500, updatedAt: 500 }),
  ]);
  assert.deepEqual(
    listCards(tie).map((item) => item.id),
    ['bk_c', 'bk_b', 'bk_a'],
  );

  const added = 'bk_order_add';
  addCard(added, draft({ word: 'いち' }));
  addCard(added, draft({ word: 'に' }));
  addCard(added, draft({ word: 'さん' }));
  const rows = listCards(added);
  assert.equal(rows.length, 3);
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1]!;
    const cur = rows[i]!;
    assert.ok(
      prev.createdAt > cur.createdAt || (prev.createdAt === cur.createdAt && prev.id > cur.id),
      `第 ${i} 项打破了「新→旧、同刻 id 倒序」：${prev.id} → ${cur.id}`,
    );
  }
});

test('addCard 去重：同 word + 同 dictionaryExpression 是刷新，不是多一行', () => {
  // 用户手滑点两次「保存」很常见；两行一模一样的卡比一行被刷新更糟。
  const bookId = 'bk_dup';
  const first = addCard(bookId, draft({ context: '旧上下文', offset: 1, length: 2 }));
  const second = addCard(bookId, draft({ context: '新上下文', offset: 7, length: 4 }));

  assert.equal(second.id, first.id, '应复用旧卡的 id');
  assert.equal(countCards(bookId), 1, '不能变成两张');
  const [only] = listCards(bookId);
  assert.equal(only?.context, '新上下文');
  assert.equal(only?.offset, 7);
  assert.equal(only?.length, 4);
  assert.equal(only?.createdAt, first.createdAt, 'createdAt 不该被刷新');
  assert.ok(only !== undefined && only.updatedAt >= first.updatedAt, 'updatedAt 应被顶到新时间');

  // 去重键是「word 且 dictionaryExpression」：辞书形不同就该是两张。
  addCard(bookId, draft({ dictionaryExpression: '食べる（別）' }));
  assert.equal(countCards(bookId), 2);
});

test('addCard：word 空时退到 dictionaryExpression，两个都空时用占位符', () => {
  // 列表里一张没有标签的卡，用户根本认不出是哪次查询，宁可显示占位符。
  const fromExpression = addCard('bk_fallback_a', draft({ word: '   ', dictionaryExpression: '食べる' }));
  assert.equal(fromExpression.word, '食べる');

  const unnamed = addCard('bk_fallback_b', draft({ word: '', dictionaryExpression: '' }));
  assert.equal(unnamed.word, '（未命名）');
});

test('updateCard：能改 note；未知 id 返回 null', () => {
  const bookId = 'bk_update_note';
  const created = addCard(bookId, draft());
  const updated = updateCard(bookId, created.id, { note: '五段动词' });

  assert.ok(updated, '存在就该返回改后的卡');
  assert.equal(updated!.note, '五段动词');
  assert.equal(updated!.word, created.word, '没在 patch 里的字段应原样保留');
  assert.equal(updated!.createdAt, created.createdAt);
  assert.ok(updated!.updatedAt >= created.updatedAt, '更新应顶 updatedAt');
  assert.equal(listCards(bookId)[0]?.note, '五段动词', '改完要落盘');

  assert.equal(updateCard(bookId, 'bk_不存在', { note: 'x' }), null);
});

test('updateCard：白名单之外（id/createdAt/context）改不动', () => {
  // patch 来自渲染进程；放任它覆盖 id/createdAt，UI 一次手滑就能造出两张同 id 的卡。
  const bookId = 'bk_whitelist';
  const created = addCard(bookId, draft());
  const patched = updateCard(bookId, created.id, {
    id: 'bk_hacked',
    createdAt: 1,
    context: '被篡改',
    offset: 999,
    updatedAt: 1,
  } as any);

  assert.ok(patched);
  assert.equal(patched!.id, created.id);
  assert.equal(patched!.createdAt, created.createdAt);
  assert.equal(patched!.context, created.context);
  assert.equal(patched!.offset, created.offset);
  assert.ok(patched!.updatedAt >= created.updatedAt, '时间戳由主进程说了算');

  const [stored] = listCards(bookId);
  assert.equal(stored?.id, created.id);
  assert.equal(stored?.context, created.context);
});

test('updateCard：空白 word 被忽略，不会把卡改成没标题', () => {
  const bookId = 'bk_blank_word';
  const created = addCard(bookId, draft({ word: '食べる' }));
  const updated = updateCard(bookId, created.id, { word: '   ' });
  assert.equal(updated?.word, '食べる', '空白 word 应保持旧值');
  assert.equal(listCards(bookId)[0]?.word, '食べる');
});

test('removeCard：删到返回 true，再删返回 false，列表变短', () => {
  const bookId = 'bk_remove';
  const first = addCard(bookId, draft({ word: 'A' }));
  addCard(bookId, draft({ word: 'B' }));
  assert.equal(countCards(bookId), 2);

  assert.equal(removeCard(bookId, first.id), true);
  assert.equal(countCards(bookId), 1);
  assert.equal(removeCard(bookId, first.id), false, '第二遍不该说删掉了');
  assert.equal(listCards(bookId).length, 1);
});

test('坏 JSON：读当空，写一次就是一次修复', () => {
  // 一个坏字节不该把整页查询打崩；用户下一次「保存」就该让文件回到可用状态。
  const bookId = 'bk_corrupt';
  fs.mkdirSync(bookDir(bookId), { recursive: true });
  fs.writeFileSync(cardsFileFor(bookId), '{ 这不是 JSON', 'utf8');

  assert.deepEqual(listCards(bookId), []);
  assert.equal(countCards(bookId), 0);

  const created = addCard(bookId, draft());
  assert.equal(countCards(bookId), 1);
  assert.equal(listCards(bookId)[0]?.id, created.id);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(cardsFileFor(bookId), 'utf8')), '写后应是合法 JSON');
});

test('listCards 返回防御性副本：改返回值不影响后续读', () => {
  // 返回值会被 UI 层随便改（排序、就地标注），不能因此污染下一读。
  const bookId = 'bk_copy';
  const created = addCard(bookId, draft());
  updateCard(bookId, created.id, { note: '原始笔记' });

  const first = listCards(bookId);
  first[0]!.note = '被改过';
  first[0]!.analyses = [{ word: 'x', text: '伪造', profileName: 'p', model: 'm', createdAt: 1 }];
  first[0]!.word = '被改过';
  first.push(card({ id: 'bk_injected' }));

  const second = listCards(bookId);
  assert.equal(second.length, 1, '往返回值里 push 不该影响落盘内容');
  assert.equal(second[0]?.note, '原始笔记');
  assert.equal(second[0]?.word, '食べる');
  assert.deepEqual(second[0]?.analyses, []);
});

test('校验：非对象/缺 id 的条目丢掉，多余的字段丢掉', () => {
  // 手工编辑过的文件、或将来版本多写的键，都不该让读侧多出无法定位的幽灵卡。
  const bookId = 'bk_validate';
  seed(bookId, [
    card({ id: 'bk_ok', word: '好卡' }),
    null,
    '不是对象',
    42,
    card({ id: '' }), // 空 id 同样定位不到，按「缺 id」处理
    { ...card({ id: 'bk_extra' }), extraKey: '多余的' },
    { ...card({ id: 'bk_partial' }), word: 42, createdAt: 'yesterday' },
    { ...card({ id: 'bk_bad_analysis' }), analyses: [{ word: 'x', text: 5 }] },
    {
      ...card({ id: 'bk_analysis' }),
      analyses: [
        { word: '猫', text: '解释', profileName: 'p', model: 'm', createdAt: 9, extra: 1 },
      ],
    },
  ]);

  const listed = listCards(bookId);
  assert.deepEqual(
    listed.map((item) => item.id).sort(),
    ['bk_analysis', 'bk_bad_analysis', 'bk_extra', 'bk_ok', 'bk_partial'],
    '只留下有 id 的对象条目',
  );

  const extra = listed.find((item) => item.id === 'bk_extra');
  assert.ok(extra !== undefined && !('extraKey' in extra), '未知键应在重建对象时被丢掉');

  const partial = listed.find((item) => item.id === 'bk_partial');
  assert.equal(partial?.word, '', '类型不对的字段退回默认值而不是丢掉整条');
  assert.equal(partial?.createdAt, 0);

  const badAnalysis = listed.find((item) => item.id === 'bk_bad_analysis');
  assert.deepEqual(badAnalysis?.analyses, [], '没有正文的分析结果等于没有');

  const analysis = listed.find((item) => item.id === 'bk_analysis');
  assert.deepEqual(analysis?.analyses, [
    { word: '猫', text: '解释', profileName: 'p', model: 'm', createdAt: 9 },
  ]);
  assert.ok(
    analysis?.analyses[0] !== undefined && !('extra' in analysis.analyses[0]),
    '嵌套对象的未知键也要丢',
  );
});
