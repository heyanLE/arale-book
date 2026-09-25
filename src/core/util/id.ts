import { randomBytes } from 'node:crypto';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * 生成稳定主键。
 *
 * 为什么不用 `crypto.randomUUID()`：id 同时当**书目录名**用（`<libraryDir>/<id>/`），
 * 而 UUID 带连字符、全库遍历时也更难一眼看出是 id。这里用 `bk_` + 16 位 base36。
 * 字母表刻意排除大写，因为 macOS/Windows 文件系统大小写不敏感，大小写混用的 id
 * 在某些同步/备份工具下会互撞。
 */
export function makeBookId(): string {
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    out += ID_ALPHABET[bytes[i]! % ID_ALPHABET.length];
  }
  return `bk_${out}`;
}

/** 词典 id 用同一字母表，前缀不同以便一眼区分。 */
export function makeDictId(): string {
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i += 1) {
    out += ID_ALPHABET[bytes[i]! % ID_ALPHABET.length];
  }
  return `dc_${out}`;
}
