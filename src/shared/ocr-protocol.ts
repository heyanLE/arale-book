/**
 * OCR **页面协议**：任何 OCR 运行进程都要说这一种 NDJSON。
 *
 * ## 为什么要有统一协议
 *
 * 引擎有三种来源，将来还会更多：
 * - **系统 OCR**：随应用走的原生小工具（macOS Vision、Windows.Media.Ocr）；
 * - **扩展**：下载安装的包内 Python + ONNX Runtime 引擎；
 * - 以后可能还有用户自己挂的命令行工具。
 *
 * 如果每个引擎各说一套 JSON，主进程就要为每种引擎写一份解析器，加一个引擎就多一处
 * 解析 bug。所以这里定死**一种**流式协议，引擎之间只在「谁来跑」上不同：
 *
 * ```
 * {"kind":"meta", ...}                                  ← 首行，永远有
 * {"kind":"page","file":…,"ok":true,"width":…,"lines":[…]}
 * {"kind":"page","file":…,"ok":false,"error":"…"}
 * {"kind":"fatal","error":"…"}
 * ```
 *
 * ## 为什么是流式（一行一页）而不是跑完一次吐一个大 JSON
 *
 * 一次 171 页的识别要十几分钟。跑完再吐，UI 在整个过程中只能显示「正在识别」，
 * 用户看不出它是不是卡死了；而且要等最后一页跑完才知道第一页的结果。
 * 一行一页之后：进度条是真的、取消能立刻生效（kill 进程）、单页失败不影响整本。
 *
 * ## 坐标口径
 *
 * `box` 是**原图像素**坐标 `[x1, y1, x2, y2]`，**左上原点**（网页/图片的坐标系）。
 * 引擎自己的坐标系五花八门：Vision 给的是归一化 + 左下原点，WinRT 给的是左上原点
 * 但单位随缩放走。转换是**各引擎自己的责任**——协议这一层只认上面这一种，这样
 * `reading-order.ts` 与 `blocks.ts` 就不必知道文字是从哪个系统来的。
 *
 * ⚠️ 改这里的字段名等于改跨进程协议：`arale-native` 的 `probe` 曾经因为漏了一个字段
 * 让「套娃包」整个功能不可用。改之前先看 `tests/ocr-protocol.test.ts`。
 */

import type { Box } from './types';

/** 一行的输出形状。 */
export interface OcrLineOut {
  text: string;
  /** 0..1。引擎不给就填 1（宁可乐观，也不要因为缺置信度把文字丢掉）。 */
  confidence: number;
  /** 原图像素坐标 `[x1, y1, x2, y2]`，左上原点。 */
  box: Box;
  /** 是否竖排。引擎推断不出来时按宽高比猜（见 `core/ocr/types.ts`）。 */
  vertical: boolean;
}

/** 一页的输出形状。 */
export interface OcrPageOut {
  file: string;
  ok: boolean;
  width: number;
  height: number;
  lines: OcrLineOut[];
  /** `ok:false` 时必有。 */
  error?: string;
}

/** 首行元信息：实际生效的识别语言 / 引擎自报的名字。 */
export interface OcrMetaOut {
  engine: string;
  /** 实际生效的识别语言。空数组 = 引擎自己的默认。 */
  languages: string[];
  /** 请求的语言，用于对比出「降级了」。 */
  requested: string[];
}

/**
 * 自检结果。
 *
 * runner 被以 `--probe` 启动时要**不识别任何真实图片**、只报告「这台机器上这套 OCR
 * 到底能不能跑」。存在的理由见 `native/arale-vision-ocr` 里 `selfCheck()` 的注释：
 * 系统 OCR 依赖按需下载的识别资源，缺失时每一页都会失败——那种失败必须提前说。
 */
export interface OcrProbeOut {
  ok: boolean;
  error: string | null;
}

/** 解析一行 NDJSON 的结果。 */
export type OcrStreamEvent =
  | { kind: 'meta'; meta: OcrMetaOut }
  | { kind: 'page'; page: OcrPageOut }
  | { kind: 'probe'; probe: OcrProbeOut }
  | { kind: 'fatal'; error: string }
  /**
   * 认不出来的行：**不抛**，交给调用方决定是记日志还是忽略。
   *
   * `raw` 是**原样**的行（不 trim）：排查「引擎到底写了什么」时，前后空白与 `\r`
   * 本身就是线索。日志里也不需要调用方再去还原。
   */
  | { kind: 'unknown'; raw: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toBox(value: unknown): Box | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const numbers = value.map((item) => (typeof item === 'number' && Number.isFinite(item) ? item : null));
  if (numbers.some((item) => item === null)) return null;
  const [x1, y1, x2, y2] = numbers as [number, number, number, number];
  // 归一化到 x1<=x2、y1<=y2：引擎可能给反（Vision 的行框不会，但第三方工具会）。
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

/**
 * 解析一行。**永不抛**——子进程的输出是不可信输入，一行坏数据不该让整本识别失败。
 *
 * 严格的字段校验是刻意的：宁可把一行判成 `unknown`，也不要把一个缺 `box` 的「行」
 * 塞进文字层——那种行在阅读器里会渲染成 0×0 的隐形块，用户点不到，也查不出原因。
 */
export function parseOcrStreamLine(raw: string): OcrStreamEvent {
  const line = raw.trim();
  if (line === '') return { kind: 'unknown', raw };

  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return { kind: 'unknown', raw };
  }
  if (!isRecord(parsed)) return { kind: 'unknown', raw };

  const kind = parsed['kind'];
  if (kind === 'meta') {
    return {
      kind: 'meta',
      meta: {
        engine: typeof parsed['engine'] === 'string' ? parsed['engine'] : 'unknown',
        languages: stringArray(parsed['languages']),
        requested: stringArray(parsed['requested']),
      },
    };
  }

  if (kind === 'probe') {
    return {
      kind: 'probe',
      probe: {
        ok: parsed['ok'] === true,
        error: typeof parsed['error'] === 'string' ? parsed['error'] : null,
      },
    };
  }

  if (kind === 'fatal') {
    return {
      kind: 'fatal',
      error: typeof parsed['error'] === 'string' ? parsed['error'] : 'OCR 运行进程报了一个没有说明的错误',
    };
  }

  if (kind === 'page') {
    const file = parsed['file'];
    if (typeof file !== 'string') return { kind: 'unknown', raw };
    const ok = parsed['ok'] === true;
    if (!ok) {
      return {
        kind: 'page',
        page: {
          file,
          ok: false,
          width: 0,
          height: 0,
          lines: [],
          error: typeof parsed['error'] === 'string' ? parsed['error'] : '这一页识别失败',
        },
      };
    }

    const width = numberOr(parsed['width'], 0);
    const height = numberOr(parsed['height'], 0);
    const rawLines = Array.isArray(parsed['lines']) ? parsed['lines'] : [];
    const lines: OcrLineOut[] = [];
    for (const item of rawLines) {
      if (!isRecord(item)) continue;
      const box = toBox(item['box']);
      const text = typeof item['text'] === 'string' ? item['text'] : '';
      // 空文本没有意义，丢掉：它会在文字层里变成一个点不到的空块。
      if (box === null || text.trim() === '') continue;
      lines.push({
        text,
        confidence: clamp01(numberOr(item['confidence'], 1)),
        box,
        vertical: item['vertical'] === true,
      });
    }
    return { kind: 'page', page: { file, ok: true, width, height, lines } };
  }

  return { kind: 'unknown', raw };
}

/**
 * 按行切分一个**可能不完整**的 chunk。
 *
 * 子进程的输出会按任意边界分片（一个 pipe read 可能只有半个 JSON），
 * 所以必须保留尾巴等到下一片。踩过一次：直接把 `chunk.split('\n')` 全部当完整行解析，
 * 遇到跨片的半个 JSON 就当成坏行丢掉，表现为「偶尔少几页的文字」——极难复现。
 */
export function splitOcrStreamChunk(chunk: string): { lines: string[]; rest: string } {
  const parts = chunk.split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts, rest };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
