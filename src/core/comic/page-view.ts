import type { ComicPage } from '../../shared/types';

export interface ComicPageView {
  zoom: number;
  pan: { x: number; y: number };
}

export type ComicPageViews = Record<string, ComicPageView>;
export const DEFAULT_PAGE_VIEW: ComicPageView = { zoom: 1, pan: { x: 0, y: 0 } };
export const MIN_COMIC_ZOOM = 0.2;
export const MAX_COMIC_ZOOM = 8;

export interface ComicViewGeometry {
  width: number;
  height: number;
  baseScale: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Session-only space around a zoomed image, used while reading immersively. */
  panMargin?: { x: number; y: number };
}

/** 页资源及尺寸变化后不复用旧位置；不同适配模式、单双页和跨页配对各自记忆。 */
export function comicPageViewKey(fit: string, pages: readonly ComicPage[], rtl: boolean): string {
  return JSON.stringify([fit, pages.length > 1 && rtl, pages.map(page => [page.url, page.width, page.height])]);
}

export function clampComicPageView(view: ComicPageView, geometry: ComicViewGeometry): ComicPageView {
  const zoom = Math.min(MAX_COMIC_ZOOM, Math.max(MIN_COMIC_ZOOM, view.zoom));
  const margin = zoom > 1 ? geometry.panMargin : undefined;
  const maxX = Math.max(0, (geometry.width * geometry.baseScale * zoom - geometry.viewportWidth) / 2) + Math.max(0, margin?.x ?? 0);
  const maxY = Math.max(0, (geometry.height * geometry.baseScale * zoom - geometry.viewportHeight) / 2) + Math.max(0, margin?.y ?? 0);
  return { zoom, pan: {
    x: maxX === 0 ? 0 : Math.min(maxX, Math.max(-maxX, view.pan.x)),
    y: maxY === 0 ? 0 : Math.min(maxY, Math.max(-maxY, view.pan.y)),
  } };
}

/** localStorage 可能被手动编辑或损坏，逐条校验，避免无效值污染页面 transform。 */
export function parseComicPageViews(raw: string | null): ComicPageViews {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, ComicPageView] => {
      const value = entry[1];
      return value && typeof value === 'object' && Number.isFinite(value.zoom)
        && value.zoom >= MIN_COMIC_ZOOM && value.zoom <= MAX_COMIC_ZOOM
        && value.pan && Number.isFinite(value.pan.x) && Number.isFinite(value.pan.y);
    }));
  } catch {
    return {};
  }
}
