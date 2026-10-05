/** Compile into a fresh test directory so removed tests cannot run from stale output. */
import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
rmSync(resolve(root, 'dist-test'), {recursive:true, force:true});
for (const args of [[resolve(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.test.json'], ['--test', '--test-concurrency=1', 'dist-test/tests/*.test.js', 'tests/nightly.test.mjs']]) {
  const result = spawnSync(process.execPath, args, {cwd:root, stdio:'inherit'});
  if (result.error) throw result.error;
  if (result.status) process.exit(result.status);
}
