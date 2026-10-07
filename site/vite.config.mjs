import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  preview: { host: '127.0.0.1', port: 5174, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL('../dist-site', import.meta.url)),
    emptyOutDir: true,
    target: ['chrome110', 'safari17'],
  },
});
