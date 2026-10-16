import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import { buildAnkiPackage } from '../src/core/study/apkg';
import { learningCardText, learningEtymology } from '../src/core/study/card-content';
import { dictionaryEtymology, isLoanwordCandidate } from '../src/core/study/etymology';
import { parsePipelineCards, pipelinePrompt, readyDraft, shouldGenerate, type PipelineInput } from '../src/core/study/pipeline';
import { manualAiDocument, parseManualAiResult } from '../src/core/study/manual-ai';
import type { StudyCandidate, StudyCardDraft, StudyDictionaryEvidence, StudyManualAiSession } from '../src/shared/types';

const candidate: StudyCandidate = { id: 'loan', expression: 'アルバイト', reading: 'あるばいと', partOfSpeech: '名詞', jlpt: 3, jlptConflict: false,
  count: 2, selected: true, excluded: false, meaning: '', exportedAt: null, contextRef: 'source', occurrences: [{ id: 'source', ref: 'page:p.png#0', label: '第 1 页', text: 'アルバイトがあります。', start: 0, end: 5 }] };
const evidence: StudyDictionaryEvidence = { id: 'dict:1', dictionary: '用户词典', expression: 'アルバイト', reading: 'あるばいと', text: '（独 Arbeit）兼职；临时工作', ambiguous: false, truncated: false };
const input: PipelineInput = { candidate, occurrence: candidate.occurrences[0]!, evidence: [evidence], fields: ['meaning', 'sentence', 'etymology'], tier: 'A3' };
const response = (etymology: unknown = '德语 Arbeit（工作），日语中指兼职。') => JSON.stringify({ items: [{ id: candidate.id, meaning: '兼职；仅供参考。', sentenceTranslation: '', etymology, usage: '', nuance: '', evidenceIds: [evidence.id], issues: [] }] });

test('removes workflow caveats while preserving uncertainty as actual vocabulary meaning', () => {
  assert.equal(learningCardText('猫（仅供参考）\n译文和 OCR 未经人工校对。\n请人工核对。'), '猫');
  assert.equal(learningCardText('可能；也许。'), '可能；\n也许。');
  assert.equal(learningCardText('兼职；仅供参考。'), '兼职；');
  assert.equal(learningCardText('相机（词典参考，尚未语境消歧）'), '相机');
  assert.equal(learningEtymology('可能来自英语 camera'), '');
  assert.equal(learningEtymology('英语 camera（相机）'), '英语 camera（相机）');
});
test('loanword origins come from explicit dictionary attributions and unresolved words route to AI', () => {
  assert.equal(isLoanwordCandidate(candidate), true);
  assert.equal(isLoanwordCandidate({ ...candidate, expression: '猫' }), false);
  assert.equal(isLoanwordCandidate({ ...candidate, properName: true }), false);
  assert.equal(dictionaryEtymology(candidate, [evidence]), '德语 Arbeit');
  assert.equal(dictionaryEtymology(candidate, [{ ...evidence, text: '兼职；工作' }]), '');
  assert.equal(shouldGenerate(input, 'A3'), false);
  assert.equal(shouldGenerate({ ...input, evidence: [{ ...evidence, text: '兼职' }] }, 'A3'), true);
  assert.equal(shouldGenerate({ ...input, fields: ['etymology'] }, 'A4'), false);
  assert.equal(shouldGenerate({ ...input, fields: ['etymology'], evidence: [] }, 'A4'), true);
});
test('etymology parses, remains optional, rejects invalid types, and is empty for non-loanwords', () => {
  const draft = parsePipelineCards(response(), [input])[0]!;
  assert.match(draft.etymology!, /Arbeit/); assert.equal(draft.meaning, '兼职；');
  assert.equal(readyDraft({ ...draft, fields: ['meaning', 'etymology'], etymology: '' }, 'A3'), true);
  assert.throws(() => parsePipelineCards(response({ origin: 'Arbeit' }), [input]), /词源/);
  assert.throws(() => parsePipelineCards(response('x'.repeat(1201)), [input]), /词源/);
  const native = { ...input, candidate: { ...candidate, expression: '仕事' } };
  assert.equal(parsePipelineCards(response(), [native])[0]?.etymology, '');
  assert.match(pipelinePrompt([input], 'A3').system, /etymology/);
});
test('external AI roundtrip includes, validates and retains loanword etymology', () => {
  const session: StudyManualAiSession = { id: 'session', kind: 'cards', createdAt: 1, sourceHash: 'hash', tasksPerFile: 1, directory: 'temp', fields: input.fields,
    tasks: [{ ...input, readingSource: 'dictionary' }], batches: [{ id: 'batch', fileName: 'task-001.md', taskIds: [candidate.id], prompt: 'prompt', completed: false }], decisions: {}, drafts: [] };
  assert.match(manualAiDocument(session, 0, '漫画'), /"etymology"/);
  const row = { ...JSON.parse(response()).items[0], reading: 'あるばいと' };
  const result = parseManualAiResult(JSON.stringify({ sessionId: 'session', batchId: 'batch', items: [row] }), session);
  assert.match(result.drafts![0]!.etymology!, /Arbeit/);
});
test('APKG v3 stores etymology and empty legacy provenance, renders no protective phrases', async () => {
  const draft: StudyCardDraft = { candidateId: candidate.id, fields: ['reading', 'meaning', 'sentence', 'lemma', 'etymology'], reading: candidate.reading, meaning: '兼职\n仅供参考。',
    sentence: input.occurrence.text, lemma: candidate.expression, sentenceTranslation: '', usage: '建议人工核对。', nuance: '', needsReview: false, reviewReason: '', etymology: '德语 Arbeit（工作）' };
  const initialize = require('sql.js/dist/sql-asm-memory-growth.js') as typeof import('sql.js');
  const bytes = await buildAnkiPackage('book', '漫画', 'A3', [{ candidate, draft }], initialize);
  const archive = unzipSync(bytes); const SQL = await initialize(); const db = new SQL.Database(archive['collection.anki2']);
  try {
    const fields = String(db.exec('SELECT flds FROM notes')[0]!.values[0]![0]).split('\x1f');
    const models = JSON.parse(String(db.exec('SELECT models FROM col')[0]!.values[0]![0]));
    const model = Object.values(models)[0] as any;
    assert.equal(fields.length, 13); assert.equal(fields[10], ''); assert.equal(fields[12], '德语 Arbeit（工作）');
    assert.equal(model.flds[12].name, 'Etymology'); assert.match(model.tmpls[0].afmt, /词源/);
    assert.doesNotMatch(model.tmpls[0].afmt, /Provenance/);
    assert.doesNotMatch(fields.join(' '), /仅供参考|人工核对|未经|自动生成/);
  } finally { db.close(); }
});

test('A3 generates a missing loanword origin and reuses a dictionary origin without extra model requests', async () => {
  const { runCardPipeline } = await import('../src/core/study/runner');
  const { defaultStudyWorkflow } = await import('../src/core/study/harness');
  let calls = 0;
  const generate = async (glossary: string) => {
    const list = { bookId: 'book', generatedAt: 1, segmentGeneratedAt: 1, jlptSource: 'test', candidates: [structuredClone(candidate)], workflow: defaultStudyWorkflow() };
    return runCardPipeline({ list, request: { tier: 'A3', profileId: 'model', translationProfileId: '', fields: ['meaning', 'lemma', 'etymology'] }, sourceHash: 'source',
      ensureDictionary: async () => undefined, lookupTerms: () => [{ expression: candidate.expression, reading: candidate.reading, glossary: [glossary], dictionaryId: 'dict', dictionaryTitle: '词典', sequence: 1, score: 0, rules: [], termTags: [], definitionTags: [] }],
      llm: { complete: async request => { calls++; const row = JSON.parse(request.user).items[0]; return { ok: true, model: 'test', profileName: 'test', text: JSON.stringify({ items: [{ id: row.id, meaning: '兼职', sentenceTranslation: '', etymology: '德语 Arbeit（工作），日语指兼职。', usage: '', nuance: '', evidenceIds: [], issues: [] }] }) }; } },
      signal: new AbortController().signal, save: () => {},
    });
  };
  const generated = await generate('兼职');
  assert.equal(calls, 1); assert.match(generated.workflow!.cardRun!.drafts[0]!.etymology!, /Arbeit/);
  const local = await generate('（独 Arbeit）兼职');
  assert.equal(calls, 1); assert.equal(local.workflow!.cardRun!.drafts[0]!.etymology, '德语 Arbeit');
});

test('editing an existing etymology persists the full 1200-character limit', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { StudyService } = await import('./support/study/service'); const { setUserDataRootForTesting } = await import('./support/paths');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-etymology-')); const dir = path.join(root, 'library', 'book'); fs.mkdirSync(dir, { recursive: true });
  setUserDataRootForTesting(root);
  try {
    const draft = parsePipelineCards(response(), [input])[0]!;
    fs.writeFileSync(path.join(dir, 'study-list.json'), JSON.stringify({ bookId: 'book', generatedAt: 1, segmentGeneratedAt: 1, jlptSource: 'test', candidates: [candidate], workflow: { levels: [3], includeUnknown: false, cardRun: { tier: 'A3', sourceHash: 'source', drafts: [draft], completedAt: 1 } } }));
    const service = new StudyService({ getBook: () => null, getSegments: () => null, ensureDictionary: async () => undefined, lookupMeaning: () => '' });
    service.patchCard('book', candidate.id, { etymology: '词'.repeat(1200) });
    assert.equal(service.read('book')!.workflow!.cardRun!.drafts[0]!.etymology!.length, 1200);
  } finally { setUserDataRootForTesting(null); fs.rmSync(root, { recursive: true, force: true }); }
});
