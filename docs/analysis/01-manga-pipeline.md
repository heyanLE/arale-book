# 01 — Fushi/Hibiki Comic & Manga Pipeline: Import → Storage → Reader → OCR Overlays

Read-only analysis of `/Users/heyanle/Desktop/project/Fushi` @ working tree. Every non-obvious
claim carries a `path/file.dart:LINE` reference. Where a fact could not be established the text
says **not found**.

Terminology used below:
- **mokuro payload** = the shared in-memory + on-disk page/block model
  (`MokuroPayload` / `MokuroImage` / `MokuroBlock`, `mokuro_payload.dart`).
- **`.mokuro`** = mokuro v0.2+ producer JSON (external tool / mokuro.moe).
- **`manga.json`** = the app's own serialization of the same model; the single on-disk truth the
  reader reads back (`mangaPayloadToJson`, `mokuro_payload.dart:323`).
- **manga book** = a row in `EpubBooks` with `format = 'manga'` — the "third kind of book"
  (`packages/fushi_core/lib/src/database/tables.dart:471-L476`).

---

## 1. Entry points

All paths converge on three `MangaImporter` entry functions. Everything else is classification UI.

### 1.1 The three importers (the choke points)

| Entry function | Input | file:line |
|---|---|---|
| `MangaImporter.importFromMokuroPath` | `.mokuro` file + sibling page images | `packages/fushi_engine/lib/media/manga/manga_importer.dart:219` |
| `MangaImporter.importFromImageFolder` | bare folder of page images (no text) | `packages/fushi_engine/lib/media/manga/manga_importer.dart:81` |
| `MangaImporter.importFromMangaJson` | internal `manga.json` + image root | `packages/fushi_engine/lib/media/manga/manga_importer.dart:300` |

Both `importFromMokuroPath` and `importFromMangaJson` funnel into the two-pass kernel
`_copyAndInsert` (`manga_importer.dart:344`); `importFromImageFolder` builds an **empty-OCR**
payload first via `payloadFromImageFolder` (`manga_importer.dart:112`) and then calls the same
kernel (call site `manga_importer.dart:94`). The doc comment is explicit that OCR blocks start
empty and "an OCR failure therefore never removes the book" (`manga_importer.dart:78-L80`).

### 1.2 Drag-and-drop (desktop + surfaces)

1. Classification constants live in `fushi/lib/src/media/drag_drop/drop_classification.dart`.
   `kDragMangaExtensions = {mokuro, cbz, cbr, rar, cb7}` (`drop_classification.dart:91-L97`).
   `.zip` is deliberately **not** in it — it is ambiguous with Yomitan dictionary packs and goes
   through `kDragImageArchiveProbeExtensions = {zip}` (`drop_classification.dart:107-L109`).
2. `classifyDroppedFiles` (`drop_classification.dart:224`) is a pure function taking two injected
   predicates: `isDirectory` and `isImageArchive` (`drop_classification.dart:226-L227`).
   Directories go to both `directories` **and** `mangas` (`drop_classification.dart:250-L254`);
   probed `.zip` goes to `mangas` only (`drop_classification.dart:261-L266`).
3. The expensive probe runs in a background isolate to avoid a synchronous unzip on the drop
   callback — `probeDroppedImageArchives` → `Isolate.run(() => MangaModule.isImageArchive(path))`
   (`fushi/lib/src/media/drag_drop/image_archive_probe.dart:66`; rationale
   `image_archive_probe.dart:12-L20`).
4. The shelf drop callback builds `DroppedFiles` and calls `decideDropIntent`
   (`fushi/lib/src/pages/implementations/reader_history/books.part.dart:1235` and `:1251`).
   `DropSurface.books`/`manga` + `files.mangas` non-empty → `DropIntent.importNewManga`
   (`fushi/lib/src/media/drag_drop/drop_decision.dart:64` and `:87`).
5. The intent is executed by opening the manga import dialog with the first manga path
   (`books.part.dart:1283-L1290`), gated on the manga module being enabled
   (`books.part.dart:1284-L1287`).
6. The video surface explicitly ignores manga intents (`home_video_page.dart:1812`).

### 1.3 File picker / import dialog

- `MangaImportDialog` resolves the carrier via `ImportCarrierResolver` with the manga-native
  predicates injected (`fushi/lib/src/media/manga/manga_import_dialog.dart:83-L89`), and its
  `initState` re-classifies whatever the upstream prefilled (`manga_import_dialog.dart:95-L112`).
- The dispatch switch is `manga_import_dialog.dart:434-L470`: `mangaFolder → importImageFolder`,
  `mangaMokuro → importMokuro`, `mangaArchive → importArchive`, `mangaBatchFolder → batch`,
  `pdf → importPdfAsManga`.
- Carrier taxonomy: `ImportCarrier` enum, `fushi/lib/src/media/import/import_carrier.dart:11-L57`.
  The single-source file-extension set is `kMangaCarrierFileExtensions = {.mokuro, .cbz, .cbr,
  .rar, .cb7, .zip, .epub, .pdf}` (`import_carrier.dart:104-L113`).

### 1.4 The facade

All UI callers go through `MangaModule` (`fushi/lib/src/media/manga/manga_module.dart:23`):
`canImportPath` (`:24`), `importMokuro` (`:27`), `isImageArchive` (`:42`), `importBatchFolder`
(`:55`), `importImageFolder` (`:68`), `importPdfAsManga` (`:85`), `importArchive` (`:103`),
`openOcrImportWizard` (`:124`), `openBookOcr` (`:157`), `openOnlineCatalog` (`:190`).
`openBookOcr` is currently the reader-external OCR trigger for an already-shelved local volume
(`fushi/lib/src/media/manga/library/manga_series_page.dart:1265-L1279`).

### 1.5 Batch folder (a directory full of per-volume carriers)

`importMangaBatchFolder` iterates carrier files and imports each as its own book
(`fushi/lib/src/media/manga/import/manga_folder_batch.dart:99`), calling
`MangaImporter.importFromMokuroPath` per volume (`manga_folder_batch.dart:152`). Motivation is
BUG-1649: a folder of `epub`/`cbz`/`.mokuro` used to be misread as a page-image folder and failed
with `Manga image folder has no pages` (`import_carrier.dart:20-L32`).

### 1.6 Online chapter download / discovery / mokuro.moe

- Online shelf entry creation writes a placeholder `{"pages":[]}` `manga.json` plus an optional
  `cover.<ext>` in `<bookDir>` (`fushi/lib/src/media/manga/library/online_manga_library_service.dart:124-L159`).
- Per-chapter download writes `<bookDir>/chapters/<digest>/manga.json` +
  `images/*` (`fushi/lib/src/media/manga/download/manga_download_service.dart:665-L687`).
- mokuro.moe volume download: fetch `.mokuro` → fetch `.cbz` (`.part` resume) → unpack into
  `extract/` → place `<volume>.mokuro` → `importFromMokuroPath` with
  `DuplicatePolicy.skip()` (`fushi/lib/src/media/manga/online/mokuro_moe_volume_downloader.dart:160-L232`).
- Source-library scanning (remote/local roots) uses the shared foldering rule and then imports:
  `planMangaFolders` (`fushi/lib/src/media/source_library/source_library_scanner.dart:429`),
  `.mokuro` → `importFromMokuroPath` (`:794` and `:960`), bare image folders →
  `importFromImageFolder` (`:826`).
- Discovery import (a downloaded image archive) routes to `MangaModule.importArchive`
  (`fushi/lib/src/media/discovery/import/discovery_import_production.dart:109`).

### 1.7 Format conversion ("rebuild" an existing book into a manga)

`fushi/lib/src/media/manga/book_format_rebuild.dart` rasterizes PDF pages or copies EPUB spine
images into a staging dir, then runs the **same** `payloadFromImageFolder` /
`planMangaDestRels` / `copyMangaArtifacts` trio as the importer
(`book_format_rebuild.dart:262-L283`), and finally `updateEpubBookFormat(...)` with
`mangaReadingMode: null` (`book_format_rebuild.dart:204-L217`). The doc comment on
`payloadFromImageFolder` (`manga_importer.dart:105-L111`) exists precisely to keep import and
conversion byte-identical.

### 1.8 OCR wizard (post-import / pre-import OCR)

`MangaOcrWizardDialog` picks one of five engines (`MangaOcrEngineId`: localOnnx, systemOcr,
googleLens, externalMokuro, pairedHost — `fushi/lib/src/media/manga/ocr/manga_ocr_engine.dart:3-L15`),
runs it, then either imports the produced `manga.json`/`.mokuro` or, for an already-shelved book,
rewrites the book-root `manga.json` in place (`manga_ocr_wizard_dialog.dart:548-L635`).
The engine dependency set is assembled once in `MangaOcrWizardEngines.resolve`
(`fushi/lib/src/media/manga/manga_ocr_wizard_engines.dart:50-L73`) — a class whose only purpose is
to make it impossible for a future entry point to forget one runner (BUG-1418,
`manga_ocr_wizard_engines.dart:14-L29`).

### 1.9 Not an entry point

`fushi/lib/src/reader/reader_gallery_page.dart` is the **EPUB illustration gallery** (chapter-grouped
image grid extracted out of the EPUB reader chrome), not part of the manga pipeline:
`reader_gallery_page.dart:1-L2`, and grep for `manga`/`Manga` in the file returns nothing.

---

## 2. Supported formats & detection

### 2.1 The shared extension table

`packages/fushi_engine/lib/media/media_extensions.dart` is the single truth source for the image
base set:

```
kImageExtensionsBase = {.jpg, .jpeg, .png, .webp, .gif, .bmp}   media_extensions.dart:17-L24
```

Manga code aliases it instead of re-listing:

- Import: `const Set<String> kMangaImageExtensions = kImageExtensionsBase;`
  (`manga_importer.dart:24`).
- Whole-volume OCR: `const Set<String> kMangaOcrImageExtensions = kImageExtensionsBase;`
  (`packages/fushi_engine/lib/ocr/manga_ocr_folder_job.dart:47`).

This aliasing is the fix for BUG-1121: the two tables used to be hand-written and drifted, so a
`.bmp` comic imported fine but its bmp pages were silently skipped by OCR
(`media_extensions.dart:3-L5`, `manga_ocr_folder_job.dart:40-L46`). Guard test:
`fushi/test/ocr/manga_ocr_image_extensions_guard_test.dart`.

### 2.2 Archive / container extensions

| Extension | Treated as | Evidence |
|---|---|---|
| `.mokuro` | manifest (JSON) + sibling images | `kMokuroExtension` `manga_folder_plan.dart:27`; `drop_classification.dart:91-L97` |
| `.cbz` | ZIP image archive | `drop_classification.dart:91-L97`; zip path in `manga_archive_importer.dart:359-L430` |
| `.rar`, `.cbr`, `.cb7` | 7-Zip-extracted image archive | `_kSevenZipMangaArchiveExtensions` `fushi/lib/src/media/manga/import/manga_archive_importer.dart:88-L92` |
| `.zip` | **ambiguous** — probed by opening the package | `drop_classification.dart:107-L109`, `manga_archive_importer.dart:268-L336` |
| `.epub` | ambiguous — probed for "pure image EPUB" | `manga_archive_importer.dart:273-L275`, `isPureImageEpub` `:830-L850` |
| `.pdf` | manga-capable (rasterized) but not "manga domain" | `import_carrier.dart:83-L101`, `import_carrier.dart:104-L113` |
| `.tar`, `.tar.gz`, `.7z`, `.xz` | **not found** anywhere in the manga paths | — |

Case handling: `.mokuro` check uses `p.extension(path).toLowerCase() != '.mokuro'`
(`manga_importer.dart:41`); archive extension is lowercased before the 7z set test
(`manga_archive_importer.dart:347`); image extensions are compared lowercased
(`manga_importer.dart:60-L61`, `manga_ocr_folder_job.dart:124-L127`).

### 2.3 What the `looksLikeImageArchive` classifier decides

`MangaArchiveImporter.looksLikeImageArchive` (`manga_archive_importer.dart:268`):

1. RAR/CBR/CB7 → `true` immediately (`:270-L272`) — no content read.
2. `.epub` → `_looksLikeImageEpub` (image count > 0 then `EpubParser.parseSyncFromPath` +
   `_isPureImageEpub`) (`:273-L275`, `:784-L828`).
3. Otherwise stream-open the ZIP central directory (`_open`, `:897-L909`) and scan entries:
   - `index.json` at root → `hasDictionaryIndex`; any `*_bank_*` prefix → `hasDictionaryBank`
     (`:100-L106`, `:289-L296`);
   - `.mokuro` → `hasMokuro` (`:298-L301`);
   - image extension → `hasImage` (`:302-L303`);
   - `.opf/.xhtml/.html/.htm` → `hasMarkup` (`:304-L311`).
   - **Dictionary pack veto**: `index.json && any bank` → `false` (`:313-L326`); otherwise
     `hasImage && (hasMokuro || !hasMarkup)` (`:327-L330`).

`_validateEntry` rejects symbolic links, absolute paths, Windows drive prefixes and any `..`
segment (`:911-L920`).

---

## 3. Import & storage layout

### 3.1 Library root

`MangaStorage` deliberately reuses `EpubStorage` rather than creating a parallel root
(`packages/fushi_engine/lib/media/manga/manga_storage.dart:22-L33`):

- Root: `<appDocDir>/fushi_books/` (`packages/fushi_engine/lib/epub/epub_storage.dart:10`, `:30`,
  `:39`).
- Book dir: `<fushi_books>/<bookKey>/` where `bookKey = sanitizeTtuFilename(storedTitle)`
  (`manga_importer.dart:364`, `manga_storage.dart:46-L51`).
- `MangaStorage.kMangaJsonFileName = 'manga.json'` (`manga_storage.dart:39`) and
  `kImagesDirName = 'images'` (`manga_storage.dart:42`).

### 3.2 Two-pass import kernel (validate everything, then write)

Pass 1 — `planMangaDestRels` (`manga_importer.dart:156-L172`): for each payload page, sanitize the
`img_path` into relative segments (traversal is a hard failure:
`throw MangaImportException('Unsafe manga image path (traversal)')`,
`manga_storage.dart:66-L72`), de-duplicate case-insensitively
(`uniqueDestRel`, `manga_storage.dart:88-L112`), and assert the source file exists
(`manga_importer.dart:166-L169`). The reason for splitting pass 1 from pass 2 is stated at
`manga_importer.dart:152-L155`: the duplicate-title dialog must not fire before validation, or a
doomed import leaves an empty book directory plus a spurious prompt.

Pass 2 — `copyMangaArtifacts` (`manga_importer.dart:180-L210`):
- copies each page from `srcDir` to `<bookDir>/images/<destRel>` (`:194-L196`);
- rewrites `url` to the `destRel` (`:197-L199`);
- writes `<bookDir>/manga.json` with `jsonEncode(mangaPayloadToJson(...))`, `flush: true`
  (`:204-L207`);
- returns `(pageCount, coverRel)` where **`coverRel = destRels.first`** (`:209`).

`_copyAndInsert` (`:344`) then inserts the DB row and an `added` activity event, with rollback of
both the row and the book directory on any failure (`:416-L432`).

Sub-directory structure is preserved because `sanitizeRelSegments` keeps segments (only the leading
`images/` segment is stripped to avoid `images/images/...`) (`manga_storage.dart:57-L83`).

### 3.3 Mokuro page-root resolution (two coexisting conventions)

`resolveMokuroPageRoot` (`mokuro_payload.dart:178`) is the single decision point shared by the local
importer, the admission predicate and the remote-scanner mirror:

- convention A: `img_path` includes the volume prefix (`vol1/p001.jpg`) → root = `[]` (mokuro's
  own directory);
- convention B: bare filenames in a sub-directory named after the `.mokuro` stem → root =
  `[volumeName]`.

Candidates come from `mokuroPageRootCandidates` (`mokuro_payload.dart:202-L206`) and the same list is
reused to build the diagnostic "searched: ..." message at `manga_importer.dart:257-L264`.
BUG-1830: three consumers each hardcoded convention A, so every convention-B volume failed with a
misleading "Missing manga page image" (`mokuro_payload.dart:158-L177`).

### 3.4 Concrete on-disk tree (locally imported `.mokuro` volume)

```
<appDocDir>/fushi_books/
└── <bookKey>/                       # sanitizeTtuFilename(title)
    ├── manga.json                   # MokuroPayload serialized; EpubBooks.epubPath == "manga.json"
    └── images/
        ├── 001.jpg                  # url rewritten to "images/001.jpg"
        ├── 002.jpg
        └── vol1/                    # preserved img_path sub-structure
            └── 003.jpg              # url "images/vol1/003.jpg"
```

### 3.5 Concrete on-disk tree (online series + downloaded chapters)

```
<appDocDir>/fushi_books/
└── <bookKey>/
    ├── manga.json                   # placeholder '{"pages":[]}' for online shelf entries
    ├── cover.jpg                    # optional, fetched from the source
    └── chapters/
        └── <sha256(chapterKey)[:24]>/
            ├── manga.json           # pages[{url,width,height,blocks}]
            └── images/
                └── page-000001.jpg
```

Chapter layout + digest are defined once in
`packages/fushi_engine/lib/media/manga/manga_chapter_storage.dart:1-L20`:
`kMangaChaptersDirName = 'chapters'` (`:32`), `mangaChapterDigest = sha256(chapterKey)[:24]`
(`:37-L38`), digest shape guard `^[0-9a-f]{24}$` (`:43-L44`).
`readDownloadedChapterPayload` is the **only** "is this chapter downloaded" predicate: `manga.json`
exists + parses + `pages` non-empty + every page resolves through the traversal guard
(`:68-L89`).

### 3.6 Sidecar files / caches written next to the source

Whole-volume OCR writes inside the *scanned* directory, not the book directory
(`manga_ocr_folder_job.dart:310-L320`):

```
<scannedDir>/
└── manga_ocr_out/
    ├── manga.json                                  # kMangaOcrOutputFileName
    └── _pages/<engineSignature>/<page url with '/'→'__'>.json
```

`kMangaOcrOutDirName = 'manga_ocr_out'` (`:22`), `kMangaOcrPagesCacheDirName = '_pages'` (`:25`),
`kMangaOcrOutputFileName = 'manga.json'` (`:38`),
`ocrPageCacheFileName = '<relativeUrl with / → __>.json'` (`:162-L163`).
The enumerator skips the output directory so re-runs do not OCR their own artifacts
(`:146-L148`).

The per-page cache is keyed by **page name**, not page index, and stores a
`(source_path, source_size, source_modified_ms)` fingerprint so an edited page misses
(`MangaOcrFilePageCache.read/write`, `:184-L241`).

### 3.7 Cover

- Local import / conversion: the cover is the **first page's relative path** (`coverRel =
  destRels.first`, `manga_importer.dart:209`), stored in `EpubBooks.coverPath`
  (`manga_importer.dart:387`). The bookshelf resolves it as `p.join(extractDir, coverPath)`
  (`manga_importer.dart:72-L73`). No thumbnail is generated here.
- Online shelf entries: a real `cover.<ext>` file is fetched from the source; its bytes are
  validated (rejecting Cloudflare HTML with unknown magic), written atomically via
  `MediaCoverService.applyCoverBytes`, and only the **basename** is stored
  (`online_manga_library_service.dart:130-L160`). BUG-2496 rationale at `:136-L138`.
- Mining/Anki card image: the exact OCR-hit page file, with `ensureMangaCoverPng` copying a
  no-extension crop to `<name>.png` (`manga_fushi_page.dart:283-L298`).

### 3.8 `manga.json` write path is serialized + atomic

`fushi/lib/src/media/manga/manga_json_writeback.dart`:
- per-path in-process write lock, `runExclusiveOnMangaJson` (`:47-L62`);
- `writeMangaJsonAtomically` writes `<path>.tmp` then `rename` **directly over** the target — the
  comment forbids `delete()` first because that is the only step that breaks atomicity
  (`:64-L87`);
- the header enumerates the four call sites that must hold the lock (`:15-L25`).

---

## 4. Data model

### 4.1 In-memory / on-disk model (`packages/fushi_engine/lib/media/manga/mokuro_payload.dart`)

The whole of `mokuro_payload.dart` is 500 lines and every producer (`.mokuro`, internal ONNX OCR,
Google Lens, system OCR, mokuro.moe downloads) funnels into these four types.

| Type | Field | Type | Notes / file:line |
|---|---|---|---|
| `MokuroPayload` | `images` | `List<MokuroImage>` | sequential page order, `:21` |
| | `ocr` | `MangaOcrMetadata?` | optional producer metadata, `:24` |
| `MangaOcrMetadata` | `engine` | `String` | `:40` |
| | `engineSignature` | `String` | `:41` |
| | `schemaVersion` | `int` | `:42` |
| `MokuroImage` | `url` | `String` | always forward-slash, sub-dirs preserved, `:60`; `normalizeMangaUrl` `:153` |
| | `size` | `MokuroSize` | pixels **as reported by the producer**, never decoded, `:64` |
| | `blocks` | `List<MokuroBlock>` | `:67` |
| `MokuroBlock` | `rectangle` | `MokuroRect` | `box = [x1,y1,x2,y2]`, `:91` |
| | `isVertical` | `bool` | vertical Japanese text, `:95` |
| | `fontSize` | `double` | `:98` |
| | `zIndex` | `int` | stack priority; from array index when the producer has no field, `:102`, `:409-L411` |
| | `lines` | `List<String>` | `:105` |
| | `linesCoords` | `List<List<List<double>>>?` | per-line polygons; mokuro via ctd only, `:112` |
| | `regions` | `List<MangaOcrTextRegion>?` | character-level hit regions, `:120` |
| `MangaOcrTextRegion` | `rectangle` | `MokuroRect` | page-image pixels, `:143` |
| | `utf16Start` / `utf16End` | `int` | indices into `block.lines.join()`, `:144-L145` |

Geometry value types (`packages/fushi_engine/lib/media/manga/mokuro_geometry.dart`) are intentionally
`dart:ui`-shaped but pure Dart, because the engine is `dart compile exe`-able and must not import
`dart:ui` (`mokuro_geometry.dart:1-L11`): `MokuroPoint` (`:15`), `MokuroSize` (`:36`),
`MokuroRect` (`:60`). Conversion to Flutter types happens only at the boundary via
`fushi/lib/src/media/manga/mokuro_geometry_ui.dart`.

Producer/serialization split:

| Function | Direction | Shape | file:line |
|---|---|---|---|
| `parseMokuro` | `.mokuro` JSON → model | `pages[].img_path/img_width/img_height/blocks[]`; `font_size`, `vertical`, `lines` tolerant; `lines_coords` preserved | `mokuro_payload.dart:219` |
| `parseMangaJson` | internal JSON → model | `pages[].url/width/height/blocks[]`; reads explicit `z_index`; parses `ocr` metadata | `mokuro_payload.dart:270` |
| `mangaPayloadToJson` | model → internal JSON | emits `ocr?`, `pages[].{url,width,height,blocks[]}`, `box/vertical/font_size/z_index/lines`, optional `lines_coords`, optional `regions` | `mokuro_payload.dart:323` |

### 4.2 Persistence: `EpubBooks` (the "manga row")

`packages/fushi_core/lib/src/database/tables.dart:435`:

| Column | Role for manga | file:line |
|---|---|---|
| `bookKey` (PK) | `sanitizeTtuFilename(title)` — cross-device identity | `tables.dart:437`, `manga_importer.dart:364` |
| `uid` | machine-local stable id used by `ReaderPositions`/`MangaChapterStates` | `tables.dart:449` |
| `title` | stored (possibly suffixed) title | `manga_importer.dart:386` |
| `coverPath` | first page relative path, or online `cover.jpg` basename | `manga_importer.dart:387`, `online_manga_library_service.dart:151` |
| `epubPath` | **`'manga.json'`** | `manga_importer.dart:388`, `manga_storage.dart:37-L39` |
| `extractDir` | absolute book dir | `manga_importer.dart:389` |
| `chapterCount` | **page count** for a volume | `manga_importer.dart:390` |
| `chaptersJson` | `'[]'` for a volume; chapter list JSON for an online series entry | `manga_importer.dart:391`, `online_manga_library_service.dart:170` |
| `format` | `BookFormat.manga.dbValue` (`'manga'`) | `tables.dart:471-L476`, `manga_importer.dart:393` |
| `mangaReadingMode` | `null` = auto-detect; `'spread'`/`'webtoon'` = user override | `tables.dart:478-L482` |
| `sourceMetadata` | online entry descriptor (JSON) | `online_manga_library_service.dart:171` |
| `sourceId` | network/local source library FK | `tables.dart:489-L493` |

### 4.3 Other persisted manga state

| Table | Key fields | file:line |
|---|---|---|
| `ReaderPositions` | `bookUid`, `sectionIndex` (= 0-based page), `normCharOffset`, `charOffset` (webtoon page-fraction ×1000) | `packages/fushi_core/lib/src/database/tables.dart:122-L136`; encoding `manga_fushi_page.dart:738-L746` |
| `MangaChapterStates` | `(bookUid, chapterKey)` PK, `lastPage`, `lastFraction`, `pageCount`, `readAt` | `tables.dart:2791-L2815` |
| `MangaDownloadJobs` | `jobId = sha256(kind NUL bookKey NUL chapterKey)[:32]`, `status`, `pagesDone/pagesTotal`, `autoOcr` | `tables.dart:2981-L3016` |

Progress write-through is a single place: `_persistPosition` writes `ReaderPositions` and
`MangaChapterStates` together (`manga_fushi_page.dart:3253-L3306`).

---

## 5. Page rendering & reading order

### 5.1 Two reading modes, one auto-detector

`MangaReadingMode { spread, webtoon }` (`fushi/lib/src/media/manga/manga_reading_mode.dart:4-L9`).
Auto-detection uses the **median** of `height/width` across pages, never decoding the image:
median > `kWebtoonAspectThreshold = 2.0` → webtoon, else spread; zero-width pages skipped; empty
payload → spread (`manga_reading_mode.dart:11-L46`).

Resolution order at load time: DB override wins, else auto-detect:
`MangaFushiPage.modeOverrideFromDb(row.mangaReadingMode) ?? detectReadingMode(payload)`
(`manga_fushi_page.dart:1451-L1455`). `null` means "follow auto" by schema contract
(`tables.dart:478-L482`).

### 5.2 Page order

Page order is **the payload array order**, i.e. `manga.json` order. There is no re-sort in the
reader. The order is established at import time by the natural-sort comparator
`naturalCompare` (`manga_ocr_folder_job.dart:61-L103`) applied to relative URLs:

```
pages.sort((a, b) => naturalCompare(a.relativeUrl, b.relativeUrl));   manga_ocr_folder_job.dart:155-L156
```

`naturalCompare` compares digit runs numerically and everything else case-insensitively, with a
stable tie-break for `001` vs `1` (`:71-L93`). Consequence: `p2.jpg < p10.jpg`. This is a pure
lexicographic-on-relative-path sort, so a volume that mixes sub-directories orders by the whole
relative path, not by directory-then-name.

### 5.3 Spread pairing and RTL

- Page layout: `MangaPageLayout { single, double }`; user preference
  `MangaSpreadPreference { auto, single, double }` default `auto`
  (`fushi/lib/src/media/manga/manga_spread_model.dart:1-L21`).
- Auto rule: landscape → double, portrait → single (`resolveMangaPageLayout`,
  `manga_spread_model.dart:42-L54`).
- The initial preference is read from `manga_spread_preference` (default `'auto'`) at
  `preferences_repository.dart:2730-L2732`.
- `buildMangaSpreads(pageCount, layout, spreadOffset)` pairs pages 2-at-a-time; `spreadOffset >= 1`
  emits page 0 alone first (solo cover), and an odd trailing page becomes a solo entry
  (`manga_spread_model.dart:81-L116`). The reader always passes `spreadOffset: 1`
  (`manga_fushi_page.dart:1817-L1831`), so: **cover solo, then facing pairs**.
- `MangaSpreadEntry.pageIndices` is ascending; RTL left/right ordering is applied at render time,
  not in the model (`manga_spread_model.dart:56-L71`).
- Reading direction default is **RTL**: `getPref('manga_reading_direction', defaultValue: 'rtl')`
  (`preferences_repository.dart:2738-L2739`); any value other than `'ltr'` maps to `'rtl'`
  (`manga_fushi_page.dart:1437`). UI options at
  `fushi/lib/src/settings/settings_schema_manga.dart:41-L60`.

RTL is implemented by **reversing DOM write order of spreads**, not by CSS direction on the strip
(`manga_overlay_html.dart:657-L681`): the strip stays `direction:ltr` so `offsetLeft` remains a
stable multiple of `100vw`, while RTL spreads are written in reverse so "next" lands to the left.
The comment records the bug this fixes: mirroring only the input (not the geometry) made the
default RTL mode slide backwards (`manga_overlay_html.dart:658-L667`).

### 5.4 Window document / page loading

- Local payload loading: `row.extractDir + row.epubPath` → `readAsString` →
  `MangaFushiPage.parseMangaJsonOffUi` (an `Isolate.run` static method — must be static or `this`
  becomes unsendable, `manga_fushi_page.dart:720-L727`) → `imagesDir = dirname(json)/images`
  (`manga_fushi_page.dart:1394-L1431`).
- A `LocalMangaPageProvider` is opened over `imagesDir` + relative page paths
  (`manga_fushi_page.dart:1462-L1465`; interface `fushi/lib/src/media/manga/mihon/manga_page_provider.dart:11-L32`).
- The WebView is given a single generated HTML document. Spread mode materializes only a window of
  spreads (`_kWindowRadius = 0`, `manga_fushi_page.dart:980`) and paginates by `translateX`;
  webtoon renders **all** pages once and scrolls (`manga_fushi_page.dart:1956-L2026`; document
  builder `mangaWindowDocument`, `manga_overlay_html.dart:580`).
- Page images are served to the WebView by an interceptor on the virtual host `manga.local`
  (`kMangaHost`, `manga_fushi_page.dart:381`): the payload `url` is percent-encoded per segment
  (`mangaImageUrl`, `:630-L639`), and `_interceptRequest` decodes it, resolves it through the
  traversal guard, and returns bytes with `Access-Control-Allow-Origin: *`
  (`:1858-L1919`). Traversal is distinguished from a missing file: 403 vs 404 (`:1899-L1908`).
  macOS/iOS additionally register the `fushi-manga://` custom scheme
  (`kMangaResourceScheme`, `:385`, `_loadMangaCustomScheme`, `:1922-L1935`; scheme selection
  `:1992-L1995`).

---

## 6. Text overlays (the selectable / lookup-able layer)

Technology: the renderer is **Flutter `InAppWebView` with an HTML document**; OCR boxes become
absolutely-positioned transparent HTML elements, and text selection is done by an injected
`fushiSelection` JavaScript object — not Flutter widgets, not a `CustomPainter`.

### 6.1 The overlay generator (`fushi/lib/src/media/manga/manga_overlay_html.dart`)

`mangaOcrBoxesHtml(MokuroImage page)` (`:27`) emits one `<p class="ocr-box">` per block:

- Block box → percentages of the page size:
  `leftPct = r.left/pageWidth*100`, and likewise top/width/height (`:36-L39`, page dims from
  `page.size`, with a `<= 0 → 1` divide guard `:28-L29`).
- Font size → container-query inline-size units:
  `rawCqi = block.fontSize / pageWidth * 100`, with a non-zero floor `3.0` when the producer gave
  `0` (`:40-L47`). Two documented failure modes drive this: `font-size:%` collapses the invisible
  text to the box corner and every tap misses (ERRATA H5, `:17-L20`), and `font-size:0cqi`
  collapses the hit area (ERRATA M1, `:43-L45`). `container-type:inline-size` (not `size`) is
  required or the `<img>`-driven page height collapses (`:22-L24`, `:492-L496`).
- Vertical blocks get `writing-mode:vertical-rl` (`:48-L50`) and `data-ocr-orientation`
  (`:51`).
- If character regions exist, the `<p>` contains per-character `<span class="ocr-char">` and gets
  `pointer-events:none` (so the child spans own hit-testing); otherwise it contains
  `lines.join('<br>')` and keeps `pointer-events:auto` (`:52-L76`).
- Each `<p>` also carries `data-manga-sentence` and `data-manga-sentence-group`
  (`:60-L63`).

Page wrapper `mangaPageDivHtml` (`:510-L553`): a `position:relative; container-type:inline-size`
div with inline `aspect-ratio: w/h`, the base `<img>` with `pointer-events:none`, and the OCR boxes
appended. It also writes `data-page`, `data-pw`, `data-ph`, `data-spread`, `data-spread-pages`,
`data-ocr-loaded` (`:541-L547`). Spread sizing is `min(slotVw, 100*w/h vh)` × `min(100vh, slotVw*h/w vw)`
with `slotVw = 100/pagesInSpread` (`:530-L538`).

The document wrapper `mangaWindowDocument` (`:580-L763`) builds `#manga-viewport > #manga-root >
.manga-spread > .manga-page` for spread, or a column of `.manga-page` for webtoon
(`:692-L710`), injects `inlineSelectionJs` and the gesture machine script (`:757-L761`), and
contains the CSS that disables native selection/drag (BUG-051) and sets `touch-action:none`
(BUG-1701) (`:717-L753`).

### 6.2 Polygon / box → text box

Two sources of geometry feed the same renderer:

1. **Producer-supplied `regions`** (`MangaOcrTextRegion`) are used verbatim:
   `mangaEffectiveTextRegions` returns them if present
   (`manga_overlay_html.dart:345-L349`).
2. **Derived character regions** when the producer only gave a block box + lines
   (`mangaEffectiveTextRegions`, `:345-L396`):
   - line rectangles come from `lines_coords` polygons, each reduced to its axis-aligned bounding
     box (`_mangaLineRects`, `:398-L453`); if absent or malformed, lines are distributed evenly
     across the block box — for vertical blocks right-to-left, for horizontal top-to-bottom
     (`:429-L452`);
   - each line is split into non-space grapheme clusters (`line.characters`,
     `package:characters`), and each character gets an equal slice of the line rectangle along
     the text axis (`:356-L394`);
   - `utf16Start/utf16End` are accumulated across the joined line text (`utf16Base += line.length`,
     `:393`), matching the `block.lines.join()` contract.

Character spans map **parent-relative percentages** (`(r.left - parent.left)/parentWidth*100`,
`:471-L474`) and carry `data-utf16-start` and `data-ocr-orientation` (`:477-L483`).

Google Lens is the producer that supplies real line-derived regions:
`buildPageDetections`-equivalent in `fushi/lib/src/media/manga/ocr/google_lens_ocr_service.dart`
converts normalized paragraph bounds to pixels (`_toPixels`, `:349-L355`) and emits
`MangaOcrTextRegion`s per character (`:308-L325`). Local ONNX and legacy mokuro do **not** emit
regions — the comment states this explicitly (`manga_overlay_html.dart:338-L344`).

### 6.3 Hit-testing

All in the injected JS (`_mangaGestureJs`, `manga_overlay_html.dart:793-L1531`):

```js
function _hitOcrChar(x, y){                                  // manga_overlay_html.dart:1170
  var stack = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [];
  ...
  var charEl = el.closest && el.closest('.ocr-char');
  ...
  var candidates = exact;                                    // :1179
  if (!candidates.length && page) {                          // :1180 fallback: all chars on page
    candidates = Array.prototype.slice.call(page.querySelectorAll('.ocr-char'));
  }
  var best = null, bestArea = Infinity;
  for (...) {
    var r = candidate.getBoundingClientRect();
    if (x < r.left - 4 || x > r.right + 4 ||
        y < r.top - 4 || y > r.bottom + 4) continue;         // :1187-L1188 4px slop
    var area = Math.max(0.01, r.width * r.height);
    if (area < bestArea) { best = candidate; bestArea = area; }   // :1190 smallest wins
  }
  return best;
}
```

The tie-break rule is therefore **smallest overlapping character rectangle wins**, with a constant
4 screen-pixel slop at every zoom level (`:1167-L1169`). This is a linear scan over the candidate
list; `elementsFromPoint` narrows it to stacked elements first, with a fallback to every character
on the page (`:1179-L1182`). Note the `zIndex` field is **not** consulted by hit-testing — the
documented rule is geometric area, not stacking order.

Selection path (`_selectOcrChar`, `:1194-L1218`):

```js
  var node = charEl.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return false;
  window.__mangaLastOcrHit = { text: node.textContent || '',
                               orientation: charEl.getAttribute('data-ocr-orientation') || '',
                               x: x, y: y, zoom: ZOOM };
  ...
  selection.selectFromPosition(node, 0, 40, x, y);           // :1213
```

The third argument (maxLength) is load-bearing: the file header records that omitting it makes the
scan gate always false and lookup silently dead (`:559-L563`).

Two lookup entry points share that one function: tap (`_onTap` → `_selectOcrChar(x, y, false)`,
`:1243-L1252`) and Shift-hover (`mousemove` with throttle, `:1219-L1228`).

### 6.4 Payload to Flutter and on to the dictionary

`buildSelectionPayload` in `fushi/lib/src/reader/reader_selection_scripts.dart:1274` assembles the
JSON:

- `text` = the scanned word; `sentence` = the block's `data-manga-sentence` when present, else the
  ordinary punctuation-based paragraph context (`reader_selection_scripts.dart:1300-L1304`,
  `:1366-L1368`);
- `verticalWriting` from `[data-ocr-orientation]` (`:1305-L1310`);
- `mangaPageIndex` from `.manga-page[data-page]` (`:1316-L1321`);
- anchor rect: union of all `.ocr-box` sharing the same `data-manga-sentence-group`
  (`:1322-L1347`), else the caret/selection rect;
- `fireTextSelected` posts it on the `onTextSelected` JavaScript channel
  (`reader_selection_scripts.dart:1381-L1384`).

Dart side:

- the manga reader registers **exactly one** `onTextSelected` handler
  (`manga_fushi_page.dart:2892-L2913`, registered at `:4072-L4078`; the "exactly one" contract is
  documented at `:358-L361`);
- `ReaderSelectionData.fromJson` parses the payload (`fushi/lib/src/reader/reader_selection_data.dart:20-L52`);
- `dispatchMangaSelection` (`manga_fushi_page.dart:258-L281`) selects the mining page
  (`selectPageForMining`, `:2919-L2959`), sets the sentence, converts the JS viewport rect to a
  screen rect (`mangaSelectionRectFromPayload`, `:95-L114`, adding the chrome top inset), and calls
  `searchDictionaryResult`.

### 6.5 Incremental OCR overlay replacement (no document reload)

When whole-volume OCR finishes a page, only that page's `.ocr-box` nodes are replaced:
`window.__mangaReplaceOcr(pageIndex, html)` (`manga_overlay_html.dart:933-L940`), driven from Dart
by `_replaceSpreadOcr` which also removes boxes for pages no longer in the window and flips
`data-ocr-loaded` (`manga_fushi_page.dart:2260-L2302`). On book open, per-page cache results are
merged back into the in-memory payload by `_recoverIncrementalOcrCache` →
`recoverCachedMangaOcr` (`manga_fushi_page.dart:1744-L1797`).

### 6.6 Sentence grouping across blocks (producer-agnostic)

`_mangaBlockSentenceAssignments` (`manga_overlay_html.dart:103-L204`) union-finds adjacent blocks
into sentence groups, treats narrow kana-only runs next to kanji runs as ruby (excluded from the
mined sentence but included in the group), and refuses to join across a sentence terminator.
Motivation is documented with a real page and a bug id: Google Lens emits one paragraph per
vertical column, so One Piece produced four neighbouring blocks `だいじょうぶ` / `大丈夫` / `だよな`
/ `?` and per-block `<p>`s made mining capture only the clicked column (BUG-1333,
`:82-L95`).

---

## 7. Tokenization of manga text

**There is no morphological tokenizer (no MeCab, no Sudachi, no Jieba) anywhere in the manga
pipeline.** Greps for `mecab`/`sudachi`/`jieba` across `native/`, `packages/`, `pubspec.yaml`
return nothing. Two different things are routinely confused here:

### 7.1 The only actual tokenizer: manga-ocr's BERT char tokenizer (OCR decoding)

`packages/fushi_engine/lib/ocr/manga_ocr_tokenizer.dart`:

- built from the model's `vocab.txt`, one token per line, line number = id
  (`MangaOcrTokenizer.fromVocabText`, `:15-L42`);
- special ids required to be present: `[CLS]`, `[SEP]`, `[PAD]`, `[UNK]`, optional `[MASK]`
  (`:32-L41`);
- `decode(Iterable<int>)` skips specials and strips the WordPiece `##` prefix (`:55-L65`);
- `postProcess` removes all whitespace, normalizes `…` → `...`, and collapses 2+ `・`/`.` into
  equal-length dots (`:67-L77`).

It is used only by `MangaOcrRecognizer` to turn beam-search ids into a string
(`packages/fushi_engine/lib/ocr/manga_ocr_recognizer.dart:157-L170`), and is loaded in the isolate
at `manga_ocr_service_impl.dart:367-L374`. **It never touches the dictionary.**

The separate PP-OCRv6 CTC vocabulary (`parsePpOcrCharacterDict` /
`buildPpOcrCtcVocab`, `packages/fushi_engine/lib/ocr/ppocr_line_recognizer.dart:35` and `:71`) is
likewise recognition-only.

### 7.2 Dictionary lookup: a custom script-aware scanner + native normalized lookup

What feeds the dictionary is the JS scanner in
`fushi/lib/src/reader/reader_selection_scripts.dart`:

- `scanDelimiters` is an explicit character class of Japanese/ASCII punctuation and newlines
  (`reader_selection_scripts.dart:371`);
- `isScanStop` = delimiter OR (when `scanNonJapaneseText === false`) a non-Japanese code point
  (`:402-L405`), using the same "space-delimited letter" model as the native
  `native/fushidicts/fushidicts_src/scan/word_scan.cpp` (`:416-L417`, `:437-L446`);
- `selectFromPosition` (`:1216-L1266`) walks a `TreeWalker` over text nodes, skips furigana
  (`rt`/`rp`, `:447-L450`, `:484`), skips whitespace-only nodes (`:485-L490`), expands a
  non-Japanese hit leftwards to its token start (`:1220-L1224`), and scans forward up to
  `maxLength` characters (40, passed by the manga overlay).

So: **the "tokenization" for lookup is a script/whitespace/delimiter scanner, not a morphological
analyzer.** The native side (`native/fushidicts`, a fork of Manhhao/hoshidicts —
`native/fushidicts/UPSTREAM.md:9`) then does normalization/lemmatization (NFKC via vendored
utf8proc, kanji standardization table) in `fushidicts_src/text_processor/text_processor.cpp`
(`UPSTREAM.md:33-L36`). It is reached through `dart:ffi`
(`packages/fushi_dictionary/lib/src/engine/fushidicts.dart:2`,
`packages/fushi_dictionary/lib/src/ffi/fushidicts_ffi_bindings.dart:1`).

Manga-specific wrinkles that the scanner must survive, all in the JS layer: mixed vertical and
horizontal blocks on one page (hence per-hit `verticalWriting`,
`reader_selection_data.dart:75-L80`), OCR-produced apostrophes (U+2018 from mis-read U+2019,
`reader_selection_scripts.dart:426-L436`), and paragraph-boundary whitespace (`:462-L478`).

---

## 8. Dependencies

### 8.1 Dart packages (from `pubspec.yaml` files)

| Package | Constraint | Where | Why it matters here |
|---|---|---|---|
| `archive` | `^3.6.1` | `fushi/pubspec.yaml:32`, `packages/fushi_engine/pubspec.yaml:35` | ZIP/CBZ/EPUB central-directory reading & extraction. Deliberately pinned to 3.x: root `pubspec.yaml:151-L167` explains that 4.0 removed `package:archive/archive_io.dart`, which this repo uses in 12+ places. |
| `image` | `^4.3.0` | `fushi/pubspec.yaml:109`, `packages/fushi_engine/pubspec.yaml:45` | Pure-Dart decode, crop, resize, `bakeOrientation`; header probing (`image_size_probe.dart:3`). |
| `flutter_onnxruntime` | `^1.8.3` (path-overridden) | `fushi/pubspec.yaml:173`, override `pubspec.yaml:139-L140` | ONNX Runtime sessions for detector/recognizer/PP-OCR. Fork because upstream pinned `onnxruntime-objc 1.23` forcing macOS 14/iOS 16 (`pubspec.yaml:131-L138`). |
| `characters` | `^1.3.0` | `fushi/pubspec.yaml:40` | Grapheme-cluster iteration when subdividing a line into character hit regions (`manga_overlay_html.dart:3`, `:361`). |
| `crypto` | `^3.0.0` | `fushi/pubspec.yaml:150`, `packages/fushi_engine/pubspec.yaml:38` | `sha256(chapterKey)[:24]` chapter directory digest (`manga_chapter_storage.dart:37-L38`). |
| `path` | `^1.8.2` | `fushi/pubspec.yaml:125`, engine `:47` | `p.canonicalize` traversal guard, `p.joinAll` page paths. |
| `flutter_inappwebview` | `^6.1.5` | `fushi/pubspec.yaml:90` | The entire manga reader surface + JS bridge (`onTextSelected`, `onMangaTurn`, …). Windows implementation is a fork (`pubspec.yaml:9`, `:22`). |
| `drift` / `sqlite3` / `sqlite3_flutter_libs` | `>=2.33.0 <2.34.0` / `>=3.4.0 <4.0.0` / `^0.5.28` | `fushi/pubspec.yaml:100-L102` | `EpubBooks` manga rows, `ReaderPositions`, `MangaChapterStates`, `MangaDownloadJobs`. |
| `ffi` | `^2.1.3` | `fushi/pubspec.yaml:103`, engine `:41` | `dart:ffi` bindings for the dictionary engine. |
| `http` | `^1.2.0` | `fushi/pubspec.yaml:105`, engine `:44` | Google Lens upload, model downloads, mokuro.moe. |
| `pdfrx` | `2.4.5` (pinned) | `fushi/pubspec.yaml:130-L131` | PDF → page rasters in `book_format_rebuild.dart` / `manga_pdf_importer.dart`. Pin reason: newer versions would force `archive ^4`. |
| `file_selector` / `desktop_drop` etc. | — | `fushi/pubspec.yaml` | Folder/file pickers and drag-drop (`desktop_drop` is a local fork, `pubspec.yaml:54`). |

### 8.2 Native / non-Dart boundaries

| Boundary | What crosses it | Evidence |
|---|---|---|
| `flutter_onnxruntime` MethodChannel (root engine) | all ORT session creation/inference; called from a background isolate via `BackgroundIsolateBinaryMessenger.ensureInitialized(RootIsolateToken)` | `fushi/lib/src/ocr/ocr_inference_ort.dart:14-L16`, `:59-L69`; isolate structure `packages/fushi_engine/lib/ocr/manga_ocr_service_impl.dart:4-L12` |
| ONNX Runtime native lib (ONNX Runtime DirectML NuGet 1.22.0 on Windows) | EP availability; Windows ships only `onnxruntime.dll` / `onnxruntime_providers_shared.dll` / `DirectML.dll` (no CUDA) | `packages/fushi_engine/lib/ocr/ocr_inference.dart:91-L114` |
| `7za` / `7z` external binary | RAR/CBR/CB7 listing + extraction | `manga_archive_importer.dart:112-L177`; locator `fushi/lib/src/media/discovery/import/discovery_archive_extractor.dart:37-L76` (bundled `<exeDir>/7za/7z.exe`, then `7z.exe`, then PATH `7z`/`7za`) |
| Native `fushidicts` (C++/FFI + JNI) | dictionary lookup after the scanner produces a query string | `native/fushidicts/fushidicts_ffi.cpp`, `native/fushidicts/fushidicts_jni.cpp`; Dart bindings `packages/fushi_dictionary/lib/src/engine/fushidicts.dart:2` |
| Platform OCR MethodChannel `app.fushi.reader/system_ocr` | Android ML Kit / Apple Vision / Windows.Media.Ocr fallback engine | `fushi/lib/src/ocr/system_ocr_channel.dart:139-L140`; service `fushi/lib/src/media/manga/ocr/system_ocr_manga_service.dart:45-L49` |
| `mokuro` CLI (optional user install) | external whole-volume OCR producing `.mokuro` | `fushi/lib/src/media/manga/external_mokuro_runner.dart:7-L13`, resolution order `:31-L41` |
| Isolate boundary | whole-volume OCR runs in `Isolate.spawn` with only `String`/functions in args | `manga_ocr_service_impl.dart:62-L83`, `:156-L175`, `:441-L463` |

### 8.3 Model artifacts downloaded at runtime

`kMangaOcrModelManifest` (`packages/fushi_engine/lib/ocr/manga_ocr_model_manifest.dart:54-L104`),
~470 MB total, all Apache-2.0:

| File | Bytes | Source |
|---|---|---|
| `detector-v4-s_int8.onnx` | 11,120,765 | `ogkalu/comic-text-and-bubble-detector` (RT-DETR-v2 int8) |
| `encoder_model.onnx` | 343,454,249 | `mayocream/manga-ocr-onnx` |
| `decoder_model.onnx` | 117,480,262 | same |
| `vocab.txt` | 30,216 | same |
| `ppocrv6_small_det.onnx` | 9,880,512 | `PaddlePaddle/PP-OCRv6_small_det_onnx` @ revision sha |
| `ppocrv6_small_rec.onnx` | 21,159,378 | `PaddlePaddle/PP-OCRv6_small_rec_onnx` @ revision sha |
| `ppocrv6_small_rec.yml` | 150,579 | same (CTC dictionary) |

Model directory default is `<appSupport>/ocr_models/manga`
(`defaultMangaOcrModelsDir`, `manga_ocr_model_fingerprint.dart:38`).
Cache invalidation uses a 12-char content fingerprint of the installed models
(`kMangaOcrModelFingerprintLength = 12`, `manga_ocr_model_fingerprint.dart:35`;
`resolveLocalMangaOcrEngineSignature`, `:106`), and its doc explains BUG-1173 (upstream model swap
silently reusing stale page caches, `:8`).

---

## Appendix A. OCR pipeline stages (producer detail for §6)

### A.1 Stage 0 — page enumeration and decode

`enumerateMangaPages(root)` recurses to `kMangaPageScanMaxDepth = 6` (`:110`), skips
`manga_ocr_out`, filters by `kMangaOcrImageExtensions`, and natural-sorts by relative URL
(`:121-L158`). Recursion depth is a bug fix: mokuro.moe CBZs put pages at `images/<volume>/001.jpg`
(depth 2), which the old "top level + one subdirectory" enumerator missed entirely
(`:114-L120`).

`decodeMangaPageFile` decodes with `package:image` and then **bakes EXIF orientation** —
the comment says browser rendering honors EXIF, so OCR must use the same oriented pixel space or
the overlay is rotated/translated relative to the visible page (`:298-L308`).

### A.2 Stage 1 — text/bubble detection (RT-DETR-v2, 3 classes)

`packages/fushi_engine/lib/ocr/text_detector.dart`:

- classes: `0 = bubble`, `1 = text_bubble`, `2 = text_free` (`:35-L37`);
- input: 640×640, `rescale 1/255`, **no mean/std normalization**, RGB CHW; default preprocessing is
  an aspect-ratio-destroying *squish* matching the official `do_pad=false`, with an optional
  letterbox mode (`computeLetterbox`, `:74-L107`; `rtdetrPreprocess`, `:113-L154`);
- decoding supports both exports: raw `logits`/`pred_boxes` with sigmoid + cxcywh→xyxy
  (`decodeRtdetrOutputs`, `:178-L212`) and graph-internal post-processing outputs
  `scores`/`labels`/`boxes` (`decodeProcessedRtdetrOutputs`, `:227-L265`);
- lightweight class-aware NMS, `iouThreshold = 0.7`: bubbles and text are separate groups, and
  text_bubble/text_free deliberately share a group so one query passing both thresholds cannot be
  recognised twice (`nmsGroupOf`, `:267-L274`; `applyClassAwareNms`, `:277-L298`);
- `buildPageDetections` computes `insideBubble` by testing the text box centre against bubble
  boxes (`:301-L321`);
- `TextDetector.detect` also feeds `orig_target_sizes` and tolerates labels arriving as
  float/int64/int32 (`_labelValues`, `:214-L224`).

### A.3 Stage 2 — reading order (pure Dart heuristics)

`packages/fushi_engine/lib/ocr/reading_order.dart`:

1. `clusterPanels` unions blocks whose x and y gaps are both ≤ `0.75 × min(short side)` of the
   smaller block (`:61-L72`);
2. panels are grouped into horizontal bands by vertical overlap, bands sorted top→bottom, and
   within a band panels are ordered by `centerX` — RTL by default (`computeReadingOrder`,
   `:127-L160`);
3. `orderWithinPanel` clusters horizontally-overlapping blocks into columns, sorts columns
   right-to-left (RTL), and within a column top-to-bottom — i.e. vertical-text column-major order
   (`:91-L121`).

`MangaOcrPipeline` passes `rightToLeft: true` by default (`manga_ocr_pipeline.dart:67`).

### A.4 Stage 3 — per-block recognition with orientation routing

`MangaOcrPipeline.processPage` (`manga_ocr_pipeline.dart:115-L150`): detect → compute order →
recognise each box in order, skipping empty results. Vertical/horizontal is decided by
`isVerticalBlock(box) = box.height > box.width * kVerticalAspectThreshold` with
`kVerticalAspectThreshold = 1.25` (`:51-L59`); the comment records that the old 1.5 threshold
misclassified ~1.4:1 vertical cover text (`:52-L55`).

`RoutingOcrRecognizer` (`packages/fushi_engine/lib/ocr/routing_ocr_recognizer.dart`) routes by
**one** rule: `routesToHorizontalPath(box) => box.width >= box.height` (`:32-L35`), deliberately a
looser test than the display-side 1.25 so near-square short lines still go to manga-ocr.

- Vertical block → whole block into manga-ocr (`:52-L54`).
- Horizontal block → crop → PP-OCRv6 DB line detection → thin-line (furigana) filter → line
  reading order → per line: vertical sub-line padded by `kRoutingLinePadding = 4` back to
  manga-ocr, horizontal sub-line to PP-OCR recognition (`:62-L111`).
- Empty/failed route falls back to whole-block manga-ocr rather than dropping the block
  (`:17-L18`, `:55-L59`).

PP-OCR line detector (`ppocr_line_detector.dart`): DB post-process with `thresh=0.2`,
`box_thresh=0.45`, `unclip_ratio=1.4`, BGR + ImageNet normalization (`:31-L48`, `:68-L92`,
`:113-L187`); axis-aligned boxes only, with the unclip distance computed from the connected
component's true pixel count to avoid swallowing neighbouring lines on skewed text (`:170-L173`);
furigana filter drops lines thinner than `0.6 ×` the p75 thickness (`:189-L203`); reading order is
column-RTL when vertical lines are the majority, else top-to-bottom/left-to-right (`:205-L221`).

Manga-ocr recognizer (`manga_ocr_recognizer.dart`): 224×224 input, ITU-R 601 luma greyscale
duplicated across 3 channels, `(x/255-0.5)/0.5` normalization (`:36-L56`); encoder once, then
autoregressive decoder with beam search `num_beams=4, length_penalty=2.0,
no_repeat_ngram_size=3, max_length=300, early_stopping=true` (`:92-L171`), implemented in
`beam_search.dart` (`beamSearchDecode`, `:129`).

`estimateMangaFontSize(block) = sqrt(box.area / charCount)` (`manga_ocr_folder_job.dart:244-L254`)
is what populates `MokuroBlock.fontSize` for internally produced OCR.

### A.5 Stage 4 — payload assembly and write

`buildMangaPayloadFromResults` (`manga_ocr_folder_job.dart:259-L296`) builds `MokuroBlock`s with
`zIndex = array index` (which is reading order) and re-evaluates verticality at assembly time so
that caches produced under the old stricter threshold gain vertical regions without re-running OCR
(`:277-L280`). `runMangaOcrFolderJob` then writes `<dir>/manga_ocr_out/manga.json` atomically
(`:380-L390`) with `MangaOcrMetadata(engine: 'local_onnx', engineSignature, schemaVersion: 1)`
(`:372-L379`).

### A.6 Cancellation, caching, isolate and EP policy

- `OcrCancelToken` is checked between pages and between blocks; completed pages stay cached
  (`manga_ocr_pipeline.dart:20-L43`, `:91-L110`).
- Engine signature = `kLocalMangaOcrEngineSignature ('local-onnx-v2-oriented')` **plus** the model
  content fingerprint; `runMangaOcrFolderJob` deliberately has **no default** for it so no caller
  can forget it (`manga_ocr_folder_job.dart:27-L35`, `:316-L320`).
- The v2 signature documents an EXIF fix: v1 coordinates were measured on the encoded matrix while
  the browser displayed the oriented page, shifting the lookup layer on portrait pages
  (`manga_ocr_folder_job.dart:28-L31`).
- EP policy is a pure function: per-platform accelerated-provider preference is an **empty list**
  on every platform today — Windows because the shipped int8 detector cannot build a DirectML
  session and CUDA is not in the shipped NuGet; Apple because CoreML silently returns empty
  detections on iOS (BUG-1613) — with measured tables inline in the comments
  (`packages/fushi_engine/lib/ocr/ocr_inference.dart:54-L151`).
  `selectOcrExecutionProviders` intersects the preference with the runtime's *compiled-in* EPs and
  always appends CPU (`:166-L180`).
- Degradation observability is inseparable from the plan object: `OcrAccelerationPlan.toAcceleration`
  merges pre-flight and runtime reasons (`manga_ocr_service_impl.dart:186-L220`), and the value is
  carried on every `MangaOcrVolumeEvent` (`manga_ocr_service.dart:110-L136`).

### A.7 Other OCR producers (same payload model)

| Engine | Producer | Notes |
|---|---|---|
| `localOnnx` | `MangaOcrServiceImpl` (isolate) | `manga_ocr_service_impl.dart:725` |
| `googleLens` | `GoogleLensMangaOcrService` | uploads page bytes, converts normalized paragraph/character bounds to pixels and emits `regions` (`google_lens_ocr_service.dart:269-L332`); **default engine** `kDefaultMangaOcrEnginePreference = googleLens` (`manga_ocr_engine.dart:33-L34`) |
| `systemOcr` | `SystemOcrMangaService` over the `app.fushi.reader/system_ocr` channel | `system_ocr_manga_service.dart:221-L243`; 30 s per-page timeout `:25` |
| `externalMokuro` | `ExternalMokuroRunner` (mokuro CLI) | produces `.mokuro`, parsed with `parseMokuro` (`manga_ocr_job_registry.dart:280-L282`) |
| `pairedHost` | interconnect client | remote OCR, result path only |

Completion of any engine writes into the book-root `manga.json` inside the app-level registry's
`_ingest`: read result → `parseMokuro` (external) or `parseMangaJson` (internal) → under the
per-path lock → `writeMangaJsonAtomically` (`manga_ocr_job_registry.dart:269-L295`). Job ownership
is app-level, not page-level — leaving the reader does not cancel OCR (BUG-2449,
`manga_ocr_job_registry.dart:1-L14`).

---

## 9. Complexity inventory for a minimal desktop-only clone

"Load-bearing" = removing it breaks core reading + lookup. "Optional" = can be dropped without
breaking the core loop.

| Area | Minimal clone must have | Optional / deferrable | Evidence |
|---|---|---|---|
| **Payload model** | `MokuroPayload/MokuroImage/MokuroBlock` + `box`, `vertical`, `font_size`, `lines`; `parseMangaJson` + `mangaPayloadToJson` round trip | `linesCoords`, `regions`, `ocr` metadata, `isVertical` heuristics, `zIndex` | `mokuro_payload.dart:13-L146`, `:323-L371` |
| **Geometry** | `MokuroRect/Size` boxing | pure-Dart alias layer (only needed because engine compiles to exe) | `mokuro_geometry.dart:1-L11` |
| **Import** | folder-of-images → `images/` + `manga.json`; `.mokuro` parse + page-root resolution; traversal guard; duplicate-title policy; rollback | archive (CBZ/ZIP) support, RAR/7z, EPUB-as-manga, PDF-as-manga, batch folder, discovery/mokuro.moe, source-library scan, format rebuild, activity events | `manga_importer.dart:219`, `:344`, `:156`; `manga_storage.dart:66` |
| **Storage** | `<fushi_books>/<bookKey>/{manga.json, images/}`; `EpubBooks` row with `format='manga'` | `chapters/<digest>/` online layout; `MangaChapterStates`; `MangaDownloadJobs` | `manga_storage.dart:22-L42`; `tables.dart:435-L497`; `manga_chapter_storage.dart:32-L52` |
| **Reader shell** | one WebView document generator with `<img>` + absolutely-positioned OCR boxes | Flutter chrome, fullscreen, context menu, gamepad, volume keys, pan shortcuts, animation prefs | `manga_overlay_html.dart:580`; `manga_fushi_page.dart:4055` |
| **Overlay** | percentage-positioned `.ocr-box` with `cqi` font size; character spans; `elementsFromPoint` smallest-area hit test; `selectFromPosition` to dictionary | sentence grouping / ruby detection; `lines_coords`; Shift-hover; "show OCR boxes" debug; OCR replacement without reload | `manga_overlay_html.dart:27-L80`, `:345-L396`, `:1170-L1193`, `:1194-L1218` |
| **Page order / direction** | payload-array order + a natural sort at import; RTL default; single/double page toggle | auto-webtoon detection, per-page fraction restore, webtoon whole-document mode | `manga_ocr_folder_job.dart:61`, `:155`; `manga_reading_mode.dart:11`; `preferences_repository.dart:2738` |
| **OCR** | nothing (empty blocks still reads; OCR is additive) | ALL of: ONNX detect/route/recognise, PP-OCR, model download, EP policy, isolate, caching, engine registry, 4 alternate engines | `manga_importer.dart:78-L80`; `manga_ocr_folder_job.dart:321` |
| **Images in WebView** | `manga.local` interceptor + traversal guard + per-segment percent encoding | custom `fushi-manga://` scheme (Apple), page-byte session for online chapters | `manga_fushi_page.dart:381`, `:630`, `:1858` |
| **Mining/dictionary** | the scanner (`selectFromPosition`) + one `onTextSelected` handler | Anki mining, sentence groups, stats clock, read ledger | `reader_selection_scripts.dart:1216`; `manga_fushi_page.dart:2892` |
| **Dependencies to keep** | `image`, `path`, `flutter_inappwebview`, a DB, `characters` (only if deriving regions) | `archive`, 7-Zip binary, `flutter_onnxruntime`, `crypto`, `http`, `pdfrx`, dictionary FFI | §8 |

Rough load-bearing file list (desktop clone): `mokuro_payload.dart`, `mokuro_geometry.dart`,
`manga_storage.dart`, `manga_importer.dart` (minus archive branches), `manga_overlay_html.dart`,
`manga_spread_model.dart`, `manga_reading_mode.dart`, `reader_selection_scripts.dart`
(shared with EPUB), and a thin reader host. `manga_ocr_*`, `*_ocr_*`, `manga_download_service.dart`,
`manga_chapter_storage.dart`, `mihon/`, `aidoku/`, `online/`, `interconnect/` are all separable.

---

## 10. Gotchas & hard-won lessons

Ordered by how likely a reimplementation is to trip on them. All quotes are verbatim from code comments.

| # | Trap | Evidence (file:line) | What breaks in a clone |
|---|---|---|---|
| 1 | Two mokuro `img_path` root conventions must both be probed, and the admission predicate must use the same rule as the importer | `mokuro_payload.dart:158-L177`, `manga_importer.dart:26-L37`, `:243-L265` (BUG-1830) | Hardcoding `<.mokuro dir>` fails every "pages inside `<volume>/`" volume with a misleading "Missing manga page image"; a gate that differs from execution says yes and then always fails. |
| 2 | Image-extension tables must be one source | `media_extensions.dart:3-L9`, `manga_ocr_folder_job.dart:40-L47` (BUG-1121) | A `.bmp` page imports but OCR silently drops it, producing a short `manga.json` with no error. |
| 3 | Percent-decoding belongs only to the URL-producing side | `manga_storage.dart:141-L157` (BUG-2484, BUG-1221) | Unconditional `Uri.decodeComponent` in the file resolver crashes lookup/mining for `100%.jpg`, and silently turns `%41.jpg` into `A.jpg`. Two path forms (`canonicalize` for the guard, `normalize+absolute` for the return) must coexist or case-sensitive platforms get false `existsSync` failures. |
| 4 | EXIF orientation must be baked before OCR and before size probing | `manga_ocr_folder_job.dart:28-L31`, `:298-L308`; `image_size_probe.dart:36-L55` | Otherwise the overlay is rotated/shifted relative to the visible page, and spread/webtoon auto-detection flips. WebP EXIF specifically must be handled or 20×40 becomes 40×20. |
| 5 | Overlay hit geometry must be explicit, in pixels, not browser typography | `manga_overlay_html.dart:338-L344`, `:17-L24`, `:43-L47` | `font-size:%`, `container-type:size`, or `font-size:0cqi` all collapse the hit layer; every tap misses. |
| 6 | RTL must mirror DOM order, not just inputs | `manga_overlay_html.dart:657-L667`, `:1267-L1276` | Default RTL mode animates backwards ("press next, page slides back"). A stale comment once claimed Dart clamps direction — it does not (`:1272-L1273`). |
| 7 | `selectFromPosition`'s third argument (maxLength) is mandatory; exactly one `onTextSelected` handler per page | `manga_overlay_html.dart:559-L563`, `:1213`; `manga_fushi_page.dart:358-L361`, `:2888-L2891` (ERRATA H2) | Omitting maxLength makes the scan gate always false → lookup silently dead; a second handler double-fires lookups. |
| 8 | `.tmp` + rename, never delete-then-rename, and every writer of one `manga.json` must share the per-path lock | `manga_json_writeback.dart:8-L25`, `:64-L87`; `manga_ocr_folder_job.dart:380-L389` | A delete window loses the whole volume's OCR on a crash; an unlocked read-modify-write drops updates and clobbers the fixed-name `.tmp`. |
| 9 | Archive extraction must reuse the *reader's* path derivation | `manga_archive_importer.dart:719-L731` | Using the book-dir sanitizer (which strips a leading `images/`) writes `001.png` while the reader looks for `images/001.png` → `Missing manga page image` for the whole volume. |
| 10 | A `.mokuro` inside a CBZ must be honored, not discarded | `manga_archive_importer.dart:371-L392` (BUG-2018 partial) | Rebuilding an empty payload permanently destroys OCR the user already generated. |
| 11 | Dictionary packs can contain images — image presence alone is not "this is a manga" | `manga_archive_importer.dart:313-L326` | A Yomitan pack with illustrations gets imported as a junk "manga" and the dictionary is never imported. |
| 12 | `.zip` classification requires a real package read, and that read must be off the UI thread | `drop_classification.dart:99-L109`; `image_archive_probe.dart:12-L20` | Wrong bucket ("button works, drag says unsupported") or a multi-second UI freeze on drop. |
| 13 | Page cache keys must include model identity, and the manifest URL must be a pinned revision | `manga_ocr_folder_job.dart:32-L35`; `manga_ocr_model_manifest.dart:11-L17`; `manga_ocr_model_fingerprint.dart:8` (BUG-1173) | Upstream model swap silently reuses stale page caches; a mutable `main` ref makes the fingerprint useless. |
| 14 | Do not request execution providers that are not compiled in, and never report an empty preference list as degraded | `ocr_inference.dart:54-L114`, `:153-L180`; `manga_ocr_service_impl.dart:222-L271`, `:231-L233` (BUG-2050, BUG-1613, BUG-1163) | A failed DirectML/CoreML session costs 1.5–9 s per job; CoreML on iOS silently returns **zero** detections with `effective=coreml, fallback=null` so telemetry cannot see it; falsely reporting CPU as degraded leaves a warning the user can never clear. |
| 15 | Page enumeration depth is data-dependent, not a constant; skipped IO errors are deliberate | `manga_ocr_folder_job.dart:114-L120`, `:134-L141`; `manga_folder_plan.dart:93-L115` | mokuro.moe CBZ pages live at `images/<volume>/001.jpg`; "top level + one subdir" scans zero pages, and letting one permission error abort a whole volume is worse than skipping a directory. |
| 16 | Page count / chapter semantics are overloaded in `EpubBooks`, and `mangaReadingMode = null` means "auto" not "unset" | `manga_importer.dart:70-L74`; `tables.dart:471-L482`; `manga_fushi_page.dart:1451-L1454`; `book_format_rebuild.dart:210-L217` | `chapterCount` = page count, `epubPath` = `'manga.json'`, `chaptersJson = '[]'`; writing a default mode string pins the wrong layout forever and conversion must null it. |
| 17 | Parsing `manga.json` must happen off the UI isolate, and the closure must be static | `manga_fushi_page.dart:720-L727` | An instance-method closure captures `this`/binding and `Isolate.run` throws "object is unsendable". |
| 18 | WebView document generation must be fenced | `manga_fushi_page.dart:219-L247`, `:2028-L2076`; `manga_window_load_gate.dart:8-L20` (BUG-1153, BUG-1170, BUG-1171) | Late `onLoadStop` from a previous document unlocks the new one; a renderer death during `loadData` leaves a 10 s timeout that surfaces as an uncaught async error. |
| 19 | `touch-action:none` must be set before the gesture starts; `will-change:transform` must not be permanent | `manga_overlay_html.dart:722-L727`, `:731-L735` | Pinch and native pan run simultaneously; a persistent `will-change` pins the rasterization scale, so zoomed-out pages stay aliased until you zoom past the old scale (BUG-1759). |
| 20 | Webtoon and spread own different vertical-position truth; the reported fraction must be *within-page* | `manga_overlay_html.dart:816-L827`, `:920-L932`, `:1082-L1086`, `:1487-L1527` | webtoon vertical = `scrollY`, `PAN_Y ≡ 0`; spread vertical = `PAN_Y`. A global fraction is consumed as a page-internal offset → restore lands a full page off. |
| 21 | Right-drag pan must go through the same `_panBy` as everything else | `manga_overlay_html.dart:951-L961` | A hand-rolled copy loses clamp and webtoon routing; guards count a literal to prevent reintroduction. |
| 22 | Model disk accounting must measure the directory, not the manifest | `manga_ocr_service.dart:51-L57`; `manga_ocr_service_impl.dart:672-L680` (BUG-1732) | "Shown 450 MB / freed 176 MB" mismatch; orphan `.part` files become invisible and undeletable. |
| 23 | One platform-support boolean must not gate two different capabilities | `manga_ocr_service_impl.dart:590-L615` (BUG-1780) | Blocking "can this device run ONNX" also hides model management and box-OCR → a dead loop where the app tells the user to go download models on a page with no download button. |
| 24 | Job ownership must outlive the page | `manga_ocr_job_registry.dart:1-L14` (BUG-2449, BUG-2513) | Returning to the shelf killed a multi-hour OCR; queueing per `bookKey` is also required so consecutive chapter downloads are not silently swallowed. |
| 25 | Never show an empty sentence / never trust `chapters/` presence as completeness | `manga_fushi_page.dart:2971-L2979` (TODO-956); `manga_chapter_storage.dart:110-L131` | Mining/favourites would receive an empty sentence; listing half-finished chapters is acceptable, serving them is not. |
| 26 | Duplicate-title window must come **after** validation | `manga_importer.dart:149-L155` | Otherwise a doomed import prompts the user and leaves an empty book directory before failing. |

### Guards that pin the above (tests)

Primary: `fushi/test/media/manga/{manga_importer,manga_storage,manga_folder_plan,manga_import_can_import,manga_spread_layout_pref,manga_json_writeback}_test.dart`,
`fushi/test/pages/{manga_interceptor,manga_selection_dispatch,manga_mining_cover,manga_path_case_preserved,manga_spread_double_page}_test.dart`,
`fushi/test/media/drag_drop/dictionary_zip_not_manga_test.dart`,
`fushi/test/ocr/{manga_ocr_image_extensions_guard,manga_ocr_pipeline,manga_ocr_folder_job,manga_ocr_model_fingerprint,manga_ocr_recognizer}_test.dart`,
and `fushi/integration_test/manga_ocr_volume_e2e_itest.dart` — the live meter that caught the
CoreML empty-detection bug (`ocr_inference.dart:131-L133`).

---

## 11. Explicit "not found" list

- No `tar` / `tar.gz` / `7z` (as an extension) / `xz` handling in any manga path.
- No MeCab / Sudachi / Jieba / morphological analyzer anywhere in the repo.
- No `libarchive` or native unrar binding — RAR/CBR/CB7 go through an external `7z`/`7za` process.
- No `zip` entry in `kDragMangaExtensions` (by design) and no `epub` entry (handled via the books
  branch; rationale `drop_classification.dart:86-L90`).
- No server-side/headless `manga.json` reader found in `services/` (the engine layer is shared, but
  the HTTP page-serving endpoints referenced from `manga_chapter_storage.dart:1-L20` were not read
  in this pass).
- `fushi/lib/src/reader/reader_gallery_page.dart` contains **no** manga code; it is the EPUB
  illustration gallery.
