/**
 * 跑 Rust sidecar 自己的单测。
 *
 * 与 `build-native.mjs` 同理：Rust 工具链装在仓库内的 `.rust/`，必须显式给出
 * `PATH` / `CARGO_HOME` / `RUSTUP_HOME`。写成一个脚本（而不是把三行 export 塞进
 * package.json）是为了跨平台——npm 的 script 默认走 sh，Windows 上会直接挂。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const crateDir = join(root, 'native', 'arale-native');
const cargoHome = join(root, '.rust', 'cargo');
const rustupHome = join(root, '.rust', 'rustup');
const localCargo = join(cargoHome, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const systemCargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo';

if (!existsSync(crateDir)) {
  console.log('native/arale-native 不存在，跳过');
  process.exit(0);
}
const useLocalToolchain = existsSync(localCargo);
const cargoBin = useLocalToolchain ? localCargo : systemCargo;
const cargoProbe = spawnSync(cargoBin, ['--version'], { stdio: 'ignore' });
if (cargoProbe.status !== 0) {
  console.warn('没有找到 Rust 工具链（系统 Cargo 或仓库 .rust/），跳过原生测试');
  process.exit(0);
}

const env = { ...process.env };
if (useLocalToolchain) {
  env.PATH = `${join(cargoHome, 'bin')}${delimiter}${process.env.PATH ?? ''}`;
  env.CARGO_HOME = cargoHome;
  env.RUSTUP_HOME = rustupHome;
}

const result = spawnSync(cargoBin, ['test', '--release'], {
  cwd: crateDir,
  stdio: 'inherit',
  env,
});

process.exit(result.status ?? 1);
