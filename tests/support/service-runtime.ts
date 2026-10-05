import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { readJson, writeJsonAtomic } from '../../src/core/util/atomic-json';
import type { ServiceRuntime } from '../../src/core/services/runtime';
export const nodeServiceRuntime: ServiceRuntime = {
  readJson, writeJsonAtomic,
  hash: (algorithm, value) => createHash(algorithm).update(value).digest('hex'),
  randomHex: bytes => randomBytes(bytes).toString('hex'),
  sibling: (file, name) => path.join(path.dirname(file), name),
};
