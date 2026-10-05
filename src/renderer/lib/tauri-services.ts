import { sha256 } from '@noble/hashes/sha2.js';
import { md5 } from '@noble/hashes/legacy.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { LlmService } from '@core/services/llm';
import { TranslationService } from '@core/services/translation';
import type { ServiceRuntime } from '@core/services/runtime';

type Kind = 'llm' | 'translation';
type Native = (channel: string, ...args: unknown[]) => Promise<any>;

/** One instance per Worker, retained across reader/settings views. Native owns credentials. */
export class TauriServices {
  private mutation: Promise<unknown> = Promise.resolve();
  private files = new Map<string, unknown>();
  private revisions = new Map<Kind, string>();
  private signatures = new Map<Kind, Record<string, string>>();
  private capabilityDirty = false;
  private capabilityWrites: Promise<unknown> = Promise.resolve();
  private llm: LlmService;
  private translation: TranslationService;
  private readonly runtime: ServiceRuntime = {
    readJson: <T>(file: string, fallback: T): T => structuredClone((this.files.get(file) ?? fallback) as T),
    writeJsonAtomic: (file, value) => {
      this.files.set(file, structuredClone(value));
      if (file === 'llm-output-capabilities.json') this.capabilityDirty = true;
    },
    hash: (algorithm, value) => bytesToHex((algorithm === 'sha256' ? sha256 : md5)(new TextEncoder().encode(value))),
    randomHex: size => bytesToHex(crypto.getRandomValues(new Uint8Array(size))),
    sibling: (_file, name) => name,
  };

  constructor(private readonly native: Native) {
    this.llm = new LlmService({ settingsFile: 'llm', runtime: this.runtime,
      signatureImpl: id => this.signatures.get('llm')?.[id] ?? null });
    this.translation = this.newTranslation();
  }

  private newTranslation(): TranslationService {
    return new TranslationService({ settingsFile: 'translation', runtime: this.runtime,
      signatureImpl: id => this.signatures.get('translation')?.[id] ?? null });
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.mutation.then(fn, fn); this.mutation = task.catch(() => undefined); return task;
  }

  private async load(kind: Kind): Promise<void> {
    const snapshot = await this.native('service:load', kind);
    if (kind === 'translation' && this.revisions.get(kind) !== snapshot.revision) this.translation = this.newTranslation();
    this.files.set(kind, snapshot.settings);
    this.revisions.set(kind, snapshot.revision);
    this.signatures.set(kind, snapshot.signatures);
    if (kind === 'llm' && !this.capabilityDirty) this.files.set('llm-output-capabilities.json', snapshot.capabilities);
  }

  private async flushCapabilities(): Promise<void> {
    if (!this.capabilityDirty) return;
    this.capabilityDirty = false;
    const records = structuredClone(this.files.get('llm-output-capabilities.json'));
    const revision = this.revisions.get('llm');
    const task = this.capabilityWrites.then(() => this.native('service:capabilities', revision, records));
    this.capabilityWrites = task.catch(() => undefined);
    await task;
  }

  private fetcher(kind: Kind, profileId: string | null, revision: string): typeof fetch {
    return async (input, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const id = crypto.randomUUID();
      const abort = () => { void this.native('service:cancel', id).catch(() => undefined); };
      init?.signal?.addEventListener('abort', abort, { once: true });
      try {
        const data = await this.native('service:http', { id, kind, profileId, revision,
          url: String(input), method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers)),
          body: init?.body?.toString() ?? '' });
        if (init?.signal?.aborted || data.aborted) throw new DOMException('Aborted', 'AbortError');
        const response = new Response(data.body, { status: data.status, headers: data.headers });
        Object.defineProperty(response, 'url', { value: data.url });
        return response;
      } finally { init?.signal?.removeEventListener('abort', abort); }
    };
  }

  async request(channel: string, args: any[]): Promise<unknown> {
    try { return await this.dispatch(channel, args); }
    catch (error) {
      if (channel === 'llm:analyze' || channel === 'llm:complete') {
        return { ok: false, text: '', profileName: '', model: '', error: String(error) };
      }
      if (channel === 'translation:translate') {
        return { ok: false, text: '', profileName: '', provider: '', sourceReading: '', sourceLanguage: '', targetLanguage: '', error: String(error) };
      }
      throw error;
    }
  }

  private async dispatch(channel: string, args: any[]): Promise<unknown> {
    const kind: Kind = channel.startsWith('llm:') ? 'llm' : 'translation';
    const action = channel.slice(channel.indexOf(':') + 1);
    if (action === 'analyze' || action === 'complete' || action === 'translate') {
      const captured = await this.serialize(async () => {
        await this.load(kind);
        const settings = kind === 'llm' ? this.llm.settings() : this.translation.settings();
        const profileId = args[0]?.profileId ?? settings.activeProfileId;
        if (args[0]?.expectedProfileSignature && this.signatures.get(kind)?.[profileId] !== args[0].expectedProfileSignature)
          throw new Error('服务配置已变化，请重新提交任务');
        return { stored: structuredClone(this.files.get(kind)), revision: this.revisions.get(kind)!,
          profileId, translation: this.translation };
      });
      const fetchImpl = this.fetcher(kind, captured.profileId, captured.revision);
      // Each LLM call gets immutable settings; all calls share the service's semaphore via a
      // contextual fetch adapter instead of changing its options during an in-flight request.
      if (kind === 'llm') {
        const service = this.llm;
        return this.withLlmSnapshot(service, captured.stored, fetchImpl, action, args[0]);
      }
      return captured.translation.translate({ ...args[0], fetchImpl: fetchImpl, settingsSnapshot: captured.stored });
    }
    return this.serialize(async () => {
      await this.load(kind);
      const service = kind === 'llm' ? this.llm : this.translation;
      if (action === 'settings') return service.settings();
      if (action === 'setApiKey' || action === 'setSecret') {
        await this.native('service:secret', kind, args[0], args[1], this.revisions.get(kind));
      } else if (action === 'update') {
        service.update(args[0]);
        const settings: any = structuredClone(this.files.get(kind));
        const credentials: Record<string, string> = {};
        if (kind === 'llm') for (const profile of args[0]?.profiles ?? []) {
          if (Object.hasOwn(profile, 'apiKey')) credentials[profile.id] = typeof profile.apiKey === 'string' ? profile.apiKey : '';
        }
        for (const profile of settings.profiles) delete profile[kind === 'llm' ? 'apiKey' : 'secret'];
        await this.native('service:save', kind, settings, credentials, this.revisions.get(kind));
      } else throw new Error(`未知服务操作：${channel}`);
      this.capabilityDirty = false;
      await this.load(kind);
      return (kind === 'llm' ? this.llm : this.translation).settings();
    });
  }

  private async withLlmSnapshot(service: LlmService, stored: unknown, fetchImpl: typeof fetch, action: string, request: any) {
    try {
      return action === 'complete' ? await service.complete({ ...request, fetchImpl: fetchImpl, settingsSnapshot: stored })
        : await service.analyze({ ...request, fetchImpl: fetchImpl, settingsSnapshot: stored });
    } finally {
      // A failed capability-cache write must not discard a successful paid response.
      try { await this.flushCapabilities(); } catch (error) { console.warn('[arale] capability cache', error); }
    }
  }
}
