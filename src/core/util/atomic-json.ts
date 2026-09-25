/**
 * 原子写 JSON —— 移植 Fushi 的 `.tmp` + `rename` 惯例（analysis 02 §3）。
 *
 * 为什么必须原子：书库索引被任何一次崩溃写坏，用户整个书架就没了。直接
 * `writeFile` 在断电/强杀时会留下截断的 JSON，`JSON.parse` 直接抛。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 写文件：先写同目录的 `.tmp-<pid>-<ts>`，`fsync` 后 `rename` 覆盖目标。
 * rename 在同一文件系统上是原子的，所以读者要么看到旧内容要么看到新内容。
 */
export function writeFileAtomic(target: string, data: string | Buffer): void {
  ensureDir(path.dirname(target));
  const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 清理失败不掩盖原错误 */
    }
    throw error;
  }
}

/** 原子写 JSON（2 空格缩进，结尾换行，便于 git diff）。 */
export function writeJsonAtomic(target: string, value: unknown): void {
  writeFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * 读 JSON。文件不存在或内容损坏时返回 `fallback`，并把损坏文件另存为
 * `<name>.corrupt-<ts>`——静默吞掉会掩盖「索引写坏」这个真问题。
 */
export function readJson<T>(source: string, fallback: T): T {
  let raw: string;
  try {
    raw = fs.readFileSync(source, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    try {
      fs.renameSync(source, `${source}.corrupt-${Date.now().toString(36)}`);
    } catch {
      /* 另存失败也不能让调用方崩 */
    }
    return fallback;
  }
}
