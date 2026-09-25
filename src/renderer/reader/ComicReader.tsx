/**
 * 漫画阅读器。
 *
 * 与 EPUB 阅读器完全不同的两条铁律：
 * - 图片是**页面资源**（`arale://`），不是文档，所以没有 iframe、没有桥接脚本；
 * - 文字层是自己叠的绝对定位层，几何按原图像素 × 缩放比算（见 ComicTextLayer）。
 *
 * 页码方向：`book.direction === 'rtl'`（日漫默认）时，
 * - 双页跨页的**低页号在右边**（DOM 顺序要镜像）；
 * - **翻页按钮整体反向**：「下一页」跑到左边、箭头朝左。方向键的「前进」也翻到左边。
 *   这不是输入映射的小事，DOM 顺序也要跟着镜像，否则会出现「按下一页，画面往反方向动」
 *   （docs/analysis/01 §10 第 6 条）。
 *
 * 跨页配对（含「封面单独成页」的偏移量）全部交给 `core/comic/spread.ts` 的纯函数算，
 * 这里只负责渲染与动画。阅读器里的 `pageIndex` **永远是一个跨页的起始页**。
 *
 * OCR：识别是**串行队列**（主进程 `ocr/service.ts`），这本书在跑或排队时，
 * 引擎选择器固化在那条任务的引擎上并淡化，主按钮变成「停止识别」/「取消排队」。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import type {
  BookRecord,
  ComicPage,
  OcrCapability,
  OcrJobResult,
  OcrProgress,
  OcrProviderId,
  OcrQueueState,
  PageText,
  ReadingDirection,
  ReadingPosition,
} from '@shared/types';
import {
  SPREAD_OFFSETS,
  clampSpreadOffset,
  spreadOffsetLabel,
  spreadPages,
  spreadPlan,
  stepSpread,
} from '@core/comic/spread';
import { api, assetUrl, call, run, useShellCommand } from '../lib/api';
import { useBookSettings } from '../lib/reader-settings';
import { WordCardPopup } from '../dict/WordCardPopup';
import type { UseWordCardsResult } from '../dict/word-cards';
import { ComicTextLayer, type ComicTextLookup, type ComicTextSelection } from './ComicTextLayer';
import { ocrControlState } from './ocr-controls';
import { capturePointer } from '../lib/pointer';

export interface ComicReaderProps {
  book: BookRecord;
  initialPosition: ReadingPosition | null;
  onProgress: (label: string) => void;
  /** 本书正在进行中的 OCR 进度，没有任务时为 null。 */
  ocrProgress?: OcrProgress | null;
  /** 本书最近一次 OCR 结果（用来决定按钮文案：识别 / 重新识别）。 */
  ocrResult?: OcrJobResult | null;
  onStartOcr?: (bookId: string, force?: boolean, provider?: OcrProviderId) => void;
  onCancelOcr?: (bookId: string) => void;
  /** 各 OCR 引擎的可用性。只有 ≥2 个可用时才显示引擎选择器。 */
  ocrCapability?: OcrCapability | null;
  /** 全局识别队列快照：判断这本书是在跑、在排队、还是什么都没做。 */
  ocrQueue?: OcrQueueState | null;
  /** 打开这本书的分词视图。 */
  onOpenSegments?: () => void;

  /**
   * 词卡状态。**由 ReaderView 持有**，不是阅读器自己创建的 ——
   * 词卡夹的开关在阅读器顶栏上、而顶栏属于 ReaderView；状态放两处必然不同步。
   */
  wordCards: UseWordCardsResult;
}

/** 翻页滑动动画时长（ms）。够短，连按方向键不会排出一条动画队列。 */
const SLIDE_MS = 220;

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.2;
/** 拖动超过这个像素数就算平移，而不是点击查词。 */
const DRAG_THRESHOLD_PX = 4;

export function ComicReader({
  book,
  initialPosition,
  onProgress,
  ocrProgress = null,
  ocrResult = null,
  onStartOcr,
  onCancelOcr,
  ocrCapability = null,
  ocrQueue = null,
  onOpenSegments,
  wordCards,
}: ComicReaderProps): JSX.Element {
  // 设置页里的是**默认值**；阅读器里改的写进本书的覆盖值，不影响下一本新书。
  const { settings, overrides: bookSettings, patch: patchBook } = useBookSettings(book.id);
  // 引擎选择：本书上次选的优先，其次跟设置里的默认，最后才落到内置兜底。
  const [ocrProvider, setOcrProvider] = useState<OcrProviderId | null>(
    bookSettings.ocrProvider ?? null,
  );
  const usableProviders = (ocrCapability?.providers ?? []).filter((item) => item.available);

  /**
   * 这本书的队列身份。
   *
   * `active` 是「正在跑」，`pending` 里能找到就是「排队中」——两者对按钮文案不同
   * （停止识别 / 取消排队），但对引擎选择器都一样：**固化，不许改**。
   */
  const queuedEntry =
    ocrQueue === null
      ? null
      : ocrQueue.active?.bookId === book.id
        ? ocrQueue.active
        : (ocrQueue.pending.find((entry) => entry.bookId === book.id) ?? null);
  const ocrActive = queuedEntry !== null && ocrQueue?.active?.bookId === book.id;
  const queuedPosition = ocrQueue
    ? ocrQueue.pending.findIndex((entry) => entry.bookId === book.id) + 1
    : 0;
  /** 引擎 id → 显示名。 */
  const providerLabelOf = (id: OcrProviderId): string =>
    ocrCapability?.providers.find((item) => item.id === id)?.label ?? id;

  const ocrControls = ocrControlState({
    queueEntry: queuedEntry,
    active: ocrActive,
    queuePosition: queuedPosition,
    providerOverride: ocrProvider,
    defaultProvider: ocrCapability?.selected ?? 'system',
    providerLabel: providerLabelOf,
    progress: ocrProgress,
    hasResult: ocrResult?.ok === true,
    canStart: onStartOcr !== undefined,
    canCancel: onCancelOcr !== undefined,
  });
  const effectiveProvider = ocrControls.provider;

  const pages = useMemo<ComicPage[]>(() => book.pages ?? [], [book.pages]);
  const total = pages.length;
  /**
   * 方向可以被阅读器内的按钮改。改的是书库里的元数据（updateMeta），但 App 手里的
   * `open.book` 是打开那一刻的快照，不会自己刷新 —— 所以本地留一份覆盖值，保证按钮按下去
   * 画面立刻翻转，而不是要退出重进才生效。
   */
  const [directionOverride, setDirectionOverride] = useState<ReadingDirection | null>(null);
  const direction = directionOverride ?? book.direction;
  const rtl = direction === 'rtl';
  /** 双页跨页模式。 */
  const spread = settings.comicSpread;
  /** 配对偏移：前几页各自单独成页（0..4）。见 `core/comic/spread.ts`。 */
  const spreadOffset = clampSpreadOffset(settings.comicSpreadOffset);

  const [pageIndex, setPageIndex] = useState(() => {
    const index = initialPosition?.pageIndex;
    const raw = typeof index === 'number' && index >= 0 && index < total ? index : 0;
    // 归一化到跨页起始页：磁盘上的进度可能是「上一跨页的第二页」（用户上次在单页模式，
    // 或者刚改过偏移量），直接拿它当起点会让并排的两页整体错位一格。
    return spreadPlan(raw, total, spreadOffset, spread).start;
  });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  /**
   * 空格键是否按着。
   *
   * 拖动**只表示划词**，移动画面改用「空格+拖动 / 中键拖动 / 滚轮」。
   * 之前是「画面溢出时拖动=移动、否则=划词」——手势含义取决于一个看不见的状态，
   * 用户永远建立不起预期（实测反馈就是「拖不动」）。现在两种意图各有各的明确入口。
   */
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [textVersion, setTextVersion] = useState(0);
  const [textLayerOn, setTextLayerOn] = useState(true);
  /** 词卡弹窗 + 词卡夹的状态（点击、划词、pin、保存、LLM 分析都走它）。 */

  const cacheRef = useRef(new Map<number, PageText>());
  const viewportRef = useRef<HTMLDivElement>(null);
  const suppressClickRef = useRef(false);
  const dragRef = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null);
  const pageIndexRef = useRef(pageIndex);
  pageIndexRef.current = pageIndex;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;

  // ------------------------------------------------------------------
  // 视口尺寸
  // ------------------------------------------------------------------

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setViewport({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // ------------------------------------------------------------------
  // 页面与缩放几何
  // ------------------------------------------------------------------

  /** 本跨页要显示的页下标（单页模式恒为 1 个；书尾可能只剩 1 个）。 */
  const visibleIndices = spreadPages(pageIndex, total, spreadOffset, spread);
  const primary = visibleIndices[0] !== undefined ? pages[visibleIndices[0]] : undefined;
  const secondary = visibleIndices[1] !== undefined ? pages[visibleIndices[1]] : undefined;

  const pairWidth = (primary?.width ?? 1) + (secondary?.width ?? 0);
  const pairHeight = Math.max(primary?.height ?? 1, secondary?.height ?? 1);

  const availableWidth = Math.max(1, viewport.w - 8);
  const availableHeight = Math.max(1, viewport.h - 8);
  const baseScale =
    settings.comicFit === 'width'
      ? availableWidth / pairWidth
      : settings.comicFit === 'height'
        ? availableHeight / pairHeight
        : 1;
  const scale = baseScale * zoom;

  const displayedPairWidth = pairWidth * scale;
  const displayedPairHeight = pairHeight * scale;
  const canPan = displayedPairWidth > viewport.w + 1 || displayedPairHeight > viewport.h + 1;

  // 缩放/换页后把平移量夹回可达范围，免得图被拖出视野再也拉不回来。
  useEffect(() => {
    setPan((prev) => {
      const maxX = Math.max(0, (displayedPairWidth - viewport.w) / 2);
      const maxY = Math.max(0, (displayedPairHeight - viewport.h) / 2);
      const x = Math.min(maxX, Math.max(-maxX, prev.x));
      const y = Math.min(maxY, Math.max(-maxY, prev.y));
      return x === prev.x && y === prev.y ? prev : { x, y };
    });
  }, [displayedPairWidth, displayedPairHeight, viewport.w, viewport.h]);

  // 换页或换适配模式时回到居中。
  useEffect(() => {
    setPan({ x: 0, y: 0 });
  }, [pageIndex, settings.comicFit, spread]);

  // 配对规则变了（开/关双页、改偏移量）→ 把当前页重新归到它所属的跨页。
  // 不做这一步的话，改偏移量之后当前页会停在「第二个半页」上，画面看着像跳了一页。
  useEffect(() => {
    setPageIndex((current) => spreadPlan(current, total, spreadOffset, spread).start);
  }, [spreadOffset, spread, total]);

  // ------------------------------------------------------------------
  // 文字层（按页缓存，Map 避免重复 IPC）
  // ------------------------------------------------------------------

  useEffect(() => {
    let alive = true;
    const wanted = spreadPages(pageIndex, total, spreadOffset, spread).filter(
      (index) => pages[index] !== undefined,
    );

    const missing = wanted.filter((index) => !cacheRef.current.has(index));
    if (missing.length === 0) return;

    void (async () => {
      for (const index of missing) {
        const pageText = await call('加载文字层', () => api.book.pageText(book.id, index));
        if (!alive) return;
        // 没有 OCR 数据时主进程返回 blocks: []，同样缓存起来，避免每次翻回来都再问一遍。
        if (pageText) cacheRef.current.set(index, pageText);
      }
      if (alive) setTextVersion((v) => v + 1);
    })();

    return () => {
      alive = false;
    };
  }, [book.id, pageIndex, pages, spreadOffset, spread, total]);

  // textVersion 只作为依赖用：缓存是 ref，需要一次 setState 把新内容带进这一帧。
  const texts = useMemo(() => new Map(cacheRef.current), [textVersion]);

  // ------------------------------------------------------------------
  // 进度
  // ------------------------------------------------------------------

  const firstRenderRef = useRef(true);
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return;
    }
    run('保存阅读进度', () =>
      api.library.savePosition({ bookId: book.id, pageIndex, updatedAt: Date.now() }),
    );
  }, [book.id, pageIndex]);

  useEffect(
    () => () => {
      run('保存阅读进度', () =>
        api.library.savePosition({
          bookId: book.id,
          pageIndex: pageIndexRef.current,
          updatedAt: Date.now(),
        }),
      );
    },
    [book.id],
  );

  useEffect(() => {
    onProgressRef.current(
      total > 0
        ? `第 ${pageIndex + 1} / ${total} 页${spread ? ' · 双页' : ''} · ${Math.round(zoom * 100)}%`
        : '无页面',
    );
  }, [pageIndex, total, spread, zoom]);

  // ------------------------------------------------------------------
  // 预加载相邻页
  // ------------------------------------------------------------------

  useEffect(() => {
    // 预热前后**各一个跨页**（可能两页），而不是固定 ±2 页：
    // 有偏移量时「前后各两页」跟真实的翻页落点对不上。
    const targets = new Set<number>();
    for (const forward of [true, false]) {
      const start = stepSpread(pageIndex, total, spreadOffset, spread, forward);
      for (const index of spreadPages(start, total, spreadOffset, spread)) targets.add(index);
    }
    for (const index of targets) {
      const page = pages[index];
      if (!page) continue;
      const src = assetUrl(book.id, page.url);
      if (!src) continue;
      // 用一次性的 Image 预热 `arale://` 的缓存；对象随 GC 回收，不必手动管理。
      const image = new Image();
      image.src = src;
    }
  }, [book.id, pageIndex, pages, spreadOffset, spread, total]);

  // ------------------------------------------------------------------
  // 导航
  // ------------------------------------------------------------------

  // 滑动动画的两个 ref：一个记「这次换页该往哪边滑」，一个指向被动画的那层。
  const slideRef = useRef<HTMLDivElement>(null);
  const pendingSlideRef = useRef<'forward' | 'back' | null>(null);

  /**
   * 唯一的换页入口。
   *
   * 为什么要收成一个：换页要同时更新页号、清弹窗、**并记下方向**给滑动动画用。
   * 分散在 next/prev/goTo/Home/End 五处各写一遍，早晚漏掉一处（漏掉的表现是
   * 「按 End 跳页没有动画」这种没人会去查的小 bug）。
   */
  const navigate = useCallback(
    (target: number, forward: boolean) => {
      closeUnpinned();
      const clamped = Math.min(Math.max(0, target), Math.max(0, total - 1));
      if (clamped === pageIndexRef.current) return;
      pendingSlideRef.current = forward ? 'forward' : 'back';
      setPageIndex(clamped);
    },
    [total],
  );

  const next = useCallback(
    () => navigate(stepSpread(pageIndexRef.current, total, spreadOffset, spread, true), true),
    [navigate, total, spreadOffset, spread],
  );

  const prev = useCallback(
    () => navigate(stepSpread(pageIndexRef.current, total, spreadOffset, spread, false), false),
    [navigate, total, spreadOffset, spread],
  );

  /** 跳到某个跨页；方向按目标与当前页的相对位置推断（目录跳转、Home/End 都走这里）。 */
  const goTo = useCallback(
    (index: number) => navigate(index, index >= pageIndexRef.current),
    [navigate],
  );

  /**
   * 翻页滑动动画。
   *
   * 用 Web Animations API 而不是「给元素换 key 让它重挂载」：重挂载会重建 `<img>`，
   * 而 `arale://` 是自定义协议、不参与 HTTP 缓存，于是每次翻页都看得见一次图片重解码
   * 的闪白。`element.animate()` 只动 transform/opacity，DOM 一个节点都不换。
   *
   * 用 `useLayoutEffect` 是为了在**paint 之前**起动画：晚一帧的话，新页会先以最终位置
   * 闪一下，再跳回起点开始滑。
   *
   * 方向：前进时新页从「阅读推进的方向」进入——LTR 前进从右边进，RTL 前进从左边进。
   */
  useLayoutEffect(() => {
    const dir = pendingSlideRef.current;
    pendingSlideRef.current = null;
    if (dir === null) return;
    const el = slideRef.current;
    if (el === null) return;
    // 系统开了「减少动态效果」就不滑。这是无障碍要求，不是可选项。
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const fromRight = dir === 'forward' ? !rtl : rtl;
    const offset = fromRight ? '100%' : '-100%';
    el.animate(
      [
        { transform: `translateX(${offset})`, opacity: 0.35 },
        { transform: 'translateX(0%)', opacity: 1 },
      ],
      { duration: SLIDE_MS, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' },
    );
  }, [pageIndex, rtl]);

  /**
   * 换页时关掉没固定的词卡。
   *
   * 不关固定过的：用户特意 pin 住就是为了让它跨页留着。
   * 用 ref 拿最新的 popups，避免把 `navigate` 的依赖拖成一大串（那会让每次翻页
   * 都重建回调，进而让键盘监听反复解绑重绑）。
   */
  const popupsRef = useRef(wordCards.popups);
  popupsRef.current = wordCards.popups;
  const closeUnpinned = useCallback(() => {
    for (const item of popupsRef.current) {
      if (!item.pinned) wordCards.closePopup(item.id);
    }
  }, [wordCards]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat) return;
      const target = event.target as HTMLElement | null;
      // 输入框里敲空格是打字，不是「按住空格要移动画面」。
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      setSpaceHeld(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceHeld(false);
    };
    // 失焦时清掉：切走窗口再回来，keyup 收不到，空格会永远"按着"。
    const onBlur = () => setSpaceHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // ------------------------------------------------------------------
  // 滚轮：Cmd/Ctrl+滚轮缩放，普通滚轮移动画面
  // ------------------------------------------------------------------

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        setZoom((current) =>
          clamp(current * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), MIN_ZOOM, MAX_ZOOM),
        );
        return;
      }
      // React 的 onWheel 是 passive 的（preventDefault 无效），所以这里挂原生非 passive 监听。
      if (!canPan) return;
      event.preventDefault();
      setPan((current) => ({ x: current.x - event.deltaX, y: current.y - event.deltaY }));
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [canPan]);

  // ------------------------------------------------------------------
  // 拖动平移
  // ------------------------------------------------------------------

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      suppressClickRef.current = false;
      if (!canPan) return;
      // 中键拖动是通用惯例；空格+左键是给没有中键的鼠标留的路子。
      const middle = event.button === 1;
      const spacePan = event.button === 0 && spaceHeld;
      if (!middle && !spacePan) return;
      event.preventDefault();
      dragRef.current = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y, moved: false };
      capturePointer(event.currentTarget, event.pointerId);
    },
    [canPan, pan.x, pan.y, spaceHeld],
  );

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    suppressClickRef.current = true;
    setPan({ x: drag.px + dx, y: drag.py + dy });
  }, []);

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // ★ 拖动结束会紧跟一个 click，我们要吃掉它（否则「拖完画面」会顺手弹出一张词卡）。
    // 但**不能**只靠 `handleLookup` 去清这个标记：指针被 viewport 捕获时，那一次 click
    // 的目标也是 viewport，根本不会走到文字层的 `handleLookup`，标记就永远留着了 ——
    // 症状是「移动过一次画面之后，下一次点击查词没反应」，而且完全看不出原因。
    // 排到下一个宏任务清掉：click 在同一轮同步派发，一定早于定时器。
    if (suppressClickRef.current) {
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
  }, []);

  // ------------------------------------------------------------------
  // 查词
  // ------------------------------------------------------------------

  const handleLookup = useCallback(
    async (payload: ComicTextLookup) => {
      if (suppressClickRef.current) {
        // 这一次「点击」其实是拖动平移的收尾，别弹词卡。
        suppressClickRef.current = false;
        return;
      }
      const result = await call('查词', () => api.dict.lookup(payload.context, payload.offset));
      if (!result) return;
      // 点击：用扫描命中的表面形当卡片标题（允许最长匹配去猜）。
      wordCards.openPopup({
        word: result.term !== '' ? result.term : result.query,
        context: payload.context,
        offset: payload.offset,
        length: 0,
        anchor: payload.anchor,
        result,
      });
    },
    [wordCards],
  );

  /**
   * 划词：**按用户框住的原文精确查**。
   *
   * 与点击的区别只有一处，但很关键：offset 必须是选区起点、且卡片标题直接用选区原文。
   * 词典那一栏该怎么查还是怎么查（同一条链路），所以「查询用的词」和「词典里的词」
   * 允许不一样——用户框「食べました」，词典里给「食べる」，这是对的。
   */
  const handleSelect = useCallback(
    async (payload: ComicTextSelection) => {
      const result = await call('查词', () => api.dict.lookup(payload.context, payload.start));
      if (!result) return;
      wordCards.openPopup({
        word: payload.text,
        context: payload.context,
        offset: payload.start,
        length: payload.end - payload.start,
        anchor: payload.anchor,
        result,
      });
    },
    [wordCards],
  );

  // ------------------------------------------------------------------
  // 键盘 / 菜单命令
  // ------------------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      }
      const forwardKey = rtl ? 'ArrowLeft' : 'ArrowRight';
      const backKey = rtl ? 'ArrowRight' : 'ArrowLeft';

      if (event.key === forwardKey || event.key === 'PageDown' || event.key === ' ') {
        event.preventDefault();
        next();
      } else if (event.key === backKey || event.key === 'PageUp') {
        event.preventDefault();
        prev();
      } else if (event.key === 'Home') {
        event.preventDefault();
        goTo(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        goTo(total - 1);
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        setZoom((current) => clamp(current * ZOOM_STEP, MIN_ZOOM, MAX_ZOOM));
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        setZoom((current) => clamp(current / ZOOM_STEP, MIN_ZOOM, MAX_ZOOM));
      } else if (event.key === '0') {
        event.preventDefault();
        setZoom(1);
      } else if (event.key === 's' || event.key === 'S') {
        event.preventDefault();
        patchBook({ comicSpread: !spread });
      } else if (event.key === 'Escape') {
        // 词卡自己处理 Esc（它在捕获阶段收，并且固定住的卡不响应），
        // 这里只在没有卡的时候让 Esc 顺便关掉词典兜底状态。
        closeUnpinned();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeUnpinned, goTo, next, prev, rtl, total, spread, patchBook]);

  useShellCommand((command) => {
    switch (command) {
      case 'nextPage':
        next();
        break;
      case 'prevPage':
        prev();
        break;
      case 'zoomIn':
        setZoom((current) => clamp(current * ZOOM_STEP, MIN_ZOOM, MAX_ZOOM));
        break;
      case 'zoomOut':
        setZoom((current) => clamp(current / ZOOM_STEP, MIN_ZOOM, MAX_ZOOM));
        break;
      case 'zoomReset':
        setZoom(1);
        break;
      default:
        break;
    }
  });

  // ------------------------------------------------------------------

  /** 一页 + 它在 pages 里的下标。RTL 时把两页的 DOM 顺序反过来（低页号靠右）。 */
  interface Slot {
    page: ComicPage;
    index: number;
  }

  const slots: Slot[] = [];
  for (const index of visibleIndices) {
    const page = pages[index];
    if (page !== undefined) slots.push({ page, index });
  }
  // RTL：低页号靠右，所以 DOM 顺序反过来（flex 从左往右排）。
  if (rtl && slots.length === 2) slots.reverse();

  if (total === 0) {
    return (
      <div className="placeholder">
        这本书没有可显示的页面。可能导入时图片没被识别，试试重新导入。
      </div>
    );
  }

  const primaryText = texts.get(pageIndex);
  const noOcrData = primaryText !== undefined && primaryText.blocks.length === 0;

  /**
   * 切换阅读方向。本地立刻生效（`directionOverride`），写库是后台的事——
   * 等 IPC 回来才翻转画面会让人以为按钮没反应。
   */
  const setDirection = (nextDirection: ReadingDirection) => {
    if (nextDirection === direction) return;
    setDirectionOverride(nextDirection);
    run('切换阅读方向', async () => {
      await api.library.updateMeta(book.id, { direction: nextDirection });
    });
  };

  /** 已经在头/尾时，前后翻都回到同一页——用它做禁用判断，比 `pageIndex <= 0` 准。 */
  const atStart = stepSpread(pageIndex, total, spreadOffset, spread, false) === pageIndex;
  const atEnd = stepSpread(pageIndex, total, spreadOffset, spread, true) === pageIndex;

  /**
   * 翻页按钮。
   *
   * RTL 时**整体反向**：「下一页」跑到左边、箭头朝左。箭头一律指在「画面会往哪边走」
   * 的方向上，所以两个按钮的箭头永远朝外——这比贴一个 RTL/LTR 文字标签更直观。
   */
  const backButton = (
    <button
      type="button"
      className="btn btn-sm"
      disabled={atStart}
      onClick={prev}
      title={`上一页（${rtl ? '→' : '←'} / PageUp）`}
      data-testid="comic-prev"
    >
      {rtl ? '→ 上一页' : '← 上一页'}
    </button>
  );
  const forwardButton = (
    <button
      type="button"
      className="btn btn-sm"
      disabled={atEnd}
      onClick={next}
      title={`下一页（${rtl ? '←' : '→'} / PageDown）`}
      data-testid="comic-next"
    >
      {rtl ? '下一页 ←' : '下一页 →'}
    </button>
  );
  // RTL：前进在左、后退在右（阅读推进的方向就是往左）。
  const leadingTurn = rtl ? forwardButton : backButton;
  const trailingTurn = rtl ? backButton : forwardButton;

  return (
    <div className="comic-reader">
      <div
        ref={viewportRef}
        className={`comic-viewport${canPan ? ' can-pan' : ''}${canPan && spaceHeld ? ' is-panning' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          className="comic-spread"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px)`,
            width: `${displayedPairWidth}px`,
            height: `${displayedPairHeight}px`,
          }}
        >
          {/* 动画层单独一层：`.comic-spread` 的 transform 归平移量所有，
              两者写在同一个元素上会互相覆盖（拖动时橡皮筋 / 翻页时平移量丢失）。 */}
          <div className="comic-slide" ref={slideRef}>
          {slots.map((slot) => {
            const width = slot.page.width * scale;
            const height = slot.page.height * scale;
            const src = assetUrl(book.id, slot.page.url);
            return (
              <div key={`${slot.index}-${slot.page.url}`} className="comic-page-slot" style={{ width, height }}>
                {src !== null && (
                  <img
                    className="comic-page-img"
                    src={src}
                    alt=""
                    draggable={false}
                    decoding="async"
                    style={{ width, height }}
                  />
                )}
                {textLayerOn && (
                  <ComicTextLayer
                    text={texts.get(slot.index) ?? null}
                    pageWidth={slot.page.width}
                    pageHeight={slot.page.height}
                    displayedWidth={width}
                    displayedHeight={height}
                    onLookup={(payload) => void handleLookup(payload)}
                    onSelect={(payload) => void handleSelect(payload)}
                    // 只在真的按着空格时让路——否则拖动永远是划词。
                    deferDragToPan={canPan && spaceHeld}
                  />
                )}
              </div>
            );
          })}
          </div>
        </div>
      </div>

      <div className="comic-footer">
        {leadingTurn}
        <span className="comic-page-label mono" data-testid="comic-page-label">
          {visibleIndices.length > 1 ? `${pageIndex + 1}–${pageIndex + visibleIndices.length}` : pageIndex + 1}
          {' / '}
          {total}
        </span>
        {trailingTurn}

        <span className="toolbar-sep" />

        <select
          className="select"
          value={settings.comicFit}
          onChange={(e) =>
            patchBook({ comicFit: e.target.value as 'width' | 'height' | 'actual' })
          }
          title="适配方式"
        >
          <option value="height">适应高度</option>
          <option value="width">适应宽度</option>
          <option value="actual">原始尺寸</option>
        </select>

        <button
          type="button"
          className={`btn btn-sm${spread ? ' btn-primary' : ''}`}
          onClick={() => patchBook({ comicSpread: !spread })}
          title="双页跨页（s）"
          data-testid="comic-spread"
        >
          双页
        </button>

        {/* 配对偏移：只在双页模式下才有意义（单页模式每页本来就是一页）。 */}
        {spread && (
          <select
            className="select select-sm"
            value={String(spreadOffset)}
            onChange={(e) =>
              patchBook({ comicSpreadOffset: clampSpreadOffset(Number(e.target.value)) })
            }
            title={`配对偏移：${spreadOffsetLabel(spreadOffset)}`}
            data-testid="comic-spread-offset"
          >
            {SPREAD_OFFSETS.map((value) => (
              <option key={value} value={String(value)}>
                偏移 {value}
              </option>
            ))}
          </select>
        )}

        {/* 阅读方向：两个选项都摆出来并各带一个箭头，当前那个高亮 ——
            只显示当前值的单按钮很难一眼看出「点下去会变成什么」。 */}
        <div className="seg" role="group" aria-label="阅读方向" data-testid="comic-direction">
          <button
            type="button"
            className={`seg-btn${rtl ? '' : ' is-active'}`}
            aria-pressed={!rtl}
            onClick={() => setDirection('ltr')}
            title="从左到右：低页号在左，下一页在右"
          >
            LTR <span className="seg-arrow" aria-hidden="true">→</span>
          </button>
          <button
            type="button"
            className={`seg-btn${rtl ? ' is-active' : ''}`}
            aria-pressed={rtl}
            onClick={() => setDirection('rtl')}
            title="从右到左（日漫）：低页号在右，下一页在左"
          >
            RTL <span className="seg-arrow" aria-hidden="true">←</span>
          </button>
        </div>

        <span className="toolbar-sep" />

        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setZoom((current) => clamp(current / ZOOM_STEP, MIN_ZOOM, MAX_ZOOM))}
          title="缩小（-）"
        >
          −
        </button>
        <span className="comic-zoom mono">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setZoom((current) => clamp(current * ZOOM_STEP, MIN_ZOOM, MAX_ZOOM))}
          title="放大（+）"
        >
          ＋
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setZoom(1)} title="重置缩放（0）">
          1:1
        </button>

        <span className="toolbar-sep" />

        {usableProviders.length > 1 && (
          <select
            // `is-frozen` 把「锁定」这件事画出来：只 disabled 的话，用户看到的只是
            // 「点了没反应」，不知道是为什么。
            className={`select select-sm${ocrControls.frozen ? ' is-frozen' : ''}`}
            value={effectiveProvider}
            disabled={ocrControls.frozen}
            title={ocrControls.providerTitle}
            data-testid="comic-ocr-provider"
            onChange={(event) => {
              const next = event.target.value as OcrProviderId;
              setOcrProvider(next);
              // 按书记住：这本用 arale_onnx_v1、那本用系统 OCR 是常态。
              patchBook({ ocrProvider: next });
            }}
          >
            {usableProviders.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        )}

        {/*
          识别中/排队中时同一个按钮变成「停止识别」/「取消排队」，并把动作从「开始」
          换成「取消」。以前这里是「识别中 12/171」的**禁用**按钮 + 旁边一个孤零零的
          「取消」——两个按钮表达一件事，还要求用户先看懂哪个是哪个。
        */}
        <button
          type="button"
          className={`btn btn-sm${ocrControls.isCancel ? ' btn-danger' : ''}`}
          disabled={ocrControls.disabled}
          title={ocrControls.title}
          data-testid="comic-ocr-action"
          data-ocr-action={ocrControls.isCancel ? 'cancel' : 'start'}
          onClick={() => {
            if (ocrControls.isCancel) onCancelOcr?.(book.id);
            else onStartOcr?.(book.id, ocrResult?.ok === true, effectiveProvider);
          }}
        >
          {ocrControls.label}
        </button>

        {onOpenSegments && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={onOpenSegments}
            title="看这本书的词表，或生成/重新生成分词"
          >
            分词
          </button>
        )}

        <button
          type="button"
          className={`btn btn-sm${textLayerOn ? ' btn-primary' : ''}`}
          onClick={() => setTextLayerOn((on) => !on)}
          title="显示/隐藏 OCR 文字层（点击查词）"
        >
          文字层
        </button>

        {textLayerOn && noOcrData && <span className="comic-text-hint">本页无 OCR 数据</span>}
      </div>

      {/* 弹窗可以同时开多张：pin 住的不会被后来者顶掉。 */}
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

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
