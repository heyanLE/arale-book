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

// generate_context! embeds frontendDist even during cargo check/test.
// Build it for every entry so a clean checkout never relies on previous output.
await run(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build'], { ...buildEnv, ARALE_TAURI_BUILD: '1' });
const manifest = ['--manifest-path', resolve(root, 'src-tauri/Cargo.toml'), '--locked'];
if (mode === 'dev') await run('cargo', ['run', ...manifest]);
else if (mode === 'build') await run('cargo', ['build', ...manifest, '--release']);
else if (mode === 'pack') {
  // A workspace-local official CLI also works on machines without a global install.
  const local = resolve(root, '.tmp/tauri-cli/bin', process.platform === 'win32' ? 'cargo-tauri.exe' : 'cargo-tauri');
  const options = [];
  if (version) options.push('--config', JSON.stringify({ version }));
  if (process.env.ARALE_BUILD_TARGET) options.push('--target', process.env.ARALE_BUILD_TARGET);
  const cli = resolve(root, 'node_modules/@tauri-apps/cli/tauri.js');
  const invoke = args => existsSync(cli) ? run(process.execPath, [cli, ...args])
    : existsSync(local) ? run(local, args) : run('cargo', ['tauri', ...args]);
  if (process.platform === 'darwin' && process.env.CI) {
    // Build must succeed before any retry; bundle never substitutes an old binary.
    await invoke(['build', ...options, '--no-bundle', '--', '--locked']);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await invoke(['bundle', ...options, '--verbose']);
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        console.warn('macOS installer bundling failed; retrying once without recompiling.');
        await new Promise(accept => setTimeout(accept, 1500));
      }
    }
  } else await invoke(['build', ...options, '--', '--locked']);
} else await run('cargo', [mode, ...manifest]);
