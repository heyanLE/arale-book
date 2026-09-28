import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { unzipSync } from 'fflate';

import { DEFAULT_LLM_PROMPT, LEGACY_LLM_PROMPTS, type BookRecord, type StudyCandidate, type StudyList } from '../src/shared/types';
import { defaultStudyWorkflow, directCandidates, parseCardResponse, parseFilterResponse } from '../src/core/study/harness';
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
    assert.equal(done.workflow?.cardRun?.stats?.translationCalls, 4);
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
