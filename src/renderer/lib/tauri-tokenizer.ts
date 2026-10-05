import kuromoji from 'kuromoji/build/kuromoji.js';
import type { MorphToken } from '@core/study/candidates';

interface Tokenizer { tokenize(text: string): Array<{ surface_form: string; basic_form?: string; reading?: string; pos: string; pos_detail_1?: string; word_type?: string }>; }
let loading: Promise<Tokenizer> | null = null;
export async function tokenizeJapanese(text: string): Promise<MorphToken[]> {
  if (!text.trim()) return [];
  loading ??= new Promise<Tokenizer>((resolve, reject) => {
    // BrowserDictionaryLoader uses path.join, so give it a same-origin path, not a URL.
    kuromoji.builder({ dicPath: new URL(/* @vite-ignore */ '../kuromoji/', import.meta.url).pathname }).build((error, tokenizer) => {
      if (error) reject(error); else resolve(tokenizer);
    });
  }).catch(error => { loading = null; throw error; });
  const tokenizer = await loading;
  return tokenizer.tokenize(text).map(token => ({
    surface: token.surface_form, lemma: token.basic_form ?? token.surface_form,
    reading: token.reading ?? '', pos: token.pos, posDetail: token.pos_detail_1 ?? '',
    known: token.word_type !== 'UNKNOWN',
  }));
}
