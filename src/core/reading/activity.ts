import type { ReadingActivity, ReadingDay, ReadingEntry } from '../../shared/reading';

export function localDay(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Count only foreground time before the idle deadline; reject sleep/suspended timer gaps. */
export function activeInterval(from: number, to: number, lastInput: number, foreground: boolean): number {
  if (!foreground || to <= from || to - from > 60_000) return 0;
  return Math.max(0, Math.min(to, lastInput + 120_000) - from);
}

/** Split at local calendar midnight, including DST days. */
export function splitReadingTime(bookId: string, from: number, duration: number): ReadingActivity[] {
  const result: ReadingActivity[] = [];
  const end = from + duration;
  while (from < end) {
    const midnight = new Date(from);
    midnight.setHours(24, 0, 0, 0);
    const next = Math.min(end, midnight.getTime());
    result.push({ id: '', bookId, day: localDay(from), activeMs: next - from, locations: [] });
    from = next;
  }
  return result;
}

export function summarizeReading(days: readonly ReadingDay[]) {
  const words = new Map<string, number>();
  const pages = new Set<string>();
  const chapters = new Set<string>();
  for (const row of days) {
    for (const location of row.locations) {
      (location.startsWith('page:') ? pages : chapters).add(`${row.bookId}:${location}`);
    }
    for (const [word, count] of Object.entries(row.words)) words.set(word, (words.get(word) ?? 0) + count);
  }
  return {
    activeMs: days.reduce((sum, row) => sum + row.activeMs, 0),
    lookups: days.reduce((sum, row) => sum + row.lookups, 0),
    books: new Set(days.map(row => row.bookId)).size,
    days: new Set(days.filter(row => row.activeMs > 0).map(row => row.day)).size,
    pages: pages.size, chapters: chapters.size, words: words.size,
    repeated: [...words].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]).slice(0, 20),
  };
}

export function journalMarkdown(entries: readonly ReadingEntry[]): string {
  return entries.map(entry => {
    const pos = entry.position;
    const location = pos.pageIndex !== undefined ? `第 ${pos.pageIndex + 1} 页` : `第 ${(pos.spineIndex ?? 0) + 1} 章 · 字符 ${pos.charOffset ?? 0}`;
    return `## ${entry.title.replace(/[\r\n]/g, ' ')}\n\n${entry.bookTitle.replace(/[\r\n]/g, ' ')} · ${location}\n\n${entry.quote ? entry.quote.split('\n').map(line => `> ${line}`).join('\n') + '\n\n' : ''}${entry.note}\n`;
  }).join('\n');
}
