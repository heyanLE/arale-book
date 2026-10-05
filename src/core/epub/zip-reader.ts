/** Node filesystem adapter; shared ZIP parsing lives in zip-memory.ts. */
import * as fs from 'node:fs';
import { openZip, ZipReadError, type ZipEntry } from './zip-memory';
export * from './zip-memory';
export function readZipFile(filePath: string): ZipEntry[] {
  let bytes: Uint8Array;
  try { bytes = fs.readFileSync(filePath); }
  catch (err) { throw new ZipReadError(`无法读取文件 ${filePath}：${err instanceof Error ? err.message : String(err)}`); }
  return openZip(bytes);
}
