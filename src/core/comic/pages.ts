/**
 * 漫画页枚举 —— 扩展名白名单、存档成员挑选、自然序排序。
 *
 * 对应 Fushi `manga_ocr_folder_job.dart` 的 `enumerateMangaPages` 与
 * `media_extensions.dart` 的 `kImageExtensionsBase`。
 */
import { normalizeRel } from '../util/paths';
import { byNaturalOrder } from '../util/natural-sort';

/**
 * 图片扩展名基集（小写、含点），顺序即「按序取用」的优先序。
 *
 * **必须只有这一张表。** Fushi BUG-1121：导入侧与整卷 OCR 侧各自手写整表并悄悄
 * 漂移——导入认 `.bmp`，OCR 白名单却没有它，于是 bmp 漫画能入库、OCR 时 bmp 页
 * 被静默跳过，产物 `manga.json` 缺页且没有任何提示。导出的目的就是让
 * `isComicImage` / `collectArchivePages` / 未来的 OCR 任务全部引用同一个常量，
 * 而不是各写一遍。
 */
export const COMIC_IMAGE_EXTENSIONS: readonly string[] = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'];

/**
 * 整卷 OCR 的产物目录名（在被扫描目录内，枚举时必须排除自己，
 * `manga_ocr_folder_job.dart:22`）。不排除的话，第二次 OCR 会把第一次的
 * `manga.json` 和 `_pages/*.json` 当输入重新扫一遍。
 */
export const MOKURO_OUT_DIR = 'manga_ocr_out';

function extnameLower(rel: string): string {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

function basename(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

/** 按扩展名判断是否页图（大小写不敏感）。 */
export function isComicImage(rel: string): boolean {
  const ext = extnameLower(normalizeRel(rel));
  return COMIC_IMAGE_EXTENSIONS.includes(ext);
}

/**
 * 自然序排序（`naturalCompare`：数字段按数值比，`p2.jpg < p10.jpg`）。
 *
 * 页序在阅读器里**就是数组顺序**，没有任何二次排序（analysis 01 §5.2），所以
 * 这里必须复刻 Fushi 的口径：按**整条相对路径**做字典序比较，先归一化正斜杠。
 * 注意这是「路径级」比较而不是「目录优先」——同一卷混了子目录时，页序由整条
 * 路径决定，跟目录层级无关。
 */
export function sortPagePaths(rels: readonly string[]): string[] {
  return rels.map((rel) => normalizeRel(rel)).sort(byNaturalOrder((rel) => rel));
}

/** Fushi 的垃圾成员判据：macOS 资源叉与元数据目录。 */
function isJunkMember(name: string): boolean {
  const segments = name.split('/');
  if (segments.includes('__MACOSX')) return true;
  const base = basename(name);
  return base.startsWith('._') || base === '.DS_Store';
}

/**
 * 从压缩包成员名里挑出页图：丢掉目录项、垃圾成员、OCR 产物目录，只留图片，
 * 再自然序排序。
 *
 * OCR 产物目录按**任意路径段**排除（`manga_ocr_out/...` 或 `a/manga_ocr_out/...`），
 * 因为用户可能把扫描根选在上一层；Fushi 的目录遍历同样在每一层检查该名字
 * （`manga_ocr_folder_job.dart:146-148`）。子目录里的图片**保留**：mokuro.moe 的
 * 卷 CBZ 会把页图放在 `<卷名>/` 下，只有顶层是不对的。
 */
export function collectArchivePages(names: readonly string[]): string[] {
  const pages: string[] = [];
  for (const raw of names) {
    const rel = normalizeRel(raw);
    if (rel === '' || rel.endsWith('/')) continue;
    if (isJunkMember(rel)) continue;
    if (rel.split('/').includes(MOKURO_OUT_DIR)) continue;
    if (!isComicImage(rel)) continue;
    pages.push(rel);
  }
  return sortPagePaths(pages);
}
