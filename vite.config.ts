import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'node:path';

/**
 * 渲染进程用 Vite 打包；主进程/预加载用 tsc（见 tsconfig.main.json）。
 *
 * `base: './'` 是必须的：产物由 Electron 以 `file://` 加载，绝对路径 `/assets/...`
 * 会解析到磁盘根目录，页面直接白屏。这是 Electron + Vite 最常见的坑。
 */
export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome130',
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      // 渲染进程也可以直接复用 core 里的**纯**逻辑（目前只有漫画的双页配对规则）。
      // ⚠️ 只能 import 不碰 `node:*` / `electron` 的模块 —— core 里像 `util/atomic-json`
      // 那种用 `node:fs` 的模块拿到浏览器里会直接构建失败。
      '@core': path.resolve(__dirname, 'src/core'),
    },
  },
  server: {
    port: 5273,
  },
});
