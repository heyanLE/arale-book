/**
 * 词卡「子句分析」收集的单测。
 *
 * 守的是用户报的那条：**同一句话 ABC，A 的 LLM 分析已经在缓存里，AB 的词卡里也要包含
 * 它**。旧实现要求「上下文逐字符相同」，而划 A 与划 AB 的上下文本来就不同（跨行划词之后
 * AB 的上下文是两块拼起来的），于是这条规则几乎永远不生效；重启应用后更连会话缓存都没有，
 * 只剩 `cards.json` 里的分析——而旧实现根本不读词卡。
 *
 * 所以这里把判据钉死：**词包含**（A ⊆ AB），上下文只影响「同一个词的多条选哪条」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectContainedAnalyses,
  hasAnalysisFor,
  sortAnalyses,
  type AnalysedSource,
} from '../src/core/cards/analyses';
import type { WordCard, WordCardAnalysis } from '../src/shared/types';

function analysis(word: string, text = `${word} 的分析`, createdAt = 1): WordCardAnalysis {
  return { word, text, profileName: 'p', model: 'm', createdAt };
}

function card(word: string, analyses: WordCardAnalysis[], context = '吾輩は猫である。'): WordCard {
  return {
    id: `c_${word}`,
    word,
    context,
    offset: 0,
    length: word.length,
    dictionaryExpression: word,
    dictionaryId: 'd1',
    dictionaryTitle: 'd',
    dictionaryReading: '',
    note: '',
    analyses,
    createdAt: 1,
    updatedAt: 1,
  };
}

const SENTENCE = '今日はいい天気ですね。';

test('★ 用户报的那条：A 的分析在词卡里，AB 这张卡要带上它（不要求上下文相同）', () => {
  // A 的分析存在**词卡**里（持久化的真相源），上下文是「A 所在那一段」。
  const cards = [card('いい', [analysis('いい')], 'いい天気ですね。')];
  const result = collectContainedAnalyses({
    word: 'いい天気',
    // AB 的上下文是跨行拼起来的一段：与 A 的不相等，只是包含关系。
    context: '今日はいい天気ですね。明日は雨が降るそうです。',
    cards,
    session: [],
  });
  assert.deepEqual(result.map((entry) => entry.word), ['いい']);
  assert.equal(result[0]?.text, 'いい 的分析', '带过来的是 A 的分析正文');
});

test('★ 上下文**不同也不影响**包含：同一个词在别的段落分析过，照样带过来', () => {
  const cards = [card('天気', [analysis('天気')], 'まったく別の段落です。')];
  const result = collectContainedAnalyses({
    word: 'いい天気ですね',
    context: SENTENCE,
    cards,
    session: [],
  });
  assert.deepEqual(result.map((entry) => entry.word), ['天気'], '只有「上下文相等」才收 = 就是它坏掉的原因');
});

test('跨重启也要成立：分析只在卡片文件里（会话缓存是空的）', () => {
  const cards = [card('猫', [analysis('猫')]), card('吾輩', [])];
  const result = collectContainedAnalyses({
    word: '吾輩は猫である',
    context: SENTENCE,
    cards,
    session: [],
  });
  assert.deepEqual(result.map((entry) => entry.word), ['猫']);
});

test('不包含的绝不冒出来：划 AB 时不该出现无关的 C', () => {
  const cards = [card('犬', [analysis('犬')]), card('雨', [analysis('雨')])];
  const result = collectContainedAnalyses({ word: '猫である', context: SENTENCE, cards, session: [] });
  assert.deepEqual(result, []);
});

test('顺序：短的在前，当前词自己最后（用户的心智是先小后大）', () => {
  const cards = [
    card('猫である', [analysis('猫である')]),
    card('猫', [analysis('猫')]),
    card('である', [analysis('である')]),
  ];
  const result = collectContainedAnalyses({
    word: '猫である',
    context: SENTENCE,
    cards,
    session: [],
  });
  assert.deepEqual(result.map((entry) => entry.word), ['猫', 'である', '猫である']);
});

test('同一个词有多条：同上下文的优先，其次「互相包含」，最后取更新的', () => {
  const same = [card('猫', [analysis('猫', '同段', 1)], SENTENCE)];
  const other = [card('猫', [analysis('猫', '别的段落', 99)], 'まったく別の段落。')];
  const preferred = collectContainedAnalyses({
    word: '猫である',
    context: SENTENCE,
    cards: [...other, ...same],
    session: [],
  });
  assert.equal(preferred[0]?.text, '同段', '同段上下文的那条优先，哪怕它更旧');

  // 两边都不相等：取更新的那条（但**不丢**）。
  const newest = collectContainedAnalyses({
    word: '猫である',
    context: '第三段。',
    cards: [...same, ...other],
    session: [],
  });
  assert.equal(newest.length, 1, '同一个词只显示一条');
  assert.equal(newest[0]?.text, '别的段落', '没有相关上下文时取更新的');

  // 互相包含算「相关」：它比无关段落优先。
  const nested = collectContainedAnalyses({
    word: '猫である',
    context: '今日は猫である。明日は雨。',
    cards: [card('猫', [analysis('猫', '包含', 1)], '猫である。'), card('猫', [analysis('猫', '无关', 50)], 'まったく別。')],
    session: [],
  });
  assert.equal(nested[0]?.text, '包含');
});

test('会话里的未保存分析也算（用户划 A 分析完但还没保存词卡）', () => {
  const session: AnalysedSource[] = [{ analysis: analysis('天気', '刚跑完', 7), context: SENTENCE }];
  const result = collectContainedAnalyses({
    word: 'いい天気ですね',
    context: SENTENCE,
    cards: [],
    session,
  });
  assert.deepEqual(result.map((entry) => entry.word), ['天気']);
});

test('会话与词卡里同一个词各有一份 → 只留一条（同上下文取更新的）', () => {
  const cards = [card('猫', [analysis('猫', '词卡里', 1)], SENTENCE)];
  const session: AnalysedSource[] = [{ analysis: analysis('猫', '刚跑的', 9), context: SENTENCE }];
  const result = collectContainedAnalyses({ word: '猫である', context: SENTENCE, cards, session });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.text, '刚跑的');
});

test('空词（「整张卡」那条）在它是当前词时保留，在别的卡上不会乱入', () => {
  const cards = [card('', [analysis('')])];
  // 当前词就是空词：它是「自己」，保留。
  assert.deepEqual(
    collectContainedAnalyses({ word: '', context: SENTENCE, cards, session: [] }).map((e) => e.word),
    [''],
  );
  // 当前词是「猫である」：空词不是它的子串，不该出现（`''.includes` 恒真，要挡住）。
  assert.deepEqual(
    collectContainedAnalyses({ word: '猫である', context: SENTENCE, cards, session: [] }),
    [],
  );
});

test('空正文的分析被丢掉；不修改入参（返回的是副本）', () => {
  const empty: WordCardAnalysis = { word: '猫', text: '', profileName: '', model: '', createdAt: 1 };
  const cards = [card('猫', [empty]), card('猫である', [analysis('猫である')])];
  const word = '猫である';
  const result = collectContainedAnalyses({ word, context: SENTENCE, cards, session: [] });
  assert.deepEqual(result.map((e) => e.word), ['猫である']);
  assert.notEqual(result[0], cards[1]!.analyses[0], '返回副本，改它不该动到词卡');

  // 顺序规则：**自己永远最后**（哪怕它比别的长），其余按长度升序。
  const sorted = sortAnalyses([analysis('abcd'), analysis('ab'), analysis('')], 'ab');
  assert.deepEqual(sorted.map((e) => e.word), ['', 'abcd', 'ab']);
  assert.equal(sortAnalyses([analysis('ab'), analysis('abcd')], 'ab').map((e) => e.word).join(), 'abcd,ab');
});

test('hasAnalysisFor：界面据此决定显示结果栏还是「分析」入口', () => {
  const list = [analysis('猫'), analysis('猫である')];
  assert.equal(hasAnalysisFor(list, '猫'), true);
  assert.equal(hasAnalysisFor(list, '犬'), false);
  assert.equal(hasAnalysisFor([], '猫'), false);
});
