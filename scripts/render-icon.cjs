/**
 * 渲染 あられブック 的应用图标（1024×1024 PNG）。
 *
 * 为什么用 Electron 渲染而不是塞一张现成的图：这个仓库刻意不存二进制资源
 * （示例书也是脚本生成的），图标同样应该是**可复现的构建产物**。而且品牌元素
 * 就一个「あ」字 + 朱色渐变，用 CSS 画比维护一套多尺寸 PNG 更省事。
 *
 * 用法（必须用 Electron 跑）：
 *   node_modules/.bin/electron scripts/render-icon.cjs <输出.png> [尺寸]
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const out = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : path.join(__dirname, '..', 'build', 'icon.png');
const size = Number(process.argv[3] ?? 1024);

/**
 * macOS 的应用图标是「圆角方块 + 内缩」，外面留一圈透明。
 * 不内缩的话 Dock 里会顶到边，和系统其它图标放一起明显不对。
 */
const INSET = Math.round(size * 0.08);
const RADIUS = Math.round(size * 0.225);

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: transparent;
               width: ${size}px; height: ${size}px; }
  .tile {
    position: absolute;
    left: ${INSET}px; top: ${INSET}px;
    width: ${size - INSET * 2}px; height: ${size - INSET * 2}px;
    border-radius: ${RADIUS}px;
    /* 朱色渐变：与界面里的 --accent / --accent-hover 同一族 */
    background: linear-gradient(145deg, #d0563a 0%, #b8442c 52%, #8f3220 100%);
    box-shadow: inset 0 ${Math.round(size * 0.006)}px ${Math.round(size * 0.02)}px rgba(255,255,255,.28);
    display: grid; place-items: center;
  }
  .glyph {
    font-family: "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif;
    font-weight: 600;
    font-size: ${Math.round(size * 0.46)}px;
    line-height: 1;
    color: #fff;
    /* 轻微下移：漢字视觉重心偏上，不调会显得浮 */
    transform: translateY(${Math.round(size * 0.012)}px);
    text-shadow: 0 ${Math.round(size * 0.008)}px ${Math.round(size * 0.012)}px rgba(0,0,0,.18);
  }
</style></head>
<body><div class="tile"><span class="glyph">あ</span></div></body></html>`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`);
  await new Promise((resolve) => setTimeout(resolve, 700));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  const png = image.toPNG();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} bytes, ${size}x${size})`);
  app.exit(0);
});
