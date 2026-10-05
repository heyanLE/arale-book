/** Node adapter. Vite replaces this module with the same bundled JSON in a worker. */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 找到随包分发的 `data/ja-transforms.json`。
 *
 * 编译产物可能在 `<root>/dist/core/dict/`（主进程）或 `<root>/dist-test/src/core/dict/`
 * （测试），两者到仓库根的层数不同，所以逐级向上找，而不是写死 `../../`。
 * 打包/换布局时可用 `ARALE_JA_TRANSFORMS` 指定绝对路径覆盖。
 */
function resolveTransformsPath(): string {
  const override = process.env.ARALE_JA_TRANSFORMS;
  if (override && fs.existsSync(override)) return override;
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, 'data', 'ja-transforms.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const fromCwd = path.join(process.cwd(), 'data', 'ja-transforms.json');
  if (fs.existsSync(fromCwd)) return fromCwd;
  throw new Error('找不到 data/ja-transforms.json；可用 ARALE_JA_TRANSFORMS 指定绝对路径');
}

export function loadTransforms(): unknown {
  return JSON.parse(fs.readFileSync(resolveTransformsPath(), 'utf8')) as unknown;
}
/**
 * 找到随包分发的 `data/kanji-variants.json`。
 *
 * 与 `deinflect.ts` 的 `resolveTransformsPath` 同一套逐级向上查找：编译产物可能在
 * `dist/core/dict/` 或 `dist-test/src/core/dict/`，到仓库根的层数不同。
 * 找不到**不抛**——异体字折叠是锦上添花，缺了它只是少一层兜底，不该让整个查词挂掉。
 */
function resolveVariantsPath(): string | null {
  const override = process.env.ARALE_KANJI_VARIANTS;
  if (override && fs.existsSync(override)) return override;
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, 'data', 'kanji-variants.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const fromCwd = path.join(process.cwd(), 'data', 'kanji-variants.json');
  return fs.existsSync(fromCwd) ? fromCwd : null;
}

export function loadVariants(): unknown {
  const source = resolveVariantsPath();
  return source === null ? {} : JSON.parse(fs.readFileSync(source, 'utf8'));
}
