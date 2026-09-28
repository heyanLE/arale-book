import type { SegmentUnit, StudyCandidate, StudyOccurrence } from '../../shared/types';
import { lookupJlpt, normalizeReading, studyKey, type JlptIndex } from './jlpt';

export interface MorphToken {
  surface: string;
  lemma: string;
  reading: string;
  pos: string;
  known: boolean;
}

const CONTENT_POS = new Set(['名詞', '動詞', '形容詞', '副詞', '連体詞', '感動詞']);
const MAX_OCCURRENCES = 5;

/** 形态分析 token 必须能逐字对应 OCR 原文，才能安全回跳和做例句。 */
export function buildStudyCandidates(
  units: readonly SegmentUnit[],
  parsed: readonly (readonly MorphToken[])[],
  jlpt: JlptIndex,
): StudyCandidate[] {
  const byId = new Map<string, StudyCandidate>();
  units.forEach((unit, unitIndex) => {
    let cursor = 0;
    for (const token of parsed[unitIndex] ?? []) {
      if (!token.surface) continue;
      const start = unit.text.indexOf(token.surface, cursor);
      if (start < 0) continue;
      const end = start + token.surface.length;
      cursor = end;
      if (!CONTENT_POS.has(token.pos)) continue;
      const expression = (token.lemma && token.lemma !== '*' ? token.lemma : token.surface).trim();
      const surfaceReading = normalizeReading(token.reading && token.reading !== '*' ? token.reading : '');
      if (!expression || (!token.known && [...expression].length < 2)) continue;
      const match = lookupJlpt(jlpt, expression, surfaceReading);
      const reading = match.reading || (expression === token.surface ? surfaceReading : '');
      const id = studyKey(expression, reading);
      const occurrence: StudyOccurrence = { id: `${unit.ref}@${start}`, ref: unit.ref, label: unit.label, text: unit.text, start, end };
      let candidate = byId.get(id);
      if (!candidate) {
        candidate = {
          id, expression, reading, partOfSpeech: token.pos,
          jlpt: match.level, jlptConflict: match.conflict,
          count: 0, occurrences: [], meaning: '', selected: false,
          excluded: false, contextRef: occurrence.id, exportedAt: null,
        };
        byId.set(id, candidate);
      }
      candidate.count += 1;
      if (candidate.occurrences.length < MAX_OCCURRENCES) candidate.occurrences.push(occurrence);
    }
  });
  return [...byId.values()].sort((a, b) => b.count - a.count || (a.expression < b.expression ? -1 : 1));
}

/** 已选卡片导出为 Anki 可读的 UTF-8 TSV；字段中不允许真实换行或制表符。 */
export function ankiTsv(candidates: readonly StudyCandidate[], bookTitle: string): { text: string; count: number } {
  const rows = ['#separator:tab', '#html:true', '#tags column:3'];
  let count = 0;
  const seenFronts = new Set<string>();
  for (const item of candidates) {
    if (!item.selected || item.excluded) continue;
    const occurrence = item.occurrences.find((one) => one.id === item.contextRef) ?? item.occurrences[0];
    const front = escapeHtml(safeField(`${item.expression}${item.reading ? `（${item.reading}）` : ''}`));
    if (seenFronts.has(front)) continue;
    seenFronts.add(front);
    const back = [item.meaning, occurrence?.text ?? '', `${bookTitle} · ${occurrence?.label ?? ''}`]
      .map((field) => escapeHtml(safeField(field)))
      .filter(Boolean)
      .join('<br>');
    const bookTag = bookTitle.trim().replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40) || 'book';
    const tags = `aralebook book_${bookTag}${item.jlpt ? ` jlpt_n${item.jlpt}` : ''}`;
    rows.push(`${front}\t${back}\t${tags}`);
    count += 1;
  }
  return { text: `${rows.join('\n')}\n`, count };
}

function safeField(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ').trim();
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
