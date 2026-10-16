import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

// Unix 可执行夹具验证真实启动脚本，不调用 Swift、真实 Cargo 或打开应用。
const skip = process.platform === 'win32' || /\s/.test(process.execPath);
function fixture(): { root: string; log: string; env: NodeJS.ProcessEnv } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'arale-startup-')));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'node_modules/vite/bin'), { recursive: true });
  for (const file of ['tauri.mjs', 'nightly.mjs']) copyFileSync(resolve(__dirname, '../../scripts', file), join(root, 'scripts', file));
  const log = join(root, 'calls.jsonl');
  const recordBuild = `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(log)}, JSON.stringify({ stage: 'frontend' }) + '\\n');`;
  writeFileSync(join(root, 'scripts/build-vision-ocr.mjs'), '');
  writeFileSync(join(root, 'node_modules/vite/bin/vite.js'), recordBuild);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: join(root, 'empty-path') };
  for (const key of Object.keys(env)) if (['CARGO_HOME', 'RUSTUP_HOME', 'ARALE_BUILD_VERSION', 'TAURI_CONFIG'].includes(key) || key.toUpperCase() === 'PATH' && key !== 'PATH') delete env[key];
  return { root, log, env };
}

test('Tauri startup uses repository Cargo and passes Rustup homes/PATH to its children', { skip }, t => {
  const { root, log, env } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cargoHome = join(root, '.rust/cargo'), rustupHome = join(root, '.rust/rustup');
  mkdirSync(join(cargoHome, 'bin'), { recursive: true });
  writeFileSync(join(cargoHome, 'bin/cargo'), `#!${process.execPath}
const fs = require('node:fs');
if (process.env.CARGO_HOME !== ${JSON.stringify(cargoHome)} || process.env.RUSTUP_HOME !== ${JSON.stringify(rustupHome)}) throw new Error('Rustup homes missing');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ stage: 'cargo', args: process.argv.slice(2), path: process.env.PATH }) + '\\n');
if (process.argv[2] === '--version') console.log('cargo fixture');
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [join(root, 'scripts/tauri.mjs'), 'check'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.map(call => call.stage), ['cargo', 'frontend', 'cargo']);
  assert.deepEqual(calls[0].args, ['--version']);
  assert.deepEqual(calls[2].args, ['check', '--manifest-path', join(root, 'src-tauri/Cargo.toml'), '--locked']);
  assert.equal(calls[2].path.split(delimiter)[0], join(cargoHome, 'bin'));
});

test('missing Cargo fails with an actionable message before building the frontend', { skip }, t => {
  const { root, log, env } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [join(root, 'scripts/tauri.mjs'), 'check'], { env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /无法运行 Rust Cargo/);
  assert.doesNotMatch(result.stderr, /node:internal\/child_process/);
  assert.equal(existsSync(log), false);
});
