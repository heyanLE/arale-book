/**
 * deinflect.ts 单测：Yomitan 日语变形还原。
 *
 * 数据路径：编译产物在 `dist-test/tests/`，所以要回到仓库根再进 `data/`；
 * 另外再单独测一遍「deinflect.ts 自己也能找到随包数据」（不传 transforms 参数）。
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  MAX_DEINFLECTION_DEPTH,
  deinflect,
  jaTransforms,
  parseTransformFile,
  type DeinflectionCandidate,
  type TransformFile,
} from '../src/core/dict/deinflect';

const TRANSFORMS_PATH = path.join(__dirname, '..', '..', 'data', 'ja-transforms.json');
const transforms = parseTransformFile(JSON.parse(fs.readFileSync(TRANSFORMS_PATH, 'utf8')) as unknown);

function find(candidates: DeinflectionCandidate[], text: string): DeinflectionCandidate | undefined {
  return candidates.find((candidate) => candidate.text === text);
}

test('随包数据：54 transforms / 22 conditions，且模块自带的 jaTransforms 与磁盘一致', () => {
  assert.equal(Object.keys(transforms.transforms).length, 54);
  assert.equal(Object.keys(transforms.conditions).length, 22);
  assert.equal(transforms.language, 'ja');
  assert.equal(jaTransforms.language, 'ja');
  assert.equal(Object.keys(jaTransforms.transforms).length, 54);
  // wholeWord 规则（いらっしゃいます→いらっしゃる）在解析后仍保留 wholeWord 标记。
  const masuRules = jaTransforms.transforms['-ます']?.rules ?? [];
  assert.equal(masuRules.filter((rule) => rule.wholeWord === true).length, 8);
});

test('parseTransformFile: 形状不对就抛', () => {
  assert.throws(() => parseTransformFile(null), /顶层必须是对象/);
  assert.throws(() => parseTransformFile({}), /language/);
  assert.throws(
    () => parseTransformFile({ language: 'ja', conditions: {}, transforms: { a: { name: 'a', rules: [{ type: 'nope' }] } } }),
    /未知/,
  );
  const ok = parseTransformFile({
    language: 'xx',
    conditions: { a: { name: 'A', isDictionaryForm: true } },
    transforms: { t: { name: 'T', description: 'd', rules: [{ type: 'suffix', fromSuffix: 'x', toSuffix: 'y', conditionsIn: ['a'], conditionsOut: [] }] } },
  });
  assert.equal(ok.transforms['t']?.rules[0]?.fromSuffix, 'x');
});

test('食べました → 食べる（ました→ます→る，两步）', () => {
  const candidates = deinflect('食べました', transforms);
  const target = find(candidates, '食べる');
  assert.ok(target, '必须能还原出 食べる');
  assert.equal(target.trace.length, 2);
  assert.deepEqual(
    target.trace.map((step) => step.name),
    ['-た', '-ます'],
  );
  assert.equal(target.trace[1]?.description.length !== 0, true);
});

test('食べなかった → 食べる（かった→い 得到 食べない，再 ない→る）', () => {
  const target = find(deinflect('食べなかった', transforms), '食べる');
  assert.ok(target);
  assert.equal(target.trace.length, 2);
  assert.equal(target.trace[0]?.name, '-た');
  assert.equal(target.trace[1]?.name, 'negative');
});

test('書いた → 書く（五段 いた→く）', () => {
  const target = find(deinflect('書いた', transforms), '書く');
  assert.ok(target, '五段动词必须能还原（子条件 v5 的展开错了这里会挂）');
  assert.equal(target.trace.length, 1);
  assert.equal(target.trace[0]?.name, '-た');
});

test('来ました → 来る', () => {
  const target = find(deinflect('来ました', transforms), '来る');
  assert.ok(target);
  assert.equal(target.trace.length, 2);
});

test('食べる（已是辞书形）→ 自己，轨迹为空', () => {
  const target = find(deinflect('食べる', transforms), '食べる');
  assert.ok(target);
  assert.deepEqual(target.trace, []);
  assert.deepEqual(target.conditions, ['*']);
});

test('高い → 自己仍在候选里，且轨迹最短者胜出', () => {
  const candidates = deinflect('高い', transforms);
  const target = find(candidates, '高い');
  assert.ok(target);
  assert.deepEqual(target.trace, []);
});

test('wholeWord 规则：いらっしゃいます → いらっしゃる', () => {
  const target = find(deinflect('いらっしゃいます', transforms), 'いらっしゃる');
  assert.ok(target);
  assert.equal(target.trace.length, 1);
});

test('中间状态不能只按文本去重：食べます 的两条来路都要留着才能走到 食べる', () => {
  // 食べました 以「した」结尾，会被 した→す（conditionsOut v5）抢先生成 食べます；
  // 若按文本去重只留 v5 那条，-ます 链就断了。
  const candidates = deinflect('食べました', transforms);
  assert.ok(find(candidates, '食べる'));
});

test('轨迹最短者胜：合成数据里同一文本有一长一短两条路径', () => {
  const synthetic: TransformFile = {
    language: 'xx',
    conditions: {
      k: { name: 'K', isDictionaryForm: false },
    },
    transforms: {
      shortWay: {
        name: 'short-way',
        description: '一步把 bc 变成 Q',
        rules: [{ type: 'suffix', fromSuffix: 'bc', toSuffix: 'Q', conditionsIn: [], conditionsOut: [] }],
      },
      longWay: {
        name: 'long-way',
        description: '先把 c 变成 Q',
        rules: [{ type: 'suffix', fromSuffix: 'c', toSuffix: 'Q', conditionsIn: [], conditionsOut: ['k'] }],
      },
      longWay2: {
        name: 'long-way-2',
        description: '再砍掉 b',
        rules: [{ type: 'suffix', fromSuffix: 'bQ', toSuffix: 'Q', conditionsIn: ['k'], conditionsOut: [] }],
      },
    },
  };
  const candidates = deinflect('abc', synthetic);
  // abc --shortWay--> aQ（1 步）；abc --longWay--> abQ --longWay2--> aQ（2 步）。
  const target = find(candidates, 'aQ');
  assert.ok(target, '两条路径都产出 aQ');
  assert.deepEqual(
    target.trace.map((step) => step.name),
    ['short-way'],
  );
  // 中间态也是合法候选，不能被吞掉。
  assert.ok(find(candidates, 'abQ'));
});

test('maxDepth 生效：深度 1 时 食べました 还到不了 食べる', () => {
  const shallow = deinflect('食べました', transforms, 1);
  assert.equal(find(shallow, '食べる'), undefined);
  assert.ok(find(shallow, '食べます'));

  const deep = deinflect('食べました', transforms, MAX_DEINFLECTION_DEPTH);
  assert.ok(find(deep, '食べる'));
});

test('空串返回空数组；纯汉字词至少返回自己', () => {
  assert.deepEqual(deinflect('', transforms), []);
  const kanji = deinflect('寿司', transforms);
  assert.ok(find(kanji, '寿司'));
});

test('输出确定性：同样输入两次结果 deepEqual', () => {
  assert.deepEqual(deinflect('食べました', transforms), deinflect('食べました', transforms));
});
