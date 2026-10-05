import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { unzipSync } from 'fflate';
import type { BookRecord, DictTerm, StudyCandidate, StudyList } from '../src/shared/types';
import { adjacentContext, bestOccurrences, dictionaryEvidence, parsePipelineCards, pipelineOutputLimit, recoverPipelineCards, recoverPipelineVerification, selectOccurrence, type PipelineInput } from '../src/core/study/pipeline';
import { buildStudyCandidates } from '../src/core/study/candidates';
import { createJlptIndex } from '../src/core/study/jlpt';
import { defaultStudyWorkflow } from '../src/core/study/harness';
import { StudyService, chooseMeaning, type StudyServiceOptions } from './support/study/service';
import { setUserDataRootForTesting } from './support/paths';

function item(id = '猫'): StudyCandidate {
  return { id, expression: id, reading: 'ねこ', partOfSpeech: '名詞', jlpt: 3, jlptConflict: false,
    count: 2, tokenizerKnown: true, selected: true, excluded: false, meaning: '旧释义', exportedAt: null,
    contextRef: 'first', occurrences: [{ id: 'first', ref: 'page:p001.png#0', label: '第1页', text: `${id}が好きです。`, start: 0, end: id.length }] };
}
function term(word = '猫', text = '猫；家养动物', reading = 'ねこ'): DictTerm {
  return { expression: word, reading, glossary: [text], definitionTags: [], termTags: [], rules: [], score: 0,
    sequence: 1, dictionaryId: 'dict', dictionaryTitle: '用户手动导入词典' };
}
async function fixture(items: StudyCandidate[], options: Partial<StudyServiceOptions>, run: (service: StudyService, file: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-pipeline-'));
  const dir = path.join(root, 'library', 'book'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'study-list.json');
  fs.writeFileSync(file, JSON.stringify({ bookId: 'book', generatedAt: 1, segmentGeneratedAt: 1, jlptSource: 'test', candidates: items,
    workflow: { ...defaultStudyWorkflow(), directAppliedAt: 1, imageMode: 'none' } } satisfies StudyList));
  setUserDataRootForTesting(root);
  try {
    await run(new StudyService({ getBook: () => ({ id: 'book', title: '测试漫画', format: 'comic' } as BookRecord), getSegments: () => null,
      ensureDictionary: async () => undefined, lookupMeaning: () => '', translation: { translate: async () => translated('我喜欢猫。') }, ...options }), file);
  } finally { setUserDataRootForTesting(null); fs.rmSync(root, { recursive: true, force: true }); }
}
const translated = (text: string) => ({ ok: true, text, sourceReading: '', profileName: 'test', provider: 'bing' as const, sourceLanguage: 'ja', targetLanguage: 'zh-Hans' });
test('manual deferral prevents export until a complete card is explicitly approved again', async () => {
  await fixture([item()], {lookupTerms: () => [term()]}, async service => {
    await service.runCards('book', {tier:'A1',translationProfileId:'t'});
    const deferred = service.patchCard('book', '猫', {status:'deferred',needsReview:true}).workflow!.cardRun!.drafts[0]!;
    assert.equal(deferred.status, 'deferred'); assert.equal(deferred.needsReview,true); assert.equal(deferred.manuallyApproved,false);
    const approved = service.patchCard('book','猫',{needsReview:false}).workflow!.cardRun!.drafts[0]!;
    assert.equal(approved.status,'ready'); assert.equal(approved.needsReview,false);
  });
});
function modelResult(user: string, verify = false) {
  const input = JSON.parse(user) as { items: Array<{ id: string; dictionary: Array<{ id: string }> }> };
  return { ok: true, profileName: 'test', model: 'test', text: JSON.stringify({ items: input.items.map(i => verify ? { id: i.id, issues: [] } : {
    id: i.id, meaning: '猫', sentenceTranslation: '我喜欢猫。', usage: '', nuance: '', evidenceIds: i.dictionary.map(e => e.id), issues: [],
  }) }), usage: { promptTokens: 100, completionTokens: 50 } };
}

test('A3 沿用 A2 清晰项词典＋翻译，不额外生成或复核', async () => {
  let calls = 0, translations = 0;
  await fixture([item()], { lookupTerms: () => [term()],
    llm: { complete: async request => { calls++; return modelResult(request.user); } },
    translation: { translate: async () => { translations++; return translated('我喜欢猫。'); } } }, async service => {
    const preview = await service.previewCards('book', 'A3');
    assert.equal(preview.aiItems, 0); assert.equal(preview.translationSentences, 1);
    const result = await service.runCards('book', { tier: 'A3', profileId: 'llm', translationProfileId: 't' });
    assert.equal(calls, 0); assert.equal(translations, 1);
    assert.equal(result.workflow!.cardRun!.drafts[0]?.referenceOnly, true);
  });
});

test('A1/A2 多义词完整保留，A2 有词典时不调用 AI；缺词才补全', async () => {
  let calls = 0;
  await fixture([item()], { lookupTerms: () => [term('猫', 'ねこ\n① 动物\n② 三弦琴')],
    llm: { complete: async request => { calls++; return modelResult(request.user); } } }, async service => {
    for (const tier of ['A1', 'A2'] as const) {
      const result = await service.runCards('book', { tier, profileId: 'llm', translationProfileId: 't' });
      const draft = result.workflow!.cardRun!.drafts[0]!;
      assert.equal(draft.status, 'ready'); assert.match(draft.meaning, /①.*\n②/s);
    }
    assert.equal(calls, 0);
  });
  await fixture([item()], { lookupTerms: () => [], llm: { complete: async request => { calls++; return modelResult(request.user); } } }, async service => {
    const result = await service.runCards('book', { tier: 'A2', profileId: 'llm', translationProfileId: 't' });
    assert.equal(calls, 1); assert.equal(result.workflow!.cardRun!.drafts[0]?.status, 'ready');
  });
});

test('只有原句/辞书形不要求外部配置，导出 v2 只包含所选字段，人工保存不强求句译', async () => {
  await fixture([item()], { lookupTerms: () => [], translation: undefined, llm: undefined }, async (service, file) => {
    const result = await service.runCards('book', { tier: 'A4', fields: ['sentence', 'lemma'], translationProfileId: '' });
    const draft = result.workflow!.cardRun!.drafts[0]!;
    assert.equal(draft.status, 'ready'); assert.equal(draft.meaning, ''); assert.equal(draft.reading, '');
    service.patchCard('book', '猫', { needsReview: false });
    assert.equal(await service.exportPackage('book', file + '.apkg'), 1);
    const init = require('sql.js/dist/sql-asm-memory-growth.js') as typeof import('sql.js');
    const SQL = await init(); const db = new SQL.Database(unzipSync(fs.readFileSync(file + '.apkg'))['collection.anki2']);
    try { const values = String(db.exec('SELECT flds FROM notes')[0]!.values[0]![0]).split('\x1f');
      assert.equal(values.length, 12); assert.equal(values[2], ''); assert.equal(values[3], ''); assert.equal(values[5], ''); assert.equal(values[11], '猫');
    } finally { db.close(); }
  });
});

test('A4 无翻译参考时仍可由 LLM 生成已选句译；字段变化不能混用旧检查点', async () => {
  let calls = 0;
  await fixture([item()], { lookupTerms: () => [], translation: undefined, llm: { complete: async request => {
    calls++; if (calls === 1) return { ok: false, profileName: 'test', model: 'test', text: '', error: 'HTTP 503' };
    return modelResult(request.user);
  } } }, async (service, file) => {
    const request = { tier: 'A4' as const, profileId: 'llm', translationProfileId: '' };
    await assert.rejects(service.runCards('book', request), /503/);
    const result = await service.runCards('book', request);
    assert.equal(result.workflow!.cardRun!.drafts[0]?.status, 'ready');
    assert.equal(result.workflow!.cardRun!.stats?.translationCalls, 0);
    result.workflow!.pendingCardRun = result.workflow!.cardRun; delete result.workflow!.cardRun;
    fs.writeFileSync(file, JSON.stringify(result));
    await assert.rejects(service.runCards('book', { ...request, fields: ['lemma'] }), /旧释义检查点/);
    const changed = await service.runCards('book', { ...request, fields: ['lemma'], restart: true });
    assert.deepEqual(changed.workflow!.cardRun!.drafts[0]?.fields, ['lemma']);
    assert.equal(changed.workflow!.cardRun!.stats?.llmCalls, 0);
  });
});

test('缺少假名时尝试辞书形翻译罗马音，缓存保留且不从整句猜词位', async () => {
  const candidate = item(); candidate.reading = ''; const requests: string[] = [];
  await fixture([candidate], { lookupTerms: () => [], translation: { translate: async request => {
    requests.push(request.text); return { ...translated('猫'), sourceReading: 'neko' };
  } } }, async service => {
    const result = await service.runCards('book', { tier: 'A1', fields: ['reading', 'lemma'], translationProfileId: 't' });
    assert.deepEqual(requests, ['猫']); const draft = result.workflow!.cardRun!.drafts[0]!;
    assert.equal(draft.reading, 'ねこ'); assert.equal(draft.readingSource, 'translation_romaji'); assert.equal(draft.status, 'ready');
    await service.runCards('book', { tier: 'A1', fields: ['reading', 'lemma'], translationProfileId: 't' });
    assert.deepEqual(requests, ['猫']);
  });
});

test('A3 疑难项允许三次修复，不插入复核请求；超过上限仍待审', async () => {
  let calls = 0;
  await fixture([item()], { lookupTerms: () => [term('猫', '① 动物\n② 三弦琴')],
    translation: { translate: async () => translated('我喜欢猫。') },
    llm: { complete: async request => {
      assert.equal(request.tool?.name, 'submit_anki_pipeline'); calls++;
      const result = modelResult(request.user); const rows = JSON.parse(result.text);
      rows.items[0].issues = [{ field: 'meaning', code: 'ambiguous', reason: `仍存疑 ${calls}` }];
      result.text = JSON.stringify(rows); return result;
    } } }, async service => {
    const result = await service.runCards('book', { tier: 'A3', profileId: 'llm', translationProfileId: 't' });
    assert.equal(calls, 4); assert.equal(result.workflow!.cardRun!.drafts[0]?.repairs, 3);
    assert.equal(result.workflow!.cardRun!.drafts[0]?.status, 'needs_review');
  });
});

test('A3 没有进展的同句修复提前停止', async () => {
  let calls = 0;
  await fixture([item()], { lookupTerms: () => [], translation: { translate: async () => translated('我喜欢猫。') },
    llm: { complete: async request => { calls++; const result = modelResult(request.user); const rows = JSON.parse(result.text);
      rows.items[0].issues = [{ field: 'meaning', code: 'ambiguous', reason: '仍无法判断' }]; result.text = JSON.stringify(rows); return result; } } }, async service => {
    const result = await service.runCards('book', { tier: 'A3', profileId: 'llm', translationProfileId: 't' });
    assert.equal(calls, 2); assert.equal(result.workflow!.cardRun!.drafts[0]?.repairs, 1);
    assert.equal(result.workflow!.cardRun!.drafts[0]?.status, 'needs_review');
  });
});

test('邻句取自真实同框/同页文字层，缺失或旧原文不跨页拼接', () => {
  const one = item().occurrences[0]!;
  const unit = (ref: string, text: string) => ({ ref, text, label: '', tokens: [] });
  const units = [unit('page:p001.png#-1', 'これは犬。'), unit(one.ref, one.text), unit('page:p001.png#1', 'かわいいね。')];
  assert.equal(adjacentContext(one, units).previous, 'これは犬。');
  assert.equal(adjacentContext(one, units).next, 'かわいいね。');
  assert.equal(adjacentContext(one, [units[1]!, unit('page:p002.png#0', '別のページ。')]).next, '');
  assert.equal(adjacentContext({ ...one, text: '猫が寝ている。' }, units).previous, '');
  assert.equal(adjacentContext({ ...one, text: '犬だ。猫が好きです。鳥だ。', start: 3, end: 4 }, []).next, '鳥だ。');
});

test('候选从全部出处保留最佳五处，而非最先五处，并保留正确原文偏移', () => {
  const texts = ['猫', '猫', '猫', '猫', '猫', 'この猫はとてもかわいいですね。'];
  const units = texts.map((text, i) => ({ text, ref: `page:p${i}.png#0`, label: `第${i}页`, tokens: [] }));
  const candidates = buildStudyCandidates(units, texts.map(() => [{ surface: '猫', lemma: '猫', reading: 'ネコ', pos: '名詞', known: true }]), createJlptIndex([]));
  assert.equal(candidates[0]?.count, 6);
  assert.equal(candidates[0]?.occurrences.length, 5);
  assert.equal(candidates[0]?.occurrences[0]?.text, texts[5]);
  assert.equal(candidates[0]?.contextRef, candidates[0]?.occurrences[0]?.id);
  assert.equal(candidates[0]?.occurrences[0]?.start, 2);
});

test('自动选句尊重用户锁定，非法偏移降到末尾', () => {
  const candidate = item();
  candidate.occurrences.push({ id: 'invalid', ref: 'bad', label: '', text: '猫', start: 10, end: 11 });
  assert.equal(bestOccurrences(candidate.occurrences)[0]?.id, 'first');
  candidate.contextPinned = true; candidate.contextRef = 'invalid';
  assert.equal(selectOccurrence(candidate)?.id, 'invalid');
});

test('日汉双解空读音假名词可以取义，汉字的未知读音不能随意匹配', () => {
  const kana = { ...item('やばい'), reading: 'やばい' };
  assert.equal(dictionaryEvidence([term('やばい', '危险，不妙', '')], kana).length, 1);
  assert.equal(chooseMeaning([{ term: term('やばい', '危险，不妙', '') }], 'やばい', 'やばい'), '危险，不妙');
  assert.equal(dictionaryEvidence([term('猫', '猫', '')], item()).length, 0);
  assert.equal(dictionaryEvidence([term('どきどき', '心跳', '')], { ...item('ドキドキ'), reading: 'どきどき' }).length, 1);
});

test('证据保留词典来源和编号义项，不能把多义条目当单义', () => {
  const evidence = dictionaryEvidence([term('猫', 'ねこ［猫］\n① 动物\n② 三弦琴')], item());
  assert.equal(evidence.length, 2); assert.ok(evidence.every(e => e.ambiguous));
  assert.equal(evidence[0]?.dictionary, '用户手动导入词典');
});

test('新协议拒绝缺字段、错误类型和未知证据，可选提示存疑时自动删除', () => {
  const candidate = item();
  const inputs: PipelineInput[] = [{ candidate, occurrence: candidate.occurrences[0]!, evidence: dictionaryEvidence([term()], candidate) }];
  assert.throws(() => parsePipelineCards('{"items":[{"id":"猫"}]}', inputs), /字符串/);
  const row = { id: '猫', meaning: '猫', sentenceTranslation: '我喜欢猫。', usage: '不可靠提示', nuance: '不可靠语气', evidenceIds: [inputs[0]!.evidence[0]!.id], issues: [] as unknown[] };
  assert.throws(() => parsePipelineCards(JSON.stringify({ items: [{ ...row, evidenceIds: ['invented'] }] }), inputs), /未知词典/);
  assert.throws(() => parsePipelineCards(JSON.stringify({ items: [{ ...row, issues: false }] }), inputs), /数组/);
  row.issues = [{ field: 'usage', code: 'unsupported', reason: '没有提示依据' }];
  const draft = parsePipelineCards(JSON.stringify({ items: [row] }), inputs)[0]!;
  assert.equal(draft.usage, ''); assert.equal(draft.nuance, ''); assert.equal(draft.needsReview, false);
});

test('A0 无翻译和 LLM 仍能生成并导出词典参考卡', async () => {
  await fixture([item()], { lookupTerms: () => [term()], llm: { complete: async () => { throw new Error('不得调用'); } },
    translation: { translate: async () => { throw new Error('不得翻译'); } } }, async (service, file) => {
    const result = await service.runCards('book', { tier: 'A0', translationProfileId: 't' });
    const draft = result.workflow!.cardRun!.drafts[0]!;
    assert.equal(draft.referenceOnly, true); assert.equal(draft.sentenceTranslation, ''); assert.equal(draft.status, 'ready');
    assert.equal(await service.exportPackage('book', file + '.apkg'), 1);
    assert.ok(unzipSync(fs.readFileSync(file + '.apkg'))['collection.anki2']);
  });
});

test('A1/A2 清晰参考项同一句只翻译一次，词典变更后刷新证据', async () => {
  const a = item(), b = item('犬');
  a.occurrences[0]!.text = '猫も犬も好きです。'; b.occurrences[0] = { ...a.occurrences[0]!, start: 2, end: 3 };
  b.reading = 'いぬ';
  let translations = 0, llmCalls = 0, text = '猫';
  await fixture([a, b], { lookupTerms: word => [term(word, word === '猫' ? text : '犬', word === '猫' ? 'ねこ' : 'いぬ')],
    translation: { translate: async () => { translations++; return translated('猫和狗我都喜欢。'); } },
    llm: { complete: async () => { llmCalls++; throw new Error('清晰参考项无需 LLM'); } } }, async service => {
    const result = await service.runCards('book', { tier: 'A2', profileId: 'llm', translationProfileId: 't' });
    assert.equal(translations, 1); assert.equal(llmCalls, 0);
    assert.ok(result.workflow!.cardRun!.drafts.every(d => d.status === 'ready' && d.referenceOnly));
    text = '猫，动物';
    const refreshed = await service.runCards('book', { tier: 'A1', translationProfileId: 't' });
    assert.equal(refreshed.workflow!.cardRun!.drafts[0]?.meaning, text);
  });
});

test('A4 全量生成不额外复核，先提供翻译参考', async () => {
  let calls = 0;
  await fixture([item()], { lookupTerms: () => [term()], llm: { complete: async request => { calls++; return modelResult(request.user, request.tool?.name === 'verify_anki_pipeline'); } } }, async service => {
    const standard = await service.runCards('book', { tier: 'A4', profileId: 'llm', translationProfileId: 't' });
    assert.equal(calls, 1); assert.equal(standard.workflow!.cardRun!.drafts[0]?.needsReview, false);
    assert.equal(standard.workflow!.cardRun!.stats?.translationCalls, 1);
    await service.runCards('book', { tier: 'A4', profileId: 'llm', translationProfileId: 't' });
    assert.equal(calls, 1); // 相同计划复用已完成卡。
  });
});

test('预览读取当前词典，但不修改候选、不请求模型和翻译', async () => {
  await fixture([item()], { lookupTerms: () => [term()], llm: { complete: async () => { throw new Error('不应调用'); } } }, async (service, file) => {
    const before = fs.readFileSync(file, 'utf8');
    const cheap = await service.previewCards('book', 'A2');
    assert.equal(cheap.aiItems, 0); assert.equal(cheap.translationSentences, 1);
    const full = await service.previewCards('book', 'A4');
    assert.equal(full.aiItems, 1); assert.equal(full.baseCalls, 1); assert.ok(full.estimatedInputTokens > 0);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
});

test('核心歧义换备用原句修复，不增加复核请求', async () => {
  const candidate = item();
  candidate.occurrences[0] = { ...candidate.occurrences[0]!, text: 'この猫がとてもかわいいので好きです。', start: 2, end: 3 };
  candidate.occurrences.push({ id: 'second', ref: 'page:p002.png#0', label: '第2页', text: '猫を見た。', start: 0, end: 1 });
  let calls = 0;
  await fixture([candidate], { lookupTerms: () => [term()], llm: { complete: async request => {
    calls++;
    const verify = request.tool?.name === 'verify_anki_pipeline';
    const result = modelResult(request.user, verify);
    const input = JSON.parse(request.user);
    if (!verify && !input.repair) {
      const rows = JSON.parse(result.text);
      rows.items[0].issues = [{ field: 'meaning', code: 'ambiguous', reason: '第一句的义项存疑' }];
      result.text = JSON.stringify(rows);
    }
    return result;
  } } }, async service => {
    const result = await service.runCards('book', { tier: 'A4', profileId: 'llm', translationProfileId: 't' });
    const draft = result.workflow!.cardRun!.drafts[0]!;
    assert.equal(calls, 2); assert.equal(draft.contextRef, 'second'); assert.equal(draft.repairs, 1); assert.equal(draft.status, 'ready');
  });
});

test('A4 丢弃可选提示，不增加复核或修复请求', async () => {
  let calls = 0;
  await fixture([item()], { lookupTerms: () => [term('猫', '① 动物')], llm: { complete: async request => {
    calls++;
    const verify = request.tool?.name === 'verify_anki_pipeline';
    const result = modelResult(request.user, verify);
    const rows = JSON.parse(result.text);
    if (verify) rows.items[0].issues = [{ field: 'usage', code: 'unsupported', reason: '提示无证据' }];
    else { rows.items[0].usage = '无依据的提示'; rows.items[0].nuance = '无依据的语气'; }
    result.text = JSON.stringify(rows); return result;
  } } }, async service => {
    const result = await service.runCards('book', { tier: 'A4', profileId: 'llm', translationProfileId: 't' });
    const draft = result.workflow!.cardRun!.drafts[0]!;
    assert.equal(calls, 1); assert.equal(draft.usage, ''); assert.equal(draft.nuance, ''); assert.equal(draft.status, 'ready');
  });
});

test('新协议格式错误拆批，返回乱序仍按候选顺序落盘', async () => {
  const items = [item('猫0'), item('猫1'), item('猫2')];
  let calls = 0;
  await fixture(items, { lookupTerms: word => [term(word)], llm: { complete: async request => {
    calls++; const result = modelResult(request.user);
    const rows = JSON.parse(result.text);
    if (calls === 1) rows.items.pop(); else rows.items.reverse();
    result.text = JSON.stringify(rows); return result;
  } } }, async service => {
    const result = await service.runCards('book', { tier: 'A4', profileId: 'llm', translationProfileId: 't' });
    assert.equal(calls, 3); assert.deepEqual(result.workflow!.cardRun!.drafts.map(d => d.candidateId), items.map(i => i.id));
  });
});

test('取消中止新流水线 LLM，持久检查点不冒充完整卡片', async () => {
  let began!: () => void;
  const running = new Promise<void>(resolve => { began = resolve; });
  await fixture([item()], { lookupTerms: () => [term()], llm: { complete: async request => {
    began();
    await new Promise<void>((_, reject) => request.signal!.addEventListener('abort', () => reject(new Error('已取消')), { once: true }));
    return modelResult(request.user);
  } } }, async service => {
    const work = service.runCards('book', { tier: 'A4', profileId: 'llm', translationProfileId: 't' });
    await running; service.cancel('book'); await assert.rejects(work, /取消/);
    const list = service.read('book')!;
    assert.equal(list.workflow?.cardRun, undefined); assert.equal(list.workflow?.pendingCardRun?.drafts.length, 0);
    assert.ok(list.workflow?.pendingCardRun?.pipeline?.planHash);
  });
});

test('AI 补词义允许缺词典证据，保留 AI 来源标记', async () => {
  await fixture([item()], { lookupTerms: () => [], llm: { complete: async request => modelResult(request.user, request.tool?.name === 'verify_anki_pipeline') } }, async service => {
    const result = await service.runCards('book', { tier: 'A4', profileId: 'llm', translationProfileId: 't' });
    const draft = result.workflow!.cardRun!.drafts[0]!;
    assert.equal(draft.status, 'ready'); assert.equal(draft.meaningSource, 'ai');
  });
});

test('新档位导出已通过卡，保留待审卡且只标记实际导出项', async () => {
  const good = item(), bad = { ...item('犬'), reading: 'いぬ' };
  await fixture([good, bad], { lookupTerms: word => word === '猫' ? [term()] : [] }, async (service, file) => {
    const result = await service.runCards('book', { tier: 'A0', translationProfileId: 't' });
    assert.equal(result.workflow?.cardRun?.drafts.length, 2);
    assert.equal(await service.exportPackage('book', file + '.apkg'), 1);
    const saved = service.read('book')!;
    assert.ok(saved.candidates[0]!.exportedAt); assert.equal(saved.candidates[1]!.exportedAt, null);
    assert.equal(saved.workflow?.cardRun?.drafts[1]?.needsReview, true);
  });
});

test('新增卡数按阅读优先度控制，后续运行保留已有卡并继续暂缓项', async () => {
  const low = item('犬'), high = item('猫');
  low.reading = 'いぬ'; low.count = 1; high.count = 20;
  await fixture([low, high], { lookupTerms: word => [term(word, word, word === '猫' ? 'ねこ' : 'いぬ')] }, async service => {
    const first = await service.runCards('book', { tier: 'A0', translationProfileId: 't', newCardLimit: 1 });
    assert.equal(first.workflow!.cardRun!.drafts[0]?.status, 'deferred');
    assert.equal(first.workflow!.cardRun!.drafts[1]?.status, 'ready');
    const second = await service.runCards('book', { tier: 'A0', translationProfileId: 't', newCardLimit: 1 });
    assert.ok(second.workflow!.cardRun!.drafts.every(d => d.status === 'ready'));
  });
});

test('更换草稿出处重置审核；A0 补词义可人工通过，无需补不存在的句译', async () => {
  const candidate = item();
  candidate.occurrences.push({ ...candidate.occurrences[0]!, id: 'second', label: '第2页', text: '猫です。' });
  await fixture([candidate], { lookupTerms: () => [term()] }, async service => {
    await service.runCards('book', { tier: 'A0', translationProfileId: 't' });
    const changed = service.patchCard('book', '猫', { contextRef: 'second' });
    assert.equal(changed.workflow!.cardRun!.drafts[0]?.needsReview, true);
    const approved = service.patchCard('book', '猫', { meaning: '猫', needsReview: false });
    assert.equal(approved.workflow!.cardRun!.drafts[0]?.status, 'ready');
    assert.equal(approved.workflow!.cardRun!.drafts[0]?.manuallyApproved, true);
  });
});

test('汉字卡缺读音不能仅靠确认按钮放行，补读音后才能导出', async () => {
  const candidate = { ...item(), reading: '' };
  await fixture([candidate], { lookupTerms: () => [] }, async service => {
    await service.runCards('book', { tier: 'A0', translationProfileId: 't' });
    const blocked = service.patchCard('book', '猫', { meaning: '猫', needsReview: false });
    assert.equal(blocked.workflow!.cardRun!.drafts[0]?.needsReview, true);
    const approved = service.patchCard('book', '猫', { reading: 'ねこ', needsReview: false });
    assert.equal(approved.workflow!.cardRun!.drafts[0]?.status, 'ready');
  });
});

test('预算不足时暂缓，增加预算复用同计划；未知 usage 不算零', async () => {
  let calls = 0;
  await fixture([item()], { lookupTerms: () => [term()], llm: { complete: async request => { calls++; const result = modelResult(request.user); return { ...result, usage: undefined }; } } }, async service => {
    const low = await service.runCards('book', { tier: 'A4', profileId: 'llm', translationProfileId: 't', tokenBudget: 1000 });
    assert.equal(calls, 0); assert.equal(low.workflow!.cardRun!.drafts[0]?.status, 'deferred');
    const resumed = await service.runCards('book', { tier: 'A4', profileId: 'llm', translationProfileId: 't', tokenBudget: 200000 });
    assert.equal(calls, 1); assert.equal(resumed.workflow!.cardRun!.drafts[0]?.status, 'ready');
    assert.ok(resumed.workflow!.cardRun!.pipeline!.budgetUsed > 0);
    assert.ok(resumed.workflow!.cardRun!.stats!.estimatedTokens! > 0);
  });
});

test('相同 profileId 的模型配置变化后拒绝混用旧检查点，显式重启才放弃', async () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ ...item(`猫${i}`), reading: 'ねこ' }));
  let signature = 'old', calls = 0, fail = true;
  await fixture(items, { lookupTerms: word => [term(word)], llm: { profileSignature: () => signature, complete: async request => {
    calls++; if (fail && calls === 2) return { ok: false, text: '', profileName: 'test', model: 'test', error: 'HTTP 503' };
    return modelResult(request.user);
  } } }, async service => {
    const request = { tier: 'A4' as const, profileId: 'llm', translationProfileId: 't', concurrency: 1 as const };
    await assert.rejects(service.runCards('book', request), /503/);
    assert.equal(service.read('book')!.workflow!.pendingCardRun!.drafts.length, 6);
    signature = 'new'; fail = false;
    await assert.rejects(service.runCards('book', request), /旧释义检查点/);
    const result = await service.runCards('book', { ...request, restart: true });
    assert.equal(result.workflow!.cardRun!.drafts.length, 7);
  });
});

test('批次失败后同计划只处理剩余项，成功卡顺序稳定', async () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ ...item(`猫${i}`), reading: 'ねこ' }));
  let calls = 0;
  await fixture(items, { lookupTerms: word => [term(word)], llm: { complete: async request => {
    calls++; if (calls === 2) return { ok: false, text: '', profileName: 'test', model: 'test', error: 'HTTP 503' };
    return modelResult(request.user);
  } } }, async service => {
    const request = { tier: 'A4' as const, profileId: 'llm', translationProfileId: 't', concurrency: 1 as const };
    await assert.rejects(service.runCards('book', request));
    const result = await service.runCards('book', request);
    assert.equal(calls, 3); assert.deepEqual(result.workflow!.cardRun!.drafts.map(d => d.candidateId), items.map(i => i.id));
  });
});

test('截断恢复只接受完整、唯一且通过原协议的条目，字符串括号不干扰边界', () => {
  const candidates = [item('猫'), item('犬')];
  const inputs = candidates.map(candidate => ({ candidate, occurrence: candidate.occurrences[0]!, evidence: dictionaryEvidence([term(candidate.expression)], candidate) }));
  const row = { id: '猫', meaning: '猫 { } [ ] " \\', sentenceTranslation: '我喜欢猫。', usage: '', nuance: '', evidenceIds: [inputs[0]!.evidence[0]!.id], issues: [] };
  const text = `{"items":[${JSON.stringify(row)},{"id":"犬","meaning":"未完成`;
  assert.equal(recoverPipelineCards(text, inputs).length, 1);
  assert.equal(recoverPipelineCards(text, inputs)[0]!.meaning, row.meaning);
  assert.equal(recoverPipelineCards(`{"items":[${JSON.stringify(row)},${JSON.stringify(row)},`, inputs).length, 0);
  assert.equal(recoverPipelineCards(JSON.stringify({ items: [{ ...row, evidenceIds: ['fake'] }] }), inputs).length, 0);
  assert.equal(recoverPipelineCards('{"untrusted":{"items":[', inputs).length, 0);
  assert.equal(recoverPipelineCards(`{"items":[${JSON.stringify({ ...row, sentenceTranslation: undefined })}],`, inputs).length, 0);
  assert.deepEqual([...recoverPipelineVerification('{"items":[{"id":"猫","issues":[]},{"id":"犬","issues":[', inputs).keys()], ['猫']);
});

test('截断生成已完成卡正常校验，其余重新小批生成，输出额度不随拆批下降', async () => {
  const items = ['猫', '犬', '鳥', '魚'].map(word => item(word));
  const calls: Array<{ ids: string[]; verify: boolean; limit: number }> = [];
  await fixture(items, { lookupTerms: word => [term(word, '① 动物')], llm: { complete: async request => {
    const ids = JSON.parse(request.user).items.map((i: { id: string }) => i.id) as string[];
    const verify = request.tool?.name === 'verify_anki_pipeline';
    calls.push({ ids, verify, limit: request.maxOutputTokens! });
    if (calls.length === 1) {
      const payload = JSON.parse(request.user); payload.items = payload.items.slice(0, 2);
      const partial = modelResult(JSON.stringify(payload)).text.slice(0, -2) + ',{"id":"未完成';
      return { ok: false, text: '', truncatedText: partial, error: '输出 token limit：模型答案被截断', profileName: 'test', model: 'test', usage: { promptTokens: 100, completionTokens: 32768 } };
    }
    return modelResult(request.user, verify);
  } } }, async service => {
    const result = await service.runCards('book', { tier: 'A4', profileId: 'llm', translationProfileId: 't', concurrency: 1 });
    const ordered = calls[0]!.ids;
    assert.deepEqual(calls.map(c => [c.verify, c.ids]), [[false, ordered], [false, ordered.slice(2)]]);
    assert.ok(calls.filter(c => !c.verify).every(c => c.limit === 49152));
    assert.equal(result.workflow!.cardRun!.drafts.length, 4);
    assert.ok(result.workflow!.cardRun!.drafts.every(d => d.status === 'ready'));
    assert.equal(result.workflow!.cardRun!.stats!.completionTokens, 32818);
  });
});

test('单卡截断仅扩额重试一次，失败暂缓并继续其他词，不无限重复付费', async () => {
  const limits: number[] = [];
  await fixture([item('猫'), item('犬')], { lookupTerms: word => [term(word)], llm: { complete: async request => {
    limits.push(request.maxOutputTokens!);
    const ids = JSON.parse(request.user).items.map((i: { id: string }) => i.id) as string[];
    if (ids.includes('猫')) return { ok: false, text: '', truncatedText: '', error: '输出 token limit：模型答案被截断', profileName: 'test', model: 'test' };
    return modelResult(request.user);
  } } }, async service => {
    const result = await service.runCards('book', { tier: 'A4', profileId: 'llm', translationProfileId: 't', concurrency: 1 });
    assert.deepEqual(limits, [49152, 49152, 65536, 49152]);
    assert.equal(result.workflow!.cardRun!.drafts[0]!.status, 'deferred');
    assert.equal(result.workflow!.cardRun!.drafts[1]!.status, 'ready');
    assert.equal(pipelineOutputLimit('A4'), 49152);
  });
});

test('已恢复并核查的卡在后续 HTTP 失败后落盘，续跑不重复生成', async () => {
  const items = ['猫', '犬', '鳥'].map(word => item(word)); let calls = 0;
  const ids: string[][] = [];
  await fixture(items, { lookupTerms: word => [term(word)], llm: { complete: async request => {
    calls++; const payload = JSON.parse(request.user); ids.push(payload.items.map((i: { id: string }) => i.id));
    if (calls === 1) {
      payload.items = payload.items.slice(0, 1);
      return { ok: false, text: '', truncatedText: modelResult(JSON.stringify(payload)).text.slice(0, -2) + ',{"id":',
        error: '输出 token limit：模型答案被截断', profileName: 'test', model: 'test' };
    }
    if (calls === 2) return { ok: false, text: '', error: 'HTTP 503', profileName: 'test', model: 'test' };
    return modelResult(request.user);
  } } }, async service => {
    const request = { tier: 'A4' as const, profileId: 'llm', translationProfileId: 't', concurrency: 1 as const };
    await assert.rejects(service.runCards('book', request), /503/);
    assert.equal(service.read('book')!.workflow!.pendingCardRun!.drafts[0]!.candidateId, ids[0]![0]);
    const result = await service.runCards('book', request);
    assert.deepEqual(ids[2], ids[0]!.slice(1));
    assert.equal(result.workflow!.cardRun!.drafts.length, 3);
  });
});
