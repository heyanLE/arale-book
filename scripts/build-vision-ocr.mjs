#!/usr/bin/env node
/**
 * 构建 macOS 系统 OCR 小工具（`native/arale-vision-ocr/main.swift`）。
 *
 * 产物落到 `native/arale-vision-ocr/arale-vision-ocr`，与 Rust 解包器同一套布局
 * （`native/<tool>/<tool>`），这样 `extraResources` 与 `nativeToolDir()` 只需要一条规则。
 *
 * ## 两个坑，改这个脚本前先读
 *
 * 1. **模块缓存必须指到工作区里**。`swiftc` 默认把模块缓存写到 `$TMPDIR` 或
 *    `~/Library/Caches`；在受限环境（沙箱、CI）里那可能是不可写的，报的错却是
 *    `unable to open output file …/SwiftShims-*.pcm` + 「could not build Objective-C
 *    module 'SwiftShims'」，看起来像 SDK 坏了。设 `CLANG_MODULE_CACHE_PATH` 就好。
 * 2. **加 `-warnings-as-errors`**。Swift 的弃用警告（比如
 *    `supportedRecognitionLanguages(for:revision:)` 在 macOS 12 起弃用）现在只是警告，
 *    但下一个 SDK 就可能是错误。宁可现在就知道。
 *
 * 用 `swiftc` 而不是 Xcode 工程：只有一个源文件，`swiftc` 一行就够，
 * 不用让构建依赖 Xcode（CommandLineTools 里有 swiftc，用户机器上多半也有）。
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcDir = path.join(root, 'native', 'arale-vision-ocr');
const source = path.join(srcDir, 'main.swift');
const output = path.join(srcDir, 'arale-vision-ocr');

if (process.platform !== 'darwin') {
  console.log(`系统 OCR 小工具只构建 macOS 版本（当前 ${process.platform}）——跳过。`);
  process.exit(0);
}

if (!fs.existsSync(source)) {
  console.error(`找不到源码：${source}`);
  process.exit(1);
}

const moduleCache = path.join(root, '.vision-build', 'modcache');
fs.mkdirSync(moduleCache, { recursive: true });

const result = spawnSync(
  'swiftc',
  [
    '-O',
    '-warnings-as-errors',
    '-framework', 'Vision',
    '-framework', 'ImageIO',
    source,
    '-o', output,
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      // 见文件头第 1 条。
      CLANG_MODULE_CACHE_PATH: moduleCache,
      SWIFT_MODULECACHE_PATH: moduleCache,
    },
  },
);

if (result.error) {
  console.error(`调用 swiftc 失败：${result.error.message}`);
  console.error('需要安装 Xcode Command Line Tools：`xcode-select --install`');
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`swiftc 退出码 ${result.status}`);
  process.exit(result.status ?? 1);
}

const size = fs.statSync(output).size;
console.log(`系统 OCR 小工具构建完成：${path.relative(root, output)}（${(size / 1024).toFixed(0)} KB）`);

// 自检：构建成功不等于**这台机器**能用（macOS 的 accurate 依赖按需下载的资源）。
// 这里如实报告，不当作构建失败——同一个二进制在资源齐全的机器上是好的。
const probe = spawnSync(output, ['--probe'], { encoding: 'utf8' });
const verdict = (probe.stdout ?? '').trim();
console.log(`自检：${verdict === '' ? '(无输出)' : verdict}`);
if (probe.status !== 0) {
  console.warn(
    '⚠️ 这台机器上系统 OCR 不可用（不影响构建产物）：macOS 的文字识别资源是按需下载的。' +
      '打开一次「预览 / 照片」里的实况文本即可让系统装上，然后重新运行本脚本确认。',
  );
}
