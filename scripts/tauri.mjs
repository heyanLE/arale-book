/** Tauri application entry. Node is used for development/build only, never bundled. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDateVersion } from './nightly.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2] ?? 'dev';
if (!['dev', 'build', 'pack', 'check', 'test'].includes(mode)) throw new Error(`Unknown Tauri mode: ${mode}`);
const version = process.env.ARALE_BUILD_VERSION;
if (version && !parseDateVersion(version)) throw new Error('ARALE_BUILD_VERSION must be a date version (YYYY.M.D)');
const buildEnv = version ? { ...process.env, TAURI_CONFIG: JSON.stringify({ ...JSON.parse(process.env.TAURI_CONFIG ?? '{}'), version }) } : process.env;

function run(command, args, env = buildEnv) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', env });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept() : reject(new Error(`${command} exited ${code}`)));
  });
}

if (process.platform === 'darwin') await run(process.execPath, [resolve(root, 'scripts/build-vision-ocr.mjs')]);
if (mode === 'pack') await run(process.execPath, [resolve(root, 'scripts/make-icon.mjs')]);

if (mode === 'dev' || mode === 'build' || mode === 'pack') {
  await run(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build'], { ...buildEnv, ARALE_TAURI_BUILD: '1' });
}
const manifest = ['--manifest-path', resolve(root, 'src-tauri/Cargo.toml'), '--locked'];
if (mode === 'dev') await run('cargo', ['run', ...manifest]);
else if (mode === 'build') await run('cargo', ['build', ...manifest, '--release']);
else if (mode === 'pack') {
  // A workspace-local official CLI also works on machines without a global install.
  const local = resolve(root, '.tmp/tauri-cli/bin', process.platform === 'win32' ? 'cargo-tauri.exe' : 'cargo-tauri');
  const args = ['build'];
  if (version) args.push('--config', JSON.stringify({ version }));
  if (process.env.ARALE_BUILD_TARGET) args.push('--target', process.env.ARALE_BUILD_TARGET);
  args.push('--', '--locked');
  const cli = resolve(root, 'node_modules/@tauri-apps/cli/tauri.js');
  if (existsSync(cli)) await run(process.execPath, [cli, ...args]);
  else if (existsSync(local)) await run(local, args);
  else await run('cargo', ['tauri', ...args]);
} else await run('cargo', [mode, ...manifest]);
