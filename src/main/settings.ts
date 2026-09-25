/**
 * 主进程侧默认值的读写（`<userData>/settings.json`）。
 *
 * 与 `ocr/service.ts` 的 `ocrProvider` 共用同一个文件——两者都是「新东西的默认值」，
 * 分两个文件会让「恢复默认」变成半个操作，也让用户要翻两个地方才能看清自己改过什么。
 *
 * 这里刻意不做缓存：settings.json 只有几百字节，读写都是毫秒级，而缓存必然要处理
 * 「另一个模块改了它」的失效问题。省下的那点 IO 不值那个复杂度。
 */

import type { AppDefaults } from '../shared/defaults';
import { normalizeAppDefaults } from '../shared/defaults';
import { readJson, writeJsonAtomic } from '../core/util/atomic-json';

/** 读默认值。文件缺失/损坏都退回内置默认（永不抛）。 */
export function readAppDefaults(file: string): AppDefaults {
  return normalizeAppDefaults(readJson<unknown>(file, {}));
}

/** 写入默认值（合并进现有 settings.json，别把 ocrProvider 抹掉）。 */
export function writeAppDefaults(file: string, patch: Partial<AppDefaults>): AppDefaults {
  const current = readJson<Record<string, unknown>>(file, {});
  const next = { ...normalizeAppDefaults({ ...current, ...patch }) };
  writeJsonAtomic(file, { ...current, ...next });
  return next;
}
