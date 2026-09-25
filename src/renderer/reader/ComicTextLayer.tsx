/**
 * 漫画文字层：把 mokuro 的 OCR 方块铺成一层**完全透明**的可点区域，叠在页面图片上方。
 *
 * 几何铁律（docs/analysis/01 §6.1 / §10 第 5 条）：
 * - 一切以**原图像素**为基准。`box` 与 `fontSize` 都是原图像素，渲染时只乘缩放比；
 * - 字号必须是 `block.fontSize * scaleY` 这样的**绝对 px**，绝不能用 `%` / `cqw` ——
 *   百分比字号会让隐形文字塌到框角，命中框随之消失，点击查词整体失效；
 * - 缩放比按 `displayedWidth / page.width` 与 `displayedHeight / page.height` **分开**
 *   算（理论上等比，但一旦页面尺寸元数据与实际比例不符，分开算至少不会让方块错位）。
 *
 * ## 划词为什么是「跨方块」的
 *
 * 文字层一个文字行/列一个方块，所以**一句话换行就落在两个方块里**。拖动因此不能锁在
 * 「按下时那块」上：锚点记在起点，之后每次移动都用指针位置**重新命中**一个方块
 * （见 `core/comic/selection.ts` 的 `pickBlockAt`，落在空隙里按宽容度吸附），
 * 再把锚点到当前点之间的所有方块拼成一段。手指/鼠标只有一根，指针事件又都被
 * `setPointerCapture` 送到起点那个元素上，所以「当前在哪一块」只能自己算——
 * 这也正是原来跨行划不动的原因（`start.block !== block` 直接 return）。
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import type { Box, PageText, TextBlock } from '@shared/types';
import { boundaryAt, charIndexAt, charRangeRects } from '@core/comic/text-geometry';
import {
  SELECT_GAP_TOLERANCE_PX,
  buildSelection,
  pickBlockAt,
  selectionRanges,
  type SelectionPoint,
  type SelectionRange,
} from '@core/comic/selection';
import { capturePointer } from '../lib/pointer';
import type { AnchorRect } from '../dict/WordCardPopup';

export interface ComicTextLookup {
  /** 方块全文（`lines.join('')`）。 */
  context: string;
  /** 点击字符在 context 内的 UTF-16 偏移。 */
  offset: number;
  /** 命中方块在**视口**里的矩形，用于定位弹窗。 */
  anchor: AnchorRect;
}

/**
 * 划词结果。
 *
 * 与 [ComicTextLookup] 的关键区别：这里的 `start`/`end` 是**用户明确框住的**范围，
 * 上层必须按这段原文精确查词，不许再做最长匹配去猜——猜出来的词和用户框的可以不一样，
 * 那是点击才允许的宽容度。
 */
export interface ComicTextSelection {
  /** 方块全文。 */
  context: string;
  /** 选区起点（UTF-16，含）。 */
  start: number;
  /** 选区终点（UTF-16，不含）。 */
  end: number;
  /** 选区原文（`context.slice(start, end)`）。 */
  text: string;
  /** 选区在**视口**里的矩形，用于定位弹窗。 */
  anchor: AnchorRect;
}

export interface ComicTextLayerProps {
  /** null = 该页还没加载完或没有 OCR 数据。 */
  text: PageText | null;
  pageWidth: number;
  pageHeight: number;
  displayedWidth: number;
  displayedHeight: number;
  onLookup: (payload: ComicTextLookup) => void;
  /**
   * 划词回调。没传就当不支持划词（例如只读模式的将来用法）。
   */
  onSelect?: (payload: ComicTextSelection) => void;
  /**
   * 这次拖动是否**让给移动画面**。
   *
   * 只有用户明确表达了「我要移动画面」时才为 true（按住空格，或中键——中键在
   * `button !== 0` 时本来就会被下面直接放行）。默认 false，于是**拖动永远是划词**。
   *
   * 不要把它绑成「画面是否溢出」：那样手势含义会取决于一个看不见的状态，
   * 用户无法建立预期（实测反馈就是「拖不动」）。
   */
  deferDragToPan: boolean;
}

/** 拖动超过这个像素数才算划词，否则当点击。和阅读器的平移阈值同一个量级。 */
const SELECT_THRESHOLD_PX = 3;


/** 页面上一个方块在**视口**里的矩形（client 坐标）。拖选期间复用，不再每帧量 DOM。 */
interface BlockHitRect {
  /** `PageText.blocks` 里的下标——与 DOM 顺序无关，靠 `data-block-index` 认。 */
  index: number;
  rect: Box;
}

export function ComicTextLayer(props: ComicTextLayerProps): JSX.Element | null {
  const {
    text,
    pageWidth,
    pageHeight,
    displayedWidth,
    displayedHeight,
    onLookup,
    onSelect,
    deferDragToPan,
  } = props;
  const layerRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  /**
   * 正在拖选时的**锚点与当前点**（都是「方块下标 + 字符边界」）。
   *
   * 不存「哪个 block 对象」：跨行划词时当前点会落到别的方块上，存对象就写不下这件事。
   * 也不存 ranges：ranges 由这两个点纯函数推出来，渲染时现算（代价可忽略），
   * 免得出现「状态里的区间」和「几何算出来的区间」两套真相。
   */
  const [drag, setDrag] = useState<{ anchor: SelectionPoint; focus: SelectionPoint } | null>(null);
  const startRef = useRef<{
    index: number;
    boundary: number;
    x: number;
    y: number;
    /** 按下瞬间量好的所有方块矩形：拖选期间缩放/布局不会变，量一次就够。 */
    hits: BlockHitRect[];
  } | null>(null);
  /** 最近一次**成功命中**的方块。指针跑到所有方块之外时靠它兜底，避免选区乱跳。 */
  const lastFocusRef = useRef<SelectionPoint | null>(null);
  const movedRef = useRef(false);

  const scaleX = pageWidth > 0 ? displayedWidth / pageWidth : 1;
  const scaleY = pageHeight > 0 ? displayedHeight / pageHeight : 1;

  const boxes = useMemo(
    () => (text === null ? [] : text.blocks.map((block) => boxToStyle(block, scaleX, scaleY))),
    [text, scaleX, scaleY],
  );

  /**
   * 拖选中的每一块各画哪一段。**由锚点/当前点现算**，不存在 state 里：区间只有一套
   * 真相（`selectionRanges`），渲染与松手时的取词走同一个函数，不会出现「高亮画了
   * 三块、取词只取了一块」这种不一致。
   */
  const dragRanges = useMemo(() => {
    if (drag === null || text === null) return new Map<number, SelectionRange>();
    return new Map(
      selectionRanges(text.blocks, drag.anchor, drag.focus).map((range) => [range.index, range]),
    );
  }, [drag, text]);

  /** 指针位置 → 原图像素坐标。 */
  const toImage = useCallback(
    (clientX: number, clientY: number) => {
      const rect = layerRef.current?.getBoundingClientRect();
      return {
        x: scaleX > 0 ? (clientX - (rect?.left ?? 0)) / scaleX : 0,
        y: scaleY > 0 ? (clientY - (rect?.top ?? 0)) / scaleY : 0,
      };
    },
    [scaleX, scaleY],
  );

  /**
   * 量出当前**所有**方块的视口矩形。拖选只在按下时量一次：中途不会有缩放/重排
   * （按住空格或中键的平移走的是另一条路，不会同时拖选）。
   */
  const collectHits = useCallback((): BlockHitRect[] => {
    const layer = layerRef.current;
    if (layer === null) return [];
    const elements = layer.querySelectorAll<HTMLElement>('.comic-text-block[data-block-index]');
    const hits: BlockHitRect[] = [];
    for (const element of elements) {
      const index = Number(element.dataset['blockIndex']);
      if (!Number.isInteger(index)) continue;
      const rect = element.getBoundingClientRect();
      // 退化的框（0 宽/高）不参与命中：它吸不到任何指针，留着只会抢「最近」，
      hits.push({ index, rect: [rect.left, rect.top, rect.right, rect.bottom] });
    }
    return hits;
  }, []);

  /** 指针在视口里的位置 → 方块下标 + 该方块内的字符边界。离所有方块都太远时返回 null。 */
  const resolvePoint = useCallback(
    (hits: readonly BlockHitRect[], clientX: number, clientY: number): SelectionPoint | null => {
      if (text === null) return null;
      const hit = pickBlockAt(
        hits.map((item) => item.rect),
        clientX,
        clientY,
        SELECT_GAP_TOLERANCE_PX,
      );
      if (hit === null) return null;
      const block = text.blocks[hits[hit]!.index];
      if (block === undefined) return null;
      const point = toImage(clientX, clientY);
      return { block: hits[hit]!.index, boundary: boundaryAt(block, point.x, point.y) };
    },
    [text, toImage],
  );

  const handlePointerDown = useCallback(
    (block: TextBlock, index: number) => (event: React.PointerEvent<HTMLDivElement>) => {
      startRef.current = null;
      movedRef.current = false;
      lastFocusRef.current = null;
      // 中键/其它键 → 交给画布去移动画面（不 stopPropagation）。
      if (onSelect === undefined || event.button !== 0) return;
      // 用户按着空格（明确想移动画面）→ 同样让路。
      if (deferDragToPan) return;
      const point = toImage(event.clientX, event.clientY);
      const boundary = boundaryAt(block, point.x, point.y);
      startRef.current = {
        index,
        boundary,
        x: event.clientX,
        y: event.clientY,
        hits: collectHits(),
      };
      // 锚点就是按下的这一块：命中测试不必参与，用户明确点在这儿了。
      lastFocusRef.current = { block: index, boundary };
      // 阻止冒泡到阅读器的平移处理，否则拖选的同时画布也在动。
      event.stopPropagation();
      capturePointer(event.currentTarget, event.pointerId);
    },
    [collectHits, deferDragToPan, onSelect, toImage],
  );

  const handlePointerMove = useCallback(
    (block: TextBlock) => (event: React.PointerEvent<HTMLDivElement>) => {
      const start = startRef.current;
      if (start === null) return;
      const moved =
        Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) >= SELECT_THRESHOLD_PX;
      if (!moved && !movedRef.current) return;
      movedRef.current = true;
      // ★ 当前点用**指针位置重新命中**，不再要求「还在按下时那一块上」——跨行划词就是
      //   从这里来的。指针跑到所有方块外面（超过宽容度）时保留上一次的落点。
      const resolved = resolvePoint(start.hits, event.clientX, event.clientY);
      if (resolved !== null) lastFocusRef.current = resolved;
      const focus = resolved ?? lastFocusRef.current;
      if (focus === null) return;
      setDrag({ anchor: { block: start.index, boundary: start.boundary }, focus });
    },
    [resolvePoint],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const start = startRef.current;
      startRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setDrag(null);
      if (start === null || onSelect === undefined || !movedRef.current || text === null) {
        return;
      }

      const blocks = text.blocks;
      // 松手处的落点：优先现算（指针可能已经移出），其次用移动过程中最后一次命中的。
      const focus = resolvePoint(start.hits, event.clientX, event.clientY) ?? lastFocusRef.current;
      if (focus === null) return;

      const anchor: SelectionPoint = { block: start.index, boundary: start.boundary };
      // ★ 跨行/跨列：锚点到落点之间的**所有**方块拼成一段，方块之间不插换行。
      const selection = buildSelection(blocks, anchor, focus);
      let payload = {
        context: selection.context,
        start: selection.start,
        end: selection.end,
        text: selection.text,
      };

      if (selection.ranges.length === 0 || selection.text.length === 0) {
        // 两端落在同一个字里（没跨过任何边界）→ 至少选中指针下那一个字，
        // 否则会出现「划了一下但什么都没选」。
        const target = blocks[focus.block];
        if (target === undefined) return;
        const context = target.lines.join('');
        if (context.length === 0) return;
        const point = toImage(event.clientX, event.clientY);
        const index = charIndexAt(target, point.x, point.y);
        const from = Math.max(0, Math.min(index, context.length - 1));
        payload = { context, start: from, end: from + 1, text: context.slice(from, from + 1) };
      }

      onSelect({ ...payload, anchor: anchorRectFor(start.hits, selection.ranges, event.currentTarget) });
    },
    [onSelect, resolvePoint, text, toImage],
  );

  /** 普通点击（没拖动）→ 沿用原来的「点哪查哪 + 最长匹配」逻辑。 */
  const handleClick = useCallback(
    (block: TextBlock) => (event: React.MouseEvent<HTMLDivElement>) => {
      if (movedRef.current) {
        movedRef.current = false;
        return;
      }
      const point = toImage(event.clientX, event.clientY);
      const context = block.lines.join('');
      if (context.length === 0) return;
      const boxRect = event.currentTarget.getBoundingClientRect();
      onLookup({
        context,
        offset: charIndexAt(block, point.x, point.y),
        anchor: { x: boxRect.left, y: boxRect.top, width: boxRect.width, height: boxRect.height },
      });
    },
    [onLookup, toImage],
  );

  if (text === null || text.blocks.length === 0) return null;

  return (
    <div ref={layerRef} className="comic-text-layer">
      {text.blocks.map((block, index) => {
        const style = boxes[index];
        if (!style) return null;
        // 每一块各自画自己那一段：跨行划词时同一个 drag 会在多块上同时出现高亮。
        const range = dragRanges.get(index);
        return (
          <div
            key={index}
            // 命中测试靠这个属性认下标（DOM 顺序与 blocks 顺序不一定一致，别靠位置猜）。
            data-block-index={index}
            className={`comic-text-block${hovered === index ? ' is-hovered' : ''}`}
            style={style}
            onMouseEnter={() => setHovered(index)}
            onMouseLeave={() => setHovered((current) => (current === index ? null : current))}
            onPointerDown={handlePointerDown(block, index)}
            onPointerMove={handlePointerMove(block)}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onClick={handleClick(block)}
          >
            {/* 选区高亮：方块本身是空的命中区（没有文字节点），所以选中的范围
                只能由我们按几何画出来，没法靠浏览器原生 ::selection。 */}
            {range !== undefined && (
              <SelectionHighlight
                block={block}
                from={range.from}
                to={range.to}
                scaleX={scaleX}
                scaleY={scaleY}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 弹窗锚点：跨行划词时用**所有被选中方块**的并集矩形。只给起点那一块的话，弹窗会
 * 压在选区的下半部分上。拿不到命中矩形（比如按下时还没量到）就退回当前元素。
 */
function anchorRectFor(
  hits: readonly BlockHitRect[],
  ranges: readonly SelectionRange[],
  element: HTMLElement,
): AnchorRect {
  const selected = new Set(ranges.map((range) => range.index));
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const hit of hits) {
    if (selected.size > 0 && !selected.has(hit.index)) continue;
    left = Math.min(left, hit.rect[0]);
    top = Math.min(top, hit.rect[1]);
    right = Math.max(right, hit.rect[2]);
    bottom = Math.max(bottom, hit.rect[3]);
  }
  if (!Number.isFinite(left) || right <= left || bottom <= top) {
    const rect = element.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * 方块在页面上的绝对定位样式。
 *
 * 字号必须是 `block.fontSize * scaleY` 这样的**绝对 px**，绝不能用 `%` / `cqw` ——
 * 百分比字号会让隐形文字塌到框角，命中框随之消失，点击查词整体失效。
 * 缩放比按 X/Y **分开**算（理论上等比，但页面尺寸元数据与实际比例不符时，
 * 分开算至少不会让方块错位）。
 */
function boxToStyle(block: TextBlock, scaleX: number, scaleY: number): React.CSSProperties {
  const [x1, y1, x2, y2] = block.box;
  return {
    left: `${x1 * scaleX}px`,
    top: `${y1 * scaleY}px`,
    width: `${Math.max(0, x2 - x1) * scaleX}px`,
    height: `${Math.max(0, y2 - y1) * scaleY}px`,
    fontSize: `${Math.max(1, block.fontSize * scaleY)}px`,
    writingMode: block.vertical ? 'vertical-rl' : 'horizontal-tb',
  };
}

/** 划词时的高亮层。按段（横排的行 / 竖排的列）切成若干矩形。 */
function SelectionHighlight({
  block,
  from,
  to,
  scaleX,
  scaleY,
}: {
  block: TextBlock;
  from: number;
  to: number;
  scaleX: number;
  scaleY: number;
}): JSX.Element {
  return (
    <>
      {charRangeRects(block, from, to).map((rect, index) => (
        <span
          key={index}
          className="comic-select-rect"
          style={{
            left: `${rect[0] * scaleX}px`,
            top: `${rect[1] * scaleY}px`,
            width: `${Math.max(1, (rect[2] - rect[0]) * scaleX)}px`,
            height: `${Math.max(1, (rect[3] - rect[1]) * scaleY)}px`,
          }}
        />
      ))}
    </>
  );
}
