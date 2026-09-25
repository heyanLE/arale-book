/**
 * 构建 Rust 原生 sidecar（`native/arale-native`）。
 *
 * 为什么需要一个脚本而不是直接在 package.json 里写 `cargo build`：
 * 本项目的 Rust 工具链装在**仓库内的 `.rust/`**（不碰用户的 `~/.cargo`），所以每次调用
 * 都得显式给 `PATH` / `CARGO_HOME` / `RUSTUP_HOME`。写在脚本里，三处环境变量只有一份定义。
 *
 * 没装 Rust 时**不失败**：`.zip`/`.cbz` 走纯 JS 的 fflate，本来就不需要原生层；
 * 只有 `.rar/.cbr/.7z/.cb7` 才依赖它。所以缺工具链时打个明确提示、以 0 退出，
 * 让 `npm install` 后的首次构建不会因为一个可选能力而整体挂掉。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const crateDir = join(root, 'native', 'arale-native');
const cargoHome = join(root, '.rust', 'cargo');
const rustupHome = join(root, '.rust', 'rustup');
const cargoBin = join(cargoHome, 'bin', 'cargo');

if (!existsSync(crateDir)) {
  console.log('native/arale-native 不存在，跳过原生构建');
  process.exit(0);
}

if (!existsSync(cargoBin)) {
  console.warn(
    [
      '',
      '⚠️  没有找到 Rust 工具链，跳过原生 sidecar 构建。',
      '   影响：.rar / .cbr / .7z / .cb7 漫画压缩包无法导入。',
      '         .zip / .cbz / EPUB / 图片文件夹 / .mokuro 不受影响（走纯 JS）。',
      '   修复：见 README「原生 sidecar」一节。',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const env = {
  ...process.env,
  PATH: `${join(cargoHome, 'bin')}:${process.env.PATH ?? ''}`,
  CARGO_HOME: cargoHome,
  RUSTUP_HOME: rustupHome,
};

console.log('building native/arale-native (release)…');
const result = spawnSync(cargoBin, ['build', '--release'], {
  cwd: crateDir,
  env,
  stdio: 'inherit',
});

if (result.status !== 0) {
  console.error(`原生 sidecar 构建失败（exit ${result.status}）`);
  process.exit(result.status ?? 1);
}

console.log('原生 sidecar 构建完成');
