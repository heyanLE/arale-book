/**
 * 打包成可双击运行的桌面应用。
 *
 * 顺序有依赖，所以必须按这个次序做：
 * 1. **先编译应用**（`dist/`）—— electron-builder 只负责装箱，不负责编译。
 * 2. **再确认 Rust sidecar 存在** —— 它是 extraResources 的输入，缺了 `electron-builder`
 *    会直接报「文件不存在」，而不是给你一个能跑但少了 .rar 支持的包。
 * 3. **再确认图标存在** —— 同理，缺 icns 会用默认 Electron 图标（很丑，但不致命）。
 * 4. 最后 `electron-builder`。
 *
 * 用法：
 *   node scripts/pack.mjs               # 当前平台
 *   node scripts/pack.mjs --mac         # 指定平台
 *   node scripts/pack.mjs --dir         # 只产出解包目录（最快，用来验证）
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);

function run(label, command, commandArgs, options = {}) {
  process.stdout.write(`\n▸ ${label}\n`);
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', ...options });
  if (result.status !== 0) {
    console.error(`\n✗ ${label} 失败（exit ${result.status}）`);
    process.exit(result.status ?? 1);
  }
}

// 1) 编译应用
run('编译应用（main + preload + renderer）', 'npm', ['run', 'build']);

// 2) Rust sidecar —— 打包前必须已经构建
const exeName = process.platform === 'win32' ? 'arale-native.exe' : 'arale-native';
const nativeBin = join(root, 'native', 'arale-native', 'target', 'release', exeName);
if (!existsSync(nativeBin)) {
  process.stdout.write('\n▸ 未找到 Rust sidecar，先构建它\n');
  run('构建 Rust sidecar', 'node', ['scripts/build-native.mjs']);
}
if (!existsSync(nativeBin)) {
  console.error(
    `\n✗ 仍然没有 ${nativeBin}。\n` +
      '  没有它，包里会缺少 .rar / .cbr / .7z / .cb7 的解包能力（其余功能正常）。\n' +
      '  想继续打包也可以：把 electron-builder.yml 里的 native extraResources 去掉。',
  );
  process.exit(1);
}

// 3) 图标
if (!existsSync(join(root, 'build', 'icon.icns')) && !existsSync(join(root, 'build', 'icon.png'))) {
  run('生成应用图标', 'node', ['scripts/make-icon.mjs']);
}

// 4) 装箱
const builderArgs = [];
if (args.includes('--mac')) builderArgs.push('--mac');
if (args.includes('--win')) builderArgs.push('--win');
if (args.includes('--linux')) builderArgs.push('--linux');
if (args.includes('--dir')) builderArgs.push('--dir');
builderArgs.push('--publish', 'never');

run('electron-builder 装箱', join(root, 'node_modules', '.bin', 'electron-builder'), builderArgs);

// 5) macOS 上再打一个 DMG。交给系统自带的 hdiutil，不走 electron-builder 的 dmg 目标
//    （后者要从 GitHub Releases 下 dmgbuild，本机不可达）。--dir 模式跳过。
if (process.platform === 'darwin' && !args.includes('--dir')) {
  run('打 DMG（hdiutil）', 'node', ['scripts/make-dmg.mjs']);
}

process.stdout.write(
  [
    '',
    '✓ 打包完成',
    `  产物目录：${join(root, 'release')}`,
    '    · ARaLeBook-<版本>-arm64-mac.zip    压缩包（解压即用）',
    '    · ARaLeBook-<版本>-arm64.dmg        磁盘映像（拖进「应用程序」）',
    '    · mac-arm64/ARaLeBook.app           解包后的应用本体',
    '',
    '  macOS 首次打开若提示「已损坏」或「无法验证开发者」（因为没签名）：',
    '    xattr -dr com.apple.quarantine "/Applications/ARaLeBook.app"',
    '  或者右键点图标 →「打开」。',
    '',
  ].join('\n'),
);
