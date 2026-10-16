import type { StudyCandidate, StudyDictionaryEvidence } from '../../shared/types';

/** Katakana is a candidate signal, not proof: names and onomatopoeia may have no foreign origin. */
export function isLoanwordCandidate(item: Pick<StudyCandidate, 'expression' | 'properName'>): boolean {
  return item.properName !== true && /^[\p{Script=Katakana}ー・\s]{2,}$/u.test(item.expression) && /[\p{Script=Katakana}]/u.test(item.expression);
}
const LANGUAGES = [
  ['英语', '英语|英語|英|English'], ['德语', '德语|ドイツ語|独|German'],
  ['法语', '法语|フランス語|仏|French'], ['葡萄牙语', '葡萄牙语|ポルトガル語|葡|Portuguese'],
  ['荷兰语', '荷兰语|オランダ語|蘭|Dutch'], ['意大利语', '意大利语|イタリア語|伊|Italian'],
  ['西班牙语', '西班牙语|スペイン語|西|Spanish'], ['俄语', '俄语|ロシア語|露|Russian'],
] as const;
/** Extract explicit dictionary attribution only; never infer an English source from spelling. */
export function dictionaryEtymology(item: StudyCandidate, evidence: readonly StudyDictionaryEvidence[]): string {
  if (!isLoanwordCandidate(item)) return '';
  for (const row of evidence) for (const [language, names] of LANGUAGES) {
    const source = row.text.replace(/<[^>]+>/g, ' ');
    const prefix = new RegExp(`(?:^|[\\s（(【\\[])(${names})[\\s:：）)】\\]]*([A-Za-zÀ-ž][A-Za-zÀ-ž'’ -]{1,70})`, 'iu').exec(source);
    const suffix = new RegExp(`([A-Za-zÀ-ž][A-Za-zÀ-ž'’ -]{1,70})\\s*[（(](${names})[）)]`, 'iu').exec(source);
    const original = (prefix?.[2] ?? suffix?.[1])?.trim();
    if (original) return `${language} ${original}`;
  }
  return '';
}
