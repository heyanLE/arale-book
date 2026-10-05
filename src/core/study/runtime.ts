import type { StudyCandidate, StudyOccurrence, StudyCardTier } from '../../shared/types';
import type { MorphToken } from './candidates';
import type { createJlptIndex } from './jlpt';
import type { CardInput } from './apkg';
export interface StudyCrop { name: string; data: Uint8Array }
export interface StudyRuntime {
  readJson<T>(file: string, fallback: T): T;
  writeJsonAtomic(file: string, value: unknown): void;
  writeFileAtomic(file: string, value: string | Uint8Array): void;
  join(...parts: string[]): string;
  bookDir(id: string): string;
  mkdir(directory: string): void;
  jlpt(): {index: ReturnType<typeof createJlptIndex>; source: string};
  wordfreqSource(): string | null;
  zipfForCandidate(candidate: StudyCandidate): number | null | undefined;
  tokenizeJapanese(text: string): Promise<MorphToken[]>;
  yield(): Promise<void>;
  crop(bookId: string, occurrence: StudyOccurrence): StudyCrop | Promise<StudyCrop>;
  pageImage(bookId: string, occurrence: StudyOccurrence): StudyCrop | Promise<StudyCrop>;
  validateSource(bookId: string, occurrence: StudyOccurrence): unknown | Promise<unknown>;
  buildPackage(bookId: string, title: string, tier: StudyCardTier, inputs: readonly CardInput[]): Promise<Uint8Array>;
}
