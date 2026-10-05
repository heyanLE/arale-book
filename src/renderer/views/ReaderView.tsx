/**
 * 阅读器外壳：负责选阅读器、顶栏与右侧栏，不掺和翻页逻辑。
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
import { ReaderToolIcon } from '../reader/ComicAnnotationControls';
import { updateSettings, useSettings } from '../lib/reader-settings';
import { WordCardPanel } from '../dict/WordCardPanel';
import { useWordCards } from '../dict/word-cards';

export interface ReaderViewProps {
  open: OpenBookResult;
  onBack: () => void;
  onStatus: (message: string) => void;
  systemBarsVisible: boolean;
  onSystemBarsChange: (visible: boolean) => void;
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
  systemBarsVisible,
  onSystemBarsChange,
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
   * 右侧栏开关在阅读器顶栏上（顶栏属于 ReaderView），而弹窗由阅读器渲染
   * （锚点在页面坐标里）。状态放两处必然不同步，所以由这里持有、往下发。
   */
  const wordCards = useWordCards(book.id);
  const { autoHideChrome: immersive } = useSettings();
  const comicMode = readerModeOf(book) === 'comic';
  const [sidebarTab, setSidebarTab] = useState<'cards' | 'layers'>('cards');
  const [annotationManagerHost, setAnnotationManagerHost] = useState<HTMLDivElement | null>(null);
  const [immersiveToolsHost, setImmersiveToolsHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => { setSidebarTab('cards'); }, [book.id, comicMode]);
  const openAnnotationManager = useCallback(() => {
    setSidebarTab('layers'); wordCards.setPanelOpen(true);
  }, [wordCards.setPanelOpen]);

  const handleProgress = useCallback((label: string) => setProgress(label), []);

  useEffect(() => {
    if (progress !== '') onStatus(progress);
  }, [progress, onStatus]);

  return (
    <div className="reader">
      {immersive && <div className={`immersive-exit-zone${wordCards.panelOpen ? ' is-sidebar-open' : ''}`} aria-label="沉浸阅读工具">
        <div className="immersive-reader-actions">
          {comicMode && <div ref={setImmersiveToolsHost} />}
          <button type="button" className={`btn btn-sm immersive-icon-button${systemBarsVisible ? ' btn-primary' : ''}`}
            data-testid="immersive-system-bars" aria-pressed={systemBarsVisible} aria-label="显示或隐藏系统栏"
            title={`${systemBarsVisible ? '隐藏' : '显示'}${navigator.userAgent.includes('Mac') ? '菜单栏和 Dock' : '系统任务栏'}（覆盖页图）`}
            onPointerDown={event => event.preventDefault()} onClick={() => onSystemBarsChange(!systemBarsVisible)}><ReaderToolIcon kind="system" /></button>
          <button type="button" className={`btn btn-sm immersive-icon-button${wordCards.panelOpen ? ' btn-primary' : ''}`}
            data-testid="immersive-sidebar-toggle" aria-expanded={wordCards.panelOpen} aria-controls="reader-sidebar"
            aria-label="侧边栏"
            title={`${wordCards.panelOpen ? '收起' : '打开'}右侧栏：词卡夹${comicMode ? '、图层管理' : ''}`}
            onClick={() => wordCards.setPanelOpen(!wordCards.panelOpen)}><ReaderToolIcon kind="sidebar" /></button>
          <button type="button" className="btn immersive-exit immersive-icon-button" data-testid="immersive-exit" title="退出沉浸模式" aria-label="退出沉浸模式"
            onClick={() => updateSettings({ autoHideChrome: false })}><ReaderToolIcon kind="exit" /></button>
        </div>
      </div>}
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
        <button
          type="button"
          className={`btn btn-sm${wordCards.panelOpen ? ' btn-primary' : ''}`}
          onClick={() => wordCards.setPanelOpen(!wordCards.panelOpen)}
          title={`${wordCards.panelOpen ? '收起' : '打开'}右侧栏：词卡夹${comicMode ? '、图层管理' : ''}`}
          aria-expanded={wordCards.panelOpen}
          aria-controls="reader-sidebar"
          data-testid="reader-sidebar-toggle"
        >
          侧边栏
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
            annotationManagerHost={wordCards.panelOpen && sidebarTab === 'layers' ? annotationManagerHost : null}
            immersiveToolsHost={immersive ? immersiveToolsHost : null}
            onOpenAnnotationManager={openAnnotationManager}
          />
        )}

        {wordCards.panelOpen && (
          <aside className="reader-sidebar" id="reader-sidebar" data-testid="reader-sidebar" aria-label="阅读侧边栏">
            <div className="reader-sidebar-head">
              <div className="reader-sidebar-tabs" role="tablist" aria-label="侧边栏内容">
                <button type="button" role="tab" aria-selected={sidebarTab === 'cards' || !comicMode}
                  aria-controls="reader-sidebar-cards" id="reader-sidebar-cards-tab" data-testid="reader-sidebar-cards"
                  onClick={() => setSidebarTab('cards')}>词卡夹 <span className="mono">{wordCards.cards.length}</span></button>
                {comicMode && <button type="button" role="tab" aria-selected={sidebarTab === 'layers'}
                  aria-controls="reader-sidebar-layers" id="reader-sidebar-layers-tab" data-testid="annotations-manage"
                  onClick={() => setSidebarTab('layers')}>图层管理</button>}
              </div>
              <button type="button" className="icon-btn" title="收起侧边栏" onClick={() => wordCards.setPanelOpen(false)}>×</button>
            </div>
            {(sidebarTab === 'cards' || !comicMode) && <div className="reader-sidebar-content" role="tabpanel"
              id="reader-sidebar-cards" aria-labelledby="reader-sidebar-cards-tab">
              <WordCardPanel embedded cards={wordCards.cards} onOpen={(card) => void wordCards.openCard(card)}
                onRemove={wordCards.removeCard} onClose={() => wordCards.setPanelOpen(false)} />
            </div>}
            {comicMode && sidebarTab === 'layers' && <div className="reader-sidebar-content" role="tabpanel"
              id="reader-sidebar-layers" aria-labelledby="reader-sidebar-layers-tab" ref={setAnnotationManagerHost} />}
          </aside>
        )}
      </div>
    </div>
  );
}
