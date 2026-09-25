/**
 * EPUB 阅读器。
 *
 * 章节 HTML 由 `arale://` 协议处理器在**服务端**注入阅读样式与桥接脚本后返回，所以这里
 * 只做三件事：把 URL 塞进 iframe、跟桥接脚本收发消息、把位置落盘。
 *
 * 为什么是 iframe 而不是把 HTML 注进当前文档：章节里的相对资源、CSS、字体必须相对章节
 * URL 解析，而且书的 origin（`arale://<id>`）与外壳隔离 —— 即使 sanitize 漏了一个脚本，
 * 它也碰不到 Node/Electron（见 shared/types.ts 中 ChapterContent 的注释）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BookRecord,
  ChapterContent,
  ReadingPosition,
  SpineItem,
  TocEntry,
} from '@shared/types';
import { FUSHI_BRIDGE_TAG, type BridgeToHost, type HostToBridge } from '@shared/reader-bridge';
import { api, call, run, useShellCommand } from '../lib/api';
import { clampFontScale, readerAppearance, useBookSettings } from '../lib/reader-settings';
import { WordCardPopup } from '../dict/WordCardPopup';
import type { UseWordCardsResult } from '../dict/word-cards';
import type { AnchorRect } from '../dict/WordCardPopup';

export interface EpubReaderProps {
  book: BookRecord;
  /** 上次的阅读位置；spineIndex + charOffset 都在这里恢复。 */
  initialPosition: ReadingPosition | null;
  onProgress: (label: string) => void;
  /**
   * 打开这本书的分词视图。
   *
   * 小说和漫画一样要看词表 —— 分词服务对 EPUB 是按章节切单元的
   * （`ref = chapter:<index>:<href>`），所以这个入口本来就该两边都有；
   * 之前只加在漫画阅读器上是遗漏。
   */
  onOpenSegments?: () => void;
  /**
   * 词卡状态。**由 ReaderView 持有**，不是阅读器自己创建的 ——
   * 词卡夹的开关在阅读器顶栏上、而顶栏属于 ReaderView；状态放两处必然不同步。
   */
  wordCards: UseWordCardsResult;
}

/** 位置落盘节流：滚动时桥接脚本每 150ms 报一次，落盘没必要这么勤。 */
const POSITION_SAVE_DEBOUNCE_MS = 2000;
const FONT_SCALE_STEP = 0.1;

/** 把联合类型里的 tag 字段去掉（分发式 Omit，普通 Omit 会把联合塌成一个对象）。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type HostMessage = DistributiveOmit<HostToBridge, 'tag'>;
type ClickMessage = Extract<BridgeToHost, { type: 'click' }>;
type SelectionMessage = Extract<BridgeToHost, { type: 'selection' }>;

export function EpubReader({
  book,
  initialPosition,
  onProgress,
  onOpenSegments,
  wordCards,
}: EpubReaderProps): JSX.Element {
  // 设置页里的是**默认值**；阅读器里改的写进本书的覆盖值。
  const { settings, patch: patchBook } = useBookSettings(book.id);
  const spine = useMemo<SpineItem[]>(() => book.spine ?? [], [book.spine]);
  const total = spine.length;

  const startIndex = useMemo(() => {
    const index = initialPosition?.spineIndex;
    return typeof index === 'number' && index >= 0 && index < total ? index : 0;
  }, [initialPosition, total]);

  const [spineIndex, setSpineIndex] = useState(startIndex);
  const [chapter, setChapter] = useState<ChapterContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  /**
   * 上一次**划词**开出来的那张卡的 id（点击查词不写它）。
   *
   * 只用来决定页面上那份持久高亮该不该继续留着，见 `holdSelection`。
   */
  const [heldSelectionPopupId, setHeldSelectionPopupId] = useState<string | null>(null);
  /** 词卡弹窗 + 词卡夹（与漫画阅读器共用同一套状态中枢）。 */

  const iframeRef = useRef<HTMLIFrameElement>(null);
  /** 最近一次从 iframe 收到的全局文本偏移；null = 本章还没报过，不能让 0 覆盖已存进度。 */
  const offsetRef = useRef<number | null>(null);
  const fractionRef = useRef(0);
  const saveTimerRef = useRef<number | null>(null);

  // 订阅只注册一次，所以易变的值都走 ref（否则每次设置变化都要重挂 message 监听）。
  const spineIndexRef = useRef(spineIndex);
  spineIndexRef.current = spineIndex;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;

  const pendingRestoreRef = useRef<{ spineIndex: number; offset: number } | null>(
    initialPosition !== null &&
      typeof initialPosition.spineIndex === 'number' &&
      typeof initialPosition.charOffset === 'number'
      ? { spineIndex: initialPosition.spineIndex, offset: initialPosition.charOffset }
      : null,
  );

  // ------------------------------------------------------------------
  // 与 iframe 通信
  // ------------------------------------------------------------------

  const post = useCallback((message: HostMessage) => {
    const target = iframeRef.current?.contentWindow;
    if (!target) return;
    try {
      target.postMessage({ ...message, tag: FUSHI_BRIDGE_TAG }, '*');
    } catch {
      // iframe 已被卸载（切章/退出阅读器时会发生），忽略。
    }
  }, []);

  /**
   * 划词高亮是否继续留在页面上：那次划词的卡片还开着。
   *
   * 卡片可能被关闭按钮、Esc、点击别处、切章四种路子关掉，全都是在 hook 里改
   * `popups`，所以这里只需要"卡片没了 → 清高亮"这一条规则。
   */
  const holdSelection =
    heldSelectionPopupId !== null &&
    wordCards.popups.some((popup) => popup.id === heldSelectionPopupId);
  const holdRef = useRef(false);
  useEffect(() => {
    // 只在**由真变假**时清（也就是卡片关掉那一刻）。写成 `if (!holdSelection)` 会在
    // 挂载时、以及「划完词、卡片还在查」这段时间误清——那时它本来就还是 false。
    if (holdRef.current && !holdSelection) post({ type: 'clearHighlight' });
    holdRef.current = holdSelection;
  }, [holdSelection, post]);

  // ------------------------------------------------------------------
  // 位置保存
  // ------------------------------------------------------------------

  const save = useCallback(() => {
    const offset = offsetRef.current;
    if (offset === null) return;
    const index = spineIndexRef.current;
    const position: ReadingPosition = {
      bookId: book.id,
      spineIndex: index,
      charOffset: offset,
      updatedAt: Date.now(),
    };
    const href = spine[index]?.href;
    if (typeof href === 'string') position.spineHref = href;
    run('保存阅读进度', () => api.library.savePosition(position));
  }, [book.id, spine]);

  const flushNow = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    save();
  }, [save]);

  const flushRef = useRef(flushNow);
  flushRef.current = flushNow;

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      save();
    }, POSITION_SAVE_DEBOUNCE_MS);
  }, [save]);

  // 卸载时立刻落盘（不 debounce），否则最后两秒的滚动会丢。
  useEffect(
    () => () => {
      flushRef.current();
    },
    [],
  );

  // ------------------------------------------------------------------
  // 章节加载
  // ------------------------------------------------------------------

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    setChapter(null);
    offsetRef.current = null;

    void call('加载章节', () => api.book.chapter(book.id, spineIndex)).then((content) => {
      if (!alive) return;
      setLoading(false);
      if (!content) {
        setLoadError('章节加载失败');
        return;
      }
      setChapter(content);
    });

    return () => {
      alive = false;
    };
  }, [book.id, spineIndex, retryToken]);

  useEffect(() => {
    const label =
      total > 0
        ? `第 ${spineIndex + 1} / ${total} 章 · ${Math.round(fractionRef.current / 100)}%`
        : '无章节';
    onProgressRef.current(label);
  }, [spineIndex, total, chapter]);

  // ------------------------------------------------------------------
  // 章节跳转
  // ------------------------------------------------------------------

  const goToSpine = useCallback(
    (index: number) => {
      if (index < 0 || index >= spine.length) return;
      if (index === spineIndexRef.current) return;
      flushNow(); // 换章前先把上一章的位置落盘
      offsetRef.current = null;
      fractionRef.current = 0;
      closeUnpinned();
      setSpineIndex(index);
    },
    [flushNow, spine.length],
  );

  const handleLink = useCallback(
    (href: string) => {
      const currentHref = spine[spineIndexRef.current]?.href ?? '';
      const target = resolveSpineIndex(href, spine, currentHref);
      if (target < 0) {
        onProgressRef.current('这个链接指向本书之外的资源，已在阅读器里忽略');
        return;
      }
      goToSpine(target);
    },
    [goToSpine, spine],
  );

  /**
   * 关掉没有固定的词卡。
   *
   * 通过 ref 拿最新的 popups，避免把 `goToSpine` 的依赖拖长、每次翻章都重建回调。
   */
  const popupsRef = useRef(wordCards.popups);
  popupsRef.current = wordCards.popups;
  const closeUnpinned = useCallback(() => {
    for (const item of popupsRef.current) {
      if (!item.pinned) wordCards.closePopup(item.id);
    }
  }, [wordCards]);

  const handleClick = useCallback(
    async (message: ClickMessage) => {
      // 桥接脚本给的是 **iframe 视口内**的矩形，弹窗是相对父窗口定位的，必须加上 iframe 的
      // bounding rect，否则弹窗会出现在左上角（这是最容易漏的一步）。
      const iframeRect = iframeRef.current?.getBoundingClientRect();
      const anchor: AnchorRect = {
        x: (iframeRect?.left ?? 0) + message.rect.x,
        y: (iframeRect?.top ?? 0) + message.rect.y,
        width: message.rect.width,
        height: message.rect.height,
      };

      const result = await call('查词', () => api.dict.lookup(message.context, message.offset));
      if (!result) return;
      // 点击：用扫描命中的表面形当卡片标题（允许最长匹配去猜）。
      wordCards.openPopup({
        word: result.term !== '' ? result.term : result.query,
        context: message.context,
        offset: message.offset,
        length: 0,
        anchor,
        result,
      });

      // 顺手让 iframe 给命中词画一条临时下划线。tokens 的偏移基准是我们传进去的 context，
      // 而 message.offset 也是 context 内的偏移，所以差值可以直接搬到全局偏移上。
      const tokens = result.tokens;
      const token =
        tokens.find((t) => t.start <= message.offset && message.offset < t.end) ??
        tokens.find((t) => t.matched);
      if (token) {
        const delta = token.start - message.offset;
        const start = Math.max(0, message.absoluteOffset + delta);
        post({ type: 'highlight', start, end: start + Math.max(0, token.end - token.start) });
      }
    },
    [post, wordCards],
  );

  /**
   * 划词：**按用户框住的原文精确查**。
   *
   * 与点击的唯一区别：卡片标题直接用选区原文，并且记下选区长度。查询链路完全一样，
   * 所以「卡片上的词」和「词典里的辞书形」可以不一样——那是正确行为，不是 bug。
   */
  const handleSelection = useCallback(
    async (message: SelectionMessage) => {
      const iframeRect = iframeRef.current?.getBoundingClientRect();
      const anchor: AnchorRect = {
        x: (iframeRect?.left ?? 0) + message.rect.x,
        y: (iframeRect?.top ?? 0) + message.rect.y,
        width: message.rect.width,
        height: message.rect.height,
      };
      const result = await call('查词', () => api.dict.lookup(message.context, message.offset));
      if (!result) return;
      // 记下这次划词开出来的卡片：**卡片还开着**就是页面上高亮该留着的全部理由。
      setHeldSelectionPopupId(
        wordCards.openPopup({
          word: message.text,
          context: message.context,
          offset: message.offset,
          length: Array.from(message.text).length,
          anchor,
          result,
        }),
      );
      // 划词的高亮**一直画着**（不是点击那种闪一下）：卡片关掉才由下面的 effect 清。
      const absoluteStart = message.absoluteOffset;
      post({
        type: 'highlight',
        start: absoluteStart,
        end: absoluteStart + message.text.length,
        persistent: true,
      });
    },
    [post, wordCards],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const iframe = iframeRef.current;
      // 纵深防御：书里的脚本已被 sanitize 剥掉，但仍然只接受来自**本 iframe** 的消息。
      if (!iframe || event.source !== iframe.contentWindow) return;
      const data: unknown = event.data;
      if (!isBridgeToHost(data)) return;

      switch (data.type) {
        case 'ready': {
          const pending = pendingRestoreRef.current;
          if (pending !== null && pending.spineIndex === spineIndexRef.current) {
            post({ type: 'restore', absoluteOffset: pending.offset });
            pendingRestoreRef.current = null;
          }
          // 用 `appearance` 而不是 `fontScale`：一条消息带全部外观，避免拆成多条时
          // CSS 变量短暂处于「一半新一半旧」的状态（切换时会出现一帧闪烁）。
          post({ type: 'appearance', value: readerAppearance(settingsRef.current) });
          post({ type: 'mode', vertical: settingsRef.current.vertical });
          break;
        }
        case 'click':
          void handleClick(data);
          break;
        case 'selection':
          void handleSelection(data);
          break;
        case 'position':
          offsetRef.current = data.absoluteOffset;
          fractionRef.current = data.fraction;
          scheduleSave();
          onProgressRef.current(
            `第 ${spineIndexRef.current + 1} / ${total} 章 · ${Math.round(data.fraction / 100)}%`,
          );
          break;
        case 'link':
          handleLink(data.href);
          break;
        case 'resize':
          // 章节高度变化本身不需要父窗口做布局（iframe 自己滚），保留分支以便将来做进度条。
          break;
        default:
          break;
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [handleClick, handleLink, post, scheduleSave, total]);

  // 外观变化实时透传。桥接协议有 `appearance` 一条消息承载全部字段
  // （fontScale / fontFamily / lineHeight / margin / vertical），不要再拆成多条。
  useEffect(() => {
    post({ type: 'appearance', value: readerAppearance(settings) });
  }, [post, settings.fontScale, settings.fontFamily, settings.lineHeight, settings.margin, settings.vertical]);

  useEffect(() => {
    post({ type: 'mode', vertical: settings.vertical });
  }, [post, settings.vertical]);

  // ------------------------------------------------------------------
  // 键盘
  // ------------------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      }

      // RTL（日文竖排）下「下一章」在左边 —— 与 Fushi 的
      // resolveReaderArrowPageTurn(leftIsForward = rtl ^ reverse) 同一套语义
      // （docs/analysis/02 §5.7）。
      const forwardKey = book.direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
      const backKey = book.direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft';

      if (event.key === forwardKey) {
        event.preventDefault();
        goToSpine(spineIndexRef.current + 1);
      } else if (event.key === backKey) {
        event.preventDefault();
        goToSpine(spineIndexRef.current - 1);
      } else if (event.key === 'PageDown') {
        event.preventDefault();
        goToSpine(spineIndexRef.current + 1);
      } else if (event.key === 'PageUp') {
        event.preventDefault();
        goToSpine(spineIndexRef.current - 1);
      } else if (event.key === '[') {
        event.preventDefault();
        patchBook({ fontScale: clampFontScale(settingsRef.current.fontScale - FONT_SCALE_STEP) });
      } else if (event.key === ']') {
        event.preventDefault();
        patchBook({ fontScale: clampFontScale(settingsRef.current.fontScale + FONT_SCALE_STEP) });
      } else if (event.key === 'v' || event.key === 'V') {
        event.preventDefault();
        patchBook({ vertical: !settingsRef.current.vertical });
      } else if (event.key === 'Escape') {
        setTocOpen(false);
        closeUnpinned();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [book.direction, goToSpine]);

  // 主进程菜单 → 翻章 / 缩放。
  useShellCommand((command) => {
    switch (command) {
      case 'nextPage':
        goToSpine(spineIndexRef.current + 1);
        break;
      case 'prevPage':
        goToSpine(spineIndexRef.current - 1);
        break;
      case 'zoomIn':
        patchBook({ fontScale: clampFontScale(settingsRef.current.fontScale + FONT_SCALE_STEP) });
        break;
      case 'zoomOut':
        patchBook({ fontScale: clampFontScale(settingsRef.current.fontScale - FONT_SCALE_STEP) });
        break;
      case 'zoomReset':
        patchBook({ fontScale: 1 });
        break;
      default:
        break;
    }
  });

  // ------------------------------------------------------------------

  const toc = useMemo<TocEntry[]>(() => book.toc ?? [], [book.toc]);
  const currentLabel = chapterLabel(toc, spine[spineIndex]?.href ?? '');

  return (
    <div className="epub-reader">
      <div className="epub-stage">
        {chapter !== null && (
          <iframe
            ref={iframeRef}
            className="epub-frame"
            title={`章节 ${spineIndex + 1}`}
            src={chapter.url}
            sandbox="allow-scripts allow-same-origin"
            onLoad={() => closeUnpinned()}
          />
        )}

        {loading && <div className="reader-overlay">正在加载章节…</div>}
        {!loading && loadError !== null && (
          <div className="reader-overlay reader-overlay-error">
            <div>{loadError}</div>
            <button type="button" className="btn btn-sm" onClick={() => setRetryToken((t) => t + 1)}>
              重试
            </button>
          </div>
        )}

        {tocOpen && (
          <aside className="toc-drawer">
            <div className="toc-drawer-header">
              <span>目录</span>
              <button type="button" className="icon-btn" onClick={() => setTocOpen(false)} title="关闭">
                ×
              </button>
            </div>
            <div className="toc-drawer-body">
              {toc.length === 0 ? (
                <div className="detail-hint">这本书没有目录数据。</div>
              ) : (
                <ul className="toc-list">
                  {toc.map((entry, index) => {
                    const target = resolveSpineIndex(entry.href, spine, '');
                    return (
                      <li key={`${entry.href}-${index}`}>
                        <button
                          type="button"
                          className={`toc-item${target === spineIndex ? ' is-active' : ''}`}
                          style={{ paddingLeft: `${8 + entry.depth * 12}px` }}
                          disabled={target < 0}
                          title={entry.href}
                          onClick={() => {
                            goToSpine(target);
                            setTocOpen(false);
                          }}
                        >
                          {entry.label}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </aside>
        )}
      </div>

      <div className="epub-footer">
        <button
          type="button"
          className="btn btn-sm"
          disabled={spineIndex <= 0}
          onClick={() => goToSpine(spineIndex - 1)}
          title="上一章（← / PageUp）"
        >
          ← 上一章
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setTocOpen((open) => !open)}
          title="目录"
        >
          目录
        </button>
        {onOpenSegments && (
          <button type="button" className="btn btn-sm" onClick={onOpenSegments} title="看这本书的词表，或生成/重新生成分词">
            分词
          </button>
        )}
        <span className="epub-chapter-label cell-ellipsis" title={spine[spineIndex]?.href ?? ''}>
          {currentLabel}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          disabled={spineIndex >= total - 1}
          onClick={() => goToSpine(spineIndex + 1)}
          title="下一章（→ / PageDown）"
        >
          下一章 →
        </button>

        <span className="toolbar-sep" />

        <button
          type="button"
          className="btn btn-sm"
          onClick={() => patchBook({ fontScale: clampFontScale(settings.fontScale - FONT_SCALE_STEP) })}
          title="缩小字号（[）"
        >
          A−
        </button>
        <span className="epub-scale mono">{Math.round(settings.fontScale * 100)}%</span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => patchBook({ fontScale: clampFontScale(settings.fontScale + FONT_SCALE_STEP) })}
          title="放大字号（]）"
        >
          A+
        </button>
        <button
          type="button"
          className={`btn btn-sm${settings.vertical ? ' btn-primary' : ''}`}
          onClick={() => patchBook({ vertical: !settings.vertical })}
          title="切换竖排（v）"
        >
          竖排
        </button>
      </div>

      {/* 弹窗可同时开多张：pin 住的不会被后来者顶掉。 */}
      {wordCards.popups.map((popup, index) => (
        <WordCardPopup
          key={popup.id}
          cascade={index}
          word={popup.word}
          result={popup.result}
          anchor={popup.anchor}
          pinned={popup.pinned}
          dictionaryId={popup.dictionaryId}
          saved={wordCards.isSaved(popup)}
          saving={popup.saving}
          analyses={popup.analyses}
          analyzingWord={popup.analyzingWord}
          llmProfileId={popup.llmProfileId}
          llmProfiles={wordCards.llmProfiles}
          lastError={popup.lastError}
          onAnalyze={(target) => wordCards.analyzeWord(popup.id, target)}
          onRemoveAnalysis={(target) => wordCards.removeAnalysis(popup.id, target)}
          onSelectLlmProfile={(profileId) => wordCards.selectLlmProfile(popup.id, profileId)}
          selectionLength={popup.length}
          onClose={() => wordCards.closePopup(popup.id)}
          onTogglePin={() => wordCards.togglePin(popup.id)}
          onWordChange={(next) => wordCards.setWord(popup.id, next)}
          onSelectDictionary={(dictId) => wordCards.selectDictionary(popup.id, dictId)}
          onSave={() => wordCards.savePopup(popup.id)}

        />
      ))}

    </div>
  );
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function isBridgeToHost(data: unknown): data is BridgeToHost {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { tag?: unknown }).tag === FUSHI_BRIDGE_TAG
  );
}

/**
 * 把章节内链接 / 目录 href 映射到 spine 下标。
 *
 * spine[].href 相对 OPF 目录，toc[].href 相对书目录 —— 两者的公共部分不足以做严格拼接，
 * 但**文件名**是唯一的，所以：先按完整路径相等试一次，再退化成 basename 匹配。这也是
 * 任务书里指定的做法。
 */
function resolveSpineIndex(href: string, spine: SpineItem[], currentHref: string): number {
  if (href === '' || href.startsWith('#')) return -1;

  let path = href.split('#')[0] ?? '';
  try {
    // 用一个假的 base 只为走一遍标准的相对路径解析（处理 ./ ../ 与编码）。
    const url = new URL(href, `arale://book/${currentHref}`);
    path = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    try {
      path = decodeURIComponent(path);
    } catch {
      // href 本身编码坏了，就用原串继续试。
    }
  }
  if (path === '') return -1;

  for (let i = 0; i < spine.length; i += 1) {
    if (spine[i]?.href === path) return i;
  }

  const wanted = basename(path);
  for (let i = 0; i < spine.length; i += 1) {
    const candidate = spine[i]?.href;
    if (candidate !== undefined && basename(candidate) === wanted) return i;
  }
  return -1;
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

function chapterLabel(toc: TocEntry[], href: string): string {
  if (href === '') return '—';
  const wanted = basename(href);
  for (const entry of toc) {
    if (basename(entry.href) === wanted) return entry.label;
  }
  return wanted;
}
