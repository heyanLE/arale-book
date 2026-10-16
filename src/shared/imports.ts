import type { ImportOutcome } from './types';

export interface ImportProgress {
  stage: 'checking' | 'extracting' | 'organizing' | 'publishing';
  message: string;
  done: number;
  total: number;
}
export interface ImportTaskEntry {
  id: string;
  source: string;
  title: string;
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
  enqueuedAt: number;
  finishedAt?: number;
  progress: ImportProgress;
  results: ImportOutcome[];
}
export interface ImportQueueState {
  active: ImportTaskEntry | null;
  pending: ImportTaskEntry[];
  recent: ImportTaskEntry[];
}
