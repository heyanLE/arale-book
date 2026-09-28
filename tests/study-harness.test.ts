import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { unzipSync } from 'fflate';

import { DEFAULT_LLM_PROMPT, LEGACY_LLM_PROMPTS, type BookRecord, type StudyCandidate, type StudyList } from '../src/shared/types';
import { CARD_TIERS, FILTER_TIERS, cardHarnessPrompt, defaultStudyWorkflow, directCandidates, estimatedLlmCalls, filterHarnessPrompt, parseCardBatchResponse, parseCardResponse, parseFilterResponse, parseVerifyBatchResponse } from '../src/core/study/harness';
import { cropRect } from '../src/main/study/crop';
import { StudyService } from '../src/main/study/service';
import { setUserDataRootForTesting } from '../src/main/paths';
import { LlmService } from '../src/main/llm/service';

function candidate(id: string, jlpt: StudyCandidate['jlpt'], conflict = false): StudyCandidate {
  return {
    id, expression: id, reading: 'よみ', partOfSpeech: '名詞', jlpt, jlptConflict: conflict,
    count: 2, meaning: '原释义', selected: false, excluded: false, exportedAt: null,
    contextRef: `page:p001.png#0@0`,
    occurrences: [{ id: 'page:p001.png#0@0', ref: 'page:p001.png#0', label: '第 1 页', text: `${id}が好き`, start: 0, end: id.length }],
  };
}

test('直接筛选逐级勾选默认 N3/N2/N1，未分级和冲突另选', () => {
  assert.deepEqual(defaultStudyWorkflow().levels, [1, 2, 3]);
  const items = [candidate('N5词', 5), candidate('N4词', 4), candidate('N3词', 3), candidate('N2词', 2), candidate('N1词', 1), candidate('未知词', null), candidate('冲突词', 2, true)];
  assert.deepEqual(directCandidates(items, [1, 2, 3], false).map((item) => item.id), ['N3词', 'N2词', 'N1词']);
  assert.deepEqual(directCandidates(items, [5], true).map((item) => item.id), ['N5词', '未知词', '冲突词']);
});

test('Harness 拒绝缺项/重复 ID，制卡 JSON 必须包含词义与句译', () => {
  assert.throws(() => parseFilterResponse('{"items":[]}', ['a']), /数量/);
  assert.throws(() => parseFilterResponse('{"items":[{"id":"a","decision":"keep"},{"id":"a","decision":"reject"}]}', ['a', 'b']), /重复/);
  assert.throws(() => parseCardResponse('{"meaning":"词义"}', 'a'), /句译/);
  assert.equal(parseCardResponse('```json\n{"meaning":"词义","sentenceTranslation":"句译"}\n```', 'a').meaning, '词义');
  const response = JSON.stringify({ items: [
    { id: 'b', meaning: '乙', sentenceTranslation: '译乙' },
    { id: 'a', meaning: '甲', sentenceTranslation: '译甲' },
  ] });
  assert.deepEqual(parseCardBatchResponse(response, ['a', 'b']).map((item) => item.candidateId), ['b', 'a']);
  assert.throws(() => parseCardBatchResponse(response, ['a', 'c']), /未知/);
  assert.throws(() => parseVerifyBatchResponse('{"items":[{"id":"a","approved":true}]}', ['a', 'b']), /数量/);
});

test('小批次调用数按档位和候选数计算', () => {
  assert.equal(estimatedLlmCalls(200, FILTER_TIERS.F1), 17);
  assert.equal(estimatedLlmCalls(200, FILTER_TIERS.F2), 25);
  assert.equal(estimatedLlmCalls(200, FILTER_TIERS.F3), 50);
  assert.equal(estimatedLlmCalls(200, CARD_TIERS.R0), 0);
  assert.equal(estimatedLlmCalls(200, CARD_TIERS.R1), 34);
  assert.equal(estimatedLlmCalls(200, CARD_TIERS.R3), 68);
});

test('过长 OCR 块只把目标词附近片段送入模型，并标明已截断', () => {
  const item = candidate('特別', 3);
  item.occurrences[0]!.text = `${'あ'.repeat(500)}特別${'い'.repeat(500)}`;
  item.occurrences[0]!.start = 500;
  item.occurrences[0]!.end = 502;
  const filterPayload = JSON.parse(filterHarnessPrompt('F2', [item]).user) as Array<{ sentence: string; contextTruncated: boolean; surface: string }>;
  assert.equal(filterPayload[0]?.sentence.length, 320);
  assert.equal(filterPayload[0]?.contextTruncated, true);
  assert.ok(filterPayload[0]?.sentence.includes('特別'));
  const cardPayload = JSON.parse(cardHarnessPrompt('R1', [{ candidate: item, translatedWord: '特别', translatedSentence: '译'.repeat(900) }]).user) as Array<{ translatedSentence: string; translationTruncated: boolean }>;
  assert.equal(cardPayload[0]?.translatedSentence.length, 600);
  assert.equal(cardPayload[0]?.translationTruncated, true);
});

test('模型即使声称通过，输入上下文截断的卡仍进入待审', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-truncated-'));
  const bookId = 'bk_truncated';
  const dir = path.join(root, 'library', bookId);
  fs.mkdirSync(dir, { recursive: true });
  setUserDataRootForTesting(root);
  try {
    const item = candidate('特別', 3);
    item.occurrences[0]!.text = `${'あ'.repeat(500)}特別`;
    item.occurrences[0]!.start = 500;
    item.occurrences[0]!.end = 502;
    fs.writeFileSync(path.join(dir, 'study-list.json'), JSON.stringify({
      bookId, generatedAt: 1, segmentGeneratedAt: 1, jlptSource: 'test', candidates: [item], workflow: defaultStudyWorkflow(),
    } satisfies StudyList));
    const service = new StudyService({
      getBook: () => ({ id: bookId, title: '测试', format: 'comic' } as BookRecord),
      getSegments: () => null, ensureDictionary: async () => undefined, lookupMeaning: () => '',
      llm: { complete: async () => ({ ok: true, text: '{"meaning":"特别","sentenceTranslation":"译文","needsReview":false}', profileName: 'test', model: 'test' }) },
      translation: { translate: async () => ({ ok: true, text: '译文', sourceReading: '', profileName: 'test', provider: 'bing', sourceLanguage: 'ja', targetLanguage: 'zh-Hans' }) },
    });
    service.directFilter(bookId, [3], false);
    const result = await service.runCards(bookId, { tier: 'R1', profileId: 'p1', translationProfileId: 'bing' });
    assert.equal(result.workflow?.cardRun?.drafts[0]?.needsReview, true);
    assert.match(result.workflow?.cardRun?.drafts[0]?.reviewReason ?? '', /截取/);
  } finally {
    setUserDataRootForTesting(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('漫画裁图使用像素框并夹在原图内', () => {
  assert.deepEqual(cropRect([2, 3, 30, 40], 100, 100), { x: 0, y: 0, width: 38, height: 48 });
  assert.throws(() => cropRect([120, 3, 130, 40], 100, 100), /无效/);
});

test('R0 翻译＋裁图生成可校验的 .apkg，候选变化后禁止导出旧草稿', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-deck-'));
  const bookId = 'bk_harness_test';
  const dir = path.join(root, 'library', bookId);
  fs.mkdirSync(dir, { recursive: true });
  setUserDataRootForTesting(root);
  try {
    const list: StudyList = {
      bookId, generatedAt: 1, segmentGeneratedAt: 1, jlptSource: 'test',
      candidates: [candidate('猫', 3)], // 旧版文件没有 workflow；直接筛选须补默认配置。
    };
    fs.writeFileSync(path.join(dir, 'study-list.json'), JSON.stringify(list));
    const book = { id: bookId, title: '测试漫画', format: 'comic' } as BookRecord;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/S28AAAAASUVORK5CYII=', 'base64');
    const service = new StudyService({
      getBook: () => book, getSegments: () => null, ensureDictionary: async () => undefined,
      lookupMeaning: () => '',
      translation: { translate: async (request) => ({ ok: true, text: request.text === '猫' ? '猫' : '喜欢猫', sourceReading: '', profileName: '假翻译', provider: 'bing', sourceLanguage: 'ja', targetLanguage: 'zh-Hans' }) },
      crop: () => ({ name: 'manga_test.png', data: png }),
    });
    const filtered = service.directFilter(bookId, [3], false);
    assert.equal(filtered.candidates[0]?.selected, true);
    const made = await service.runCards(bookId, { tier: 'R0', translationProfileId: 'bing' });
    assert.equal(made.workflow?.cardRun?.drafts[0]?.meaning, '猫');
    const target = path.join(root, 'deck.apkg');
    assert.equal(await service.exportPackage(bookId, target), 1);
    const archive = unzipSync(fs.readFileSync(target));
    assert.ok(archive['collection.anki2']);
    assert.deepEqual(JSON.parse(Buffer.from(archive['media']!).toString()), { 0: 'manga_test.png' });
    assert.deepEqual(Buffer.from(archive['0']!), png);
    const initSqlJs = require('sql.js/dist/sql-asm-memory-growth.js') as typeof import('sql.js');
    const SQL = await initSqlJs();
    const db = new SQL.Database(archive['collection.anki2']);
    try {
      assert.equal(db.exec('PRAGMA integrity_check')[0]?.values[0]?.[0], 'ok');
      assert.equal(db.exec('SELECT COUNT(*) FROM notes')[0]?.values[0]?.[0], 1);
      assert.equal(db.exec('SELECT COUNT(*) FROM cards')[0]?.values[0]?.[0], 1);
      const fields = String(db.exec('SELECT flds FROM notes')[0]?.values[0]?.[0]).split('\x1f');
      assert.match(fields[4] ?? '', /<mark>猫<\/mark>/);
      assert.match(fields[8] ?? '', /manga_test.png/);
    } finally { db.close(); }
    service.patch(bookId, '猫', { reading: 'ねこ' });
    await assert.rejects(service.exportPackage(bookId, target), /候选已变化/);
  } finally {
    setUserDataRootForTesting(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('F3 两轮意见不同保留待审，R3 未通过复核时阻止导出', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-harness-'));
  const bookId = 'bk_harness_review';
  const dir = path.join(root, 'library', bookId);
  fs.mkdirSync(dir, { recursive: true });
  setUserDataRootForTesting(root);
  try {
    fs.writeFileSync(path.join(dir, 'study-list.json'), JSON.stringify({
      bookId, generatedAt: 1, segmentGeneratedAt: 1, jlptSource: 'test',
      candidates: [candidate('猫', 3), { ...candidate('手动短语', null), partOfSpeech: '短语' }], workflow: defaultStudyWorkflow(),
    } satisfies StudyList));
    const service = new StudyService({
      getBook: () => ({ id: bookId, title: '测试', format: 'comic' } as BookRecord),
      getSegments: () => null, ensureDictionary: async () => undefined, lookupMeaning: () => '',
      llm: { complete: async ({ system }) => {
        let text: string;
        if (system?.includes('独立复核第一轮')) text = '{"items":[{"id":"猫","decision":"keep","reason":"有语境"}]}';
        else if (system?.includes('筛选器')) text = '{"items":[{"id":"猫","decision":"reject","reason":"疑似噪声"}]}';
        else if (system?.includes('独立的审稿人')) text = '{"approved":false,"reason":"句译需核对"}';
        else text = '{"meaning":"猫","sentenceTranslation":"喜欢猫","usage":"","nuance":"","needsReview":false,"reviewReason":""}';
        return { ok: true, text, profileName: 'test', model: 'test' };
      } },
      translation: { translate: async () => ({ ok: true, text: '喜欢猫', sourceReading: '', profileName: 'test', provider: 'bing', sourceLanguage: 'ja', targetLanguage: 'zh-Hans' }) },
      crop: () => ({ name: 'x.png', data: Buffer.from([1]) }),
    });
    service.directFilter(bookId, [3], false);
    service.patch(bookId, '手动短语', { selected: true });
    const filtered = await service.runFilter(bookId, { tier: 'F3', profileId: 'p1' });
    assert.equal(filtered.workflow?.filterRun?.decisions['猫']?.decision, 'review');
    assert.equal(filtered.candidates[0]?.selected, true);
    assert.equal(filtered.candidates[1]?.selected, true, '人工选入的未分级短语不能被 LLM 筛选清掉');
    const made = await service.runCards(bookId, { tier: 'R3', profileId: 'p1', translationProfileId: 'bing' });
    assert.equal(made.workflow?.cardRun?.drafts[0]?.needsReview, true);
    await assert.rejects(service.exportPackage(bookId, path.join(root, 'blocked.apkg')), /存疑/);
    const patched = service.patchCard(bookId, '猫', { sentenceTranslation: '我喜欢猫', needsReview: false });
    assert.equal(patched.workflow?.cardRun?.drafts[0]?.needsReview, false);
  } finally {
    setUserDataRootForTesting(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('批量制卡失败后可从已完成草稿续跑，不重复翻译前一张卡', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-resume-'));
  const bookId = 'bk_resume';
  const dir = path.join(root, 'library', bookId);
  fs.mkdirSync(dir, { recursive: true });
  setUserDataRootForTesting(root);
  try {
    fs.writeFileSync(path.join(dir, 'study-list.json'), JSON.stringify({
      bookId, generatedAt: 1, segmentGeneratedAt: 1, jlptSource: 'test',
      candidates: [candidate('猫', 3), candidate('犬', 2)], workflow: defaultStudyWorkflow(),
    } satisfies StudyList));
    const calls: string[] = [];
    let failOnce = true;
    const service = new StudyService({
      getBook: () => ({ id: bookId, title: '测试', format: 'comic' } as BookRecord),
      getSegments: () => null, ensureDictionary: async () => undefined, lookupMeaning: () => '',
      translation: { translate: async (request) => {
        calls.push(request.text);
        if (request.text === '犬' && failOnce) { failOnce = false; return { ok: false, text: '', sourceReading: '', profileName: 'test', provider: 'bing', sourceLanguage: 'ja', targetLanguage: 'zh-Hans', error: '暂时失败' }; }
        return { ok: true, text: '译文', sourceReading: '', profileName: 'test', provider: 'bing', sourceLanguage: 'ja', targetLanguage: 'zh-Hans' };
      } },
    });
    service.directFilter(bookId, [2, 3], false);
    await assert.rejects(service.runCards(bookId, { tier: 'R0', translationProfileId: 'bing' }), /暂时失败/);
    assert.equal(service.read(bookId)?.workflow?.pendingCardRun?.drafts.length, 1);
    const done = await service.runCards(bookId, { tier: 'R0', translationProfileId: 'bing' });
    assert.equal(done.workflow?.cardRun?.drafts.length, 2);
    assert.equal(calls.filter((text) => text === '猫').length, 1);
    assert.equal(done.workflow?.cardRun?.stats?.translationCalls, 6, '失败批次的两次翻译也计入实际调用');
  } finally {
    setUserDataRootForTesting(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('F2 和 R1 用单次请求处理多项，按 ID 对齐输出并保存真实调用数', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-batched-'));
  const bookId = 'bk_batched';
  const dir = path.join(root, 'library', bookId);
  fs.mkdirSync(dir, { recursive: true });
  setUserDataRootForTesting(root);
  try {
    const candidates = Array.from({ length: 17 }, (_, index) => candidate(`詞${index}`, 3));
    fs.writeFileSync(path.join(dir, 'study-list.json'), JSON.stringify({
      bookId, generatedAt: 1, segmentGeneratedAt: 1, jlptSource: 'test', candidates, workflow: defaultStudyWorkflow(),
    } satisfies StudyList));
    let filterCalls = 0;
    let cardCalls = 0;
    const service = new StudyService({
      getBook: () => ({ id: bookId, title: '测试', format: 'comic' } as BookRecord),
      getSegments: () => null, ensureDictionary: async () => undefined, lookupMeaning: () => '',
      llm: { complete: async ({ system, user }) => {
        const input = JSON.parse(user) as Array<{ id: string; word: string }>;
        let text: string;
        if (system?.includes('筛选器')) {
          filterCalls += 1;
          text = JSON.stringify({ items: input.map((item) => ({ id: item.id, decision: 'keep', reason: '可学习' })).reverse() });
        } else {
          cardCalls += 1;
          text = JSON.stringify({ items: input.map((item) => ({ id: item.id, meaning: `义${item.word}`, sentenceTranslation: `译${item.word}`, usage: '', nuance: '', needsReview: false, reviewReason: '' })).reverse() });
        }
        return { ok: true, text, profileName: 'test', model: 'test' };
      } },
      translation: { translate: async () => ({ ok: true, text: '翻译', sourceReading: '', profileName: 'test', provider: 'bing', sourceLanguage: 'ja', targetLanguage: 'zh-Hans' }) },
    });
    service.directFilter(bookId, [3], false);
    const filtered = await service.runFilter(bookId, { tier: 'F2', profileId: 'p1' });
    assert.equal(filterCalls, 3);
    assert.equal(filtered.workflow?.filterRun?.stats?.llmCalls, 3);
    const made = await service.runCards(bookId, { tier: 'R1', profileId: 'p1', translationProfileId: 'bing' });
    assert.equal(cardCalls, 3);
    assert.equal(made.workflow?.cardRun?.stats?.llmCalls, 3);
    assert.equal(made.workflow?.cardRun?.stats?.translationCalls, 34);
    assert.deepEqual(made.workflow?.cardRun?.drafts.map((item) => item.candidateId), candidates.map((item) => item.id));
    assert.equal(made.workflow?.cardRun?.drafts[0]?.meaning, '义詞0');
  } finally {
    setUserDataRootForTesting(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('F3 和 R3 每批各运行生成与复核两次请求', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-two-pass-'));
  const bookId = 'bk_two_pass';
  const dir = path.join(root, 'library', bookId);
  fs.mkdirSync(dir, { recursive: true });
  setUserDataRootForTesting(root);
  try {
    const candidates = Array.from({ length: 7 }, (_, index) => candidate(`詞${index}`, 3));
    fs.writeFileSync(path.join(dir, 'study-list.json'), JSON.stringify({
      bookId, generatedAt: 1, segmentGeneratedAt: 1, jlptSource: 'test', candidates, workflow: defaultStudyWorkflow(),
    } satisfies StudyList));
    let filterCalls = 0;
    let cardCalls = 0;
    const service = new StudyService({
      getBook: () => ({ id: bookId, title: '测试', format: 'comic' } as BookRecord),
      getSegments: () => null, ensureDictionary: async () => undefined, lookupMeaning: () => '',
      llm: { complete: async ({ system, user }) => {
        const input = JSON.parse(user) as unknown;
        let text: string;
        if (system?.includes('筛选器') || system?.includes('独立复核第一轮')) {
          filterCalls += 1;
          const rows = Array.isArray(input) ? input as Array<{ id: string }> : (input as { candidates: Array<{ id: string }> }).candidates;
          text = JSON.stringify({ items: rows.map((item) => ({ id: item.id, decision: 'keep', reason: '保留' })) });
        } else if (system?.includes('独立的审稿人')) {
          cardCalls += 1;
          const rows = input as Array<{ source: { id: string } }>;
          text = JSON.stringify({ items: rows.map((item) => ({ id: item.source.id, approved: true, reason: '' })) });
        } else {
          cardCalls += 1;
          const rows = input as Array<{ id: string }>;
          text = JSON.stringify({ items: rows.map((item) => ({ id: item.id, meaning: '词义', sentenceTranslation: '句译', usage: '', nuance: '', needsReview: false, reviewReason: '' })) });
        }
        return { ok: true, text, profileName: 'test', model: 'test' };
      } },
      translation: { translate: async () => ({ ok: true, text: '翻译', sourceReading: '', profileName: 'test', provider: 'bing', sourceLanguage: 'ja', targetLanguage: 'zh-Hans' }) },
    });
    service.directFilter(bookId, [3], false);
    const filtered = await service.runFilter(bookId, { tier: 'F3', profileId: 'p1' });
    assert.equal(filterCalls, 2);
    assert.equal(filtered.workflow?.filterRun?.stats?.llmCalls, 2);
    const made = await service.runCards(bookId, { tier: 'R3', profileId: 'p1', translationProfileId: 'bing' });
    assert.equal(cardCalls, 4);
    assert.equal(made.workflow?.cardRun?.stats?.llmCalls, 4);
    assert.ok(made.workflow?.cardRun?.drafts.every((item) => !item.needsReview));
  } finally {
    setUserDataRootForTesting(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('批量输出缺项时自动缩批，并保存每个完成的子批次', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-split-'));
  const bookId = 'bk_split';
  const dir = path.join(root, 'library', bookId);
  fs.mkdirSync(dir, { recursive: true });
  setUserDataRootForTesting(root);
  try {
    const candidates = Array.from({ length: 3 }, (_, index) => candidate(`詞${index}`, 3));
    fs.writeFileSync(path.join(dir, 'study-list.json'), JSON.stringify({
      bookId, generatedAt: 1, segmentGeneratedAt: 1, jlptSource: 'test', candidates, workflow: defaultStudyWorkflow(),
    } satisfies StudyList));
    let calls = 0;
    const service = new StudyService({
      getBook: () => ({ id: bookId, title: '测试', format: 'comic' } as BookRecord),
      getSegments: () => null, ensureDictionary: async () => undefined, lookupMeaning: () => '',
      llm: { complete: async ({ user }) => {
        calls += 1;
        const items = JSON.parse(user) as Array<{ id: string }>;
        const text = items.length > 1 ? '{"items":[]}' : JSON.stringify({ items: [{ id: items[0]?.id, decision: 'keep', reason: '可学习' }] });
        return { ok: true, text, profileName: 'test', model: 'test' };
      } },
    });
    service.directFilter(bookId, [3], false);
    const filtered = await service.runFilter(bookId, { tier: 'F2', profileId: 'p1' });
    assert.equal(calls, 5, '3 项失败后拆成 2+1，2 项再拆成 1+1');
    assert.equal(filtered.workflow?.filterRun?.stats?.llmCalls, 5);
    assert.equal(Object.keys(filtered.workflow?.filterRun?.decisions ?? {}).length, 3);
  } finally {
    setUserDataRootForTesting(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('小模型报告上下文超限时自动拆批', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-context-split-'));
  const bookId = 'bk_context_split';
  const dir = path.join(root, 'library', bookId);
  fs.mkdirSync(dir, { recursive: true });
  setUserDataRootForTesting(root);
  try {
    fs.writeFileSync(path.join(dir, 'study-list.json'), JSON.stringify({
      bookId, generatedAt: 1, segmentGeneratedAt: 1, jlptSource: 'test',
      candidates: [candidate('猫', 3), candidate('犬', 3)], workflow: defaultStudyWorkflow(),
    } satisfies StudyList));
    let calls = 0;
    const service = new StudyService({
      getBook: () => ({ id: bookId, title: '测试', format: 'comic' } as BookRecord),
      getSegments: () => null, ensureDictionary: async () => undefined, lookupMeaning: () => '',
      llm: { complete: async ({ user }) => {
        calls += 1;
        const rows = JSON.parse(user) as Array<{ id: string }>;
        return rows.length > 1
          ? { ok: false, text: '', profileName: 'test', model: 'test', error: 'maximum context length exceeded' }
          : { ok: true, text: JSON.stringify({ items: [{ id: rows[0]?.id, decision: 'keep', reason: '保留' }] }), profileName: 'test', model: 'test' };
      } },
    });
    service.directFilter(bookId, [3], false);
    const result = await service.runFilter(bookId, { tier: 'F2', profileId: 'p1' });
    assert.equal(calls, 3);
    assert.equal(result.workflow?.filterRun?.stats?.llmCalls, 3);
  } finally {
    setUserDataRootForTesting(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R1 第二批失败后只续跑未完成的卡片批次', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-batch-resume-'));
  const bookId = 'bk_batch_resume';
  const dir = path.join(root, 'library', bookId);
  fs.mkdirSync(dir, { recursive: true });
  setUserDataRootForTesting(root);
  try {
    const candidates = Array.from({ length: 8 }, (_, index) => candidate(`詞${index}`, 3));
    fs.writeFileSync(path.join(dir, 'study-list.json'), JSON.stringify({
      bookId, generatedAt: 1, segmentGeneratedAt: 1, jlptSource: 'test', candidates, workflow: defaultStudyWorkflow(),
    } satisfies StudyList));
    let calls = 0;
    const translated: string[] = [];
    const service = new StudyService({
      getBook: () => ({ id: bookId, title: '测试', format: 'comic' } as BookRecord),
      getSegments: () => null, ensureDictionary: async () => undefined, lookupMeaning: () => '',
      llm: { complete: async ({ user }) => {
        calls += 1;
        if (calls === 2) return { ok: false, text: '', profileName: 'test', model: 'test', error: '暂时失败' };
        const rows = JSON.parse(user) as Array<{ id: string }>;
        return { ok: true, text: JSON.stringify({ items: rows.map((item) => ({ id: item.id, meaning: '词义', sentenceTranslation: '句译' })) }), profileName: 'test', model: 'test' };
      } },
      translation: { translate: async (request) => {
        translated.push(request.text);
        return { ok: true, text: '译', sourceReading: '', profileName: 'test', provider: 'bing', sourceLanguage: 'ja', targetLanguage: 'zh-Hans' };
      } },
    });
    service.directFilter(bookId, [3], false);
    await assert.rejects(service.runCards(bookId, { tier: 'R1', profileId: 'p1', translationProfileId: 'bing' }), /暂时失败/);
    assert.equal(service.read(bookId)?.workflow?.pendingCardRun?.drafts.length, 6);
    const finished = await service.runCards(bookId, { tier: 'R1', profileId: 'p1', translationProfileId: 'bing' });
    assert.equal(calls, 3);
    assert.equal(translated.filter((text) => text === '詞0').length, 1);
    assert.equal(finished.workflow?.cardRun?.drafts.length, 8);
    assert.equal(finished.workflow?.cardRun?.stats?.llmCalls, 3, '失败批次的 LLM 请求也计入实际调用');
  } finally {
    setUserDataRootForTesting(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('新版默认提示词更重视语境和不确定性，旧默认仍能自动升级', () => {
  assert.match(DEFAULT_LLM_PROMPT, /本句词义/);
  assert.match(DEFAULT_LLM_PROMPT, /不确定/);
  assert.match(DEFAULT_LLM_PROMPT, /外来語/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-llm-prompt-'));
  try {
    const file = path.join(root, 'llm.json');
    fs.writeFileSync(file, JSON.stringify({ profiles: [], activeProfileId: null, prompt: LEGACY_LLM_PROMPTS[1] }));
    assert.equal(new LlmService({ settingsFile: file }).settings().prompt, DEFAULT_LLM_PROMPT);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
