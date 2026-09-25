#!/usr/bin/env node
/**
 * 从 Fushi 的 `kanji_standardization_data.cpp` 生成 `data/kanji-variants.json`。
 *
 * ## 为什么把这个表内嵌进来（它属于「小的直接拿过来」那一类）
 *
 * 47 KB / 2122 条，却是「异体字能不能查到」的分水岭：`神`(U+FA19)、`髙`(U+9AD9)、
 * `辻` 的旧字形这类兼容汉字，NFKC **不会**把它们折成常用字形，于是词典里明明有
 * `神` / `高` 的词条，用户点到异体字却查不到——看起来像「词典不全」。
 * Fushi 把这张表编译进 C++ 引擎（`kuVariantToParent`），我们作为数据文件随包走。
 *
 * 大词典（JMdict 22 MB、Jitendex 37 MB…）走扩展下载，这个不走：
 * 47 KB 换「异体字能查」是划算的，而 22 MB 塞进安装包就不划算了。
 *
 * 用法：`node scripts/make-kanji-variants.mjs [Fushi 仓库根]`
 * 需要 Fushi 的只读 checkout；产物提交进仓库，所以**构建与运行都不需要它**。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fushiRoot = process.argv[2] ?? '/Users/heyanle/Desktop/project/Fushi';
const source = path.join(
  fushiRoot,
  'native/fushidicts/fushidicts_src/text_processor/kanji_standardization_data.cpp',
);
const output = path.join(root, 'data', 'kanji-variants.json');

if (!fs.existsSync(source)) {
  console.error(`找不到 Fushi 的异体字表：${source}`);
  console.error('用法：node scripts/make-kanji-variants.mjs /path/to/Fushi');
  process.exit(1);
}

const text = fs.readFileSync(source, 'utf8');
const pairs = [...text.matchAll(/\{\s*(0x[0-9A-Fa-f]+)\s*,\s*(0x[0-9A-Fa-f]+)\s*\}/g)].map((m) => [
  Number.parseInt(m[1], 16),
  Number.parseInt(m[2], 16),
]);

if (pairs.length === 0) {
  console.error('一条都没解析出来——表格式变了？先看一眼源文件的 kVariantToParent 数组。');
  process.exit(1);
}

// 存成「十六进制字符串 → 十六进制字符串」而不是数字数组：
// JSON 里数字没问题，但十六进制一眼能对回源文件，排查时省事；体积也多不了多少。
const table = {};
for (const [variant, parent] of pairs) {
  if (!Number.isFinite(variant) || !Number.isFinite(parent)) continue;
  // 自映射没有意义（折了等于没折），去掉能少一次查表。
  if (variant === parent) continue;
  table[variant.toString(16)] = parent.toString(16);
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(table)}\n`, 'utf8');

const size = fs.statSync(output).size;
console.log(`异体字表已生成：${path.relative(root, output)}（${Object.keys(table).length} 条，${(size / 1024).toFixed(1)} KB）`);
