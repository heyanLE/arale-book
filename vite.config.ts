import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Tauri renderer and browser Workers are bundled by Vite. Rust serves the local
 * assets; relative URLs also keep the packaged Kuromoji dictionary accessible.
 */
export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react(), {
    name: 'tauri-kuromoji-assets',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'licenses/noble-hashes.txt', source: fs.readFileSync(path.resolve(__dirname, 'node_modules/@noble/hashes/LICENSE')) });
      this.emitFile({ type: 'asset', fileName: 'licenses/marked.txt', source: fs.readFileSync(path.resolve(__dirname, 'node_modules/marked/LICENSE')) });
      for (const name of ['JLPT-ATTRIBUTION.md', 'jlpt-source-LICENSE.txt', 'WORDFREQ-ATTRIBUTION.md'])
        this.emitFile({ type: 'asset', fileName: `licenses/${name}`, source: fs.readFileSync(path.resolve(__dirname, 'data', name)) });
      const root = path.resolve(__dirname, 'node_modules/kuromoji');
      for (const name of fs.readdirSync(path.join(root, 'dict'))) {
        if (name.endsWith('.dat.gz')) this.emitFile({ type: 'asset', fileName: `kuromoji/${name}`, source: fs.readFileSync(path.join(root, 'dict', name)) });
      }
      for (const name of ['LICENSE-2.0.txt', 'NOTICE.md']) this.emitFile({ type: 'asset', fileName: `kuromoji/${name}`, source: fs.readFileSync(path.join(root, name)) });
    },
  }],
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: ['chrome110', 'safari17'],
    sourcemap: true,
  },
  worker: {
    plugins: () => [{
      name: 'reject-node-worker-imports',
      resolveId(source) {
        if (source.startsWith('node:')) throw new Error(`Worker cannot import ${source}`);
      },
    }],
  },
  resolve: {
    alias: {
      './data-source': path.resolve(__dirname, 'src/renderer/lib/dictionary-data.ts'),
      '@shared': path.resolve(__dirname, 'src/shared'),
      // 渲染进程也可以直接复用 core 里的**纯**逻辑（目前只有漫画的双页配对规则）。
      // ⚠️ 只能 import 不碰 `node:*` 的模块 —— core 里像 `util/atomic-json`
      // 那种用 `node:fs` 的模块拿到浏览器里会直接构建失败。
      '@core': path.resolve(__dirname, 'src/core'),
    },
  },
  server: {
    port: 5273,
  },
});
