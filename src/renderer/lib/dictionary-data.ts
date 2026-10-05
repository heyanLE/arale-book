// Build-time embedding of the exact same small rules used by the Node adapter.
import transforms from '../../../data/ja-transforms.json?raw';
import variants from '../../../data/kanji-variants.json?raw';
export function loadTransforms(): unknown { return JSON.parse(transforms); }
export function loadVariants(): unknown { return JSON.parse(variants); }
