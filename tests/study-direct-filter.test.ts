import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { BookRecord, StudyCandidate, StudyList } from '../src/shared/types';
import { defaultDirectOptions, directFilterStages, normalizeDirectOptions, studyPriorityScore } from '../src/core/study/harness';
import { StudyService } from '../src/main/study/service';
import { wordfreqSource, zipfForCandidate } from '../src/main/study/wordfreq';
import { setUserDataRootForTesting } from '../src/main/paths';

function item(id: string, overrides: Partial<StudyCandidate> = {}): StudyCandidate {
  return {
    id, expression: id, reading: 'よみ', partOfSpeech: '名詞', jlpt: 3, jlptConflict: false,
    count: 3, occurrences: [{ id: `page:a#0@0`, ref: 'page:a#0', label: '第 1 页', text: id, start: 0, end: id.length }],
    meaning: '', selected: false, excluded: false, contextRef: 'page:a#0@0', exportedAt: null,
    ...overrides,
  };
}

test('新增层默认宽松，人工保留可绕过自动层，明确排除始终优先', () => {
  const defaults = defaultDirectOptions();
  assert.equal(defaults.minOccurrences, null);
  assert.equal(defaults.minZipf, null);
  const values = [
    item('猫', { zipf: 5.05 }),
    item('太郎', { properName: true, zipf: 4.2 }),
    item('2025', { posDetail: '数', zipf: 3.5 }),
    item('罕见', { zipf: 2.1 }),
    item('单次', { count: 1, zipf: 5 }),
    item('词频未知', { zipf: null }),
    item('手动短语', { jlpt: 5, count: 1, zipf: null, forceInclude: true, partOfSpeech: '短语' }),
    item('显式排除', { excluded: true, forceInclude: true, zipf: 6 }),
  ];
  assert.equal(directFilterStages(values, [3], false).selected.length, 7, '新增层未启用时只保留旧 JLPT 行为及人工例外');
  const rules = normalizeDirectOptions({
    ...defaults, partOfSpeech: 'core', excludeProperNames: true, excludeNumbers: true,
    minOccurrences: 2, minZipf: 2.5, missingZipf: 'keep',
  });
  const result = directFilterStages(values, [3], false, rules);
  assert.deepEqual(result.selected.map((one) => one.id), ['猫', '词频未知', '手动短语']);
  assert.deepEqual(result.stages.map((stage) => [stage.name, stage.remaining]), [
    ['人工排除', 7], ['JLPT 参考等级', 7], ['词条类型与噪声', 5],
    ['作品内重复', 4], ['通用词频 Zipf', 3],
  ]);
  assert.deepEqual(directFilterStages(values, [3], false, { ...rules, missingZipf: 'exclude' }).selected.map((one) => one.id), ['猫', '手动短语']);
  assert.deepEqual(result.reasons['单次'], ['只出现 1 次，低于 2 次']);
  assert.deepEqual(result.reasons['太郎'], ['分词器识别为专名']);
  assert.deepEqual(result.reasons['显式排除']?.[0], '手动排除');
  assert.equal(directFilterStages([{ ...values[6]!, forceInclude: false }], [3], false, rules).selected.length, 0,
    '撤销手动保留时必须重新按规则判断，不能沿用原来绕过规则的入选状态');
});

test('未收录等级与等级冲突可独立选择，旧配置仍沿用合并开关', () => {
  const values = [item('未分级', { jlpt: null }), item('冲突', { jlpt: 2, jlptConflict: true })];
  assert.deepEqual(directFilterStages(values, [3], true).selected.map((one) => one.id), ['未分级', '冲突']);
  const split = directFilterStages(values, [3], false, { includeConflict: true });
  assert.deepEqual(split.selected.map((one) => one.id), ['冲突']);
  assert.deepEqual(split.reasons['未分级'], ['JLPT 未收录等级']);
  assert.deepEqual(directFilterStages(values, [3], true, { includeConflict: false }).selected.map((one) => one.id), ['未分级']);
});

test('wordfreq 包内 Zipf 可用，未收录与低频分开，排序只改变优先级', () => {
  assert.equal(wordfreqSource(), 'wordfreq@3.1.1/ja-large');
  assert.equal(zipfForCandidate(item('猫')), 5.05);
  assert.equal(zipfForCandidate(item('架空語xyz')), null);
  const frequent = item('猫', { count: 4, pageCount: 3, zipf: 5.05 });
  const rare = item('罕见', { count: 1, pageCount: 1, zipf: 1.5 });
  assert.ok(studyPriorityScore(frequent) > studyPriorityScore(rare));
  assert.equal(normalizeDirectOptions({ minOccurrences: -1, minZipf: 99 }).minZipf, null);
});

test('旧学习文件读盘补 Zipf，新增筛选设置持久化且可覆盖频次/词频', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-direct-layers-'));
  const bookId = 'bk_direct_layers';
  const dir = path.join(root, 'library', bookId);
  fs.mkdirSync(dir, { recursive: true });
  setUserDataRootForTesting(root);
  try {
    const list: StudyList = {
      bookId, generatedAt: 1, segmentGeneratedAt: 1, jlptSource: 'test',
      candidates: [item('猫', { count: 2 }), item('架空語xyz', { count: 3 }), item('寿司', { count: 1 })],
    };
    fs.writeFileSync(path.join(dir, 'study-list.json'), JSON.stringify(list));
    const service = new StudyService({
      getBook: () => ({ id: bookId, title: '测试', format: 'comic' } as BookRecord),
      getSegments: () => null, ensureDictionary: async () => undefined, lookupMeaning: () => '',
    });
    assert.equal(service.read(bookId)?.candidates[0]?.zipf, 5.05);
    const filtered = service.directFilter(bookId, [3], false, {
      ...defaultDirectOptions(), minOccurrences: 2, minZipf: 2.5, missingZipf: 'exclude',
    });
    assert.deepEqual(filtered.candidates.filter((one) => one.selected).map((one) => one.id), ['猫']);
    assert.equal(service.read(bookId)?.workflow?.direct?.minZipf, 2.5);
    assert.ok((service.read(bookId)?.workflow?.directAppliedAt ?? 0) > 0);
    const changed = service.patch(bookId, '寿司', { forceInclude: true });
    assert.equal(changed.selected, true);
    assert.deepEqual(service.directFilter(bookId, [3], false).candidates.filter((one) => one.selected).map((one) => one.id), ['猫', '寿司']);
    const excluded = service.patchMany(bookId, ['寿司'], { forceInclude: false, excluded: true, selected: false });
    assert.equal(excluded.candidates.find((one) => one.id === '寿司')?.selected, false);
    const restored = service.patchMany(bookId, ['寿司'], { forceInclude: true, excluded: false, selected: true });
    assert.equal(restored.candidates.find((one) => one.id === '寿司')?.forceInclude, true);
    const withCheckpoint = service.read(bookId)!;
    withCheckpoint.workflow!.pendingFilterRun = {
      tier: 'F2', profileId: 'p1', sourceHash: 'old',
      decisions: { 猫: { decision: 'keep', reason: '已处理' } },
    };
    fs.writeFileSync(path.join(dir, 'study-list.json'), JSON.stringify(withCheckpoint));
    assert.throws(() => service.directFilter(bookId, [2, 3], false), /检查点/);
    assert.throws(() => service.patch(bookId, '猫', { forceInclude: true }), /检查点/);
    assert.throws(() => service.patchMany(bookId, ['猫'], { excluded: true }), /检查点/);
    assert.throws(() => service.addPhrase(bookId, 'page:a#0@0', '猫猫', 'ねこねこ'), /检查点/);
    await assert.rejects(() => service.generate(bookId), /检查点/);
    assert.equal(Object.keys(service.read(bookId)?.workflow?.pendingFilterRun?.decisions ?? {}).length, 1);
    service.clearFilterProgress(bookId);
    assert.equal(service.read(bookId)?.workflow?.pendingFilterRun, undefined);
    assert.doesNotThrow(() => service.directFilter(bookId, [2, 3], false));
  } finally {
    setUserDataRootForTesting(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
