/**
 * 跑 Rust sidecar 自己的单测。
 *
 * 与 `build-native.mjs` 同理：Rust 工具链装在仓库内的 `.rust/`，必须显式给出
 * `PATH` / `CARGO_HOME` / `RUSTUP_HOME`。写成一个脚本（而不是把三行 export 塞进
 * package.json）是为了跨平台——npm 的 script 默认走 sh，Windows 上会直接挂。
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
  console.log('native/arale-native 不存在，跳过');
  process.exit(0);
}
if (!existsSync(cargoBin)) {
  console.warn('没有找到 Rust 工具链（.rust/cargo/bin/cargo），跳过原生测试');
  process.exit(0);
}

const result = spawnSync(cargoBin, ['test', '--release'], {
  cwd: crateDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    PATH: `${join(cargoHome, 'bin')}:${process.env.PATH ?? ''}`,
    CARGO_HOME: cargoHome,
    RUSTUP_HOME: rustupHome,
  },
});

process.exit(result.status ?? 1);
