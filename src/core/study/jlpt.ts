import type { JlptLevel } from '../../shared/types';

export type JlptRow = [expression: string, reading: string, level: number];
export interface JlptMatch { level: JlptLevel; conflict: boolean; reading: string }
export interface JlptIndex {
  exact: Map<string, JlptMatch>;
  byExpression: Map<string, JlptMatch | null>;
}

/** Kuromoji 的片假名读音与词表中的平假名读音统一。 */
export function normalizeReading(value: string): string {
  return value.trim().normalize('NFKC').replace(/[\u30a1-\u30f6]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0x60),
  );
}

export function studyKey(expression: string, reading: string): string {
  return `${expression.trim().normalize('NFKC')}\u0000${normalizeReading(reading)}`;
}

/** 重复级别保留冲突标志；展示最容易的记录，避免低估学习难度。 */
export function createJlptIndex(rows: readonly JlptRow[]): JlptIndex {
  const index: JlptIndex = { exact: new Map(), byExpression: new Map() };
  for (const [expression, reading, rawLevel] of rows) {
    if (!expression || !reading || !Number.isInteger(rawLevel) || rawLevel < 1 || rawLevel > 5) continue;
    const level = rawLevel as Exclude<JlptLevel, null>;
    const key = studyKey(expression, reading);
    const previous = index.exact.get(key);
    const normalizedReading = normalizeReading(reading);
    index.exact.set(key, {
      level: previous?.level === null || previous === undefined ? level : Math.max(previous.level, level) as Exclude<JlptLevel, null>,
      conflict: previous !== undefined && (previous.conflict || previous.level !== level),
      reading: normalizedReading,
    });
    const expressionKey = expression.trim().normalize('NFKC');
    if (!index.byExpression.has(expressionKey)) index.byExpression.set(expressionKey, { level, conflict: false, reading: normalizedReading });
    else {
      const old = index.byExpression.get(expressionKey);
      if (old && old.reading !== normalizedReading) index.byExpression.set(expressionKey, null);
      else if (old) index.byExpression.set(expressionKey, {
        level: Math.max(old.level ?? level, level) as Exclude<JlptLevel, null>,
        conflict: old.conflict || old.level !== level,
        reading: normalizedReading,
      });
    }
  }
  return index;
}

export function lookupJlpt(index: JlptIndex, expression: string, reading: string): JlptMatch {
  return index.exact.get(studyKey(expression, reading))
    ?? index.byExpression.get(expression.trim().normalize('NFKC'))
    ?? { level: null, conflict: false, reading: '' };
}
