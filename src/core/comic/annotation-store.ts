import type { AnnotationSnapshot, ComicAnnotations } from '../../shared/annotations';
import { emptyAnnotations } from './annotations';

export interface AnnotationTransport {
  read(bookId: string): Promise<AnnotationSnapshot>;
  write(bookId: string, document: ComicAnnotations): Promise<AnnotationSnapshot>;
}

export interface AnnotationState extends AnnotationSnapshot { status: 'loading' | 'saved' | 'saving' | 'error'; error: string; undo: boolean; redo: boolean; loaded: boolean; }
/** 阅读器卸载/OCR 重建期间也继续保存；同一书的写请求严格串行。 */
export class AnnotationStore {
  state: AnnotationState = { document: emptyAnnotations(), stalePages: [], status: 'loading', error: '', undo: false, redo: false, loaded: false };
  private listeners = new Set<() => void>();
  private past: ComicAnnotations[] = [];
  private future: ComicAnnotations[] = [];
  private sequence = 0;
  private savedSequence = 0;
  private inFlight = false;
  constructor(private bookId: string, private transport: AnnotationTransport) { void this.reload(); }
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = (): AnnotationState => this.state;
  private emit(next: Partial<AnnotationState>): void {
    this.state = { ...this.state, ...next, undo: !!this.past.length, redo: !!this.future.length };
    for (const fn of this.listeners) fn();
  }
  pending(): boolean { return this.sequence !== this.savedSequence; }
  async reload(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    const wasLoaded = this.state.loaded;
    this.emit({ status: 'loading', error: '', loaded: false });
    try {
      const value = await this.transport.read(this.bookId);
      this.past = []; this.future = []; this.sequence = this.savedSequence = 0;
      this.emit({ ...value, status: 'saved', loaded: true });
    } catch (error) { this.emit({ status: 'error', error: String(error), loaded: wasLoaded }); }
    finally { this.inFlight = false; }
  }
  commit(document: ComicAnnotations, history = true): void {
    if (!this.state.loaded || document === this.state.document) return;
    if (history) { this.past = [...this.past.slice(-49), this.state.document]; this.future = []; }
    this.sequence++;
    this.emit({ document: { ...document, revision: this.state.document.revision }, status: 'saving', error: '' });
    void this.save();
  }
  undo(): void {
    if (!this.state.loaded) return;
    const old = this.past.pop(); if (!old) return;
    this.future.push(this.state.document); this.commit(old, false);
  }
  redo(): void {
    if (!this.state.loaded) return;
    const next = this.future.pop(); if (!next) return;
    this.past.push(this.state.document); this.commit(next, false);
  }
  async save(): Promise<void> {
    if (this.inFlight || !this.pending()) return;
    this.inFlight = true;
    const sequence = this.sequence, document = this.state.document;
    this.emit({ status: 'saving', error: '' });
    try {
      const saved = await this.transport.write(this.bookId, document);
      this.savedSequence = sequence;
      this.emit({ document: sequence === this.sequence ? saved.document : { ...this.state.document,
        revision: saved.document.revision, pages: { ...this.state.document.pages, ...saved.document.pages } }, stalePages: saved.stalePages,
        status: this.pending() ? 'saving' : 'saved' });
      this.inFlight = false;
      if (this.pending()) void this.save();
    } catch (error) { this.inFlight = false; this.emit({ status: 'error', error: error instanceof Error ? error.message : String(error) }); }
  }
}
