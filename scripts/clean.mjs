/**
 * 清理构建产物。用 Node 脚本而不是 `rm -rf`，因为 package.json 里的脚本要跨平台
 * （Windows 上 `rm -rf` 不存在，而这是一个 desktop 应用，迟早要在 Windows 上跑）。
 */

import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

for (const target of ['dist', 'dist-test']) {
  const path = join(root, target);
  rmSync(path, { recursive: true, force: true });
  console.log(`removed ${target}`);
}
