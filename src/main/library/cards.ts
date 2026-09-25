/**
 * 词卡存储（主进程侧）。
 *
 * 一件事：把用户在阅读器里存下来的查询落成**每本书一份** `<bookDir>/cards.json`。
 * 形状对着 `main/segment/service.ts` 的产物，但有一个本质区别：
 * - 分词产物是**可再生的**，坏了重跑一次就好，所以那边坏了就当没有；
 * - 词卡是**用户自己造的、丢了就没了的数据**，所以读侧仍然「坏文件当空」，但解析失败
 *   时走 `readJson` 的「另存为 `.corrupt-<ts>`」——不能把用户的东西静默抹掉。
 *
 * 另外两条贯穿始终的约定：
 * - **不进 `content/`**：那是 `arale://` 唯一可读根。词卡是主进程/渲染进程通过 IPC 拿的
 *   派生数据，放进去就等于给阅读器开了一个不该有的读写面。这里和 `original.*`、
 *   `segments.json` 平级。
 * - **读永不抛**：文件缺失、半截 JSON、手工编辑成乱七八糟的形状，统统退化成「还没有词卡」。
 *   为一份列表把 IPC handler 打崩，用户看到的是整页报错，而正确语义只是「空的」。
 *   写侧则相反——真实 I/O 失败（磁盘满/无权限）必须抛出去：返回一张其实没落盘的卡，
 *   等于把用户的词卡静默吃掉。
 */

import * as path from 'node:path';

import type { WordCard, WordCardAnalysis, WordCardDraft } from '../../shared/types';
import { readJson, writeJsonAtomic } from '../../core/util/atomic-json';
import { makeBookId } from '../../core/util/id';
import { bookDir } from '../paths';

/** 产物文件名。派生数据，和 `content/` 平级。 */
export const CARDS_FILE = 'cards.json';

/** 落盘格式版本。现在没有迁移逻辑，写它是为了将来能一眼分辨「旧文件」。 */
const CARDS_VERSION = 1;

interface CardsFile {
  version: number;
  cards: WordCard[];
}

/** 两个字段都空时的兜底标签：列表里一张没标题的卡是认不出来的。 */
const UNNAMED_WORD = '（未命名）';

export function cardsFileFor(bookId: string): string {
  return path.join(bookDir(bookId), CARDS_FILE);
}

/** 读一本书的全部词卡，最新的在前。读不到/坏文件 → 空数组（永不抛）。 */
export function listCards(bookId: string): WordCard[] {
  return readAll(bookId);
}

/** 新增一张。返回写入后的卡（含主进程补的 id 与时间戳）。 */
export function addCard(bookId: string, draft: WordCardDraft): WordCard {
  const cards = readAll(bookId);
  const now = Date.now();
  const word = resolveWord(draft.word, draft.dictionaryExpression);

  // 去重：同 `word` + 同 `dictionaryExpression` 视为同一张。用户手滑点两次「保存」
  // 很常见，两行一模一样的卡比一行被刷新更糟；但只刷新 context/offset/length，
  // 用户写过的 note/analysis 以及 createdAt 一个字都不动。
  const existingIndex = cards.findIndex(
    (item) => item.word === word && item.dictionaryExpression === draft.dictionaryExpression,
  );
  const existing = existingIndex >= 0 ? cards[existingIndex] : undefined;
  if (existing !== undefined) {
    const refreshed: WordCard = {
      ...existing,
      context: asString(draft.context),
      offset: asNumber(draft.offset),
      length: asNumber(draft.length),
      updatedAt: now,
    };
    cards[existingIndex] = refreshed;
    writeCards(bookId, cards);
    return clone(refreshed);
  }

  const card: WordCard = {
    // 复用 `makeBookId()` 而不是 `crypto.randomUUID()`：同一个仓库里已经有这个生成器，
    // 小写 base36、定长、没有连字符，排序/日志里都好看。函数名里的 `book` 只是历史
    // 前缀（`bk_`），卡 id 存在每本书自己的文件里，和书 id 不在同一个命名空间，不会撞。
    id: makeBookId(),
    word,
    context: asString(draft.context),
    offset: asNumber(draft.offset),
    length: asNumber(draft.length),
    dictionaryExpression: asString(draft.dictionaryExpression),
    dictionaryId: asString(draft.dictionaryId),
    dictionaryTitle: asString(draft.dictionaryTitle),
    dictionaryReading: asString(draft.dictionaryReading),
    note: '',
    analyses: [],
    createdAt: now,
    updatedAt: now,
  };
  cards.push(card);
  writeCards(bookId, cards);
  return clone(card);
}

/** 改一张（只允许改 word / note / analyses）。不存在 → null。 */
export function updateCard(
  bookId: string,
  id: string,
  patch: Partial<Pick<WordCard, 'word' | 'note' | 'analyses'>>,
): WordCard | null {
  const cards = readAll(bookId);
  const index = cards.findIndex((item) => item.id === id);
  const current = index >= 0 ? cards[index] : undefined;
  if (current === undefined) return null;

  // 白名单式合并：下面只读 patch 的三个键，从不 `...patch`。所以即使调用方（或渲染
  // 进程）塞进 id/createdAt/context，也进不来——否则 UI 一次手滑就能造出两张同 id 的卡，
  // 或把卡的创建时间改成任意值。
  const next: WordCard = { ...clone(current) };
  const nextWord = patch.word;
  if (typeof nextWord === 'string' && nextWord.trim().length > 0) {
    next.word = nextWord;
  }
  // 空白 word 直接忽略：把它存下去等于把卡变成没标题的，比留着旧词更难用。
  if (typeof patch.note === 'string') next.note = patch.note;
  // 整份替换而不是追加：渲染进程手里就是「这张卡现在该有哪些分析」的完整列表，
  // 追加语义会让「删掉一条子句分析」变成做不到的操作。
  if (Array.isArray(patch.analyses)) next.analyses = normalizeAnalyses(patch.analyses);
  next.updatedAt = Date.now();

  cards[index] = next;
  writeCards(bookId, cards);
  return clone(next);
}

/** 删一张。返回是否真的删掉了。 */
export function removeCard(bookId: string, id: string): boolean {
  const cards = readAll(bookId);
  const remaining = cards.filter((item) => item.id !== id);
  // 没删到就不写盘：空写会白白刷新 mtime，也会把手工制造的问题文件「顺手修好」，
  // 让「删了一张不存在的卡」看起来像成功了。
  if (remaining.length === cards.length) return false;
  writeCards(bookId, remaining);
  return true;
}

/** 这本书有几张卡（状态栏/徽标用，不读整份文件也得读，但语义更清楚）。 */
export function countCards(bookId: string): number {
  return readAll(bookId).length;
}

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------

/**
 * 全量读 + 校验 + 排序。返回的一定是全新对象（见 `normalizeCard`），
 * 所以调用方怎么改返回值都影响不到下一次读。
 */
function readAll(bookId: string): WordCard[] {
  // `readJson` 顺带处理了「文件不存在」和「JSON 坏了」：前者给 fallback，后者把坏文件
  // 另存为 `.corrupt-<ts>` 再给 fallback——用户数据不该被静默抹掉，留个证据。
  const payload = readJson<unknown>(cardsFileFor(bookId), null);
  if (!isRecord(payload)) return [];
  const raw = payload['cards'];
  if (!Array.isArray(raw)) return [];

  const cards: WordCard[] = [];
  for (const entry of raw) {
    const card = normalizeCard(entry);
    if (card !== null) cards.push(card);
  }
  return sortNewestFirst(cards);
}

function writeCards(bookId: string, cards: WordCard[]): void {
  const payload: CardsFile = { version: CARDS_VERSION, cards };
  // 原子写，顺带 `ensureDir`：书目录被手工删过之后，「存词卡」也能自己长回来。
  writeJsonAtomic(cardsFileFor(bookId), payload);
}

/**
 * 最新在前。`createdAt` 相同时按 `id` 倒序：同一毫秒存两张卡太常见了（连点保存、
 * 批量导入），没有稳定的次键，两次读之间顺序就可能不同，UI 列表会自己跳。
 * 这里用 code-unit 比较而不是 `localeCompare`——id 是纯 ASCII base36，
 * code-unit 比较就是字典序，而且不吃 ICU 版本，跨机器结果一致。
 */
function sortNewestFirst(cards: WordCard[]): WordCard[] {
  return cards.sort((a, b) => b.createdAt - a.createdAt || compareIdDesc(a.id, b.id));
}

function compareIdDesc(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? 1 : -1;
}

/**
 * 逐字段校验并**重建**对象：显式列出已知字段，因此文件里多写的键在读侧自动消失。
 * 返回 null 的只有两种情况——不是对象，或没有可用的 `id`。没有 id 的卡无法被
 * update/remove 定位，留着只会在列表里变成删不掉的幽灵。
 */
function normalizeCard(raw: unknown): WordCard | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw['id']);
  if (id.length === 0) return null;

  return {
    id,
    word: asString(raw['word']),
    context: asString(raw['context']),
    offset: asNumber(raw['offset']),
    length: asNumber(raw['length']),
    dictionaryExpression: asString(raw['dictionaryExpression']),
    dictionaryId: asString(raw['dictionaryId']),
    dictionaryTitle: asString(raw['dictionaryTitle']),
    dictionaryReading: asString(raw['dictionaryReading']),
    note: asString(raw['note']),
    analyses: normalizeAnalyses(raw['analyses'], raw['analysis']),
    createdAt: asNumber(raw['createdAt']),
    updatedAt: asNumber(raw['updatedAt']),
  };
}

/**
 * 把存盘的分析列表读成数组。
 *
 * `legacy` 是旧格式的单条 `analysis` 字段：早期版本一张卡只存一条，字段名是 `analysis`。
 * 读的时候顺手迁移成单元素数组，**而不是让旧卡的分析凭空消失**——用户看不到自己
 * 之前跑过的结果，只会以为功能坏了。
 */
function normalizeAnalyses(raw: unknown, legacy?: unknown): WordCardAnalysis[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: WordCardAnalysis[] = [];
  for (const item of list) {
    const analysis = normalizeAnalysis(item);
    // 同一个词只留一条（后出现的覆盖先出现的）：界面上一个词一栏，
    // 两条同词会让「删除」变得含义不明。
    if (analysis === null) continue;
    const existing = out.findIndex((entry) => entry.word === analysis.word);
    if (existing >= 0) out[existing] = analysis;
    else out.push(analysis);
  }
  if (out.length === 0 && legacy !== undefined) {
    const migrated = normalizeAnalysis(legacy);
    if (migrated !== null) out.push(migrated);
  }
  // 短的在前：先划 A、再划 AB 时，界面上 A 的结果要排在 AB 上面。
  return out.sort((a, b) => a.word.length - b.word.length || a.word.localeCompare(b.word));
}

/**
 * 一条分析。没有正文的等于没有；`word` 缺了用空串（界面上显示成「整张卡」）——
 * 旧数据里没这个字段，不能因此把整条丢掉。
 */
function normalizeAnalysis(raw: unknown): WordCardAnalysis | null {
  if (!isRecord(raw)) return null;
  const text = asString(raw['text']);
  if (text.length === 0) return null;
  return {
    word: asString(raw['word']),
    text,
    profileName: asString(raw['profileName']),
    model: asString(raw['model']),
    createdAt: asNumber(raw['createdAt']),
  };
}

/**
 * 卡片顶部的词。原样保存调用方给的字符串（**不 trim**：划词时用户框住的空白也是他框的），
 * 只在「是不是空白」这一点上做兜底。空 word 退回词典辞书形，两个都空才用占位符——
 * 列表里一张没标签的卡，用户根本认不出是哪次查询。
 */
function resolveWord(rawWord: unknown, rawExpression: unknown): string {
  const word = asString(rawWord);
  if (word.trim().length > 0) return word;
  const expression = asString(rawExpression);
  if (expression.trim().length > 0) return expression;
  return UNNAMED_WORD;
}

/** 防御性副本：数组是新读出来的，但里层的分析对象也要复制，别让调用方穿透。 */
function clone(card: WordCard): WordCard {
  return { ...card, analyses: card.analyses.map((entry) => ({ ...entry })) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 只收有限数字：`NaN`/`Infinity` 落进 JSON 会变成 `null`，下一读又变 0，来回漂。 */
function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
