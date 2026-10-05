import * as path from 'node:path';
let root: string | null = null;
export function setUserDataRootForTesting(value: string | null): void { root = value; }
export function bookDir(id: string): string { if (!root) throw new Error('Test data root not configured'); return path.join(root, 'library', id); }
export function bookContentDir(id: string): string { return path.join(bookDir(id), 'content'); }
