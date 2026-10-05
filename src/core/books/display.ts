import type { BookRecord } from '../../shared/types';
/** Display fallback only. Never rewrites imported metadata or attempts to guess damaged text. */
export function bookDisplay(book: Pick<BookRecord, 'title' | 'author' | 'volume'>): { title: string; author: string; volume: number | null; needsMetadata: boolean } {
  const prefix = /^\s*\[([^\]]+)\]\s*/u.exec(book.title);
  const author = book.author || prefix?.[1] || '';
  const title = prefix ? book.title.slice(prefix[0].length) : book.title;
  const volumeMatch = /(?:第\s*)?(\d{1,3})\s*[巻卷]|\bv(\d{1,3})\b|\s(\d{1,3})$/iu.exec(title);
  const volume = book.volume ?? (volumeMatch ? Number(volumeMatch[1] ?? volumeMatch[2] ?? volumeMatch[3]) : null);
  return { title, author, volume, needsMetadata: !book.author || book.title.includes('\uFFFD') };
}
