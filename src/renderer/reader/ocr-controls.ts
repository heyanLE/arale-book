/**
 * 漫画阅读器底部那组 OCR 控件的**决策逻辑**（纯函数）。
 *
 * 为什么单独抽出来：这段有 6 个分支（空闲 / 有文字层 / 排队中 / 识别中 / 识别中且有进度 /
 * 引擎不可用），而它的表现恰好是「用户最容易觉得坏了」的地方——
 * 按钮点了没反应、引擎选不动、明明在跑却显示「识别文字」。
 *
 * 抽出来之后：
 * - 可以用单测把每个分支钉死（不用起 Electron、不用下模型、不用等真识别）；
 * - 组件里只剩 `state.label` / `state.disabled` 这样的直读，不再有嵌套三元表达式。
 */

import type { OcrProgress, OcrProviderId, OcrQueueEntry } from '@shared/types';

export interface OcrControlInput {
  /** 这本书在队列里的身份：正在跑或排队中。空闲时 null。 */
  queueEntry: OcrQueueEntry | null;
  /** `queueEntry` 是「正在跑」而不是「排队中」。 */
  active: boolean;
  /** 排队位置（1 基）。不在队列里时随便传。 */
  queuePosition: number;
  /** 用户在阅读器里临时选的引擎（没选过就是 null）。 */
  providerOverride: OcrProviderId | null;
  /** 设置里记住的默认引擎。 */
  defaultProvider: OcrProviderId;
  /** 引擎 id → 显示名。传函数而不是字符串：生效引擎要**先**解出来才知道该显示谁的名字。 */
  providerLabel: (id: OcrProviderId) => string;
  /** 正在跑时的进度快照。 */
  progress: OcrProgress | null;
  /** 这本书最近一次 OCR 是否成功过（决定「识别文字」还是「重新识别」）。 */
  hasResult: boolean;
  /** 有没有「开始识别」的回调。 */
  canStart: boolean;
  /** 有没有「取消」的回调。 */
  canCancel: boolean;
}

export interface OcrControlState {
  /**
   * 引擎选择器的值。识别中/排队中时是**那条任务的引擎**，而不是用户当前的选择——
   * 这一点就是需求里的「固化为当前正在识别的引擎」。
   */
  provider: OcrProviderId;
  /** 引擎选择器是否锁定（UI 上表现为淡化 + 禁用）。 */
  frozen: boolean;
  /** 引擎选择器的悬停说明。 */
  providerTitle: string;
  /** 主按钮文案。 */
  label: string;
  /** 主按钮是不是「中断」语义（用危险色 + 点下去取消）。 */
  isCancel: boolean;
  /** 主按钮是否禁用。 */
  disabled: boolean;
  /** 主按钮的悬停说明。 */
  title: string;
}

export function ocrControlState(input: OcrControlInput): OcrControlState {
  const {
    queueEntry,
    active,
    queuePosition,
    providerOverride,
    defaultProvider,
    providerLabel,
    progress,
    hasResult,
    canStart,
    canCancel,
  } = input;

  // 识别中/排队中：引擎固化在**那条任务**上，用户改不了。
  // 为什么不能跟用户选择走：任务在入队那一刻就把引擎定死了（前面可能还排着两本，
  // 等它开跑时用户早就在设置里换过默认引擎），选择器要是还能动就是骗人。
  const provider = queueEntry?.provider ?? providerOverride ?? defaultProvider;
  const frozen = queueEntry !== null;
  const label = providerLabel(provider);

  const providerTitle = frozen
    ? `本次识别已锁定为「${label}」——任务结束后才能改。`
    : '选哪个 OCR 引擎';

  if (frozen && active) {
    // 识别中：同一个按钮变成「停止识别」。带进度是为了保留旧版「识别中 12/171」的信息量，
    // 但那句话不该是按钮的全部——按钮要说清点下去会发生什么。
    return {
      provider,
      frozen,
      providerTitle,
      label: progress ? `停止识别 ${progress.done}/${progress.total}` : '停止识别',
      isCancel: true,
      disabled: !canCancel,
      title: '停止识别（已经识别出来的页会保留）',
    };
  }

  if (frozen) {
    return {
      provider,
      frozen,
      providerTitle,
      label: `取消排队（第 ${queuePosition} 位）`,
      isCancel: true,
      disabled: !canCancel,
      title: `取消排队（当前第 ${queuePosition} 位）`,
    };
  }

  return {
    provider,
    frozen,
    providerTitle,
    label: hasResult ? '重新识别' : '识别文字',
    isCancel: false,
    disabled: !canStart,
    title: `本地识别这一卷的文字（${label}）。OCR 是可选的，不跑也能看。`,
  };
}
