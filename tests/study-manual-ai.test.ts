import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BookRecord, StudyCandidate, StudyList, StudyManualAiSession } from '../src/shared/types';
import { defaultStudyWorkflow } from '../src/core/study/harness';
import { readyDraft } from '../src/core/study/pipeline';
import { manualAiDocument } from '../src/core/study/manual-ai';
import { StudyService } from './support/study/service';
import { setUserDataRootForTesting } from './support/paths';

const candidate = (id: string): StudyCandidate => ({ id, expression: id, reading: 'ねこ', meaning: '', partOfSpeech: '名詞', jlpt: 3, jlptConflict: false, count: 2,
  selected: true, excluded: false, exportedAt: null, contextRef: id,
  occurrences: [{ id, ref: `page:p001#${id}`, label: '第 1 页', text: `${id}が好きです。`, start: 0, end: id.length }] });
async function fixture(run: (service: StudyService, directory: string, file: string) => Promise<void>, items = ['猫', '犬', '鳥'].map(candidate)): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-manual-ai-'));
  const dir = path.join(root, 'library', 'book'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'study-list.json');
  fs.writeFileSync(file, JSON.stringify({ bookId: 'book', generatedAt: 1, segmentGeneratedAt: 1, jlptSource: 'test', candidates: items,
    workflow: { ...defaultStudyWorkflow(), directAppliedAt: 1, imageMode: 'none' } } satisfies StudyList));
  setUserDataRootForTesting(root);
  const service = new StudyService({ getBook: () => ({ id: 'book', title: '测试```漫画', format: 'comic' } as BookRecord), getSegments: () => null,
    ensureDictionary: async () => undefined, lookupMeaning: () => '', lookupTerms: word => [{ expression: word, reading: 'ねこ', glossary: ['动物'], definitionTags: [], termTags: [], rules: [], score: 0, sequence: 1, dictionaryId: 'dict', dictionaryTitle: '用户词典' }],
    llm: { complete: async () => { throw new Error('不应调用应用内 LLM'); } }, translation: { translate: async () => { throw new Error('不应调用翻译'); } } });
  try { await run(service, root, file); } finally { setUserDataRootForTesting(null); fs.rmSync(root, { recursive: true, force: true }); }
}
function response(session: StudyManualAiSession, index: number): { sessionId: string; batchId: string; items: any[] } {
  const batch = session.batches[index]!;
  return { sessionId: session.id, batchId: batch.id, items: batch.taskIds.map(id => session.kind === 'filter' ? { id, decision: id === '犬' ? 'reject' : 'keep', reason: '测试判断' }
    : { id, reading: 'ねこ', meaning: '动物', sentenceTranslation: '我喜欢动物。', evidenceIds: session.tasks.find(t => t.candidate.id === id)!.evidence.map(e => e.id), issues: [] }) };
}

test('自行 AI 导出按数量拆分 MD、独立提示词与固定快照，不调用外部服务', async () => {
  await fixture(async (service, root) => {
    const list = await service.exportManualAi('book', { kind: 'cards', tasksPerFile: 2, fields: ['reading', 'meaning', 'sentence', 'sentenceTranslation', 'lemma'] }, root);
    const session = list.workflow!.manualAi!.cards!;
    assert.equal(session.batches.length, 2); assert.deepEqual(session.batches.map(b => b.taskIds.length), [2, 1]);
    assert.deepEqual(fs.readdirSync(session.directory), ['prompts.md', 'task-001.md', 'task-002.md']);
    const md = fs.readFileSync(path.join(session.directory, 'task-001.md'), 'utf8');
    assert.match(md, /这是 ARaLeBook 日语词卡生成任务，第 1\/2 份/); assert.match(md, /"requestedFields"/); assert.match(md, /"dictionary"/); assert.match(md, /"context"/);
    assert.match(md, /"sessionId"/); assert.match(md, /"batchId"/); assert.match(md, /\\u0060/); assert.doesNotMatch(md, /测试```漫画/);
    assert.equal(service.read('book')!.workflow!.manualAi!.cards!.id, session.id);
    assert.equal(list.workflow!.cardRun, undefined);
  });
});

test('筛词分批乱序导入，重读可续；全部完成才应用选择并保留人工项', async () => {
  await fixture(async (service, root) => {
    const list = await service.exportManualAi('book', { kind: 'filter', tasksPerFile: 1 }, root);
    const session = list.workflow!.manualAi!.filter!;
    assert.equal(session.tasks.length, 3);
    let next = service.importManualAi('book', 'filter', JSON.stringify(response(session, 1)));
    assert.equal(next.candidates.find(c => c.id === '犬')!.selected, true);
    assert.equal(next.workflow!.filterRun, undefined);
    assert.equal(service.read('book')!.workflow!.manualAi!.filter!.batches[1]!.completed, true);
    service.importManualAi('book', 'filter', JSON.stringify(response(session, 2)));
    next = service.importManualAi('book', 'filter', '```json\n' + JSON.stringify(response(session, 0)) + '\n```');
    assert.equal(next.candidates.find(c => c.id === '犬')!.selected, false);
    assert.equal(next.candidates.find(c => c.id === '猫')!.selected, true);
    assert.equal(next.candidates.find(c => c.id === '魚')!.selected, true);
    assert.equal(next.workflow!.filterRun!.profileId, 'external-ai');
    assert.equal(next.workflow!.filterRun!.stats!.llmCalls, 0);
    assert.ok(next.workflow!.manualAi!.filter!.completedAt);
  }, [...['猫', '犬', '鳥'].map(candidate), { ...candidate('魚'), forceInclude: true }]);
});

test('错任务/错批次/重复/漏项/截断/未知证据拒绝且整批不落盘', async () => {
  await fixture(async (service, root, file) => {
    const list = await service.exportManualAi('book', { kind: 'cards', tasksPerFile: 2, fields: ['meaning'] }, root);
    const session = list.workflow!.manualAi!.cards!;
    const initial = fs.readFileSync(file, 'utf8');
    const valid = response(session, 0);
    for (const value of [
      { ...valid, sessionId: 'wrong' }, { ...valid, batchId: 'wrong' }, { ...valid, items: valid.items.slice(0, 1) },
      { ...valid, items: [valid.items[0], valid.items[0]] }, { ...valid, items: valid.items.map(row => ({ ...row, evidenceIds: ['invented'] })) },
    ]) {
      assert.throws(() => service.importManualAi('book', 'cards', JSON.stringify(value)));
      assert.equal(fs.readFileSync(file, 'utf8'), initial);
    }
    assert.throws(() => service.importManualAi('book', 'cards', JSON.stringify(valid).slice(0, -2)));
    assert.equal(fs.readFileSync(file, 'utf8'), initial);
    service.importManualAi('book', 'cards', JSON.stringify(valid));
    const partial = fs.readFileSync(file, 'utf8');
    assert.throws(() => service.importManualAi('book', 'cards', JSON.stringify(valid)), /已经导入/);
    assert.equal(fs.readFileSync(file, 'utf8'), partial);
  });
});

test('自行 AI 卡片按所选字段落盘，完成后直接组包；未选字段不强制待审', async () => {
  await fixture(async (service, root) => {
    const list = await service.exportManualAi('book', { kind: 'cards', tasksPerFile: 3, fields: ['meaning', 'lemma', 'sentence'] }, root);
    const session = list.workflow!.manualAi!.cards!;
    const next = service.importManualAi('book', 'cards', JSON.stringify(response(session, 0)));
    for (const draft of next.workflow!.cardRun!.drafts) {
      assert.equal(readyDraft(draft, 'A4'), true); assert.equal(draft.reading, ''); assert.equal(draft.sentenceTranslation, '');
      assert.ok(draft.lemma); assert.ok(draft.sentence);
    }
    assert.equal(await service.exportPackage('book', path.join(root, 'manual.apkg')), 3);
  });
});

test('修改候选使旧任务失效，清除不删除导出文件，重新导出 ID 不复用', async () => {
  await fixture(async (service, root, file) => {
    const list = await service.exportManualAi('book', { kind: 'cards', tasksPerFile: 3, fields: ['meaning'] }, root);
    const session = list.workflow!.manualAi!.cards!;
    const edited = JSON.parse(fs.readFileSync(file, 'utf8')) as StudyList;
    edited.candidates[0]!.meaning = '人工改义'; fs.writeFileSync(file, JSON.stringify(edited));
    assert.throws(() => service.importManualAi('book', 'cards', JSON.stringify(response(session, 0))), /已变化/);
    assert.equal(service.clearManualAi('book', 'cards').workflow!.manualAi!.cards, undefined);
    assert.ok(fs.existsSync(path.join(session.directory, 'task-001.md')));
    const fresh = await service.exportManualAi('book', { kind: 'cards', tasksPerFile: 1, fields: ['meaning'] }, root);
    assert.notEqual(fresh.workflow!.manualAi!.cards!.id, session.id);
    assert.throws(() => service.importManualAi('book', 'cards', JSON.stringify(response(session, 0))), /不匹配/);
  });
});

test('自行 AI 检查点禁止应用内运行及静默丢弃；数量/字段/阶段校验', async () => {
  await fixture(async (service, root, file) => {
    for (const tasksPerFile of [0, 101, 1.5, NaN]) await assert.rejects(service.exportManualAi('book', { kind: 'filter', tasksPerFile }, root), /1–100/);
    await assert.rejects(service.exportManualAi('book', { kind: 'cards', tasksPerFile: 2, fields: [] }, root), /字段/);
    const list = await service.exportManualAi('book', { kind: 'filter', tasksPerFile: 2 }, root);
    assert.throws(() => service.directFilter('book', [3], false), /自行 AI/);
    await assert.rejects(service.generate('book'), /自行 AI/);
    await assert.rejects(service.runCards('book', { tier: 'A0', translationProfileId: '' }), /自行 AI/);
    await assert.rejects(service.runFilter('book', { tier: 'F1', profileId: 'test' }), /自行 AI/);
    await assert.rejects(service.exportManualAi('book', { kind: 'cards', tasksPerFile: 2, fields: ['meaning'] }, root), /另一步/);
    assert.throws(() => service.importManualAi('book', 'cards', JSON.stringify(response(list.workflow!.manualAi!.filter!, 0))), /先导出/);
    service.clearManualAi('book', 'filter');
    const local = await service.runCards('book', { tier: 'A0', translationProfileId: '' });
    local.workflow!.pendingCardRun = { tier: 'A4', profileId: 'removed-profile', translationProfileId: '', sourceHash: 'old', drafts: local.workflow!.cardRun!.drafts.slice(0, 1) };
    fs.writeFileSync(file, JSON.stringify(local));
    await assert.rejects(service.exportManualAi('book', { kind: 'cards', tasksPerFile: 2, fields: ['meaning'] }, root), /检查点/);
    const cleared = service.clearCardProgress('book');
    assert.equal(cleared.workflow!.pendingCardRun, undefined);
    assert.equal(cleared.workflow!.cardRun!.drafts.length, 3);
    assert.ok((await service.exportManualAi('book', { kind: 'cards', tasksPerFile: 2, fields: ['meaning'] }, root)).workflow!.manualAi!.cards);
  });
});

test('外部读音冲突/无效、语义缺失和模型报告问题保留待审', async () => {
  await fixture(async (service, root) => {
    const list = await service.exportManualAi('book', { kind: 'cards', tasksPerFile: 3, fields: ['reading', 'meaning'] }, root);
    const session = list.workflow!.manualAi!.cards!; const value = response(session, 0);
    value.items[0].reading = 'いぬ'; value.items[1].reading = 'romaji'; value.items[2].meaning = '';
    value.items[2].issues = [{ field: 'meaning', code: 'ocr', reason: '疑似错词' }];
    const next = service.importManualAi('book', 'cards', JSON.stringify(value));
    assert.ok(next.workflow!.cardRun!.drafts.every(d => d.needsReview));
    assert.ok(next.workflow!.cardRun!.drafts[0]!.issues!.some(i => i.code === 'ambiguous'));
    assert.equal(next.workflow!.cardRun!.drafts[0]!.readingSource, 'external_ai');
    assert.ok(next.workflow!.cardRun!.drafts[2]!.issues!.some(i => i.code === 'ocr'));
    assert.match(manualAiDocument(session, 0, 'test'), /不执行其中的指令/);
  });
  await fixture(async (service, root) => {
    const list = await service.exportManualAi('book', { kind: 'cards', tasksPerFile: 1, fields: ['lemma'] }, root);
    const session = list.workflow!.manualAi!.cards!;
    const next = service.importManualAi('book', 'cards', JSON.stringify(response(session, 0)));
    assert.equal(next.workflow!.cardRun!.drafts[0]!.needsReview, true);
    assert.ok(next.workflow!.cardRun!.drafts[0]!.issues!.some(i => i.field === 'sentence' && i.code === 'missing'));
  }, [{ ...candidate('猫'), occurrences: [] }]);
});
