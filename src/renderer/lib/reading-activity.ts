import { useCallback, useEffect, useRef } from 'react';
import type { ReadingActivity } from '@shared/reading';
import type { ReadingPosition } from '@shared/types';
import { activeInterval, localDay, splitReadingTime } from '@core/reading/activity';
import { api, call, reportApiError } from './api';

const OUTBOX = 'aralebook.reading-outbox.v1';
let pending: ReadingActivity[] = [];
try {
  const stored: unknown = JSON.parse(localStorage.getItem(OUTBOX) ?? '[]');
  if (Array.isArray(stored)) pending = stored.filter(item => item && typeof item.id === 'string' && typeof item.bookId === 'string' && typeof item.day === 'string' && typeof item.activeMs === 'number' && Array.isArray(item.locations));
} catch { /* Native statistics remain authoritative; a malformed browser queue is not applied. */ }
let draining: Promise<void> | null = null;
function persistQueue() {
  try { localStorage.setItem(OUTBOX, JSON.stringify(pending)); }
  catch (error) { reportApiError('暂存统计重试队列', error); }
}
export function flushReadingActivity(): Promise<void> {
  if (draining) return draining;
  draining = (async () => {
    while (pending.length) {
      const item = pending[0]!;
      const saved = await call('保存阅读统计', () => api.reading.record(item));
      if (saved === null) break;
      pending.shift(); persistQueue();
    }
  })().finally(() => { draining = null; });
  return draining;
}
export function recordReadingActivity(activity: Omit<ReadingActivity, 'id'>) {
  pending.push({ ...activity, id: crypto.randomUUID() });
  persistQueue(); void flushReadingActivity();
}
export function recordLookup(bookId: string, word: string) {
  const normalized = word.normalize('NFKC').trim().slice(0, 200);
  if (normalized) recordReadingActivity({ bookId, day: localDay(Date.now()), activeMs: 0, locations: [], word: normalized });
}

export function useReadingActivity(bookId: string, enabled: boolean) {
  const tickRef = useRef<(() => void) | null>(null);
  const location = useRef({ values: [] as string[], since: Date.now() });
  const onPosition = useCallback((_position: ReadingPosition, locations: string[]) => {
    if (locations.join('|') !== location.current.values.join('|')) {
      tickRef.current?.();
      location.current = { values: locations, since: Date.now() };
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let previous = Date.now();
    let lastInput = previous;
    let foreground = document.visibilityState === 'visible' && document.hasFocus();
    const tick = () => {
      const now = Date.now();
      const duration = activeInterval(previous, now, lastInput, foreground);
      if (duration > 0) {
        for (const packet of splitReadingTime(bookId, previous, duration)) {
          packet.locations = now - location.current.since >= 2000 ? location.current.values : [];
          recordReadingActivity(packet);
        }
      }
      previous = now;
      void flushReadingActivity();
    };
    tickRef.current = tick;
    const input = () => {
      const now = Date.now();
      // Flush the idle tail before a fresh interaction reopens the active interval.
      if (now - lastInput >= 120_000) tick();
      lastInput = now;
    };
    const visibility = () => {
      tick();
      foreground = document.visibilityState === 'visible' && document.hasFocus();
      previous = Date.now();
      if (foreground) lastInput = previous;
    };
    const timer = window.setInterval(tick, 10_000);
    for (const event of ['pointerdown', 'keydown', 'wheel', 'reading:interaction']) window.addEventListener(event, input, true);
    window.addEventListener('focus', visibility);
    window.addEventListener('blur', visibility);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', tick);
    return () => {
      tick(); tickRef.current = null; window.clearInterval(timer);
      for (const event of ['pointerdown', 'keydown', 'wheel', 'reading:interaction']) window.removeEventListener(event, input, true);
      window.removeEventListener('focus', visibility); window.removeEventListener('blur', visibility);
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', tick);
    };
  }, [bookId, enabled]);
  return onPosition;
}
