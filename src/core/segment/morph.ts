/** 将形态分析结果映射回原文 UTF-16 区间，词典仅负责“是否收录”标记。 */
import type { SegmentRecord } from '../../shared/types';
import type { MorphToken } from '../study/candidates';

export function morphologyToRecords(
  text: string,
  tokens: readonly MorphToken[],
  hasExpression: (expression: string) => boolean,
): SegmentRecord[] {
  const result: SegmentRecord[] = [];
  let cursor = 0;
  for (const token of tokens) {
    const surface = token.surface;
    if (!surface) continue;
    const start = text.indexOf(surface, cursor);
    if (start < 0) continue;
    const end = start + surface.length;
    cursor = end;
    if (token.pos === '記号' || /^\s+$/u.test(surface)) continue;
    const baseForm = token.lemma && token.lemma !== '*' ? token.lemma : surface;
    result.push({
      surface,
      baseForm,
      start,
      end,
      matched: hasExpression(baseForm),
      partOfSpeech: token.pos,
    });
  }
  return result;
}
