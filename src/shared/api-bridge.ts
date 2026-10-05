/** Desktop API mapping used by Tauri. No Node imports. */
import { IPC, type AraleApi } from './ipc';

export interface ApiTransport {
  invoke: (channel: string, ...args: unknown[]) => Promise<any>;
  assetUrl: AraleApi['book']['assetUrl'];
  on: AraleApi['on'];
  off: AraleApi['off'];
  notify: AraleApi['notify'];
}

export function createAraleApi(transport: ApiTransport): AraleApi {
  return {
    app: {
      buildInfo: () => transport.invoke(IPC.appBuildInfo),
      checkUpdate: () => transport.invoke(IPC.appCheckUpdate),
      openRelease: (tag) => transport.invoke(IPC.appOpenRelease, tag),
    },
    annotations: {
      read: (bookId) => transport.invoke(IPC.annotationsRead, bookId),
      write: (bookId, document) => transport.invoke(IPC.annotationsWrite, bookId, document),
    },
    window: {
      setImmersive: (enabled, systemBarsVisible = false) => transport.invoke(IPC.windowSetImmersive, enabled, systemBarsVisible),
    },
    library: {
      info: () => transport.invoke(IPC.libraryInfo),
      list: (query) => transport.invoke(IPC.libraryList, query),
      importPaths: (paths) => transport.invoke(IPC.libraryImport, paths),
      importViaDialog: (kind) => transport.invoke(IPC.libraryImportDialog, kind),
      remove: (bookIds) => transport.invoke(IPC.libraryRemove, bookIds),
      open: (bookId) => transport.invoke(IPC.libraryOpen, bookId),
      savePosition: (position) => transport.invoke(IPC.librarySavePosition, position),
      updateMeta: (bookId, patch) => transport.invoke(IPC.libraryUpdateMeta, bookId, patch),
      reveal: (bookId) => transport.invoke(IPC.libraryReveal, bookId),
    },
    book: {
      chapter: (bookId, spineIndex) => transport.invoke(IPC.chapterContent, bookId, spineIndex),
      pageText: (bookId, pageIndex) => transport.invoke(IPC.comicPageText, bookId, pageIndex),
      assetUrl: (bookId, rel) => transport.assetUrl(bookId, rel),
    },
    dict: {
      status: () => transport.invoke(IPC.dictStatus),
      importPaths: (zipPaths) => transport.invoke(IPC.dictImport, zipPaths),
      importViaDialog: () => transport.invoke(IPC.dictImportDialog),
      remove: (dictId) => transport.invoke(IPC.dictRemove, dictId),
      setEnabled: (dictId, enabled) => transport.invoke(IPC.dictSetEnabled, dictId, enabled),
      lookup: (text, charOffset) => transport.invoke(IPC.dictLookup, text, charOffset),
      segment: (text) => transport.invoke(IPC.dictSegment, text),
    },
    ocr: {
      capability: () => transport.invoke(IPC.ocrCapability),
      status: (bookId) => transport.invoke(IPC.ocrStatus, bookId),
      start: (bookId, options) => transport.invoke(IPC.ocrStart, bookId, options),
      cancel: (bookId) => transport.invoke(IPC.ocrCancel, bookId),
      queue: () => transport.invoke(IPC.ocrQueue),
      selectProvider: (provider) => transport.invoke(IPC.ocrSelectProvider, provider),
    },
    extensions: {
      list: () => transport.invoke(IPC.extensionsList),
      refresh: () => transport.invoke(IPC.extensionsRefresh),
      install: (id) => transport.invoke(IPC.extensionsInstall, id),
      cancel: (id) => transport.invoke(IPC.extensionsCancel, id),
      remove: (id) => transport.invoke(IPC.extensionsRemove, id),
      addRepository: (name, url) => transport.invoke(IPC.extensionsRepositoryAdd, name, url),
      removeRepository: (url) => transport.invoke(IPC.extensionsRepositoryRemove, url),
    },
    defaults: {
      read: () => transport.invoke(IPC.defaultsRead),
      write: (patch) => transport.invoke(IPC.defaultsWrite, patch),
    },
    cards: {
      list: (bookId) => transport.invoke(IPC.cardsList, bookId),
      add: (bookId, draft) => transport.invoke(IPC.cardsAdd, bookId, draft),
      update: (bookId, id, patch) => transport.invoke(IPC.cardsUpdate, bookId, id, patch),
      remove: (bookId, id) => transport.invoke(IPC.cardsRemove, bookId, id),
    },
    llm: {
      settings: () => transport.invoke(IPC.llmSettings),
      update: (patch) => transport.invoke(IPC.llmUpdate, patch),
      setApiKey: (profileId, apiKey) => transport.invoke(IPC.llmSetApiKey, profileId, apiKey),
      analyze: (request) => transport.invoke(IPC.llmAnalyze, request),
    },
    translation: {
      settings: () => transport.invoke(IPC.translationSettings),
      update: (patch) => transport.invoke(IPC.translationUpdate, patch),
      setSecret: (profileId, secret) => transport.invoke(IPC.translationSetSecret, profileId, secret),
      translate: (request) => transport.invoke(IPC.translationTranslate, request),
    },
    segment: {
      status: (bookId) => transport.invoke(IPC.segmentStatus, bookId),
      read: (bookId) => transport.invoke(IPC.segmentRead, bookId),
      start: (bookId, options) => transport.invoke(IPC.segmentStart, bookId, options),
      cancel: (bookId) => transport.invoke(IPC.segmentCancel, bookId),
      clear: (bookId) => transport.invoke(IPC.segmentClear, bookId),
    },
    study: {
      read: (bookId) => transport.invoke(IPC.studyRead, bookId),
      generate: (bookId) => transport.invoke(IPC.studyGenerate, bookId),
      cancel: (bookId) => transport.invoke(IPC.studyCancel, bookId),
      patch: (bookId, candidateId, patch) => transport.invoke(IPC.studyPatch, bookId, candidateId, patch),
      patchMany: (bookId, candidateIds, patch) => transport.invoke(IPC.studyPatchMany, bookId, candidateIds, patch),
      addPhrase: (bookId, ref, expression, reading) => transport.invoke(IPC.studyAddPhrase, bookId, ref, expression, reading),
      export: (bookId) => transport.invoke(IPC.studyExport, bookId),
      directFilter: (bookId, levels, includeUnknown, options) => transport.invoke(IPC.studyDirectFilter, bookId, levels, includeUnknown, options),
      runFilter: (bookId, request) => transport.invoke(IPC.studyRunFilter, bookId, request),
      applyCompletedFilter: (bookId) => transport.invoke(IPC.studyApplyCompletedFilter, bookId),
      clearFilterProgress: (bookId) => transport.invoke(IPC.studyClearFilterProgress, bookId),
      runCards: (bookId, request) => transport.invoke(IPC.studyRunCards, bookId, request),
      previewCards: (bookId, tier, fields) => transport.invoke(IPC.studyPreviewCards, bookId, tier, fields),
      exportManualAi: (bookId, request) => transport.invoke(IPC.studyManualAiExport, bookId, request),
      importManualAi: (bookId, kind, text) => transport.invoke(IPC.studyManualAiImport, bookId, kind, text),
      clearManualAi: (bookId, kind) => transport.invoke(IPC.studyManualAiClear, bookId, kind),
      revealManualAi: (bookId, kind) => transport.invoke(IPC.studyManualAiReveal, bookId, kind),
      clearCardProgress: (bookId) => transport.invoke(IPC.studyClearCardProgress, bookId),
      taskQueue: () => transport.invoke(IPC.studyTaskQueue),
      cancelTask: (id) => transport.invoke(IPC.studyTaskCancel, id),
      dismissTask: (id) => transport.invoke(IPC.studyTaskDismiss, id),
      setImageMode: (bookId, mode) => transport.invoke(IPC.studySetImageMode, bookId, mode),
      patchCard: (bookId, candidateId, patch) => transport.invoke(IPC.studyPatchCard, bookId, candidateId, patch),
      exportPackage: (bookId) => transport.invoke(IPC.studyExportPackage, bookId),
    },
    on: transport.on,
    off: transport.off,
    notify: transport.notify,
  };
}
