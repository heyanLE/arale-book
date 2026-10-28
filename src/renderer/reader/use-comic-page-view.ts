import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SetStateAction } from 'react';
import {
  clampComicPageView, DEFAULT_PAGE_VIEW, parseComicPageViews,
  type ComicPageView, type ComicPageViews, type ComicViewGeometry,
} from '@core/comic/page-view';

/** 每本书独立保存；只写用户调整过的页，不把临时窗口尺寸产生的夹紧结果写回。 */
export function useComicPageView(bookId: string, pageKey: string, geometry: ComicViewGeometry) {
  const storageKey = `aralebook.comic-page-views.v1:${bookId}`;
  const [views, setViews] = useState<ComicPageViews>(() => {
    try { return parseComicPageViews(window.localStorage.getItem(storageKey)); }
    catch { return {}; }
  });
  // React state may include temporary pan beyond the image edge. Persist only
  // the position within the normal bounds, separately from the working view.
  const persisted = useRef(views);
  const dirty = useRef(false);
  const flush = useCallback(() => {
    if (!dirty.current) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(persisted.current));
      dirty.current = false;
    } catch { /* 存储不可用时仍保留当前阅读会话的记忆。 */ }
  }, [storageKey]);
  useEffect(() => {
    const timer = window.setTimeout(flush, 250);
    return () => window.clearTimeout(timer);
  }, [views, flush]);
  useEffect(() => {
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); flush(); };
  }, [flush]);

  const { width, height, baseScale, viewportWidth, viewportHeight } = geometry;
  const marginX = geometry.panMargin?.x ?? 0;
  const marginY = geometry.panMargin?.y ?? 0;
  useLayoutEffect(() => {
    // Leaving a page or changing immersion/viewport discards its temporary margin.
    setViews(persisted.current);
  }, [pageKey, marginX, marginY]);
  const update = useCallback((change: (current: ComicPageView) => ComicPageView) => {
    setViews(current => {
      const bounds = { width, height, baseScale, viewportWidth, viewportHeight, panMargin: { x: marginX, y: marginY } };
      const next = clampComicPageView(change(clampComicPageView(current[pageKey] ?? DEFAULT_PAGE_VIEW, bounds)), bounds);
      const copy = { ...current };
      if (next.zoom === 1 && next.pan.x === 0 && next.pan.y === 0) delete copy[pageKey];
      else copy[pageKey] = next;
      const saved = clampComicPageView(next, { ...bounds, panMargin: undefined });
      const durable = { ...persisted.current };
      if (saved.zoom === 1 && saved.pan.x === 0 && saved.pan.y === 0) delete durable[pageKey];
      else durable[pageKey] = saved;
      persisted.current = durable;
      dirty.current = true;
      return copy;
    });
  }, [pageKey, width, height, baseScale, viewportWidth, viewportHeight, marginX, marginY]);
  const setZoom = useCallback((action: SetStateAction<number>) => update(current => ({ ...current,
    zoom: typeof action === 'function' ? action(current.zoom) : action,
  })), [update]);
  const setPan = useCallback((action: SetStateAction<ComicPageView['pan']>) => update(current => ({ ...current,
    pan: typeof action === 'function' ? action(current.pan) : action,
  })), [update]);
  const resetView = useCallback(() => update(() => DEFAULT_PAGE_VIEW), [update]);

  return { ...clampComicPageView(views[pageKey] ?? DEFAULT_PAGE_VIEW, geometry), setZoom, setPan, resetView };
}
