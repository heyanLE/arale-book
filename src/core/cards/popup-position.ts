export interface PopupRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PopupPosition {
  left: number;
  top: number;
}

export interface PopupPlacementInput {
  anchor: PopupRect;
  popupWidth: number;
  popupHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  cascade?: number;
  gap?: number;
  edge?: number;
}

/**
 * 在锚点四周选择最不遮挡的位置。
 *
 * 先把每个候选夹进视口，再以“遮住锚点的面积”为最高权重评分；所以弹窗很高、
 * 上下都放不下时，会自动换到左右，而不是硬盖在用户刚划出的文字上。
 */
export function placePopup(input: PopupPlacementInput): PopupPosition {
  const {
    anchor,
    popupWidth,
    popupHeight,
    viewportWidth,
    viewportHeight,
    cascade = 0,
    gap = 6,
    edge = 8,
  } = input;
  const shift = (Math.max(0, cascade) % 6) * 18;
  const candidates: PopupPosition[] = [
    { left: anchor.x + shift, top: anchor.y + anchor.height + gap + shift },
    { left: anchor.x + shift, top: anchor.y - popupHeight - gap - shift },
    { left: anchor.x + anchor.width + gap + shift, top: anchor.y + shift },
    { left: anchor.x - popupWidth - gap - shift, top: anchor.y + shift },
    { left: anchor.x + anchor.width - popupWidth - shift, top: anchor.y + anchor.height + gap + shift },
    { left: anchor.x + anchor.width - popupWidth - shift, top: anchor.y - popupHeight - gap - shift },
  ];

  let best: PopupPosition | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  candidates.forEach((raw, priority) => {
    const placed = {
      left: clampToViewport(raw.left, popupWidth, viewportWidth, edge),
      top: clampToViewport(raw.top, popupHeight, viewportHeight, edge),
    };
    const popup = { x: placed.left, y: placed.top, width: popupWidth, height: popupHeight };
    const overlap = overlapArea(popup, anchor);
    const displacement = Math.abs(placed.left - raw.left) + Math.abs(placed.top - raw.top);
    // 一平方像素的文字遮挡都比候选顺序和贴边位移更重要。
    const score = overlap * 1_000_000 + displacement * 100 + priority;
    if (score < bestScore) {
      best = placed;
      bestScore = score;
    }
  });
  return best ?? { left: edge, top: edge };
}

export function overlapArea(a: PopupRect, b: PopupRect): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

function clampToViewport(value: number, size: number, viewport: number, edge: number): number {
  return Math.max(edge, Math.min(value, Math.max(edge, viewport - size - edge)));
}
