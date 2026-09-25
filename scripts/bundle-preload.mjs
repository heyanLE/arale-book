/**
 * 把预加载脚本打成**单文件**。
 *
 * 为什么必须做这一步（这不是优化，是正确性）：
 * `webPreferences.sandbox: true` 的预加载脚本跑在受限上下文里，`require()` 只允许
 * `electron` / `events` / `timers` / `url` 四个模块，**不允许 require 本地文件**。
 * 所以 tsc 产出的 `dist/preload/index.js`（里面写着 `require("../shared/ipc")`）
 * 在运行时直接报 `module not found: ../shared/ipc`，`window.arale` 根本不会被挂上,
 * 整个渲染进程的所有 IPC 调用都会 `Cannot read properties of undefined`。
 *
 * 另一个选择是把 `sandbox` 关掉，但那会让渲染进程重新拿到完整 Node 能力——为了省一个
 * 打包步骤而放弃进程隔离，不划算。
 *
 * 注意：这里**不把共享契约复制一份**。IPC 通道名与 `bookAssetUrl` 仍然只有
 * `src/shared/ipc.ts` 一处定义，只是被内联进产物而已。
 */

import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const result = await build({
  entryPoints: [join(root, 'src/preload/index.ts')],
  outfile: join(root, 'dist/preload/index.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // electron 由运行时提供，绝不能打进产物。
  external: ['electron'],
  sourcemap: true,
  logLevel: 'warning',
  metafile: true,
});

const outputs = Object.entries(result.metafile.outputs);
for (const [file, meta] of outputs) {
  console.log(`preload bundled → ${file.replace(`${root}/`, '')} (${meta.bytes} bytes)`);
}

if (outputs.length === 0) {
  console.error('preload 打包没有产出任何文件');
  process.exit(1);
}
