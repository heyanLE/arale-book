/** 不依赖用户 Python 的 Anki .apkg 导出；SQLite 由平台端口提供。 */
import { createHash } from '../util/hash';
import { strToU8, zipSync } from 'fflate';
import type { StudyCandidate, StudyCardDraft, StudyCardTier } from '../../shared/types';
import { chosenOccurrence } from './harness';

export interface CardInput {
  candidate: StudyCandidate;
  draft: StudyCardDraft;
  imageName?: string;
  image?: Uint8Array;
}

const FIELDS = ['Key', 'Expression', 'Reading', 'Meaning', 'Sentence', 'SentenceTranslation',
  'Usage', 'Nuance', 'Image', 'Source', 'Provenance'];
const CSS = '.card{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;text-align:left;line-height:1.65;max-width:720px;margin:auto;padding:18px}.word{font-size:34px;font-weight:700}.sentence{font-size:21px;margin:16px 0}.answer{font-size:22px}.muted{color:#667;font-size:14px}.image img{max-width:100%;max-height:440px}mark{background:#dfead4}';
const QFMT = '<div class="word">{{Expression}}</div><div class="sentence">{{Sentence}}</div>';
const AFMT = '{{FrontSide}}<hr id="answer"><div class="answer">{{Reading}} · {{Meaning}}</div><div>{{SentenceTranslation}}</div>{{#Usage}}<p>用法：{{Usage}}</p>{{/Usage}}{{#Nuance}}<p>语气：{{Nuance}}</p>{{/Nuance}}<div class="image">{{Image}}</div><p class="muted">{{Source}}</p><p class="muted">{{Provenance}}</p>';

/** genanki 兼容的旧版 collection.anki2 结构；参考 genanki（MIT）源码。 */
const SCHEMA = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn); CREATE INDEX ix_cards_usn on cards (usn); CREATE INDEX ix_revlog_cid on revlog (cid); CREATE INDEX ix_cards_nid on cards (nid); CREATE INDEX ix_cards_sched on cards (did, queue, due); CREATE INDEX ix_notes_csum on notes (csum);
`;

function stableNumber(value: string): number {
  return 1_000_000_000 + parseInt(createHash('sha256').update(value).digest('hex').slice(0, 8), 16);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function model(modelId: number, deckId: number, nowSec: number, extended = false): Record<string, unknown> {
  return {
    id: modelId, name: `ARaLeBook 漫画词语 v${extended ? 2 : 1}`, type: 0, mod: nowSec, usn: -1,
    sortf: 1, did: deckId, latexPre: '', latexPost: '', latexsvg: false, vers: [], css: CSS, tags: [],
    flds: (extended ? [...FIELDS, 'Lemma'] : FIELDS).map((name, ord) => ({ name, ord, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] })),
    tmpls: [{ name: '词语理解', ord: 0, qfmt: QFMT, afmt: extended
      ? AFMT.replace('{{Reading}} · {{Meaning}}', '{{#Reading}}读音（辞书形）：{{Reading}}{{/Reading}}{{#Meaning}}<div>{{Meaning}}</div>{{/Meaning}}') + '{{#Lemma}}<p>辞书形：{{Lemma}}</p>{{/Lemma}}'
      : AFMT, bqfmt: '', bafmt: '', bfont: '', bsize: 0, did: null }],
    req: [[0, 'all', [1]]],
  };
}

function deck(id: number, name: string, nowSec: number): Record<string, unknown> {
  return {
    id, name, mod: nowSec, usn: -1, desc: '', dyn: 0, conf: 1, collapsed: false,
    extendNew: 0, extendRev: 50, lrnToday: [0, 0], newToday: [0, 0], revToday: [0, 0], timeToday: [0, 0],
  };
}

function collectionConfig(deckId: number, modelId: number): Record<string, unknown> {
  return {
    activeDecks: [deckId], addToCur: true, collapseTime: 1200, curDeck: deckId,
    curModel: String(modelId), dueCounts: true, estTimes: true, newBury: true,
    newSpread: 0, nextPos: 1, sortBackwards: false, sortType: 'noteFld', timeLim: 0,
  };
}

const DEFAULT_DCONF = {
  1: { id: 1, name: 'Default', mod: 0, usn: 0, autoplay: true, replayq: true, maxTaken: 60, timer: 0,
    new: { delays: [1, 10], ints: [1, 4, 7], initialFactor: 2500, perDay: 20, order: 1, bury: true, separate: true },
    lapse: { delays: [10], mult: 0, minInt: 1, leechFails: 8, leechAction: 0 },
    rev: { perDay: 100, ease4: 1.3, fuzz: 0.05, ivlFct: 1, maxIvl: 36500, minSpace: 1, bury: true } },
};

function noteFields(input: CardInput, bookTitle: string, tier: StudyCardTier, extended = false): string[] {
  const { candidate, draft, imageName } = input;
  const occurrence = candidate.occurrences.find((one) => one.id === draft.contextRef) ?? chosenOccurrence(candidate);
  if (!occurrence) throw new Error(`「${candidate.expression}」缺少漫画出处`);
  if (occurrence.text.slice(occurrence.start, occurrence.end).length === 0) throw new Error('词语出处偏移为空');
  const target = draft.expression ?? candidate.expression;
  const rawSentence = draft.sentence ?? occurrence.text;
  const originalSentence = draft.sentence === undefined || draft.sentence === occurrence.text;
  const start = originalSentence ? occurrence.start : rawSentence.indexOf(target);
  const end = originalSentence ? occurrence.end : start + target.length;
  const sentence = start < 0 ? escapeHtml(rawSentence)
    : escapeHtml(rawSentence.slice(0, start)) + '<mark>' + escapeHtml(rawSentence.slice(start, end)) + '</mark>' + escapeHtml(rawSentence.slice(end));
  const selected = (field: import('../../shared/types').StudyCardField): boolean => !draft.fields || draft.fields.includes(field);
  return [
    `aralebook:${candidate.id}`, escapeHtml(target), selected('reading') ? escapeHtml(draft.reading ?? candidate.reading) : '',
    selected('meaning') ? escapeHtml(draft.meaning) : '', selected('sentence') ? sentence : '', selected('sentenceTranslation') ? escapeHtml(draft.sentenceTranslation) : '',
    escapeHtml(draft.usage), escapeHtml(draft.nuance), imageName ? `<img src="${imageName}">` : '',
    escapeHtml(draft.sourceLabel ?? `${bookTitle} · ${occurrence.label}`),
    escapeHtml(`${tier} 自动生成；JLPT 为非官方参考等级；译文和 OCR 未经人工校对。`),
    ...(extended ? [selected('lemma') ? escapeHtml(draft.lemma ?? candidate.expression) : ''] : []),
  ];
}

/** 返回完整 .apkg 字节；调用方负责原子落盘和导出状态。 */
export async function buildAnkiPackage(bookId: string, bookTitle: string, tier: StudyCardTier, inputs: readonly CardInput[], initialize: SqlFactory): Promise<Uint8Array> {
  if (inputs.length === 0) throw new Error('没有可导出的词卡');
  const SQL = await initialize();
  const db = new SQL.Database();
  try {
    db.run(SCHEMA);
    const deckId = stableNumber(`aralebook-deck:${bookId}`);
    const extended = inputs.some(input => !!input.draft.fields);
    const modelId = stableNumber(`aralebook-note-model:v${extended ? 2 : 1}`);
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);
    const deckName = `漫画日语::${bookTitle}`;
    db.run('INSERT INTO col VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [
      1, nowSec, now, now, 11, 0, 0, 0,
      JSON.stringify(collectionConfig(deckId, modelId)),
      JSON.stringify({ [modelId]: model(modelId, deckId, nowSec, extended) }),
      JSON.stringify({ 1: deck(1, 'Default', nowSec), [deckId]: deck(deckId, deckName, nowSec) }),
      JSON.stringify(DEFAULT_DCONF), '{}',
    ]);
    const media: Record<string, string> = {};
    const archive: Record<string, Uint8Array> = {};
    const seenImages = new Set<string>();
    const seenIds = new Set<string>();
    inputs.forEach((input, index) => {
      if (seenIds.has(input.candidate.id)) throw new Error('重复的词卡候选 ID');
      seenIds.add(input.candidate.id);
      const fields = noteFields(input, bookTitle, tier, extended);
      const guid = createHash('sha256').update(`aralebook-note:${bookId}:${input.candidate.id}`).digest('base64url').slice(0, 12);
      const noteId = now + index * 2 + 1;
      const tags = ` aralebook book_${bookId} ${input.candidate.jlpt ? `jlpt_n${input.candidate.jlpt}` : 'jlpt_unknown'} ${tier.toLowerCase()} `;
      const csum = parseInt(createHash('sha1').update(fields[0] ?? '').digest('hex').slice(0, 8), 16);
      db.run('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)', [noteId, guid, modelId, nowSec, -1, tags,
        fields.join('\x1f'), fields[1] ?? '', csum, 0, '']);
      db.run('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
        noteId + 1, noteId, deckId, 0, nowSec, -1, 0, 0, index + 1, 0, 0, 0, 0, 0, 0, 0, 0, '',
      ]);
      if (input.imageName && input.image && !seenImages.has(input.imageName)) {
        const id = Object.keys(media).length.toString();
        media[id] = input.imageName;
        archive[id] = input.image;
        seenImages.add(input.imageName);
      }
    });
    const integrity = (await db.exec('PRAGMA integrity_check'))[0]?.values[0]?.[0];
    if (integrity !== 'ok') throw new Error(`Anki SQLite 校验失败：${String(integrity)}`);
    archive['collection.anki2'] = await db.export();
    archive['media'] = strToU8(JSON.stringify(media));
    return zipSync(archive, { level: 6 });
  } finally { db.close(); }
}

export interface AnkiDatabase {
 run(sql:string,params?:Array<string|number|null>):unknown;
 exec(sql:string):Array<{values:unknown[][]}>|Promise<Array<{values:unknown[][]}>>;
 export():Uint8Array|Promise<Uint8Array>;
 close():void;
}
export type SqlFactory=()=>Promise<{Database:new()=>AnkiDatabase}>;
