/**
 * 用系统自带的 `hdiutil` 打 DMG —— 不依赖 electron-builder 的 dmg 目标。
 *
 * 为什么不用 electron-builder 的 dmg：它会去 GitHub Releases 下
 * `dmgbuild-bundle-arm64-*.tar.gz`，而本机实测 release 二进制不可达（HTML 能开、
 * 下载超时）。`hdiutil` 是 macOS 自带的，零下载、零依赖，打出来的 DMG 一样能
 * 拖进「应用程序」。
 *
 * 产物布局刻意做成最朴素的形态：**应用图标 + 一个指向 /Applications 的软链**。
 * 不做自定义背景图和图标坐标（那需要额外工具，而且一旦窗口尺寸变了就错位）。
 *
 * 用法：`node scripts/make-dmg.mjs [--app <path-to-.app>]`
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

if (process.platform !== 'darwin') {
  console.log('非 macOS，跳过 DMG');
  process.exit(0);
}

function findApp() {
  const explicit = process.argv.indexOf('--app');
  if (explicit >= 0 && process.argv[explicit + 1]) return process.argv[explicit + 1];
  const releaseDir = join(root, 'release');
  if (!existsSync(releaseDir)) return null;
  for (const entry of readdirSync(releaseDir)) {
    const candidate = join(releaseDir, entry, 'ARaLeBook.app');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const appPath = findApp();
if (!appPath) {
  console.error('找不到 .app。先跑 `npm run pack`。');
  process.exit(2);
}

// 直接从 package.json 读：`node -p` 打出来的是裸版本号，不是 JSON，JSON.parse 会炸。
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const volumeName = 'あられブック';
const outDmg = join(root, 'release', `ARaLeBook-${version}-arm64.dmg`);
const staging = join(root, 'release', '.dmg-staging');

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

// hdiutil 打的是「这个目录的内容」，所以软链放在同级即可。
symlinkSync('/Applications', join(staging, 'Applications'));
spawnSync('cp', ['-R', appPath, join(staging, basename(appPath))], { stdio: 'inherit' });

rmSync(outDmg, { force: true });
const create = spawnSync(
  'hdiutil',
  [
    'create',
    '-volname', volumeName,
    '-srcfolder', staging,
    '-ov',
    // UDZO = 压缩只读，分发用；UDBZ 更小但兼容性略差。
    '-format', 'UDZO',
    '-fs', 'HFS+',
    outDmg,
  ],
  { stdio: 'inherit' },
);

rmSync(staging, { recursive: true, force: true });

if (create.status !== 0) {
  console.error(`hdiutil 失败（exit ${create.status}）`);
  process.exit(create.status ?? 1);
}

// 顺手挂载验证一次再卸载：DMG 偶尔会「打出来但挂不上」，不验一次等于没打。
const verify = spawnSync('hdiutil', ['verify', outDmg], { stdio: 'inherit' });
if (verify.status !== 0) {
  console.error('DMG 校验失败');
  process.exit(verify.status ?? 1);
}

console.log(`\n✓ DMG 打好：${outDmg}`);
