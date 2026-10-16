import type { ReadingPosition } from './types';

export type ReadingEntryKind = 'bookmark' | 'excerpt' | 'note';
export interface ReadingEntry {
  id: string;
  bookId: string;
  bookTitle: string;
  kind: ReadingEntryKind;
  title: string;
  quote: string;
  note: string;
  position: ReadingPosition;
  pageUrl?: string;
  createdAt: number;
  updatedAt: number;
  available?: boolean;
}
export type ReadingEntryDraft = Pick<ReadingEntry, 'bookId' | 'kind' | 'title' | 'quote' | 'note' | 'position' | 'pageUrl'> &
  Partial<Pick<ReadingEntry, 'id' | 'updatedAt'>>;
export interface ReadingDay {
  day: string;
  bookId: string;
  bookTitle: string;
  activeMs: number;
  locations: string[];
  lookups: number;
  words: Record<string, number>;
}
export interface ReadingSnapshot { entries: ReadingEntry[]; days: ReadingDay[] }
export interface ReadingActivity {
  id: string;
  bookId: string;
  day: string;
  activeMs: number;
  locations: string[];
  word?: string;
}
export interface ReaderJournalProps {
  onPosition?: (position: ReadingPosition, visibleLocations: string[]) => void;
  onExcerpt?: (draft: ReadingEntryDraft) => void;
  jump?: { token: number; entry: ReadingEntry } | null;
}
