/**
 * 用 Chromium 把「带真实文字的页面」渲染成 PNG。
 *
 * 为什么必须有这个脚本：`make-samples.mjs` 里那个纯 `node:zlib` 的 PNG 编码器只会画
 * 色块。色块能验证页序、缩放、协议，但**验证不了 OCR**——「识别出 0 个框」既可能是
 * 模型没跑起来，也可能是图上本来就没字，无法区分。同理，点击查词也需要真实文字。
 *
 * 用法（**必须用 Electron 跑**，不是 node）：
 *   node_modules/.bin/electron scripts/render-text-image.cjs <spec.json>
 *
 * spec.json:
 * {
 *   "pages": [
 *     { "out": "/abs/path.png", "width": 800, "height": 1200, "background": "#fff",
 *       "blocks": [ { "text": "吾輩は猫である。", "vertical": true,
 *                     "box": [60,110,112,670], "fontSize": 26 } ] }
 *   ]
 * }
 *
 * 这是一个 **CommonJS** 脚本（Electron 主进程按 CJS 加载 .cjs），不是构建产物。
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const specPath = process.argv[2];
if (!specPath || specPath.startsWith('--')) {
  console.error('usage: electron scripts/render-text-image.cjs <spec.json>');
  app.exit(2);
}

let spec;
try {
  spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
} catch (error) {
  console.error(`读不了 spec：${error.message}`);
  app.exit(2);
}

const pages = Array.isArray(spec?.pages) ? spec.pages : [];
if (pages.length === 0) {
  console.error('spec.pages 是空的');
  app.exit(2);
}

/** 把一页的块描述转成 HTML。转义是必须的——文本来自 spec，但 spec 来自我们的脚本。 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pageHtml(page) {
  const blocks = (page.blocks ?? [])
    .map((block) => {
      const [x1, y1, x2, y2] = block.box;
      const width = Math.max(8, x2 - x1);
      const height = Math.max(8, y2 - y1);
      const fontSize = block.fontSize ?? 26;
      const cls = block.vertical ? 'v' : 'h';
      return `<div class="box ${cls}" style="left:${x1}px;top:${y1}px;width:${width}px;height:${height}px;font-size:${fontSize}px;">${escapeHtml(block.text)}</div>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: ${page.background ?? '#fff'}; }
  body { width: ${page.width}px; height: ${page.height}px; position: relative;
         font-family: "Hiragino Mincho ProN", "Yu Mincho", "Hiragino Kaku Gothic ProN", serif; }
  .box { position: absolute; background: #fff; border: 1px solid #222; box-sizing: border-box;
         padding: 4px; overflow: hidden; }
  .v { writing-mode: vertical-rl; text-orientation: upright; line-height: 1.08; letter-spacing: 1px; }
  .h { line-height: 1.4; }
</style></head><body>
${blocks}
</body></html>`;
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 100,
    height: 100,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: { offscreen: true },
  });

  for (const page of pages) {
    const width = Math.round(page.width);
    const height = Math.round(page.height);
    win.setContentSize(width, height);
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pageHtml(page))}`);
    // 等字体真正排版完成，否则截图可能是空白（首次尤其明显）。
    await new Promise((resolve) => setTimeout(resolve, 650));
    const image = await win.webContents.capturePage({ x: 0, y: 0, width, height });
    const png = image.toPNG();
    fs.mkdirSync(path.dirname(page.out), { recursive: true });
    fs.writeFileSync(page.out, png);
    console.log(`wrote ${page.out} (${png.length} bytes, ${width}x${height})`);
  }

  app.exit(0);
});
