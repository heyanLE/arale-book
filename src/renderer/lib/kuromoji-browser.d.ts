declare module 'kuromoji/build/kuromoji.js' {
  interface Token {
    surface_form: string; basic_form?: string; reading?: string;
    pos: string; pos_detail_1?: string; word_type?: string;
  }
  interface Tokenizer { tokenize(text: string): Token[]; }
  const kuromoji: { builder(options: { dicPath: string }): { build(callback: (error: unknown, tokenizer: Tokenizer) => void): void } };
  export default kuromoji;
}
