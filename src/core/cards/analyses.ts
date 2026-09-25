/**
 * 词卡上的**子句分析**收集：先划 A、再划 AB 时，AB 这张卡要带上 A 的分析。
 *
 * ## 为什么需要一个模块
 *
 * 这是用户明确要过的行为，`WordCardAnalysis.word` 的注释里就写着它（「先划 A、再划 AB
 * 时，A 的分析会作为子句挂在 AB 这张卡上」）。但旧实现只从一个**会话内**的缓存里找，
 * 判据还是「上下文必须逐字符相同」：
 *
 * ```ts
 * if (!key.endsWith(`\u0000${context}`)) continue;   // ← 旧实现的门槛
 * ```
 *
 * 于是它几乎永远匹配不上：划 A 时上下文是「A 所在的那一段」，划 AB 时上下文是**跨行
 * 拼起来**的一段，两者既不相等也不是彼此的结尾；重启应用之后连会话缓存都没了，只剩
 * `cards.json` 里存着的分析，而那些分析旧实现根本不看。
 *
 * 所以这里把判据收敛成一句话：**词包含**（`word.includes(candidate.word)`）。
 * 上下文只用来**选优**（同一段 > 互相包含 > 更新），不再当成门槛。
 *
 * ## 顺序
 *
 * 短的在前、当前词自己最后。这是用户读的顺序：先看小范围（已经想过的），再看大范围
 * （现在的）。删除按词定位，顺序稳定才不会「删了这条跳的是那条」。
 */

import type { WordCard, WordCardAnalysis } from '../../shared/types';

/** 一条分析 + 它是**在什么上下文里**跑出来的（同一个词可能在不同段落里各有一条）。 */
export interface AnalysedSource {
  analysis: WordCardAnalysis;
  context: string;
}

export interface CollectAnalysesInput {
  /** 当前词卡顶部的词。 */
  word: string;
  /** 当前查词的上下文（划词时是选区所在的整段）。 */
  context: string;
  /** 这本书的**全部词卡**——持久化的分析都在这里，是跨重启的唯一真相源。 */
  cards: readonly WordCard[];
  /** 本会话跑过、但可能还没保存到词卡里的分析（键里带着它的上下文）。 */
  session: Iterable<AnalysedSource>;
  /**
   * **正在打开的那张词卡上存着的分析**：这些一律照收，不再过「词包含」这道闸。
   *
   * 为什么要有这个例外：卡上的分析就是这个卡片攒下来的东西，用户还可能把卡片顶部的词
   * 改掉（词是**可编辑**的）。改完词之后把旧分析悄悄藏起来，比留着更让人困惑——「我明明
   * 分析过，怎么没了」。要删有 × 按钮，别替用户决定。
   */
  ownAnalyses?: readonly WordCardAnalysis[];
}

interface Candidate {
  source: AnalysedSource;
  /** 同一个词的多个来源里，谁更该被选中。 */
  score: number;
}

/**
 * 上下文的相关度：同一段最高，互相包含次之，其余最低。
 *
 * 划 A 与划 AB 正是「互相包含」：A 的上下文是 A 所在那一段，AB 的上下文是跨行拼起来的
 * 一段。就算两者只是部分重叠（选区起点不同就会这样），也只是降到最低档——**仍然不会
 * 被丢掉**：那依然是对这个词的分析。
 */
function contextScore(candidate: string, current: string): number {
  if (candidate === current) return 3;
  if (candidate === '' || current === '') return 0;
  if (current.includes(candidate) || candidate.includes(current)) return 2;
  return 1;
}

/** 同一个词有多条时留下更该显示的：先看上下文相关度，再看新。 */
function keepBetter(current: Candidate | undefined, next: Candidate): Candidate {
  if (current === undefined) return next;
  if (next.score !== current.score) return next.score > current.score ? next : current;
  return next.source.analysis.createdAt > current.source.analysis.createdAt ? next : current;
}

/**
 * 分析列表的**显示顺序**：短词在前，当前词自己最后。
 *
 * 单独导出是因为「写回词卡」的地方也要按同一顺序排：界面上看到的顺序与落盘顺序一致，
 * 下次打开才不会跳。
 */
export function sortAnalyses(
  analyses: readonly WordCardAnalysis[],
  word: string,
): WordCardAnalysis[] {
  return [...analyses].sort((a, b) => {
    const aOwn = a.word === word ? 1 : 0;
    const bOwn = b.word === word ? 1 : 0;
    if (aOwn !== bOwn) return aOwn - bOwn;
    return a.word.length - b.word.length || a.word.localeCompare(b.word);
  });
}

/**
 * 收集「当前词包含的所有已分析词 + 当前词自己」的分析。
 *
 * - 只收**被当前词包含**的词（以及当前词自己、「整张卡」那种空词）：划 AB 时冒出无关的
 *   C 的分析只会让人困惑；
 * - 同一个词有多条（不同段落各跑过一次 / 会话缓存与词卡里各有一份）时按 [contextScore]
 *   选一条，不重复显示；
 * - 短词在前、当前词自己最后。
 */
export function collectContainedAnalyses(input: CollectAnalysesInput): WordCardAnalysis[] {
  const { word, context, cards, session, ownAnalyses } = input;
  const byWord = new Map<string, Candidate>();

  const offer = (source: AnalysedSource): void => {
    const { analysis } = source;
    if (analysis.text === '') return;
    const candidate = analysis.word ?? '';
    const contained = candidate === word || (candidate !== '' && word.includes(candidate));
    if (!contained) return;
    const score = contextScore(source.context, context);
    byWord.set(candidate, keepBetter(byWord.get(candidate), { source, score }));
  };

  for (const card of cards) {
    for (const analysis of card.analyses) {
      offer({ analysis, context: card.context });
    }
  }
  for (const source of session) offer(source);
  for (const analysis of ownAnalyses ?? []) {
    if (analysis.text === '') continue;
    const candidate = analysis.word ?? '';
    byWord.set(candidate, keepBetter(byWord.get(candidate), {
      source: { analysis, context },
      score: 3,
    }));
  }

  return sortAnalyses(
    [...byWord.values()].map((entry) => ({ ...entry.source.analysis })),
    word,
  );
}

/** 这个词是否已经有分析（决定界面上显示结果栏还是「分析」入口）。 */
export function hasAnalysisFor(analyses: readonly WordCardAnalysis[], word: string): boolean {
  return analyses.some((entry) => entry.word === word);
}
