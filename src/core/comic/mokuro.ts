/**
 * mokuro 文字层读写 —— 吃 mokuro 的 `.mokuro` JSON，也吃 Fushi 内部的 `manga.json`。
 *
 * 对应 Fushi `packages/fushi_engine/lib/media/manga/mokuro_payload.dart` 的
 * `parseMokuro` / `parseMangaJson` / `mangaPayloadToJson`，输出冻结契约里的
 * `PageText[]`（`src/shared/types.ts`）。
 *
 * 两个必须记住的口径差异：
 *   - 冻结的 `PageText` **没有** width/height/字号以外的页尺寸字段，而序列化格式
 *     需要它们。我们用一个 `MokuroPage = PageText & {width,height}` 在运行时把尺寸
 *     挂在对象上（结构上仍是 `PageText`，赋值给 `PageText[]` 完全合法）。
 *   - `lines_coords` 与 `z_index` **解析时丢弃**：我们的渲染是「一个 block 一个
 *     盒子」，命中测试按几何面积取最小者（analysis 01 §6.3 记录 Fushi 的命中逻辑
 *     同样不看 zIndex），两者都用不上，硬塞进冻结契约只会制造无人消费的字段。
 */
import type { Box, PageText, TextBlock, TextRegion } from '../../shared/types';
import { normalizeRel } from '../util/paths';

/**
 * 顶层不是 JSON 对象、或 JSON 语法错误时抛这个。
 *
 * 与「形状不对」的分工（测试要求）：
 *   - 语法错误 / 顶层不是对象 → **抛** `MokuroParseError`（文件根本不是这个格式）；
 *   - 是对象但 `pages` 缺失或不是数组 → 返回 `[]`（格式对、内容空/坏，尽量活下来）。
 * 这样批量扫描时「一个坏文件」能被单独识别，而「卷是空的」不会炸掉整批导入。
 */
export class MokuroParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MokuroParseError';
  }
}

/** `PageText` + 页尺寸。尺寸是序列化 `manga.json` 必需的，冻结契约里没有它。 */
export interface MokuroPage extends PageText {
  width: number;
  height: number;
}

/** 可选的 OCR 生产者元数据（内部 `manga.json` 的 `ocr` 字段）。 */
export interface MokuroOcrMetadata {
  engine: string;
  engineSignature: string;
  schemaVersion: number;
}

const ZERO_BOX: Box = [0, 0, 0, 0];

/** `.mokuro` 与内部 `manga.json` 的键名差异；两个解析器互相容错对方的键名。 */
const URL_KEYS: Record<'mokuro' | 'internal', readonly string[]> = {
  mokuro: ['img_path', 'url'],
  internal: ['url', 'img_path'],
};
const WIDTH_KEYS: Record<'mokuro' | 'internal', readonly string[]> = {
  mokuro: ['img_width', 'width'],
  internal: ['width', 'img_width'],
};
const HEIGHT_KEYS: Record<'mokuro' | 'internal', readonly string[]> = {
  mokuro: ['img_height', 'height'],
  internal: ['height', 'img_height'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** 数字字段容错：number 直接用，数字字符串按 Fushi `_asDouble` 的口径解析。 */
function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (value.trim() !== '' && Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }
  return fallback;
}

/**
 * 统一 4 位小数。**解析阶段就舍入**是为了 round-trip 逐字节稳定：序列化本来就写
 * 4 位小数，如果解析保留全精度，`parse(serialize(parse(x)))` 会在小数第 5 位开始
 * 分叉（`1/3` 这类除不尽的派生字号几乎必然出现）。`-0` 归一成 `0`，否则
 * `deepStrictEqual` 会把 `-0` 与 `0` 判成不同。
 */
function round4(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value * 10000) / 10000;
  return rounded === 0 ? 0 : rounded;
}

function pick(raw: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = raw[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * `box` 归一化：左上角恒为 (min, min)。producer 里 `[x1,y1,x2,y2]` 偶尔写反
 * （尤其是从右到左的竖排块），不归一化会让渲染出的盒子宽度为负。
 */
function toBox(value: unknown): Box | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const x1 = asNumber(value[0], 0);
  const y1 = asNumber(value[1], 0);
  const x2 = asNumber(value[2], 0);
  const y2 = asNumber(value[3], 0);
  return [round4(Math.min(x1, x2)), round4(Math.min(y1, y2)), round4(Math.max(x1, x2)), round4(Math.max(y1, y2))];
}

function parseLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((line) => (typeof line === 'string' ? line : asString(line)));
}

/** 字符级命中框；`utf16_start/end` 与 camelCase `utf16Start/End` 都接受。 */
function parseRegions(value: unknown): TextRegion[] {
  const regions: TextRegion[] = [];
  if (!Array.isArray(value)) return regions;
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const box = toBox(entry['box']);
    if (box === null) continue;
    const start = pick(entry, ['utf16_start', 'utf16Start']);
    const end = pick(entry, ['utf16_end', 'utf16End']);
    const startValue = Math.trunc(asNumber(start, Number.NaN));
    const endValue = Math.trunc(asNumber(end, Number.NaN));
    // 与 Fushi `_parseRegions` 同判据：偏移必须是非负且非空区间，否则跳过。
    if (!Number.isFinite(startValue) || !Number.isFinite(endValue)) continue;
    if (startValue < 0 || endValue <= startValue) continue;
    regions.push({ box, utf16Start: startValue, utf16End: endValue });
  }
  return regions;
}

/**
 * 一个 block。缺 `box` 时用零矩形而不是丢掉整块——Fushi 用 `MokuroRect.zero`
 * 保留，块里的 `lines` 对「这一页有多少文字」仍有意义，丢掉会改变块的序号。
 */
function parseBlock(raw: Record<string, unknown>): TextBlock {
  const box = toBox(raw['box']) ?? ZERO_BOX;
  const lines = parseLines(raw['lines']);
  const vertical = asBoolean(raw['vertical'], true); // 缺省 true：日漫默认竖排
  let fontSize = asNumber(raw['font_size'], Number.NaN);
  if (!Number.isFinite(fontSize) || fontSize <= 0) {
    // Fushi 渲染时用的是 producer 给的值；这里只是**兜底**：缺失或 0 时按
    // 「块高 / 行数」估一个，保证文字不会塌成 0 号字而丢掉命中面积
    // （analysis 01 §6.1 的 ERRATA H5/M1 就是 0 字号导致的点不中）。
    fontSize = Math.abs(box[3] - box[1]) / Math.max(1, lines.length);
  }
  const block: TextBlock = {
    box,
    vertical,
    fontSize: round4(fontSize),
    lines,
  };
  // `single_line` 是本项目 OCR 引擎写下的「这个框只有一段文字」的承诺（见
  // `TextBlock.singleLine`）。**只认字面 true**：老文件、第三方 mokuro 都没有这个键，
  // 那种情况必须继续走面积推断，不能被一个真值缺省悄悄改掉语义。
  if (asBoolean(pick(raw, ['single_line', 'singleLine']), false)) block.singleLine = true;
  const regions = parseRegions(raw['regions']);
  if (regions.length > 0) block.regions = regions; // 非空才挂键，保证 deepEqual 稳定
  return block;
}

function parseDocument(json: string, primary: 'mokuro' | 'internal'): MokuroPage[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new MokuroParseError(`不是合法 JSON：${reason}`);
  }
  if (!isRecord(decoded)) throw new MokuroParseError('顶层必须是 JSON 对象');
  const rawPages = decoded['pages'];
  if (!Array.isArray(rawPages)) return [];

  const pages: MokuroPage[] = [];
  for (const rawPage of rawPages) {
    if (!isRecord(rawPage)) continue;
    const blocks: TextBlock[] = [];
    const rawBlocks = rawPage['blocks'];
    if (Array.isArray(rawBlocks)) {
      for (const rawBlock of rawBlocks) {
        if (isRecord(rawBlock)) blocks.push(parseBlock(rawBlock));
      }
    }
    pages.push({
      url: normalizeRel(asString(pick(rawPage, URL_KEYS[primary]))),
      width: round4(asNumber(pick(rawPage, WIDTH_KEYS[primary]), 0)),
      height: round4(asNumber(pick(rawPage, HEIGHT_KEYS[primary]), 0)),
      blocks,
    });
  }
  return pages;
}

/** `.mokuro`（`img_path` / `img_width` / `img_height`）→ 页文字层。 */
export function parseMokuro(json: string): MokuroPage[] {
  return parseDocument(json, 'mokuro');
}

/** 内部 `manga.json`（`url` / `width` / `height`）→ 页文字层。 */
export function parseMangaJson(json: string): MokuroPage[] {
  return parseDocument(json, 'internal');
}

function serializeBlock(block: TextBlock): Record<string, unknown> {
  const out: Record<string, unknown> = {
    box: block.box.map((value) => round4(asNumber(value, 0))),
    vertical: block.vertical !== false,
    font_size: round4(asNumber(block.fontSize, 0)),
    lines: block.lines.map((line) => (typeof line === 'string' ? line : asString(line))),
  };
  // `z_index` 不写：冻结的 TextBlock 没有这个字段，写了也无从读回；`lines_coords`
  // 同理被丢弃（见文件头注释）。
  if (block.singleLine === true) out['single_line'] = true;
  if (block.regions !== undefined && block.regions.length > 0) {
    out['regions'] = block.regions.map((region) => ({
      box: region.box.map((value) => round4(asNumber(value, 0))),
      utf16_start: Math.trunc(asNumber(region.utf16Start, 0)),
      utf16_end: Math.trunc(asNumber(region.utf16End, 0)),
    }));
  }
  return out;
}

/**
 * 序列化成内部 `manga.json`（`{pages:[{url,width,height,blocks:[…]}]}`，数字保留
 * 4 位小数）。`ocr` 用 Fushi 的 snake_case 键名（`engine_signature` /
 * `schema_version`），因为落盘后要被 Fushi 侧的 `parseMangaJson` 读回去；入参是
 * 契约里的 camelCase。
 */
export function serializeMangaJson(pages: PageText[], ocr?: MokuroOcrMetadata): string {
  const out: Record<string, unknown> = {};
  if (ocr !== undefined) {
    out['ocr'] = {
      engine: ocr.engine,
      engine_signature: ocr.engineSignature,
      schema_version: ocr.schemaVersion,
    };
  }
  out['pages'] = pages.map((page) => {
    const sized: Partial<MokuroPage> = page;
    return {
      url: normalizeRel(page.url),
      width: round4(asNumber(sized.width, 0)),
      height: round4(asNumber(sized.height, 0)),
      blocks: page.blocks.map(serializeBlock),
    };
  });
  return JSON.stringify(out);
}

/**
 * 只读 `.mokuro` 顶层的 `title` / `volume`（导入前的元数据探查）。
 *
 * 与 `parseMokuro` 不同，这里**绝不抛**：批量扫描里一个坏文件不能中断整批，
 * 探查不到就是 `{title:null, volume:null}`。
 */
export function parseMokuroTopLevel(json: string): { title: string | null; volume: string | null } {
  try {
    const decoded: unknown = JSON.parse(json);
    if (!isRecord(decoded)) return { title: null, volume: null };
    return { title: optionalString(decoded['title']), volume: optionalString(decoded['volume']) };
  } catch {
    return { title: null, volume: null };
  }
}

function optionalString(value: unknown): string | null {
  const text = asString(value).trim();
  return text === '' ? null : text;
}

/** 造一个「这页没有 OCR 数据」的页（lines 为空即无文字层）。 */
export function emptyPageText(url: string, width: number, height: number): MokuroPage {
  return {
    url: normalizeRel(url),
    width: round4(asNumber(width, 0)),
    height: round4(asNumber(height, 0)),
    blocks: [],
  };
}

/** 按页 url（归一化后精确匹配）找页文字层。 */
export function pageTextFor(pages: PageText[], url: string): PageText | null {
  const wanted = normalizeRel(url);
  return pages.find((page) => normalizeRel(page.url) === wanted) ?? null;
}
