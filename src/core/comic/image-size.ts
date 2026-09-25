/**
 * 图片尺寸探测（只读文件头，不解码像素）。
 *
 * 为什么需要：`BookRecord.pages[].width/height` 是**文字层坐标的基准**。漫画的文字层
 * 坐标一律是「原图像素」，渲染时按 `显示宽 / page.width` 缩放（见 ComicTextLayer 的
 * 几何规则）。尺寸读错 → 整页文字层错位，而且是那种「看起来有框、但永远框在隔壁」
 * 的错，非常难查。
 *
 * Fushi 为此专门写了 `image_size_probe.dart`，并在 `MangaImporter._pageSize` 里
 * 「先探文件头，认不出才整张解码」。这里做同样的事：
 * - 探得出来 → 零解码，快；
 * - 探不出来 → 返回 null，调用方退回整图解码（渲染进程有 Chromium 可以帮忙，或者
 *   主进程用 `naturalWidth` 在 `<img>` 里量）。
 *
 * **EXIF 方向必须处理**：手机拍的页面带 Orientation 5–8 时，编码像素矩阵是横的，
 * 而 Chromium 显示时按 EXIF 转成竖的。坐标是照「显示出来的样子」量的，所以探测结果
 * 也要跟着转，否则 portrait 页的文字层会整体偏转 90°（Fushi v2 引擎签名里那句
 * "bakes EXIF orientation before detection" 就是这个教训）。
 */

export interface ImageSize {
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (bytes.length < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (bytes[offset + i] !== expected[i]) return false;
  }
  return true;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)) >>> 0
  );
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset + 1] ?? 0) << 8) | (bytes[offset] ?? 0);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset + 3] ?? 0) << 24) | ((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 1] ?? 0) << 8) | (bytes[offset] ?? 0)) >>> 0
  );
}

/** EXIF Orientation 为 5–8 时宽高互换。 */
function orientationSwapsAxes(orientation: number): boolean {
  return orientation >= 5 && orientation <= 8;
}

export function probeOrientedImageSize(bytes: Uint8Array): ImageSize | null {
  if (startsWith(bytes, 0, PNG_SIGNATURE)) {
    // IHDR 一定是第一个 chunk：8 字节签名 + 4 长度 + 4 类型 = 偏移 16。
    if (bytes.length < 24) return null;
    return { width: readUint32BE(bytes, 16), height: readUint32BE(bytes, 20) };
  }
  if (startsWith(bytes, 0, [0xff, 0xd8])) return probeJpeg(bytes);
  if (startsWith(bytes, 0, [0x47, 0x49, 0x46])) return probeGif(bytes);
  if (startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, 8, [0x57, 0x45, 0x42, 0x50])) {
    return probeWebp(bytes);
  }
  if (startsWith(bytes, 0, [0x42, 0x4d])) return probeBmp(bytes);
  return null;
}

function probeGif(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 10) return null;
  return { width: readUint16LE(bytes, 6), height: readUint16LE(bytes, 8) };
}

function probeBmp(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 26) return null;
  const width = readUint32LE(bytes, 18);
  // 高度为负表示 top-down 位图；绝对值才是像素高。
  const rawHeight = readUint32LE(bytes, 22);
  const height = rawHeight > 0x7fffffff ? 0x100000000 - rawHeight : rawHeight;
  return { width, height };
}

function probeWebp(bytes: Uint8Array): ImageSize | null {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const fourCC = String.fromCharCode(
      bytes[offset] ?? 0,
      bytes[offset + 1] ?? 0,
      bytes[offset + 2] ?? 0,
      bytes[offset + 3] ?? 0,
    );
    const size = readUint32LE(bytes, offset + 4);
    const body = offset + 8;
    if (fourCC === 'VP8X') {
      if (body + 10 > bytes.length) return null;
      const width = 1 + ((bytes[body + 4] ?? 0) | ((bytes[body + 5] ?? 0) << 8) | ((bytes[body + 6] ?? 0) << 16));
      const height = 1 + ((bytes[body + 7] ?? 0) | ((bytes[body + 8] ?? 0) << 8) | ((bytes[body + 9] ?? 0) << 16));
      return { width, height };
    }
    if (fourCC === 'VP8 ') {
      if (body + 10 > bytes.length) return null;
      // 3 字节起始码 + 2 字节 sync + 2 字节宽 + 2 字节高（14 位有效）。
      const width = readUint16LE(bytes, body + 6) & 0x3fff;
      const height = readUint16LE(bytes, body + 8) & 0x3fff;
      return { width, height };
    }
    if (fourCC === 'VP8L') {
      if (body + 5 > bytes.length) return null;
      const bits = readUint32LE(bytes, body + 1);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return { width, height };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

function probeJpeg(bytes: Uint8Array): ImageSize | null {
  let orientation = 1;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    // 填充字节 0xFF 允许重复。
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = readUint16BE(bytes, offset + 2);
    if (length < 2) return null;
    const body = offset + 4;

    // SOF0..SOF15 里带尺寸（排除 DHT=0xC4 / JPG=0xC8 / DAC=0xCC）。
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (body + 5 > bytes.length) return null;
      const height = readUint16BE(bytes, body + 1);
      const width = readUint16BE(bytes, body + 3);
      return orientationSwapsAxes(orientation) ? { width: height, height: width } : { width, height };
    }
    if (marker === 0xe1) {
      orientation = readExifOrientation(bytes, body, Math.min(body + length - 2, bytes.length)) ?? orientation;
    }
    offset = body + length - 2;
  }
  return null;
}

/** 从 APP1/Exif 段里读 Orientation（tag 0x0112）。读不到返回 null。 */
function readExifOrientation(bytes: Uint8Array, start: number, end: number): number | null {
  if (!startsWith(bytes, start, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00])) return null; // "Exif\0\0"
  const tiff = start + 6;
  if (tiff + 8 > end) return null;
  const byteOrder = String.fromCharCode(bytes[tiff] ?? 0, bytes[tiff + 1] ?? 0);
  const little = byteOrder === 'II';
  if (!little && byteOrder !== 'MM') return null;
  const read16 = (o: number): number => (little ? readUint16LE(bytes, o) : readUint16BE(bytes, o));
  const read32 = (o: number): number => (little ? readUint32LE(bytes, o) : readUint32BE(bytes, o));
  if (read16(tiff + 2) !== 0x002a) return null;
  const ifdOffset = read32(tiff + 4);
  const ifd = tiff + ifdOffset;
  if (ifd + 2 > end) return null;
  const count = read16(ifd);
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return null;
    if (read16(entry) === 0x0112) {
      const value = read16(entry + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}
