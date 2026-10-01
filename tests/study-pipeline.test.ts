import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { unzipSync } from 'fflate';
import type { BookRecord, DictTerm, StudyCandidate, StudyList } from '../src/shared/types';
import { bestOccurrences, dictionaryEvidence, parsePipelineCards, selectOccurrence, type PipelineInput } from '../src/core/study/pipeline';
import { buildStudyCandidates } from '../src/core/study/candidates';
import { createJlptIndex } from '../src/core/study/jlpt';
import { defaultStudyWorkflow } from '../src/core/study/harness';
import { StudyService, chooseMeaning, type StudyServiceOptions } from '../src/main/study/service';
import { setUserDataRootForTesting } from '../src/main/paths';

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
      ensureDictionary: async () => undefined, lookupMeaning: () => '', ...options }), file);
  } finally { setUserDataRootForTesting(null); fs.rmSync(root, { recursive: true, force: true }); }
}
const translated = (text: string) => ({ ok: true, text, sourceReading: '', profileName: 'test', provider: 'bing' as const, sourceLanguage: 'ja', targetLanguage: 'zh-Hans' });
function modelResult(user: string, verify = false) {
  const input = JSON.parse(user) as { items: Array<{ id: string; dictionary: Array<{ id: string }> }> };
  return { ok: true, profileName: 'test', model: 'test', text: JSON.stringify({ items: input.items.map(i => verify ? { id: i.id, issues: [] } : {
    id: i.id, meaning: '猫', sentenceTranslation: '我喜欢猫。', usage: '', nuance: '', evidenceIds: i.dictionary.map(e => e.id), issues: [],
  }) }), usage: { promptTokens: 100, completionTokens: 50 } };
}

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
    const result = await service.runCards('book', { tier: 'A0', translationProfileId: '' });
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

test('A3 直接生成中文词义和句译，不依赖翻译配置；A4 全量复核', async () => {
  let calls = 0;
  await fixture([item()], { lookupTerms: () => [term()], llm: { complete: async request => { calls++; return modelResult(request.user, request.tool?.name === 'verify_anki_pipeline'); } } }, async service => {
    const standard = await service.runCards('book', { tier: 'A3', profileId: 'llm', translationProfileId: '' });
    assert.equal(calls, 1); assert.equal(standard.workflow!.cardRun!.drafts[0]?.needsReview, false);
    assert.equal(standard.workflow!.cardRun!.stats?.translationCalls, 0);
    await service.runCards('book', { tier: 'A4', profileId: 'llm', translationProfileId: '' });
    assert.equal(calls, 3);
  });
});

test('预览读取当前词典，但不修改候选、不请求模型和翻译', async () => {
  await fixture([item()], { lookupTerms: () => [term()], llm: { complete: async () => { throw new Error('不应调用'); } } }, async (service, file) => {
    const before = fs.readFileSync(file, 'utf8');
    const cheap = await service.previewCards('book', 'A2');
    assert.equal(cheap.aiItems, 0); assert.equal(cheap.translationSentences, 1);
    const full = await service.previewCards('book', 'A3');
    assert.equal(full.aiItems, 1); assert.equal(full.baseCalls, 1); assert.ok(full.estimatedInputTokens > 0);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
});

test('核心歧义先换备用原句修复，并复核修复结果，减少人工待审', async () => {
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
    const result = await service.runCards('book', { tier: 'A3', profileId: 'llm', translationProfileId: '' });
    const draft = result.workflow!.cardRun!.drafts[0]!;
    assert.equal(calls, 4); assert.equal(draft.contextRef, 'second'); assert.equal(draft.repairs, 1); assert.equal(draft.status, 'ready');
  });
});

test('A4 可选提示复核失败只删提示，不增加修复请求或人工审核', async () => {
  let calls = 0;
  await fixture([item()], { lookupTerms: () => [term()], llm: { complete: async request => {
    calls++;
    const verify = request.tool?.name === 'verify_anki_pipeline';
    const result = modelResult(request.user, verify);
    const rows = JSON.parse(result.text);
    if (verify) rows.items[0].issues = [{ field: 'usage', code: 'unsupported', reason: '提示无证据' }];
    else { rows.items[0].usage = '无依据的提示'; rows.items[0].nuance = '无依据的语气'; }
    result.text = JSON.stringify(rows); return result;
  } } }, async service => {
    const result = await service.runCards('book', { tier: 'A4', profileId: 'llm', translationProfileId: '' });
    const draft = result.workflow!.cardRun!.drafts[0]!;
    assert.equal(calls, 2); assert.equal(draft.usage, ''); assert.equal(draft.nuance, ''); assert.equal(draft.status, 'ready');
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
    const result = await service.runCards('book', { tier: 'A3', profileId: 'llm', translationProfileId: '' });
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
    const work = service.runCards('book', { tier: 'A3', profileId: 'llm', translationProfileId: '' });
    await running; service.cancel('book'); await assert.rejects(work, /取消/);
    const list = service.read('book')!;
    assert.equal(list.workflow?.cardRun, undefined); assert.equal(list.workflow?.pendingCardRun?.drafts.length, 0);
    assert.ok(list.workflow?.pendingCardRun?.pipeline?.planHash);
  });
});

test('没有词典证据不能因作者或复核声称通过而自动放行', async () => {
  await fixture([item()], { lookupTerms: () => [], llm: { complete: async request => modelResult(request.user, request.tool?.name === 'verify_anki_pipeline') } }, async service => {
    const result = await service.runCards('book', { tier: 'A4', profileId: 'llm', translationProfileId: '' });
    const draft = result.workflow!.cardRun!.drafts[0]!;
    assert.equal(draft.status, 'needs_review'); assert.equal(draft.repairs, 1);
    assert.ok(draft.issues?.some(i => i.code === 'unsupported'));
  });
});

test('新档位导出已通过卡，保留待审卡且只标记实际导出项', async () => {
  const good = item(), bad = { ...item('犬'), reading: 'いぬ' };
  await fixture([good, bad], { lookupTerms: word => word === '猫' ? [term()] : [] }, async (service, file) => {
    const result = await service.runCards('book', { tier: 'A0', translationProfileId: '' });
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
    const first = await service.runCards('book', { tier: 'A0', translationProfileId: '', newCardLimit: 1 });
    assert.equal(first.workflow!.cardRun!.drafts[0]?.status, 'deferred');
    assert.equal(first.workflow!.cardRun!.drafts[1]?.status, 'ready');
    const second = await service.runCards('book', { tier: 'A0', translationProfileId: '', newCardLimit: 1 });
    assert.ok(second.workflow!.cardRun!.drafts.every(d => d.status === 'ready'));
  });
});

test('更换草稿出处重置审核；A0 补词义可人工通过，无需补不存在的句译', async () => {
  const candidate = item();
  candidate.occurrences.push({ ...candidate.occurrences[0]!, id: 'second', label: '第2页', text: '猫です。' });
  await fixture([candidate], { lookupTerms: () => [term()] }, async service => {
    await service.runCards('book', { tier: 'A0', translationProfileId: '' });
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
    await service.runCards('book', { tier: 'A0', translationProfileId: '' });
    const blocked = service.patchCard('book', '猫', { meaning: '猫', needsReview: false });
    assert.equal(blocked.workflow!.cardRun!.drafts[0]?.needsReview, true);
    const approved = service.patchCard('book', '猫', { reading: 'ねこ', needsReview: false });
    assert.equal(approved.workflow!.cardRun!.drafts[0]?.status, 'ready');
  });
});

test('预算不足时暂缓，增加预算复用同计划；未知 usage 不算零', async () => {
  let calls = 0;
  await fixture([item()], { lookupTerms: () => [term()], llm: { complete: async request => { calls++; const result = modelResult(request.user); return { ...result, usage: undefined }; } } }, async service => {
    const low = await service.runCards('book', { tier: 'A3', profileId: 'llm', translationProfileId: '', tokenBudget: 1000 });
    assert.equal(calls, 0); assert.equal(low.workflow!.cardRun!.drafts[0]?.status, 'deferred');
    const resumed = await service.runCards('book', { tier: 'A3', profileId: 'llm', translationProfileId: '', tokenBudget: 20000 });
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
    const request = { tier: 'A3' as const, profileId: 'llm', translationProfileId: '', concurrency: 1 as const };
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
    const request = { tier: 'A3' as const, profileId: 'llm', translationProfileId: '', concurrency: 1 as const };
    await assert.rejects(service.runCards('book', request));
    const result = await service.runCards('book', request);
    assert.equal(calls, 3); assert.deepEqual(result.workflow!.cardRun!.drafts.map(d => d.candidateId), items.map(i => i.id));
  });
});
