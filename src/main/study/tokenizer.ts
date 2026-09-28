/** 独立于 OCR 包的日语形态分析器；项目已通过 Kuroshiro 携带它的词典。 */
import type { MorphToken } from '../../core/study/candidates';

interface KuromojiToken {
  surface_form: string;
  basic_form?: string;
  reading?: string;
  pos: string;
  verbose?: { word_type?: string };
}

interface Analyzer {
  init(): Promise<void>;
  parse(text: string): Promise<KuromojiToken[]>;
}

type AnalyzerConstructor = new () => Analyzer;
let analyzerPromise: Promise<Analyzer> | null = null;

function getAnalyzer(): Promise<Analyzer> {
  if (!analyzerPromise) {
    analyzerPromise = (async () => {
      const Constructor = require('kuroshiro-analyzer-kuromoji') as AnalyzerConstructor;
      const analyzer = new Constructor();
      await analyzer.init();
      return analyzer;
    })().catch((error: unknown) => {
      analyzerPromise = null;
      throw error;
    });
  }
  return analyzerPromise;
}

export async function tokenizeJapanese(text: string): Promise<MorphToken[]> {
  const analyzer = await getAnalyzer();
  const tokens = await analyzer.parse(text);
  return tokens.map((token) => ({
    surface: token.surface_form,
    lemma: token.basic_form ?? token.surface_form,
    reading: token.reading ?? '',
    pos: token.pos,
    known: token.verbose?.word_type !== 'UNKNOWN',
  }));
}
