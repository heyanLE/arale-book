import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeInterval, journalMarkdown, localDay, splitReadingTime, summarizeReading } from '../src/core/reading/activity';
import type { ReadingDay, ReadingEntry } from '../src/shared/reading';

test('reading clock counts only foreground, truncates idle boundary, ignores suspended and backwards clocks', () => {
  assert.equal(activeInterval(100_000, 110_000, 0, true), 10_000);
  assert.equal(activeInterval(115_000, 125_000, 0, true), 5_000);
  assert.equal(activeInterval(125_000, 135_000, 0, true), 0);
  assert.equal(activeInterval(0, 10_000, 0, false), 0);
  assert.equal(activeInterval(0, 70_000, 0, true), 0);
  assert.equal(activeInterval(10, 0, 0, true), 0);
});
test('reading duration is split at local calendar midnight without losing milliseconds', () => {
  const start = new Date(2026, 9, 15, 23, 59, 57).getTime();
  const packets = splitReadingTime('book', start, 10_000);
  assert.deepEqual(packets.map(packet => [packet.day, packet.activeMs]), [['2026-10-15', 3000], ['2026-10-16', 7000]]);
  assert.equal(localDay(new Date(2026, 9, 15, 0, 1).getTime()), '2026-10-15');
});
test('summary deduplicates revisits across days, separates books and formats, combines repeated lookups', () => {
  const row: ReadingDay = { day: '2026-10-15', bookId: 'a', bookTitle: 'A', activeMs: 1000, locations: ['page:0', 'page:1'], lookups: 2, words: { 猫: 2 } };
  const result = summarizeReading([row, { ...row, day: '2026-10-16', locations: ['page:0'], lookups: 1, words: { 猫: 1 } }, { ...row, bookId: 'b', locations: ['chapter:0'], words: { 犬: 2 } }]);
  assert.equal(result.pages, 2); assert.equal(result.chapters, 1); assert.equal(result.words, 2);
  assert.equal(result.books, 2); assert.equal(result.days, 2); assert.equal(result.activeMs, 3000);
  assert.deepEqual(result.repeated, [['猫', 3], ['犬', 2]]);
});
test('journal markdown preserves multiline excerpts, notes and chapter/page source labels', () => {
  const entry: ReadingEntry = { id: 'a', kind: 'excerpt', bookId: 'b', bookTitle: '作品', title: '摘录', quote: '猫\n犬', note: '理解\n疑问', position: { bookId: 'b', spineIndex: 2, charOffset: 18, updatedAt: 0 }, createdAt: 0, updatedAt: 0 };
  assert.match(journalMarkdown([entry]), /第 3 章 · 字符 18\n\n> 猫\n> 犬\n\n理解\n疑问/);
  assert.match(journalMarkdown([{ ...entry, position: { bookId: 'b', pageIndex: 4, updatedAt: 0 } }]), /第 5 页/);
});
