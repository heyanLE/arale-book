/**
 * 路径规整 —— 与 Fushi `manga_payload.dart:153-156` 的 `normalizeMangaUrl` 同口径。
 *
 * 规则：反斜杠 → 正斜杠；去掉前导斜杠；**保留子目录结构**（绝不压成 basename，
 * 因为 mokuro 卷里 `vol1/p001.jpg` 与 `vol2/p001.jpg` 同名不同页）。
 */

import * as path from 'node:path';

/** 把任意外来路径串归一成「相对、正斜杠、无前导斜杠」的形式。 */
export function normalizeRel(raw: string): string {
  const forward = raw.replace(/\\/g, '/');
  return forward.startsWith('/') ? forward.slice(1) : forward;
}

/**
 * 去掉 `rel` 里的路径穿越段（`.`、`..`）与前导 `/`，得到安全的相对路径段。
 *
 * Fushi 的 `MangaStorage.sanitizeRelSegments` 在遇到 `..` 时**抛错**（防穿越红线），
 * 这里返回 `null` 让调用方决定是抛还是跳过——导入器抛，扫描器跳过。
 * 同时剥掉盘符与 URI scheme（`C:` / `file:`），它们是压缩包成员名的常见污染。
 */
export function sanitizeRelSegments(raw: string): string[] | null {
  let value = normalizeRel(raw.trim());
  // 去掉 `file://` 之类的前缀。
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(value);
  if (scheme) value = value.slice(scheme[0].length);
  const segments: string[] = [];
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    // Windows 保留字符与盘符段一并剥掉，避免落盘后另一平台打不开。
    segments.push(segment.replace(/[<>:"|?*\u0000-\u001f]/g, '_'));
  }
  return segments;
}

/** 把安全段拼回正斜杠相对路径。 */
export function joinRel(segments: readonly string[]): string {
  return segments.join('/');
}

/** 目录内唯一化：重名时加 ` (2)`、` (3)`…，同 Fushi 的 `uniqueDestRel`。 */
export function uniqueRel(rel: string, used: Set<string>): string {
  if (!used.has(rel)) {
    used.add(rel);
    return rel;
  }
  const dir = path.posix.dirname(rel);
  const ext = path.posix.extname(rel);
  const base = path.posix.basename(rel, ext);
  const prefix = dir === '.' ? '' : `${dir}/`;
  for (let n = 2; ; n += 1) {
    const candidate = `${prefix}${base} (${n})${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

/**
 * 把 `rel` 解析为 `root` 下的绝对路径，并断言结果仍在 `root` 内。
 * 压缩包里带 `..` 的成员名靠这道关挡住（zip-slip）。
 */
export function resolveInside(root: string, rel: string): string | null {
  const segments = sanitizeRelSegments(rel);
  if (segments === null) return null;
  const resolved = path.resolve(root, ...segments);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return null;
  return resolved;
}

/** 文件名净化：作为目录名 / 主键时必须跨平台安全。移植 Fushi `sanitizeTtuFilename`。 */
export function sanitizeFileName(input: string, fallback = 'untitled'): string {
  const cleaned = input
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .replace(/[. ]+$/, '');
  const bounded = cleaned.slice(0, 120);
  return bounded.length > 0 ? bounded : fallback;
}
