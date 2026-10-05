import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictionaryEvidence, normalizeCardFields, needsLlm, needsTranslation, parsePipelineCards, pipelinePrompt, readyDraft, shouldGenerate, type PipelineInput } from '../src/core/study/pipeline';
import { romajiToKana, translatedWordReading } from '../src/core/study/reading';
import type { StudyCandidate, StudyCardField } from '../src/shared/types';

function input(fields: StudyCardField[] = ['meaning', 'sentenceTranslation']): PipelineInput {
  const candidate: StudyCandidate = { id: '食べる', expression: '食べる', reading: 'たべる', partOfSpeech: '動詞', jlpt: 5, jlptConflict: false,
    count: 1, selected: true, excluded: false, meaning: '', contextRef: 'one', exportedAt: null,
    occurrences: [{ id: 'one', ref: 'page:p#0', text: 'パンを食べました。', label: '', start: 3, end: 8 }] };
  return { candidate, occurrence: candidate.occurrences[0]!, evidence: [], fields, tier: 'A3', sentenceTranslation: '吃了面包。',
    context: { previous: 'お腹が空いた。', next: 'おいしかった。', order: 'same block' } };
}
test('字段验证、无本词含义时高档位不空跑 LLM', () => {
  assert.throws(() => normalizeCardFields([], 'A3'), /至少/);
  assert.throws(() => normalizeCardFields(['invalid' as StudyCardField], 'A3'), /有效/);
  assert.deepEqual(normalizeCardFields(['lemma', 'lemma'], 'A4'), ['lemma']);
  assert.equal(needsLlm('A4', ['sentence', 'lemma']), false);
  assert.equal(needsTranslation('A4', ['sentence', 'lemma']), false);
  assert.equal(shouldGenerate(input(['lemma']), 'A4'), false);
});
test('A2 只补缺词，A3 判断多义/未知结构，A4 全量', () => {
  const one = input();
  assert.equal(shouldGenerate(one, 'A2'), true);
  one.evidence = [{ id: 'e', dictionary: 'dict', expression: '食べる', reading: 'たべる', text: '吃', ambiguous: false, truncated: false }];
  assert.equal(shouldGenerate(one, 'A2'), false); assert.equal(shouldGenerate(one, 'A3'), false);
  one.evidence[0]!.ambiguous = true;
  assert.equal(shouldGenerate(one, 'A2'), false); assert.equal(shouldGenerate(one, 'A3'), true);
  one.evidence[0]!.ambiguous = false;
  assert.equal(shouldGenerate(one, 'A4'), true);
});
test('单个编号义项不因为有圈号就错误进入 A3 模型分支', () => {
  const one = input();
  one.evidence = dictionaryEvidence([{ expression: '食べる', reading: 'たべる', glossary: ['① 吃'], dictionaryId: 'dict', dictionaryTitle: 'dict', sequence: 1, rules: [], score: 0, termTags: [], definitionTags: [] }], one.candidate);
  assert.equal(one.evidence[0]?.ambiguous, false); assert.equal(shouldGenerate(one, 'A3'), false);
});
test('LLM 输入包含词形、译文、邻句、字段，允许无词典补义并复用句译', () => {
  const one = input();
  const prompt = pipelinePrompt([one], 'A3'); const payload = JSON.parse(prompt.user).items[0];
  assert.equal(payload.word, '食べる'); assert.equal(payload.surface, '食べました');
  assert.equal(payload.sentenceTranslation, '吃了面包。'); assert.equal(payload.context.previous, 'お腹が空いた。');
  assert.deepEqual(payload.dictionary, []); assert.deepEqual(payload.requestedFields, one.fields);
  const draft = parsePipelineCards(JSON.stringify({ items: [{ id: '食べる', meaning: '吃', sentenceTranslation: '', usage: '', nuance: '', evidenceIds: [], issues: [] }] }), [one])[0]!;
  assert.equal(draft.sentenceTranslation, '吃了面包。'); assert.equal(draft.needsReview, false);
});
test('明确修正的整句翻译不会被参考译文覆盖', () => {
  const one = input();
  const draft = parsePipelineCards(JSON.stringify({ items: [{ id: '食べる', meaning: '吃', sentenceTranslation: '我吃了面包。', usage: '', nuance: '', evidenceIds: [], issues: [] }] }), [one])[0]!;
  assert.equal(draft.sentenceTranslation, '我吃了面包。');
});
test('未勾选读音/释义/句译不阻止只含原句及辞书形的卡', () => {
  const draft = { candidateId: 'x', fields: ['sentence', 'lemma'] as StudyCardField[], sentence: '原句', lemma: '辞书形', meaning: '', sentenceTranslation: '', usage: '', nuance: '', needsReview: false, reviewReason: '', status: 'ready' as const };
  assert.equal(readyDraft(draft, 'A4'), true);
  assert.equal(readyDraft({ ...draft, lemma: '' }, 'A4'), false);
});
test('罗马音算法覆盖促音/拗音/ん，无法唯一还原的读音不自动填入', () => {
  assert.equal(romajiToKana('Neko'), 'ねこ'); assert.equal(romajiToKana('gakkou'), 'がっこう');
  assert.equal(romajiToKana('konnichiwa'), 'こんにちわ'); assert.equal(romajiToKana('matcha'), 'まっちゃ');
  assert.equal(romajiToKana("kin'en"), 'きんえん'); assert.equal(romajiToKana('shashin'), 'しゃしん');
  assert.equal(romajiToKana('Tōkyō'), null); assert.equal(romajiToKana('not japanese!'), null);
  assert.equal(translatedWordReading('猫', '猫', '猫', 'neko'), 'ねこ');
  assert.equal(translatedWordReading('猫', '猫', '猫が好き。', 'neko ga suki'), null);
  assert.equal(translatedWordReading('食べる', '食べた', '食べた', 'tabeta'), null);
  assert.equal(translatedWordReading('学校', '学校', '学校', 'gakkō'), null);
});
