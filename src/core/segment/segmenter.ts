/**
 * 分词 core —— 把「文本单元」变成可落盘的 `SegmentUnit[]` + 词表。
 *
 * **纯函数**：不 import Node/Electron、不碰磁盘、不碰词典实例。真正切词的那一步由
 * 调用方注入（主进程注入 `DictionaryStore.segment`，测试里注入假实现），于是：
 * - core 层可以脱离 Electron 单测；
 * - 「谁是文本单元」「什么是词典命中」这些策略留在 main 层，core 只负责**归一化**：
 *   夹紧偏移、处理空文本、汇总词表。
 *
 * 切词本身**不在这里重新实现**：`core/dict/lookup.ts` 的 `segment()` 已经做了
 * 词典驱动的贪心最长匹配，重写一遍只会得到两份会各自漂移的行为。
 */

import type { SegmentRecord, SegmentUnit, SegmentVocabularyEntry } from '../../shared/types';
import { buildVocabulary } from './vocabulary';

/** 一个待切分的文本单元（还没有 tokens）。 */
export interface SegmentTextUnit {
  /** 稳定引用：漫画 `page:<url>#<i>`，小说 `chapter:<i>:<href>`。 */
  ref: string;
  /** 该单元的原文；token 偏移一律相对它。 */
  text: string;
  /** UI 显示的上下文标签（页名/章节标题）。 */
  label: string;
}

export interface SegmenterDeps {
  /** 把一段文本切词。偏移必须相对传入的 text。 */
  segmentText: (text: string) => SegmentRecord[];
  /** 词典指纹与部数，写进产物（换词典后旧分词应被判定为过期）。 */
  dictionary: { count: number; signature: string };
  /** 生成器标识，如 'dictionary-longest-match'。 */
  engine: string;
}

export interface SegmentUnitsResult {
  units: SegmentUnit[];
  vocabulary: SegmentVocabularyEntry[];
  /** 一共切出多少个词（含重复、含未命中占位）。 */
  tokenCount: number;
}

/** 漫画一个文字块的单元引用。页 url 用原文（相对书目录、正斜杠），不做转义。 */
export function refForComicBlock(pageUrl: string, blockIndex: number): string {
  return `page:${pageUrl}#${blockIndex}`;
}

/** 小说一章的单元引用。spine 序号是 0 基。 */
export function refForChapter(spineIndex: number, href: string): string {
  return `chapter:${spineIndex}:${href}`;
}

/**
 * 切分一批单元。
 *
 * 三条不能变的性质（测试逐条钉住）：
 * 1. **空文本的单元照样保留**，只是 `tokens: []`——UI 要显示「这一页没有文字」，
 *    悄悄丢掉这一页会让页序与原文对不上。
 * 2. token 的 `[start, end)` 必须能把单元原文切回 `surface`（只要注入的切词器守约定）。
 * 3. 绝不因为脏数据抛异常：越界偏移夹紧、反了的区间归一、夹紧后成空区间的 token 丢弃。
 *
 * `deps.dictionary` / `deps.engine` 在这里不参与计算，它们是**依赖的描述**，
 * 真正写进产物戳的是 main 层的 service——那里才知道产物属于哪本书。
 */
export function segmentUnits(
  units: readonly SegmentTextUnit[],
  deps: SegmenterDeps,
): SegmentUnitsResult {
  const out: SegmentUnit[] = [];
  let tokenCount = 0;

  for (const unit of units) {
    const text = typeof unit.text === 'string' ? unit.text : '';
    // 空白文本不值得问词典：既省一次扫描，也保证「没文字」永远得到空 token 列表。
    const tokens = text.trim().length === 0 ? [] : sanitizeTokens(text, callSegmentText(text, deps));
    tokenCount += tokens.length;
    out.push({ ref: unit.ref, text, tokens, label: unit.label });
  }

  return { units: out, vocabulary: buildVocabulary(out), tokenCount };
}

/**
 * 调用注入的切词器。`Array.isArray` 兜底：注入方返回 undefined（词典服务崩了之后
 * 被 try/catch 吞掉之类）时，宁可当「这个词没切出来」也不能把整本书的生成打断。
 */
function callSegmentText(text: string, deps: SegmenterDeps): readonly SegmentRecord[] {
  const raw = deps.segmentText(text);
  return Array.isArray(raw) ? raw : [];
}

/**
 * 夹紧偏移。
 *
 * 注意这里**信任 token 自己的 `surface`**，不用 `text.slice(start, end)` 覆盖它：
 * `surface` 是切词器算出来的「用户点到的东西」，而偏移只是它的定位信息；两者不一致
 * 说明上游有 bug，此时以 surface 为准能保住词表语义，以切片的半个字为准只会得到乱码。
 */
function sanitizeTokens(text: string, tokens: readonly SegmentRecord[]): SegmentRecord[] {
  const length = text.length;
  const out: SegmentRecord[] = [];

  for (const token of tokens) {
    if (!token || typeof token.surface !== 'string') continue;
    const first = clampOffset(token.start, length);
    const second = clampOffset(token.end, length);
    // 反了的区间（某些右到左的文本层会写反）归一化，而不是当成错误丢掉。
    const start = Math.min(first, second);
    const end = Math.max(first, second);
    // 夹紧后成空区间：这个 token 已经不指向任何文本，留着只会让 UI 画出一个空框。
    if (start >= end) continue;
    out.push({
      surface: token.surface,
      baseForm: typeof token.baseForm === 'string' ? token.baseForm : null,
      start,
      end,
      matched: token.matched === true,
    });
  }

  return out;
}

/** 偏移 → `[0, length]` 内的整数。NaN/Infinity 当 0（它们来自坏 JSON，不是有效位置）。 */
function clampOffset(value: number, length: number): number {
  if (!Number.isFinite(value)) return 0;
  const truncated = Math.trunc(value);
  if (truncated < 0) return 0;
  if (truncated > length) return length;
  return truncated;
}
