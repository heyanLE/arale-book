/**
 * 「导入能力」的守卫测试。
 *
 * 这个文件的存在理由是一条真实事故：加原生解包（`.rar/.cbr/.7z/.cb7/.cbt`）时，
 * 导入器改了、**文件选择对话框的 `filters` 忘了改**，于是拖放能导、点「导入」
 * 却在那几个文件上永远选不中。用户看到的症状是「不支持 rar」，而代码里明明支持。
 *
 * 根因是**同一个事实写在两张表里**。修法有两步：把扩展名收进
 * `IMPORTABLE_EXTENSIONS` 一处，然后在这里钉住「对话框覆盖了导入器接受的每一个
 * 扩展名」。这类守卫的价值就在于此：下次再加格式时，漏掉任何一处都会红。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { IMPORTABLE_EXTENSIONS, IPC } from '../src/shared/ipc';
import { NATIVE_ONLY_EXTENSIONS } from '../src/shared/native-protocol';
import { COMIC_IMAGE_EXTENSIONS } from '../src/core/comic/pages';
import { detectImportKind } from '../src/main/library/importer';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { strToU8, zipSync } from 'fflate';

/** `detectImportKind` 明确接受的扩展名（= 导入器真正能处理的集合）。 */
const ACCEPTED = new Set<string>([
  ...IMPORTABLE_EXTENSIONS.epub,
  ...IMPORTABLE_EXTENSIONS.comics,
  ...IMPORTABLE_EXTENSIONS.mokuro,
  ...IMPORTABLE_EXTENSIONS.images,
]);

test('对话框过滤器覆盖导入器接受的全部扩展名（防两张表漂移）', () => {
  // 「全部文件」那条是 `*`，不参与覆盖判定。
  const dialogExtensions = new Set(
    Object.entries(IMPORTABLE_EXTENSIONS)
      .filter(([key]) => key !== 'all')
      .flatMap(([, list]) => list as readonly string[]),
  );

  const missing = [...ACCEPTED].filter((ext) => !dialogExtensions.has(ext));
  assert.deepEqual(missing, [], `这些格式导入器收、但文件选择器里选不中：${missing.join(', ')}`);

  // 「all」也必须真的覆盖全部 —— 它是用户看到的第一个过滤器。
  const all = new Set(IMPORTABLE_EXTENSIONS.all as readonly string[]);
  const notInAll = [...ACCEPTED].filter((ext) => !all.has(ext));
  assert.deepEqual(notInAll, [], `这些格式不在「电子书与漫画」过滤器里：${notInAll.join(', ')}`);
});

test('原生解包格式全部在可导入清单里', () => {
  const all = new Set(IMPORTABLE_EXTENSIONS.all as readonly string[]);
  // `NATIVE_ONLY_EXTENSIONS` 是「走 Rust sidecar」的真相源，它每加一种，
  // 上面那张表也必须跟着加 —— 否则就是又一次「代码支持、UI 选不中」。
  for (const ext of NATIVE_ONLY_EXTENSIONS) {
    assert.ok(all.has(ext), `${ext} 走原生解包，但不在可导入清单里`);
  }
});

test('页图扩展名与导入器的图片集合一致', () => {
  const images = new Set(IMPORTABLE_EXTENSIONS.images as readonly string[]);
  for (const ext of COMIC_IMAGE_EXTENSIONS) {
    assert.ok(images.has(ext), `页图扩展名 ${ext} 不在可导入清单里`);
  }
});

test('detectImportKind 对每种受支持的扩展名都不返回 unsupported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arale-import-guard-'));
  try {
    // `.zip`/`.cbz` 是**歧义扩展名**：判定要开包看里面是图片还是 OPF。
    // 所以它们得喂真内容，随便写几个字节会被正当地判成 unsupported
    // —— 那正是内容判定的意义，不是 bug。
    const realZip = Buffer.from(zipSync({ 'images/p001.png': strToU8('fake-page') }));
    for (const ext of ACCEPTED) {
      const file = path.join(dir, `probe${ext}`);
      fs.writeFileSync(file, ext === '.zip' || ext === '.cbz' ? realZip : 'x');
      const kind = detectImportKind(file);
      assert.notEqual(kind, 'unsupported', `${ext} 被判成 unsupported（导入器与清单不一致）`);
    }
    // 目录入口也要在。
    assert.equal(detectImportKind(dir), 'directory');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('IPC 通道名没有被这次改动打乱', () => {
  // 防手滑：改过滤器时顺手删掉一个通道常量是很难在 review 里看出来的。
  for (const key of ['libraryImportDialog', 'libraryImport', 'dictImportDialog', 'ocrStart', 'segmentStart']) {
    assert.ok(typeof (IPC as Record<string, string>)[key] === 'string', `IPC.${key} 丢了`);
  }
});
