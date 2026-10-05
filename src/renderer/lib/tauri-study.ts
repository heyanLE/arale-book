import { StudyService, chooseMeaning } from '@core/study/service';
import { StudyTaskQueue } from '@core/study/task-queue';
import { buildAnkiPackage, type AnkiDatabase } from '@core/study/apkg';
import { createJlptIndex, type JlptRow } from '@core/study/jlpt';
import type { StudyRuntime } from '@core/study/runtime';
import type { BookRecord, BookSegments, DictTerm, StudyCandidate, StudyTaskEntry, StudyTaskQueueState } from '@shared/types';
import { gunzipSync, strFromU8 } from 'fflate';
import jlptData from '../../../data/jlpt-vocabulary.json';
import frequencyUrl from '../../../data/ja-wordfreq-3.1.1.json.gz?url';
import { tokenizeJapanese } from './tauri-tokenizer';
import { TauriServices } from './tauri-services';

type Native = (channel: string, ...args: unknown[]) => Promise<any>;
interface Snapshot { book: BookRecord; segments: BookSegments | null; list: unknown; revision: string; source: string; dictionary: string }
const encode = (value: string | Uint8Array): string => {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
};
const decode = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));

/** One Worker across views. Native rejects writes from a replaced Worker/session. */
export class TauriStudy {
  private readonly owner = crypto.randomUUID();
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly files = new Map<string, unknown>();
  private readonly terms = new Map<string, DictTerm[]>();
  private readonly operations = new Set<string>();
  private readonly failures = new Map<string, unknown>();
  private persistenceError: unknown;
  private readonly signatures: Record<'llm' | 'translation', Record<string, string>> = { llm: {}, translation: {} };
  private readonly captures = new Map<string, { llm: Record<string,string>; translation: Record<string,string> }>();
  private recent: StudyTaskEntry[] = [];
  private writes: Promise<void> = Promise.resolve();
  private initializePromise: Promise<void> | null = null;
  private frequency: Record<string, number> | null = null;
  private study: StudyService;
  private queue: StudyTaskQueue;
  private services: TauriServices;
  private readonly tokens = new Map<string, Awaited<ReturnType<typeof tokenizeJapanese>>>();
  private readonly runtime: StudyRuntime = {
    readJson: <T>(file: string, fallback: T): T => structuredClone((this.files.get(file) ?? fallback) as T),
    writeJsonAtomic: (file, value) => {
      const id = file.split('/')[1]!;
      if (file !== `book/${id}/study-list.json`) throw new Error('非法学习文件');
      const copy = structuredClone(value) as any;
      // Translate virtual export paths before the first checkpoint: reload must never
      // leave a completed MD session pointing to an expired native grant token.
      if (id === this.exportBook && this.exportGrant) {
        for (const session of Object.values(copy.workflow?.manualAi ?? {}) as any[]) {
          if (session?.directory?.startsWith(`export/${this.exportGrant.token}/`))
            session.directory = session.directory.replace(`export/${this.exportGrant.token}`, this.exportGrant.path.replace(/\\/g, '/'));
        }
      }
      this.files.set(file, copy);
      this.schedule(async () => {
        this.check(id);
        const snapshot = this.snapshots.get(id)!;
        const result = await this.native('study:commit', this.owner, id, snapshot, copy);
        snapshot.revision = result.revision; snapshot.list = copy;
      }, id);
    },
    writeFileAtomic: (file, value) => {
      const [,token,...path] = file.split('/');
      if (!file.startsWith('export/') || !token) throw new Error('请先选择导出位置');
      const data = encode(value);
      // Export bytes are persisted before the subsequent exportedAt/session checkpoint.
      this.schedule(() => this.native('study:writeExport', this.owner, token, path.join('/'), data), this.exportBook);
    },
    join: (...parts) => parts.join('/'), bookDir: id => `book/${id}`, mkdir: () => undefined,
    jlpt: () => ({ index: this.jlptIndex, source: `stephenmk/yomitan-jlpt-vocab@${jlptData.revision}` }),
    wordfreqSource: () => this.frequency ? 'wordfreq@3.1.1/ja-large' : null,
    zipfForCandidate: candidate => this.zipf(candidate),
    tokenizeJapanese: async text => {
      let value = this.tokens.get(text); if (!value) { value = await tokenizeJapanese(text); this.tokens.set(text,value); }
      return value;
    },
    yield: async () => { await this.flush(); await new Promise(resolve => setTimeout(resolve,0)); },
    crop: (id, occurrence) => this.image(id, occurrence, 'crop'),
    pageImage: (id, occurrence) => this.image(id, occurrence, 'page'),
    validateSource: (id, occurrence) => this.native('study:image',this.owner,id,occurrence,'validate'),
    buildPackage: async (id,title,tier,inputs) => {
      const native = this.native, owner = this.owner;
      class Database implements AnkiDatabase {
        private commands: Array<{sql:string;params?:Array<string|number|null>}> = [];
        private bytes: Uint8Array | null = null;
        run(sql:string,params?:Array<string|number|null>) { this.commands.push({sql,params}); }
        async exec(sql:string) {
          if(sql !== 'PRAGMA integrity_check') throw new Error('不支持的 Anki SQL');
          this.bytes = decode(await native('study:sqlite',owner,this.commands));
          return [{values:[['ok']]}];
        }
        export() { if(!this.bytes) throw new Error('Anki SQLite 尚未校验'); return this.bytes; }
        close() { this.commands = []; this.bytes = null; }
      }
      return buildAnkiPackage(id,title,tier,inputs,async()=>({Database}));
    },
  };
  private readonly jlptIndex = createJlptIndex(jlptData.entries as JlptRow[]);
  private exportBook: string | undefined;
  private exportGrant: {token:string;path:string} | undefined;

  constructor(private readonly native: Native) {
    this.services = new TauriServices((channel,...args) => channel==='service:http'
      ? native(channel,{...args[0] as object,studyOwner:this.owner}) : native(channel,...args));
    this.study = new StudyService({
      getBook: id => this.snapshots.get(id)?.book ?? null,
      getSegments: id => this.snapshots.get(id)?.segments ?? null,
      ensureDictionary: () => this.ensureDictionary(),
      lookupTerms: expression => this.terms.get(expression) ?? [],
      lookupMeaning: (expression,reading) => chooseMeaning((this.terms.get(expression) ?? []).map(term=>({term})),expression,reading),
      progress: (bookId,done,total) => this.publish('study:progress',{bookId,done,total}),
      workflowProgress: progress => { this.queue.onProgress(progress); this.publish('study:workflow-progress',progress); },
      llm: { profileSignature: id => this.signatures.llm[id] ?? null, complete: async request => {
        await this.flush(); return this.services.request('llm:complete',[request]) as any;
      } },
      translation: { profileSignature: id => this.signatures.translation[id] ?? null, translate: async request => {
        await this.flush();
        const signature = this.signatures.translation[request.profileId ?? ''];
        const latest = await this.native('service:load','translation');
        if (signature && latest.signatures[request.profileId ?? ''] !== signature) throw new Error('翻译配置已变化，请重新提交');
        return this.services.request('translation:translate',[{...request, expectedProfileSignature: signature}]) as any;
      } },
    },this.runtime);
    this.queue = new StudyTaskQueue({
      study: {
        read: id => this.study.read(id), cancel: id => this.study.cancel(id),
        runFilter: (id,request) => this.run(id,()=>this.study.runFilter(id,request)),
        runCards: (id,request) => this.run(id,()=>this.study.runCards(id,request)),
      },
      getBook: id => this.snapshots.get(id)?.book ?? null,
      profileSignature: id => this.signatures.llm[id] ?? null,
      translationSignature: id => this.signatures.translation[id] ?? null,
      onChange: queue => this.publish('study:queue',this.withRecent(queue)),
      onDone: task => {
        this.operations.delete(task.bookId); this.captures.delete(task.bookId);
        this.publish('study:done',task);
        this.schedule(()=>this.native('study:lease',this.owner,task.bookId,false));
      },
    });
  }
  private async initialize(): Promise<void> {
    this.initializePromise ??= (async()=>{
      const state = await this.native('study:initialize',this.owner);
      this.recent = state.recent;
      try {
        const data = JSON.parse(strFromU8(gunzipSync(new Uint8Array(await (await fetch(frequencyUrl)).arrayBuffer()))));
        if (data.source==='wordfreq' && data.version==='3.1.1' && data.language==='ja' && data.wordlist==='large' && data.entries && typeof data.entries==='object') this.frequency=data.entries;
      } catch(error) { console.warn('[arale] wordfreq unavailable',error); }
    })();
    return this.initializePromise;
  }
  private schedule(fn:()=>Promise<unknown>,id?:string): void {
    const task = this.writes.then(async()=>{ if(id) this.check(id); await fn(); });
    this.writes = task.then(()=>undefined,error=>{
      if(id) { this.failures.set(id,error); this.study.cancel(id); }
      else { this.persistenceError=error; for(const bookId of this.operations) this.study.cancel(bookId); }
      console.error('[arale] study persistence',error);
    });
  }
  private async flush(id?:string): Promise<void> {
    let previous: Promise<void>; do { previous=this.writes; await previous; } while(previous!==this.writes);
    if(id) this.check(id);
  }
  private check(id:string): void { if(this.persistenceError) throw this.persistenceError; if(this.failures.has(id)) throw this.failures.get(id); }
  private publish(channel:string,payload:unknown): void {
    const copy=structuredClone(payload); this.schedule(()=>this.native('study:publish',this.owner,channel,copy));
  }
  private withRecent(queue:StudyTaskQueueState): StudyTaskQueueState { return {...queue,recent:[...queue.recent,...this.recent].slice(0,20)}; }
  private async load(id:string): Promise<void> {
    const snapshot: Snapshot = await this.native('study:snapshot',this.owner,id);
    this.snapshots.set(id,snapshot); this.files.set(`book/${id}/study-list.json`,snapshot.list); this.failures.delete(id);
  }
  private async profiles(): Promise<void> {
    const [llm,translation] = await Promise.all([this.native('service:load','llm'),this.native('service:load','translation')]);
    this.signatures.llm=llm.signatures; this.signatures.translation=translation.signatures;
  }
  private async ensureDictionary(): Promise<void> {
    const expressions = new Set<string>();
    for (const snapshot of this.snapshots.values()) {
      for(const candidate of this.study.read(snapshot.book.id)?.candidates ?? []) expressions.add(candidate.expression);
      for(const unit of snapshot.segments?.units ?? []) {
        for(const token of await this.runtime.tokenizeJapanese(unit.text)) expressions.add(token.lemma && token.lemma!=='*' ? token.lemma : token.surface);
      }
    }
    const terms: Record<string,DictTerm[]> = await this.native('dict:studyEvidence',[...expressions]); this.terms.clear();
    for(const [expression,rows] of Object.entries(terms)) this.terms.set(expression,rows);
  }
  private async run<T>(id:string,fn:()=>Promise<T>):Promise<T> {
    const captured=this.captures.get(id)!;
    try {
      await this.flush(id); await this.profiles();
      for(const kind of ['llm','translation'] as const) for(const key of Object.keys(captured[kind])) {
        if(this.signatures[kind][key]!==captured[kind][key]) throw new Error('排队期间服务配置已变化，请重新提交');
      }
      const result=await fn(); await this.flush(id); return result;
    }
    catch(error) { await this.flush(); this.check(id); throw error; }
    finally { this.operations.delete(id); this.captures.delete(id); }
  }
  private async image(id:string,occurrence:unknown,mode:string) {
    await this.flush(id); const image=await this.native('study:image',this.owner,id,occurrence,mode);
    return {name:image.name,data:decode(image.data)};
  }
  private zipf(candidate:StudyCandidate):number|null|undefined {
    if(!this.frequency) return undefined;
    const forms=new Set([candidate.expression,candidate.expression.normalize('NFKC')]);
    for(const occurrence of candidate.occurrences) { const surface=occurrence.text.slice(occurrence.start,occurrence.end); if(surface){ forms.add(surface); forms.add(surface.normalize('NFKC')); } }
    let result:number|null=null;
    for(const form of forms){const value=this.frequency[form];if(typeof value==='number' && Number.isFinite(value)) result=Math.max(result ?? value,value);}
    return result;
  }
  async request(channel:string,args:any[]):Promise<unknown> {
    await this.initialize();
    const id=args[0] as string;
    switch(channel) {
      case 'study:initialize': return null;
      case 'study:taskQueue': await this.flush(); return this.withRecent(this.queue.queueState());
      case 'study:cancel': this.study.cancel(id); return null;
      case 'study:taskCancel': this.queue.cancel(id); await this.flush(); return null;
      case 'study:taskDismiss': this.recent=this.recent.filter(task=>task.id!==id); this.queue.dismiss(id); this.publish('study:queue',this.withRecent(this.queue.queueState())); await this.flush(); return null;
      case 'study:read':
        if(!this.operations.has(id) && !this.queue.isBusy(id)) await this.load(id);
        await this.flush(id); return this.study.read(id);
    }
    if(this.queue.isBusy(id) && (channel==='study:runFilter' || channel==='study:runCards')) {
      const entry=channel==='study:runFilter'?this.queue.enqueueFilter(id,args[1]):this.queue.enqueueCards(id,args[1]);
      await this.flush(id); return entry;
    }
    if(this.operations.has(id) || this.queue.isBusy(id)) throw new Error('这本书已有学习任务，请等待或先取消');
    this.operations.add(id);
    let leased=false,queued=false;
    try {
      await this.native('study:lease',this.owner,id,true); leased=true;
      await this.flush(); await this.load(id); await this.profiles();
      if(channel==='study:runFilter' || channel==='study:runCards') {
        const capture = {llm:{},translation:{}} as {llm:Record<string,string>;translation:Record<string,string>};
        if(args[1].profileId && this.signatures.llm[args[1].profileId]) capture.llm[args[1].profileId]=this.signatures.llm[args[1].profileId]!;
        if(args[1].translationProfileId && this.signatures.translation[args[1].translationProfileId]) capture.translation[args[1].translationProfileId]=this.signatures.translation[args[1].translationProfileId]!;
        this.captures.set(id,capture);
        const task=channel==='study:runFilter' ? this.queue.enqueueFilter(id,args[1]) : this.queue.enqueueCards(id,args[1]);
        queued=true; await this.flush(id); return task;
      }
      let result:unknown;
      switch(channel) {
        case 'study:generate': result=await this.study.generate(id); break;
        case 'study:previewCards': result=await this.study.previewCards(id,args[1],args[2]); break;
        case 'study:patch': result=this.study.patch(id,args[1],args[2]); break;
        case 'study:patchMany': result=this.study.patchMany(id,args[1],args[2]); break;
        case 'study:addPhrase': result=this.study.addPhrase(id,args[1],args[2],args[3]); break;
        case 'study:directFilter': result=this.study.directFilter(id,args[1],args[2],args[3]); break;
        case 'study:applyCompletedFilter': result=this.study.applyCompletedFilter(id); break;
        case 'study:clearFilterProgress': result=this.study.clearFilterProgress(id); break;
        case 'study:manualAiImport': result=this.study.importManualAi(id,args[1],args[2]); break;
        case 'study:manualAiClear': result=this.study.clearManualAi(id,args[1]); break;
        case 'study:manualAiReveal': result=await this.native(channel,this.owner,id,args[1]); break;
        case 'study:clearCardProgress': result=this.study.clearCardProgress(id); break;
        case 'study:setImageMode': result=this.study.setImageMode(id,args[1]); break;
        case 'study:patchCard': result=this.study.patchCard(id,args[1],args[2]); break;
        case 'study:manualAiExport': case 'study:export': case 'study:exportPackage': {
          if(this.exportBook) throw new Error('另一本书正在导出，请稍后重试');
          const grant=await this.native('study:select',this.owner,channel==='study:manualAiExport'?'manualAi':channel==='study:export'?'text':'package');
          if(!grant) return channel==='study:manualAiExport'?null:{path:null,count:0};
          this.exportBook=id;
          this.exportGrant=grant;
          try { result=channel==='study:manualAiExport'?await this.study.exportManualAi(id,args[1],`export/${grant.token}`):
            {path:grant.path,count:channel==='study:export'?this.study.exportText(id,`export/${grant.token}`):await this.study.exportPackage(id,`export/${grant.token}`)};
            await this.flush(id);
            if(channel==='study:manualAiExport') {
              result=this.study.read(id)!;
            }
          } finally {await this.flush(); await this.native('study:releaseExport',this.owner,grant.token);this.exportBook=undefined;this.exportGrant=undefined;} break;
        }
        default: throw new Error(`未知制卡调用：${channel}`);
      }
      await this.flush(id); return result;
    } catch(error) {
      await this.flush(); if(!queued) await this.load(id); throw error;
    } finally {
      if(!queued) { this.operations.delete(id); this.captures.delete(id); if(leased) await this.native('study:lease',this.owner,id,false); }
    }
  }
}
