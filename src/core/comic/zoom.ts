/** Normalize wheel units before applying continuous zoom. Small trackpad events
 * must not each trigger the 20% step used by toolbar/keyboard controls. */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 800 : 1);
  // Limit isolated spikes while keeping normal high-resolution gestures additive.
  const bounded = Math.max(-120, Math.min(120, pixels));
  return Math.exp(-bounded * 0.0015);
}
