/** 保守罗马音转假名：无法还原的长音/符号返回 null，不猜拼写。 */
const rows = [
  ['a i u e o', 'あ い う え お'], ['ka ki ku ke ko', 'か き く け こ'],
  ['sa shi su se so', 'さ し す せ そ'], ['ta chi tsu te to', 'た ち つ て と'],
  ['na ni nu ne no', 'な に ぬ ね の'], ['ha hi fu he ho', 'は ひ ふ へ ほ'],
  ['ma mi mu me mo', 'ま み む め も'], ['ya yu yo', 'や ゆ よ'],
  ['ra ri ru re ro', 'ら り る れ ろ'], ['wa wo', 'わ を'],
  ['ga gi gu ge go', 'が ぎ ぐ げ ご'], ['za ji zu ze zo', 'ざ じ ず ぜ ぞ'],
  ['da de do', 'だ で ど'], ['ba bi bu be bo', 'ば び ぶ べ ぼ'], ['pa pi pu pe po', 'ぱ ぴ ぷ ぺ ぽ'],
  ['si ti tu hu', 'し ち つ ふ'], ['sha shu sho cha chu cho ja ju jo', 'しゃ しゅ しょ ちゃ ちゅ ちょ じゃ じゅ じょ'],
];
const syllables = new Map<string, string>();
for (const [latin, kana] of rows) latin!.split(' ').forEach((s, i) => syllables.set(s, kana!.split(' ')[i]!));
for (const [latin, kana] of [['k', 'き'], ['g', 'ぎ'], ['n', 'に'], ['h', 'ひ'], ['b', 'び'], ['p', 'ぴ'], ['m', 'み'], ['r', 'り']]) {
  for (const [vowel, small] of [['a', 'ゃ'], ['u', 'ゅ'], ['o', 'ょ']]) syllables.set(`${latin}y${vowel}`, kana! + small!);
}
export function romajiToKana(raw: string): string | null {
  const text = raw.normalize('NFKC').toLowerCase().replace(/’/g, "'").trim();
  if (!text || !/^[a-z']+$/.test(text)) return null;
  let result = '';
  for (let cursor = 0; cursor < text.length;) {
    const char = text[cursor]!;
    if (char === 'n' && text[cursor + 1] === 'n') { result += 'ん'; cursor += cursor + 2 === text.length ? 2 : 1; continue; }
    if (text.slice(cursor, cursor + 3) === 'tch') { result += 'っ'; cursor++; continue; }
    if (char === 'n' && (cursor === text.length - 1 || text[cursor + 1] === "'" || !/[aeiouyn]/.test(text[cursor + 1]!))) {
      result += 'ん'; cursor += text[cursor + 1] === "'" ? 2 : 1; continue;
    }
    if (char === text[cursor + 1] && /[bcdfghjkpqrstvwxyz]/.test(char)) { result += 'っ'; cursor++; continue; }
    let matched = false;
    for (const size of [3, 2, 1]) {
      const kana = syllables.get(text.slice(cursor, cursor + size));
      if (kana) { result += kana; cursor += size; matched = true; break; }
    }
    if (!matched) return null;
  }
  return result;
}
/** 仅接受目标本身的读音；不从整句罗马音猜单词位置或活用还原。 */
export function translatedWordReading(expression: string, surface: string, sentence: string, romaji: string): string | null {
  if (surface !== expression || sentence.replace(/[\s。！？!?「」『』]/gu, '') !== expression) return null;
  const kana = romajiToKana(romaji);
  // 无法从发音区分长音拼写、ぢ/じ、づ/ず；不自动采用这些候选。
  return kana && !/[じず]|お[おう]|え[えい]|ああ|いい|うう|[あいうえお]ー/.test(kana) ? kana : null;
}
