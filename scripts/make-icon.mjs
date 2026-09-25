/**
 * 应用图标：把素材包 `assets/arale-icons-v2/` 同步到「打包产物」和「界面品牌标记」。
 *
 * ## 为什么是「同步」而不是「画」
 *
 * 图标现在是**素材**（用户绘制 / AI 生成，带自己的 README、提示词与 `export.mjs`），
 * 应用这边只该负责把它放到该放的地方。这个脚本以前用 canvas 画一个「あ」字圆角块——
 * 素材包出现之后那种「代码里的图标」就是个陷阱：谁跑一次 `npm run icon`（`npm run pack`
 * 会跑）就会把手绘图标悄悄换回那个字，而且没有任何报错。
 *
 * 所以现在的职责固定成三步，顺序不可颠倒：
 *
 *   1. （可选，`--export`）macOS 上用 `sips` / `iconutil` 从两张母图重新导出各尺寸 + icns + ico；
 *   2. 把导出件拷进 `build/`（electron-builder 认的就是这里）；
 *   3. 把头像版 64px 拷成渲染进程的品牌标记 `src/renderer/assets/brand-mark.png`。
 *
 * 每一步都**校验魔数与像素尺寸**：宁可在这里炸，也不要让 electron-builder 拿一个
 * 坏图去打包——那种失败发生在打包流程最末尾，报错信息也指不到图标上。
 *
 * 用法：
 *   node scripts/make-icon.mjs            # 纯同步（素材包里已有导出件，macOS/任何平台都能跑）
 *   node scripts/make-icon.mjs --export   # 先从母图重新导出（仅 macOS，需要系统自带 sips/iconutil）
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACK = join(ROOT, 'assets', 'arale-icons-v2');

/**
 * 一张图去哪儿。`kind` 只用于报错文案与魔数校验；`size` 是**期望的像素边长**
 * （PNG 从 IHDR 读，不信任文件名——素材包里文件名与内容不符过一次）。
 */
const COPIES = [
  { from: 'aralebook.icns', to: 'build/icon.icns', kind: 'icns', why: 'macOS 打包图标' },
  { from: 'app/1024.png', to: 'build/icon.png', kind: 'png', size: 1024, why: 'Windows/Linux 打包图标' },
  { from: 'aralebook.ico', to: 'build/icon.ico', kind: 'ico', why: 'Windows 打包图标（多尺寸内嵌）' },
  {
    from: 'avatar/64.png',
    to: 'src/renderer/assets/brand-mark.png',
    kind: 'png',
    size: 64,
    why: '工具栏品牌标记（22 CSS px 显示，64px 供 3x 屏）',
  },
];

const MAGIC = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  icns: Buffer.from('icns', 'ascii'),
  ico: Buffer.from([0x00, 0x00, 0x01, 0x00]),
};

/** PNG 的真实像素尺寸（IHDR 就在开头，不需要解压）。 */
function pngSize(file) {
  const buffer = readFileSync(file);
  if (buffer.length < 24) throw new Error(`${file} 太短，不可能是 PNG`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function human(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`;
}

if (!existsSync(PACK)) {
  throw new Error(
    `找不到图标素材包：${relative(ROOT, PACK)}\n` +
      '图标是素材，不是代码生成的：请把这个目录放回去（或改这里的 PACK 常量）。',
  );
}

// 1) 可选：从母图重新导出。只有 macOS 有 sips/iconutil，别的平台直接用已导出件。
if (process.argv.includes('--export')) {
  if (process.platform !== 'darwin') {
    throw new Error('--export 需要 macOS 的 sips / iconutil；其它平台请直接同步素材包里已导出的文件');
  }
  const exported = spawnSync('node', [join(PACK, 'export.mjs')], { cwd: ROOT, encoding: 'utf8' });
  if (exported.status !== 0) {
    throw new Error(`素材包 export.mjs 失败（${exported.status}）：${exported.stderr || exported.stdout}`);
  }
  process.stdout.write(exported.stdout);
}

// 2) 同步 + 校验
const lines = [];
for (const item of COPIES) {
  const source = join(PACK, ...item.from.split('/'));
  const target = join(ROOT, ...item.to.split('/'));
  if (!existsSync(source)) throw new Error(`素材包缺文件：${item.from}`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);

  const head = readFileSync(target).subarray(0, 8);
  if (!head.subarray(0, MAGIC[item.kind].length).equals(MAGIC[item.kind])) {
    throw new Error(`${item.from} 自称 ${item.kind}，但魔数不是（源文件类型不对？）`);
  }
  let sized = '';
  if (item.kind === 'png') {
    const { width, height } = pngSize(target);
    if (width !== item.size || height !== item.size) {
      throw new Error(`${item.from} 期望 ${item.size}×${item.size}，实际 ${width}×${height}`);
    }
    sized = `${width}×${height}`;
  } else {
    sized = item.kind;
  }
  lines.push(
    `  ${item.to.padEnd(38)} ← ${item.from.padEnd(18)} ${sized.padEnd(9)} ${human(statSync(target).size).padStart(9)}   ${item.why}`,
  );
}

process.stdout.write(`图标已同步（素材包 ${relative(ROOT, PACK)}）：\n${lines.join('\n')}\n`);
process.stdout.write(
  '提示：素材包里的母图/提示词才是真相源；这里是导出件，改图标请改素材包后重跑本脚本。\n',
);
