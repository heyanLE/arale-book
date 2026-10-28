import type { DictionaryInfo } from './types';

export interface DictionaryImportProgress {
  stage: 'checking' | 'extracting' | 'parsing' | 'saving' | 'indexing';
  message: string;
  done: number;
  total: number;
  unit: 'files' | 'entries' | 'dictionaries';
  title?: string;
}
export interface DictionaryImportResult {
  dictionary: DictionaryInfo;
  indexed: boolean;
  warnings: string[];
}
export interface DictionaryImportTask {
  id: string;
  source: string;
  title: string;
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
  enqueuedAt: number;
  finishedAt?: number;
  progress: DictionaryImportProgress;
  result: DictionaryImportResult | null;
  error: string | null;
}
export interface DictionaryImportQueueState {
  active: DictionaryImportTask | null;
  pending: DictionaryImportTask[];
  recent: DictionaryImportTask[];
}
export interface DictionaryImportReceipt { taskIds: string[] }
