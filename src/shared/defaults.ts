/**
 * 主进程侧的**默认值**（存在 `<userData>/settings.json`）。
 *
 * 为什么只有这几项在主进程、其余偏好留在渲染进程的 localStorage：它们要在**导入时**
 * 用到（新书的默认阅读方向），而导入跑在主进程里。字号/主题/双页这些只在界面里用得到，
 * 没必要多一次 IPC。
 *
 * 与 `main/ocr/service.ts` 的 `ocrProvider` 共用同一个 `settings.json`——都是「默认值」，
 * 分两个文件只会让「重置设置」变成半个操作。
 */

import type { ReadingDirection } from './types';

export interface AppDefaults {
  /**
   * 新导入的书默认用哪个阅读方向。
   *
   * 默认 `rtl`（日漫的常态）。如果主要看的是中式/韩式左装订漫画，改成 `ltr` 就不必
   * 每本手动翻一次。**已导入的书不受影响**——改的是「以后」。
   */
  direction: ReadingDirection;
}

export const DEFAULT_APP_DEFAULTS: AppDefaults = { direction: 'rtl' };

/** 校验从磁盘读回来的值（手改过、旧版本、别的应用写的都可能）。 */
export function normalizeAppDefaults(raw: unknown): AppDefaults {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const direction = source['direction'];
  return { direction: direction === 'ltr' ? 'ltr' : DEFAULT_APP_DEFAULTS.direction };
}
