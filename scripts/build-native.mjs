/**
 * 构建 Rust 原生 sidecar（`native/arale-native`）。
 *
 * 为什么需要一个脚本而不是直接在 package.json 里写 `cargo build`：
 * 本项目的 Rust 工具链装在**仓库内的 `.rust/`**（不碰用户的 `~/.cargo`），所以每次调用
 * 都得显式给 `PATH` / `CARGO_HOME` / `RUSTUP_HOME`。写在脚本里，三处环境变量只有一份定义。
 *
 * 没装 Rust 时保留兼容的“提示并跳过”行为；Tauri 与服务端的归档解包需要
 * 此原生层。服务端仅扫描图片目录时可不使用解包器，调用方须检查构建完成输出。
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
  console.log('native/arale-native 不存在，跳过原生构建');
  process.exit(0);
}

const useLocalToolchain = existsSync(localCargo);
const cargoBin = useLocalToolchain ? localCargo : systemCargo;
const env = { ...process.env };
if (useLocalToolchain) {
  env.PATH = `${join(cargoHome, 'bin')}${delimiter}${process.env.PATH ?? ''}`;
  env.CARGO_HOME = cargoHome;
  env.RUSTUP_HOME = rustupHome;
}

const cargoProbe = spawnSync(cargoBin, ['--version'], { stdio: 'ignore', env });
if (cargoProbe.status !== 0) {
  console.warn(
    [
      '',
      '⚠️  没有找到 Rust 工具链，跳过原生 sidecar 构建。',
      '   影响：Tauri／服务端原生归档解包不可用。',
      '         服务端扫描图片目录不依赖此解包器。',
      '   修复：安装系统 Rust，或按 README 把工具链放到仓库 `.rust/`。',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

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
