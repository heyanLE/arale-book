/**
 * 阅读器外壳：只负责「选哪个阅读器 + 顶栏元信息」，不掺和翻页逻辑。
 *
 * EPUB 与漫画的进度模型完全不同（章节 + UTF-16 偏移 vs 页号），硬做统一抽象只会造出
 * 一个两边都别扭的接口；这里用一次显式分支换两个各自干净的实现。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  isImageNovel,
  readerModeOf,
  type OcrCapability,
  type OcrJobResult,
  type OcrProgress,
  type OcrProviderId,
  type OcrQueueState,
  type OpenBookResult,
} from '@shared/types';
import { EpubReader } from '../reader/EpubReader';
import { ComicReader } from '../reader/ComicReader';
import { updateSettings, useSettings } from '../lib/reader-settings';
import { WordCardPanel } from '../dict/WordCardPanel';
import { useWordCards } from '../dict/word-cards';

export interface ReaderViewProps {
  open: OpenBookResult;
  onBack: () => void;
  onStatus: (message: string) => void;
  /** 当前这本书的 OCR 进度（没有任务时为 null）。 */
  ocrProgress?: OcrProgress | null;
  /** 当前这本书最近一次 OCR 结果。 */
  ocrResult?: OcrJobResult | null;
  onStartOcr: (bookId: string, force?: boolean, provider?: OcrProviderId) => void;
  onCancelOcr: (bookId: string) => void;
  /** 各 OCR 引擎的状态（漫画阅读器里选择用）。 */
  ocrCapability?: OcrCapability | null;
  /**
   * 全局识别队列快照。漫画阅读器靠它判断「这本书在不在跑」——
   * 在跑时要固化引擎选择器并把按钮换成「停止识别」。
   */
  ocrQueue?: OcrQueueState | null;
  /** 打开这本书的分词视图。 */
  onOpenSegments: (bookId: string) => void;
}

export function ReaderView({
  open,
  onBack,
  onStatus,
  ocrProgress = null,
  ocrResult = null,
  onStartOcr,
  onCancelOcr,
  ocrCapability = null,
  ocrQueue = null,
  onOpenSegments,
}: ReaderViewProps): JSX.Element {
  const { book, position } = open;
  const [progress, setProgress] = useState('');
  /**
   * 词卡状态放在这一层，而不是两个阅读器各自持有。
   *
   * 词卡夹的开关在阅读器顶栏上（顶栏属于 ReaderView），而弹窗由阅读器渲染
   * （锚点在页面坐标里）。状态放两处必然不同步，所以由这里持有、往下发。
   */
  const wordCards = useWordCards(book.id);
  const { autoHideChrome: immersive } = useSettings();

  const handleProgress = useCallback((label: string) => setProgress(label), []);

  useEffect(() => {
    if (progress !== '') onStatus(progress);
  }, [progress, onStatus]);

  return (
    <div className="reader">
      <div className="reader-header">
        {/* 「← 书库」只保留工具栏上那一个：两个同样的按钮垂直堆在一起，
            用户还要想「这两个有什么区别」。 */}
        <div className="reader-heading">
          <div className="reader-title cell-ellipsis" title={book.title}>
            {book.title}
          </div>
          <div className="reader-sub cell-ellipsis">
            {book.author || '未知作者'}
            {book.series !== null ? ` · ${book.series}` : ''}
            {book.volume !== null ? ` · 第 ${book.volume} 卷` : ''}
            <span className={`format-chip format-${book.format}`}>
              {book.format === 'epub' ? 'EPUB' : '漫画'}
            </span>
            {/* 载体是小说、阅读方式是漫画 —— 这个组合必须显式标出来，
                否则用户看到「EPUB」却进了翻页阅读器会以为点错了书。 */}
            {isImageNovel(book) && (
              <span className="format-chip format-note" title="整本都是插图/扫描页，以漫画方式翻页">
                图片小说
              </span>
            )}
            {book.direction === 'rtl' && <span className="format-chip">RTL</span>}
          </div>
        </div>

        <div className="reader-header-spacer" />

        <div className="reader-progress mono" title="阅读进度">
          {progress}
        </div>

        {/* 词卡夹的开关放在顶栏，不放在词卡上：它是「这本书存过什么」的入口，
            和某一张具体的卡没关系——挂在卡上会让人以为只关那一张。 */}
        <button
          type="button"
          className={`btn btn-sm${wordCards.panelOpen ? ' btn-primary' : ''}`}
          onClick={() => wordCards.setPanelOpen(!wordCards.panelOpen)}
          title="词卡夹（这本书保存过的词卡）"
          data-testid="reader-wordcards-toggle"
        >
          词卡夹
          {wordCards.cards.length > 0 && (
            <span className="reader-badge mono">{wordCards.cards.length}</span>
          )}
        </button>

        {/* 沉浸模式：自动隐藏上下工具栏。 */}
        <button
          type="button"
          className={`btn btn-sm${immersive ? ' btn-primary' : ''}`}
          onClick={() => updateSettings({ autoHideChrome: !immersive })}
          title={immersive ? '沉浸模式已开：鼠标移开自动隐藏上下栏' : '沉浸模式：自动隐藏上下栏'}
          data-testid="reader-immersive-toggle"
        >
          {immersive ? '沉浸中' : '沉浸'}
        </button>
      </div>

      <div className="reader-body">
        {readerModeOf(book) === 'epub' ? (
          <EpubReader
            key={book.id}
            book={book}
            initialPosition={position}
            onProgress={handleProgress}
            onOpenSegments={() => onOpenSegments(book.id)}
            wordCards={wordCards}
          />
        ) : (
          <ComicReader
            // `ocrResult` 参与 key：识别完成后整卷文字层换了，必须重建阅读器
            // 才能丢掉页文字缓存（否则弹窗查的还是「没有文字层」）。
            key={`${book.id}:${ocrResult?.ok ? ocrResult.blocks : 0}`}
            book={book}
            initialPosition={position}
            onProgress={handleProgress}
            ocrProgress={ocrProgress}
            ocrResult={ocrResult}
            onStartOcr={onStartOcr}
            onCancelOcr={onCancelOcr}
            ocrCapability={ocrCapability}
            ocrQueue={ocrQueue}
            onOpenSegments={() => onOpenSegments(book.id)}
            wordCards={wordCards}
          />
        )}

        {wordCards.panelOpen && (
          <WordCardPanel
            cards={wordCards.cards}
            onOpen={(card) => void wordCards.openCard(card)}
            onRemove={wordCards.removeCard}
            onClose={() => wordCards.setPanelOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
