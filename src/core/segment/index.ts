/**
 * 分词 core 桶文件。主进程只 import 这里，避免到处记「哪个函数在哪个文件」。
 */

export { refForChapter, refForComicBlock, segmentUnits } from './segmenter';
export type { SegmentTextUnit, SegmenterDeps, SegmentUnitsResult } from './segmenter';
export { buildVocabulary, normalizeTerm } from './vocabulary';
