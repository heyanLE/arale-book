/**
 * 应用图标与品牌标记的**一致性**测试。
 *
 * 守住的是一个很容易悄悄坏掉的东西：`build/` 里的图标、渲染进程的品牌标记，都是
 * **从素材包 `assets/arale-icons-v2/` 拷出来的导出件**。它们之间一旦漂移，症状是
 * 「打包出来的应用图标还是旧那张」「工具栏那个小图标和 Dock 里的不是同一个人」——
 * 而这两件事都不会让任何测试变红，只会让人觉得图标换了但没生效。
 *
 * 所以这里逐个断言「拷出来的 == 素材包里的」，并且顺手校验魔数与像素尺寸：
 * 素材包的文件名与内容不符过一次（`*.png` 其实是别的格式），光比字节是发现不了的。
 *
 * ⚠️ 这些文件是 `npm run icon` **生成**的，不要手改它们来让测试变绿——去改素材包。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const PACK = path.join(ROOT, 'assets', 'arale-icons-v2');

/** 素材包 → 应用里的落点。与 `scripts/make-icon.mjs` 的 COPIES 必须一致。 */
const COPIES: Array<{ from: string; to: string; kind: 'png' | 'icns' | 'ico'; size?: number }> = [
  { from: 'aralebook.icns', to: 'build/icon.icns', kind: 'icns' },
  { from: 'app/1024.png', to: 'build/icon.png', kind: 'png', size: 1024 },
  { from: 'aralebook.ico', to: 'build/icon.ico', kind: 'ico' },
  { from: 'avatar/64.png', to: 'src/renderer/assets/brand-mark.png', kind: 'png', size: 64 },
];

const MAGIC = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  icns: Buffer.from('icns', 'ascii'),
  ico: Buffer.from([0x00, 0x00, 0x01, 0x00]),
};

function pngSize(buffer: Buffer): { width: number; height: number } {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test('图标素材包还在（图标是素材，不是代码生成的）', () => {
  for (const file of ['README.md', 'export.mjs', 'app-master.png', 'avatar-master.png']) {
    assert.ok(fs.existsSync(path.join(PACK, file)), `素材包缺少 ${file}`);
  }
});

test('build/ 与品牌标记都是素材包的导出件（逐字节相同，且格式/尺寸对得上）', () => {
  for (const item of COPIES) {
    const source = path.join(PACK, ...item.from.split('/'));
    const target = path.join(ROOT, ...item.to.split('/'));
    assert.ok(fs.existsSync(source), `素材包缺 ${item.from}`);
    assert.ok(fs.existsSync(target), `${item.to} 不存在——跑一次 \`npm run icon\``);

    const sourceBuffer = fs.readFileSync(source);
    const targetBuffer = fs.readFileSync(target);
    assert.ok(
      sourceBuffer.equals(targetBuffer),
      `${item.to} 与素材包 ${item.from} 不一致（漂移了？跑 \`npm run icon\`，别手改这个文件）`,
    );

    const magic = MAGIC[item.kind];
    assert.ok(
      targetBuffer.subarray(0, magic.length).equals(magic),
      `${item.to} 自称 ${item.kind}，魔数却不是——文件名与内容不符`,
    );
    if (item.size !== undefined) {
      const { width, height } = pngSize(targetBuffer);
      assert.equal(width, item.size, `${item.to} 宽度`);
      assert.equal(height, item.size, `${item.to} 高度`);
      assert.ok(width > 0 && height > 0);
    }
  }
});

test('工具栏用的是素材头像，而不是「あ」字占位块', () => {
  const toolbar = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'components', 'Toolbar.tsx'), 'utf8');
  assert.match(toolbar, /import brandMark from '\.\.\/assets\/brand-mark\.png'/, '要 import 同步出来的品牌图');
  assert.match(toolbar, /<img[^>]*className="brand-mark"/, '品牌标记必须是 img（以前的「あ」是 span）');
});

test('打包配置指向的是这三张（mac icns / win ico / linux png）', () => {
  const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  assert.match(yml, /mac:\n(?:.|\n)*?icon: build\/icon\.icns/, 'mac.icon');
  assert.match(yml, /win:\n(?:.|\n)*?icon: build\/icon\.ico/, 'win.icon（多尺寸 ico，比现场转 png 清楚）');
  assert.match(yml, /linux:\n(?:.|\n)*?icon: build\/icon\.png/, 'linux.icon');
});
