import type { ReadingDirection } from './types';

export type ReaderEdge = 'left' | 'right';
export type ReaderTurn = 'back' | 'forward';

/**
 * 把屏幕边缘映射成阅读顺序里的前进/后退。
 *
 * LTR 从左往右推进，所以右边是下一页；RTL（日漫）正好相反。
 */
export function turnForReaderEdge(direction: ReadingDirection, edge: ReaderEdge): ReaderTurn {
  const leftIsForward = direction === 'rtl';
  return (edge === 'left') === leftIsForward ? 'forward' : 'back';
}
