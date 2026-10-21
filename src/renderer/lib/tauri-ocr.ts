import { convertOcr } from '@core/ocr/convert';
export { convertOcr } from '@core/ocr/convert';
import type { BookRecord, ComicPage } from '@shared/types';
type Native = (channel: string, ...args: unknown[]) => Promise<any>;
export interface PendingOcr { token: string; book: BookRecord & { pages: ComicPage[] }; raw: (string | null)[]; old: unknown; provider: string }

export class TauriOcr {
  private active = new Map<string, Promise<void>>();
  constructor(private native: Native) {}
  async finalize(): Promise<void> {
    const pending = await this.native('ocr:pending') as PendingOcr | null;
    if (!pending) return;
    const existing = this.active.get(pending.token); if (existing) return existing;
    const work = (async () => {
      let payload: unknown;
      try { payload = convertOcr(pending); } catch (error) { payload = { error: String(error) }; }
      await this.native('ocr:commit', pending.token, payload);
    })();
    this.active.set(pending.token, work);
    try { await work; } finally { this.active.delete(pending.token); }
  }
}
