/**
 * 底部状态栏：左「书库路径 / 种类统计」，中「最近一次操作的结果」，右「结果计数 / 选中数」。
 *
 * 桌面应用需要一个「不说话但一直在」的反馈位；错误横幅只负责打断性的失败，日常的
 * 「已导入 3 本」这类回执都落在这里。
 *
 * 右下角还挂着一个 `ocrSlot`：OCR 队列的全局入口。它不在这里实现，而是由 App 传进来
 * ——队列要能在所有视图里被点开，状态属于 App；状态栏只负责给它一个「右下角」的位置。
 */

import type * as React from 'react';
import type { LibraryInfo } from '@shared/types';
import type { ThemeMode } from '../lib/reader-settings';

export interface StatusBarProps {
  info: LibraryInfo | null;
  /** 当前筛选后显示的条数。 */
  shown: number;
  /** 筛选后的总数（契约里 LibraryPage.total 就是过滤后的总数）。 */
  total: number;
  selectionCount: number;
  /**
   * OCR 队列入口（右下角）。队列为空时它自己渲染成 null，状态栏不用判断。
   *
   * 曾经这里是一个纯文本的 `ocrLabel`：进度只读、不可点、也没法取消。
   * 现在识别是排队的，必须能点开看「排到第几个了」。
   */
  ocrSlot?: React.ReactNode;
  statusMessage: string;
  busy: boolean;
  theme: ThemeMode;
  /** 阅读器视图下显示书名，否则 null。 */
  readerLabel: string | null;
}

const THEME_TEXT: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
};

export function StatusBar(props: StatusBarProps): JSX.Element {
  const { info, shown, total, selectionCount, ocrSlot, statusMessage, busy, theme, readerLabel } = props;

  return (
    <footer className="statusbar">
      <div className="statusbar-group statusbar-left">
        {busy && <span className="statusbar-spinner" aria-hidden="true" />}
        <span className="statusbar-path mono cell-ellipsis" title={info?.dir ?? '未连接主进程'}>
          {info?.dir ?? '未连接主进程'}
        </span>
      </div>

      <div className="statusbar-group statusbar-center">
        <span className="statusbar-msg cell-ellipsis" title={statusMessage}>
          {readerLabel !== null ? `阅读中：${readerLabel}` : statusMessage}
        </span>
      </div>

      <div className="statusbar-group statusbar-right mono">
        {info && (
          <span className="statusbar-stat" title="EPUB / 漫画">
            {info.epubCount} EPUB · {info.comicCount} 漫画
          </span>
        )}
        <span className="statusbar-stat" title="当前筛选显示 / 过滤后总数">
          {shown === total ? `${total} 本` : `${shown} / ${total} 本`}
        </span>
        {selectionCount > 0 && <span className="statusbar-stat">已选 {selectionCount}</span>}
        {ocrSlot}
        <span className="statusbar-stat">{THEME_TEXT[theme]}</span>
      </div>
    </footer>
  );
}
