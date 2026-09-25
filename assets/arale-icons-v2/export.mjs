// Format/size exports only; keep the generated artwork and its alpha intact.
// Run with macOS system tools: node assets/arale-icons-v2/export.mjs
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}
for (const kind of ['app', 'avatar']) {
  const dir = join(root, kind);
  mkdirSync(dir, { recursive: true });
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    run('sips', ['-z', String(size), String(size), join(root, `${kind}-master.png`), '--out', join(dir, `${size}.png`)]);
  }
}

const iconset = join(root, 'aralebook.iconset');
mkdirSync(iconset, { recursive: true });
for (const [size, filename] of [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
]) {
  copyFileSync(join(root, size <= 32 ? 'avatar' : 'app', `${size}.png`), join(iconset, filename));
}
run('iconutil', ['-c', 'icns', iconset, '-o', join(root, 'aralebook.icns')]);

// PNG-compressed ICO entries supported by modern Windows / Electron.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const payloads = sizes.map(size => readFileSync(join(root, size <= 32 ? 'avatar' : 'app', `${size}.png`)));
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, i) => {
  const entry = 6 + i * 16;
  header[entry] = header[entry + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(payloads[i].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += payloads[i].length;
});
writeFileSync(join(root, 'aralebook.ico'), Buffer.concat([header, ...payloads]));
console.log('Exported both PNG families, macOS ICNS and Windows ICO.');
