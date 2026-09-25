# 02 — Novel / EPUB pipeline (Fushi / Hibiki)

Scope: how a novel enters the app, how it is parsed and stored, how it renders in the WebView
reader, and how a tap on a word becomes a dictionary query. Paths are relative to the Fushi
checkout root. Non-obvious claims carry a `path/file.dart:LINE` citation; unverifiable ones say
**not found**. The Fushi repo was read only; nothing there was modified.

---

## 1. Entry points

### 1.1 Where a novel enters

Everything converges on `EpubImporter`.

| Door | Call site | Importer reached |
|---|---|---|
| Book import dialog, single file | `fushi/lib/src/media/audiobook/book_import_dialog.dart:1106` `_importEpubOnly`; EPUB branch `:1150` | `EpubImporter.importFromPath` |
| Same dialog, text-ish file | `book_import_dialog.dart:1135-1147` | `TextToEpub.convert` → `EpubImporter.import(bytes:)` |
| EPUB + subtitle + audio (alignment) | `book_import_dialog.dart:1173` `_importEpubWithAlignment` (calls at `:1185`, `:1193`) | both of the above |
| Subtitle-only "book" (SRT/VTT/ASS/SSA/LRC) | `book_import_dialog.dart:1000` `_importSubtitleBook` | `CuesToEpub.convert` → `EpubImporter.importFromPath` `:1027` |
| Discovery / auto-import queue | `fushi/lib/src/media/discovery/import/discovery_import_production.dart:42-69` | `.importFromPath` / `.import` |
| Source-library scanner | `fushi/lib/src/media/source_library/source_library_scanner.dart:698` | `.importFromPath` |
| LAN-pairing host service (incoming) | `packages/fushi_engine/lib/sync/local_library_host_service/books.part.dart:219` | injected callback |
| Cloud sync pull | `fushi/lib/src/sync/sync_orchestrator.dart:1645`, `sync_compare_dialog.dart:1043`, `reader_history/remote.part.dart:1406` | `.importFromPath` |

The reader is entered through `ReaderFushiSource`: `mediaIdentifierFor` = `hoshi://book/<bookKey>`
(`fushi/lib/src/media/sources/reader_fushi_source.dart:214`), and `mediaSourceKeyFor` routes
`epub`/`pdf`/`manga` to different readers (`:228-238`).

### 1.2 File-type classifier

`fushi/lib/src/media/import/import_carrier.dart`:

- `enum ImportCarrier {mangaFolder, mangaBatchFolder, mangaMokuro, mangaArchive, pdf, epub, text}`
  at `:13-45`; `isManga` `:48-52`, `isMangaCapable = isManga || pdf` `:66`.
- `classifyImportCarrier` at `:106-145` is pure, all FS probes injected (`:107-112`). Order:
  directory first (`:113-123`, directories have no extension and a dotted name yields a bogus
  `p.extension`), `.pdf` early-return **before** the text branch (`:128` — otherwise PDF binary
  becomes mojibake EPUB), `.mokuro` `:131`, explicit manga archives `:133`, ambiguous `.zip`/`.epub`
  probed by a real archive open (`:136-138`, set at `:148`), then the fallback
  `TextToEpub.isSupported(path) || (ext != '.epub' && ext != '.zip')` → `text` (`:141-144`).
- `kMangaCarrierFileExtensions` at `:81-90` is the declared single source of truth for the picker
  whitelist, batch enumeration and the directory branch.
- `ImportCarrierResolver` at `:164-225` memoises per path + mtime + size (`_memoKey` `:191-200`)
  because `isImageArchive` really unzips and one import asks up to three times (`:151-163`).

Picker whitelist `BookImportDialog._bookExtensions` at `book_import_dialog.dart:559-572`
(`epub`, `pdf`, `mokuro`, `cbz`, `zip` + `TextToEpub.supportedExtensions`); subtitle whitelist at
`:646-652`.

### 1.3 Other novel-ish formats (as requested)

- **TXT / MD / HTML / RST / ORG / CSV / TSV / LOG / JSON / XML** — `TextToEpub.supportedExtensions`
  `packages/fushi_engine/lib/media/audiobook/text_to_epub.dart:16-30`, `isSupported` `:32-35`,
  `convert` `:38-63` (encoding-detected read, chapter split `:67`, 30 000 chars/chapter `:14`,
  `EpubBuilder.assemble` `:57`). Downstream it is indistinguishable from a real EPUB.
- **SRT / VTT / ASS / SSA / LRC** — extension sets `fushi/lib/src/media/import/sidecar_finder.dart:20-36`;
  `parseCuesForFormat` + `CuesToEpub.convert` at `book_import_dialog.dart:1007-1032`; swap audio or
  subtitle without losing identity at `fushi/lib/src/media/import/srt_book_reimport.dart:115`
  (`reimportSrtBook`), body rebuilt via `EpubImporter.rebuildExtractedInPlace` `:241`.
- **PDF** — `fushi/lib/src/pdf/pdf_importer.dart:47` `importFromPath`. Does **not** use the
  extract pipeline: copies to `extractDir/document.pdf` (`kPdfFileName` `:39`), rasterises page 1 to
  `cover.png` (`:42`), inserts a row with `format='pdf'`, `chapterCount = pages`,
  `chaptersJson='[]'` (documented `:19-31`).
- Manga formats are a separate domain (`import_carrier.dart:133-138`).

---

## 2. Parsing — `epub_parser.dart`

Pure Dart: no FFI, no WebView (`packages/fushi_engine/lib/epub/epub_parser.dart:11-16`).

### 2.1 ZIP reading

- Library **`package:archive`** (`epub_parser.dart:4`; `archive: ^3.6.1` at `fushi/pubspec.yaml:32`
  and `packages/fushi_engine/pubspec.yaml:32`).
- `ZipDecoder().decodeBytes(bytes, verify: true)` at `:28` (bytes) / `:38` (path). `verify: true`
  turns a corrupt deflate stream into an error rather than silent garbage (HBK-AUDIT-106 `:25-27`).
- `_extractArchive` `:215-247`: safe path computed once per entry (`:224-229`), implied-parent dirs
  computed (`_archiveDirectoryPaths` `:258-270`), then writes (`:232-240`), then
  `archive.clearSync()` to release buffers (HBK-AUDIT-102 `:242-246`).
- Zip-slip: `_safeArchivePath` `:272-298` validates with `p.canonicalize` but **writes** with
  `p.normalize`. TODO-739 `:277-288`: using the canonicalised path as the write path lower-cased
  `META-INF/container.xml` to `meta-inf/...` on Windows and broke a case-sensitive peer.
- A `File` entry that is also a parent of another entry is treated as a directory
  (`:249-257`, some packers ship zero-byte dir entries without a trailing slash).

### 2.2 container.xml → OPF

- `parseFromExtracted(extractDir)` `:82` is the workhorse; `parseSync` `:24` and
  `parseSyncFromPath` `:35` decode/extract then delegate.
- `_findContainerXml` `:336-347`: `META-INF/container.xml` fast path, then case-insensitive scan
  (`_findChildDir` `:351`, `_findChildFile` `:375`) to rescue legacy lower-cased extractions.
  Errors: `FormatException('Invalid EPUB: missing META-INF/container.xml')` `:85`; `'no rootfile in
  container.xml'` `:92`; `'OPF not found: …'` `:97`.
- `_findRootfilePath` `:422-432` reads `rootfile/@full-path` and percent-decodes it
  (`_decodeHrefPath` `:901-907`, tolerant of malformed escapes).

### 2.3 Namespaced XML (the "whole book fails to import" class)

`_elements` / `_childElement` / `_attribute` at `:410-420` are the only tag-name lookups in the file
and all use `namespace: '*'` (local-name matching). Comment `:399-409`: Calibre 4.x writes
`<opf:package><opf:manifest><opf:item/>`; with qualified-name matching the manifest parsed empty,
every `itemref` was skipped, and the book threw `EPUB spine contains no readable chapters`.

### 2.4 manifest / spine / metadata / cover / TOC

- **manifest** — `_parseManifest` `:436-457`; skips items missing `id`/`href`/`media-type` `:446-448`;
  keeps `properties`; `_ManifestItem` `:910-922`.
- **spine** — `_parseSpine` `:461-544`: `spineIndex` is the true itemref ordinal via `asMap()`
  regardless of skip branch (HBK-AUDIT-103 `:468-473`); only HTML-ish media types via
  `isHtmlMediaType` `:487` (predicate in `epub_book.dart:844-849`, BUG-1203 note `:486`); paths via
  `_resolveWithinExtract` `:827-837`; missing file → skip `:498-501`; `linear` default `'yes'`
  `:503-504`/`:538`; `spreadProperty` from itemref `properties` `:506-514`; `properties="nav"` sets
  `isNav` `:516-527` (TODO-807: kept in the list because removing it would shift every stored index);
  chapters built with `EpubChapter.lazy` `:532-541` (TODO-296 deferred read); empty spine →
  `FormatException('EPUB spine contains no readable chapters')` `:107`.
- **metadata** — `_parseMetadata` `:548-557` returns the first non-empty `<dc:X>` for local-name
  `title`/`creator`/`language` (`:110-113`); title fallback `p.basenameWithoutExtension(extractDir)`
  `:111`.
- **cover** — `_parseCoverHref` `:561-589`, three tiers: EPUB 3 `properties="cover-image"` `:568`,
  EPUB 2 `<meta name="cover" content="id">` `:574-581`, first `image/*` manifest item `:583-587`;
  relative href via `_itemRelHref` `:591-603`.
- **TOC** — `_parseToc` `:607-657`: EPUB 3 nav (`properties` contains `nav`) `:614-634`, then EPUB 2
  NCX via spine `@toc` `:636-655`, else `[]`. `_parseNavDoc` `:660-681` (malformed → log + fall
  through `:676-679`), `_parseNavOl` `:683-730`, `_parseNcx` `:746-762`, `_parseNavPoints` `:764-807`.
  Image-only TOC entries take `alt`/`title` from their image (`_imageLabelWithin` `:734-743`). A
  label-less node drops only itself and promotes children (`:722-727`, `:800-804`) — the old code
  deleted the subtree, surfacing as "chapter list incomplete". Hrefs via `_resolveTocHref` `:850-876`
  (fragment kept, path percent-decoded, HBK-AUDIT-010 `:868-870`).
- **rendition:spread** — `_parseRenditionSpread` `:878-889` (`landscape|both|portrait|none`, else null).
- **resource table** — `:120-134`: every manifest item resolving inside extractDir becomes
  `resources[extractDir-relative posix href] = EpubResource(mediaType, filePath)`; BUG-1218 `:122-124`
  keeps real case in both key and path so the reader interceptor can look the declared media-type up
  by the same construction.
- **language fast path** — `readLanguageSync(filePath)` `:47-64` reads only container + OPF; missing
  anything → null, corrupt zip/XML throws (deliberately not swallowed).
- **CSS discovery** — `discoverCssRelativePaths` `:164-211` reads `text/css` from the OPF instead of
  walking the tree (TODO-1234 `:149-163`); never throws (`:207-210`).

### 2.5 Error / fallback summary

| Failure | Behaviour | Citation |
|---|---|---|
| missing container.xml / no rootfile / no OPF / empty spine | `FormatException` | `epub_parser.dart:85`, `:92`, `:97`, `:107` |
| unresolvable, non-HTML, or absent chapter file | silently skipped | `:479-501` |
| manifest item missing id/href/media-type | silently skipped | `:446-448` |
| malformed nav doc | logged, falls back to NCX, then `[]` | `:676-679` |
| non-UTF-8 chapter/CSS bytes | U+FFFD replacement, never throws | `epub_book.dart:673-682` |
| corrupt deflate | throws (`verify: true`) | `:28`, `:38` |
| legacy lower-cased `meta-inf/` | case-insensitive lookup rescues | `:336-347` |

Reader-side fallback at open: `FormatException` → rebuild `EpubBook` from DB `chaptersJson`
(`reader_fushi_page.dart:2408-2424`, builder `:2677-2740`), then a legacy book `:2412`.

---

## 3. Storage & on-disk layout

### 3.1 Directories

`packages/fushi_engine/lib/epub/epub_storage.dart`: `baseDirectory()` `:34-41` =
`<documents root>/fushi_books` via `enginePaths.documentsRootDirectory()` `:38` (cached `:20`,
`@visibleForTesting` override `:28-31`); `bookDirectory(bookKey)` `:44-52` creates;
`bookPath(bookKey)` `:55-58` does not; `deleteBookDir` `:63-69` and `bookDirExists` `:73-77` take the
**absolute** `extract_dir` value, because pre-v16 books live at `fushi_books/<int id>/` and were never
renamed (`:14-18`).

### 3.2 What is extracted / kept

- **Every ZIP entry is extracted** (`epub_parser.dart:232-240`) — no selective extraction.
- **No standalone `.epub` is kept.** `original.epub` appears *only* in a doc comment
  (`epub_storage.dart:12`); the repo's own statement is in `fushi/lib/src/epub/book_file_location.dart:12-15`
  (BUG-088: sync looked for that file and silently skipped every upload). Uploads re-zip the extract
  dir on the fly: `repackageExtractedEpub` `packages/fushi_engine/lib/sync/epub_repackage.dart:21-34`
  (`includeDirName: false`), with `resolveExtractedEpubRoot` `:43` for rows pointing one level high.
- PDF books keep `document.pdf` + `cover.png` (`pdf_importer.dart:39-42`); manga books keep
  `manga.json` (`book_file_location.dart:22-28`).

### 3.3 Staging, atomic replace, orphan recovery

`EpubImporter` always extracts into `<fushi_books>/.tmp-<millis>` first (`epub_importer.dart:32-33`,
`:71-72`, `:273-274`) because the title/`bookKey` is known only after parsing (`:90-93`). Then
`moveExtractedDirIntoPlace` `:342-389`: target missing → move `:349-352`; target owned by a live row
(compared on `p.canonicalize`) → never touched, use `<target>~2`, `~3`, … `:354-365`; target unowned
(crashed import / failed cleanup) → rename to `<target>.bak-<millis>`, move in, delete `.bak`,
rollback renames the bak back `:367-388` (BUG-564: Linux `rename(2)` onto non-empty target →
`ENOTEMPTY`). `_moveDirInto` `:399-427` falls back to recursive copy + delete on
`FileSystemException` (TODO-1286 `:332-340`: Android fuse/sdcardfs rejects directory renames);
`_copyDirSync` `:432-442` skips symlinks. Any later failure rolls back row + dirs `:217-228`.

### 3.4 DB rows written

`_persistParsed` `:94-229`: `chaptersJson` `:108`/`:237-254`; `tocJson` `:110-119`; title fallback
when the OPF title equals the staging-dir basename `:121-124`; duplicate resolution `:127-132`;
`bookKey = sanitizeTtuFilename(storedTitle)` `:137` (the primary key); move `:149-167`;
`db.insertEpubBook(...)` `:170-197` (title, author, `coverPath = book.coverHref`, `epubPath =
fileName`, `extractDir`, `chapterCount`, `chaptersJson`, `tocJson`, `importedAt`, `sourceId`,
`language`); `addActivityEvent('added')` best-effort `:202-214`. Other writers:
`rebuildExtractedInPlace` `:268-297` (parse a generated `.epub` into a temp dir and atomically swap
it into a **live** book's own `extractDir`, preserving identity/collections/tags/progress — the only
caller is subtitle re-import, `:256-267`); `reparseExtractedBook` `:305-314` (recompute
`(chapterCount, chaptersJson, coverPath)` from the extract tree for manga→book, `:299-304`).

### 3.5 Sidecars

- **CSS backups**: the CSS editor writes `<abs>.original` next to each book CSS file —
  `fushi/lib/src/epub/book_css_repository.dart:26` `originalPath`, `:27` `hasOriginal`, `:148-175`
  `saveCss` (temp+rename, creates `.original` on first edit), `:177-186` `resetFile`.
- **Import sidecars** are read from the source dir, never written into the book:
  `findSidecars` `fushi/lib/src/media/import/sidecar_finder.dart:117-146`, rules in
  `selectSidecarNames` `:67-111` (subtitle must share the exact stem, chosen by
  `_subtitleExtPriority` `:20-26`; audio matches exact stem or `stem<sep|digit>` multipart,
  `_multipartSuffix` `:40`; `.mp4` excluded `:47`); IO errors → empty, never throws `:143-145`.
- Per-book user CSS also lives in DB `book_custom_css`
  (`packages/fushi_core/lib/src/database/tables.dart:1235`).

### 3.6 Concrete tree

```
<documents>/fushi_books/
├─ .tmp-1731000000000/                  # staging (moved/deleted on success)
├─ 転生したらスライムだった件 (3)/       # bookKey = sanitizeTtuFilename(storedTitle)
│  ├─ mimetype
│  ├─ META-INF/container.xml
│  ├─ OEBPS/content.opf
│  ├─ OEBPS/toc.ncx                    # or nav.xhtml (EPUB 3)
│  ├─ OEBPS/text/ch01.xhtml …          # one spine document per chapter (lazy read)
│  ├─ OEBPS/images/p001.jpg
│  └─ OEBPS/styles/style.css[.original] # .original only after the CSS editor edits it
├─ スライム (3)~2/                      # sibling when the key-named dir is owned by a live row
├─ My PDF Book/                        # format='pdf': document.pdf + cover.png
├─ My Scanned Book/                    # format='manga': manga.json
└─ 42/                                 # legacy pre-v16 int-named dir, never renamed
```

A book whose title literally is `42` produces the same folder shape — which is exactly why
`extract_dir`, not the folder name, is authoritative (`epub_storage.dart:14-18`).

---

## 4. Data model

### 4.1 `EpubBooks` (`packages/fushi_core/lib/src/database/tables.dart:435-497`)

| Column | Type | Null | Notes / citation |
|---|---|---|---|
| `book_key` | text PK | no | `sanitizeTtuFilename(title)`; cross-device identity (`:436-437`, PK `:496`) |
| `uid` | text | no, default `''` | v81 machine-local immutable id, generated in `insertEpubBook` if absent (`:439-449`) |
| `title` | text | no | stored (possibly suffixed) title (`:450`) |
| `author` | text | yes | OPF `dc:creator` (`:451`) |
| `cover_path` | text | yes | EPUB = extract-dir-relative href, from `book.coverHref` (`epub_importer.dart:176-178`); PDF = relative `cover.png` |
| `epub_path` | text | no | original file name only; PDF = `document.pdf`; manga = `manga.json` (`:453`, `book_file_location.dart:22-28`) |
| `extract_dir` | text | no | **absolute**; the truth for locating an existing book (`:454`, `epub_storage.dart:14-18`) |
| `chapter_count` | int | no | `:455` |
| `chapters_json` | text | no | the only serialization contract (`:456`) |
| `toc_json` | text | yes | `[{title, href}]` (`:457`) |
| `source_metadata` | text | yes | `:458` |
| `imported_at` | int | no | epoch ms (`:459`) |
| `language` | text | yes | v87 BCP-47 from OPF `dc:language`, user-overridable; null = don't guess (`:461-469`) |
| `format` | text | no, default `'epub'` | `epub` / `pdf` / `manga` (`:471-476`) |
| `manga_reading_mode` | text | yes | `spread`/`webtoon`, manga only (`:478-482`) |
| `completed_at` | datetime | yes | manual or auto on last page (`:484-487`) |
| `source_id` | int FK → `media_sources.id` | yes | on delete set null (`:489-493`) |

`chapters_json` element shape is fixed by `buildChaptersJson` (`epub_importer.dart:237-254`):
`{id, href, mediaType, characters, charCaliber}`, `charCaliber = kChapterCharCountCaliber`
(currently `4`, `epub_book.dart:811`). The doc comment at `epub_importer.dart:231-236` calls it the
**only** contract and warns that field-name or caliber drift silently breaks shelf word counts.

Thin projection `EpubBookMeta` (`packages/fushi_core/lib/src/database/epub_book_meta.dart:8-31`)
deliberately omits the three large TEXT columns (`:1-7`); `getEpubBookMetas`
`database_content_misc.part.dart:94-121`; `insertEpubBook` `:179-196` (generates `uid` and clears
book + sync-deletion tombstones in one transaction, `:186-194`); `deleteEpubBook` `:1052`.

### 4.2 Reading position — `ReaderPositions` (`tables.dart:122-136`)

| Column | Type | Notes / citation |
|---|---|---|
| `id` | int autoincrement | `:123` |
| `book_uid` | text UNIQUE | v82 = `EpubBooks.uid`; deliberately no SQL FK, orphan defence is application-level (`:125-128`) |
| `section_index` | int | spine chapter index (`:129`) |
| `norm_char_offset` | int | quantised fraction 0–10000 (`:130`) |
| `char_offset` | int, default `-1` | exact in-chapter offset; `-1` = none → fraction fallback (`:131-134`) |
| `updated_at` | int | epoch ms (`:135`) |

`getReaderPosition` `database_library.part.dart:1282-1284`, `getAllReaderPositions` `:1288-1289`,
`upsertReaderPosition` (upsert on `book_uid`) `:1291-1298`, `deleteReaderPosition` `:1300-1301`.
Model/repository: `ReaderPositionRepository`
`packages/fushi_audio/lib/src/audiobook/reader_position_repository.dart:7`, `save` `:26-64`
(§8.2).

### 4.3 Other rows a novel touches

| Table | Key columns | Writer |
|---|---|---|
| `BookCustomCss` `tables.dart:1235` | per-book custom CSS | CSS editor |
| `Bookmarks` `:140-153` | `book_uid`, `section_index`, `norm_char_offset`, `label`, optional page counters | bookmark sheet |
| `RevealedImages` `:1293` | book uid + normalised image key | `onImageRevealed` (`webview.part.dart:2477-2500`) |
| `ReadingStatistics` `:157-177` | unique `(title, date_key)`; `characters_read`, `reading_time_ms`, `pages_read` | stats pipeline |
| `ActivityEvents` `:243-261` | `event_type`, `media_type`, `title`, `media_key`, `date_key`, `timestamp_ms` | import (`epub_importer.dart:202-214`) |
| `SrtBooks` `:102-118` | `uid`, `title`, `srt_path`, `audio_paths_json`, `book_key` (empty-string sentinel) | subtitle import (`book_import_dialog.dart:1074-1102`) |
| `Audiobooks`/`AudioCues` `:72-98` | `book_key`; cues by `book_key`+`chapter_href`+`sentence_index` | alignment service |
| `BookTombstones` `:1170` | `book_key`, `deleted_at` | delete / re-add (`database_content_misc.part.dart:222-239`) |

Schema version/migrations: **not found** as a single `schemaVersion` of relevance; history lives in
the `vNN:` column comments (`tables.dart:439`, `:461`, `:471`, `:478`, `:489`, `:1170`, `:1293`) and
the Drift output `database.g.dart`.

---

## 5. Rendering — the WebView reader

### 5.1 Package and platform matrix

`flutter_inappwebview: ^6.1.5` (`fushi/pubspec.yaml:90`) plus two forks: workspace path dep
`packages/flutter_inappwebview_windows` (root `pubspec.yaml:22`) and
`third_party/flutter_inappwebview_android` (override `pubspec.yaml:63-64`, rationale `:59-62`).
`InAppWebView` constructed at
`fushi/lib/src/pages/implementations/reader_fushi/webview.part.dart:1747`. **Linux is unsupported**
(`webview.part.dart:1729-1742`). Virtual host `kReaderResourceHost = 'fushi.local'`
(`packages/fushi_engine/lib/epub/reader_resource_host.dart:9`); scheme `fushi-reader` on macOS/iOS
(`fushi/lib/src/reader/reader_settings.dart:994`), `https` elsewhere
(`reader_fushi_source.dart:244-250`). Reader classes `ReaderFushiPage` / `_ReaderFushiPageState`
(`reader_fushi_page.dart:1281`, `:1367`) split into eight `part` files (`:167-174`).

### 5.2 Serving HTML/CSS/resources

**No local HTTP server.** The virtual host is intercepted:

- macOS/iOS: WKWebView custom scheme — `_usesReaderResourceCustomScheme` `webview.part.dart:67-68`,
  `resourceCustomSchemes` + `useShouldInterceptRequest:
  !_usesReaderResourceCustomScheme` `:1901-1904`, callback `onLoadResourceWithCustomScheme` `:2674-2676`
  → `_loadResourceWithCustomScheme` `:277-298`. WKWebView cannot intercept `http(s)` subresources
  (`fushi/lib/src/media/manga/reader/manga_fushi_page.dart:383`), hence the scheme.
- Android/Windows: `shouldInterceptRequest` `:2671-2673` → `_interceptRequest` `:258-275`.
- Both reach `_readerResourcePayload(WebUri)` `:110-256`:
  - `/fonts/<path>`: traversal check via `safeCustomFontPath` **plus** a whitelist of configured
    custom fonts (`:113-157`); magic-byte validation `:139` (predicate
    `reader_fushi_page.dart:1178-1186`).
  - `/epub/<path>`: decoded, joined with `_extractDir`, boundary-checked with `p.canonicalize` but
    **read** with `p.normalize` to preserve case (`:162-179`, BUG-1218); content type from the
    **OPF-declared** media-type first, extension second (`:196-211`) and both HTML-ish → served as
    `text/html`. The `:207-210` comment is emphatic: never return `application/xhtml+xml` (strict XML
    parsing turns publisher well-formedness bugs into a whole-page error and defeats `sanitizeXhtml`).
  - CSS sanitized once + cached `:213-226`; HTML sanitized + style-injected through an LRU
    (`_chapterHtmlBytes` `:305-317`, `_putChapterHtml` `:335-342`).
  - Images `Cache-Control: max-age=3600`, HTML/CSS `no-cache` because their bytes change with style
    (`:237-254`).
- Prefetch: bytes `_prefetchAdjacentChapter` `:481-517`; images
  `_prefetchAdjacentChapterImages` `:550-586` (count + byte budget).
- Internal URLs are never handed to the OS: `isExternalUrl` `reader_fushi_source.dart:265-271`
  (BUG-097 `:260-264`).

### 5.3 Served-HTML pipeline

`_buildSanitizedChapterHtmlBytes(rawData, chapterIndex:)` `webview.part.dart:349-393`:

1. `utf8.decode(..., allowMalformed: true)` `:353`.
2. `ReaderResourceSanitizer.sanitizeXhtml(html)` `:354` — every self-closing **non-void** element
   becomes a paired tag. BUG-079 (`<script/>` swallows `<body>` → blank page) and BUG-737
   (`<a id="toc-1"/>` adopts all following prose, after which `selectText` bails on `closest('a')`
   and the chapter is un-lookupable). Implementation/rationale
   `reader_resource_sanitizer.dart:30-55`, `:118-133`; void set `:12-28`.
3. `markImagesLazy(html, eagerAll: isImageOnlyChapter)` `:362-365` — `loading="lazy"
   decoding="async"` written into the **source bytes**, because JS injected after `load` is too late
   (`reader_resource_sanitizer.dart:72-90`). Exceptions: image-only chapter (eager), `class` contains
   `gaiji`, tag already has `loading=` (`:91-100`).
4. `_injectMergedChapterImages` `:371` / `:409-450` prepends absorbed single-image chapters' images
   with explicit `loading="eager"` so correctness does not depend on call order (`:430-435`).
5. Cloak style first, reader style last so it wins `!important` ties `:372-392`.

### 5.4 Style / theme / font

`fushi/lib/src/reader/reader_content_styles.dart`: `styleTag` `:147-175` wraps `css` `:235-…`;
theme colours + E-ink override (`_einkOverrideCss` `:841`); selection colour pre-composited **opaque**
over the background so dictionary and audio highlights don't stack (`:272-278`, BUG-125/BUG-123);
body font chain `_bodyFontFamily` `:221-233` (user font → language serif chain `:222-226` → bare
`serif`; unknown language → don't guess `:177-182`); Apple-only ruby line-box fix `:211-219`
(BUG-2472/BUG-2482). Settings knobs in `fushi/lib/src/reader/reader_settings.dart`: `lineHeight`
`:240`, `writingMode` default `'vertical-rl'` `:242`, `viewMode` default `'paginated'` `:245`,
`theme` `:305`, `furiganaMode` four states `:311-341`. Live updates are referenced at
`webview.part.dart:17-19`; the chapter LRU is invalidated per style change with a `_styleEpoch` guard
(`webview.part.dart:228-235`, `:488`, `:502`).

### 5.5 Pagination

CSS multi-column + programmatic scroll, driven by injected JS.

- CSS `_paginatedLayoutCss` `reader_content_styles.dart:931-1045`: `html, body { overflow:hidden;
  width/height = --page-width/--page-height; writing-mode: <setting> !important; touch-action:none
  !important }` `:955-971`; `body { column-width: …; column-gap: 22px; column-fill: auto; padding: …;
  clip-path: inset(…) }` `:988-1016`.
- Geometry: horizontal column width = content box, split across `pageColumns` by
  `columnWidthForColumns` `:109-119`; vertical column height =
  `max(fontSizePx, viewportHeight − margins − chrome insets)` `verticalColumnWidthCss` `:92-97`
  (algebraic twin `verticalColumnContentHeight` `:130-145`). `column-gap` is a fixed constant
  (`ReaderLayoutDefaults.columnGapPx`, used `:325`) and deliberately does **not** carry margins /
  font size / chrome insets — TODO-729 `:318-324` (that made the pitch drift from the real column
  period and produced half-page jumps plus premature chapter turns).
- JS (`fushi/lib/src/reader/reader_pagination_scripts.dart`): `getScrollContext()` `:2287` returns
  `{vertical, scrollEl, pageSize, maxScroll, physicalMaxScroll, viewportExtent, contentStart,
  columnGap}`; `pageSize` from `getComputedStyle(body).columnWidth` + gap `:2300-2359`; `contentStart`
  = leading padding on the turn axis `:2391-2393`. `getPagePosition`/`setPagePosition` `:2407-2439`
  read/write `scrollLeft` (horizontal) or `scrollTop` (vertical) and re-lock the root viewport
  `:2410-2426`. `registerSnapScroll` `:2441-2463` cancels native drift. `alignToPage` `:2465-2499`
  applies a phase correction (`−contentStart`) plus a `columnGap` tolerance — TODO-753/792 and
  BUG-2325 (sub-pixel column-period accumulation at fractional DPR) documented `:2466-2495`.
  `paginate(direction)` `:2907-2954` returns `"scrolled"` or `"limit"`; Dart turns the chapter when
  it sees `limit`.
- Pure-Dart shadows of the JS maths exist for unit tests (`:345-352`, notes `:2924-2938`).
- Modes: `paginated` (default), `continuous`, `vn` — `ReaderSettings.isContinuousMode`
  `reader_settings.dart:248-253`, `isVnMode` `reader_settings.dart:256-259`; layout CSS
  `reader_content_styles.dart:931` (`_paginatedLayoutCss`), `:1053` (`_vnLayoutCss`), `:1140`
  (`_continuousLayoutCss`); separate JS shells (`reader_pagination_scripts.dart` `paginate` at
  `:2907` and `:3558`).
- Spread rendering is a **separate document** (`buildSpreadPageHtml`, referenced
  `webview.part.dart:2208`, `:3094-3104`) with its own bridges (`spreadReady` `:2547`,
  `onSpreadTapEmpty` `:2217`, `onSpreadKey` `:2247`). Pairing rules in
  `fushi/lib/src/epub/epub_spread_map.dart:95-116` and `:241-279`; edge comparator
  `fushi/lib/src/epub/epub_edge_matcher.dart:19-54` (threshold 0.85 `:10`); isolate analyser + prefs
  cache `fushi/lib/src/epub/epub_spread_analyzer.dart:20-85` (key `spread_match:<bookId>` `:17`).

### 5.6 Engine injection

The engine JS is a static zero-interpolation bundle: `readerEngineSource({vnMode, continuousMode})`
`webview.part.dart:1694-1710` memoizes per mode and runs `ReaderScriptCompactor.compact`. Rationale
(BUG-1140 phase 2①): the old code interpolated ~145 K chars per navigation, forcing a full JS
re-parse with no V8 code cache (`fushi/lib/src/reader/reader_engine_config.dart:5-22`). Per-nav values
travel as one JSON `ReaderEngineConfig` (`reader_engine_config.dart:24`, fields `:27-70`), booted with
`window.__fushiEngine.install(window.__fushiReaderConfig)` (`webview.part.dart:1716-1718`). Injection
happens in `_onChapterLoadComplete` `:2896`, one `evaluateJavascript('$engineSource\n${boot}')`
`:3004-3008`; a JS-error hook is installed as a document-start user script `:1874-1879`. Install order
inside the IIFE: margins `:778-794`, selection scripts (`ReaderSelectionScripts.source()` `:744`),
pagination shell `:751-756`, `__fushiInstallShell` `:797`, caret `:801-806`, gesture/tap listeners. The
cloak removal is guaranteed even if a synchronous statement throws (BUG-1017 `:763-772`) — otherwise a
stale `body{visibility:hidden}` leaves a permanently blank book.

### 5.7 RTL / vertical writing

Writing mode is a **user setting**, not derived from the book's language:
`ReaderSettings.writingMode` default `'vertical-rl'` (`reader_settings.dart:242`), applied verbatim in
all three shells (`reader_content_styles.dart:964`, `:1083`, `:1190`);
`startsWith('vertical')` gates vertical geometry `:295`. RTL *reading* direction is exactly
`writingMode == 'vertical-rl'`: `_isRtlReading` `reader_fushi_page.dart:1462-1465` (BUG-099). Arrow
keys flip via `resolveReaderArrowPageTurn(leftIsForward = rtl ^ reverse)`
(`webview.part.dart:2276-2279`); swipe flips via `swipeLeftIsForward(invert, rtl)` `:2280-2283`. The
pagination axis follows the mode (`reader_pagination_scripts.dart:2382-2393`, `:2407-2408`). The book's
own `-epub-writing-mode: writing-mode` is **deleted** and reader-controlled
(`reader_resource_sanitizer.dart:142-143`), while `line-break`/`word-break`/`hyphens`/`text-combine`/
`text-emphasis-*` get `-webkit-` prefixes (`:144-152`). Ruby ownership and vertical run-in notes at
`reader_content_styles.dart:633-659`; furigana CSS from `:1223`.

---

## 6. Selection & lookup — tap on a word → dictionary query

### 6.1 Chain overview

```
pointer (click / tap / shift-hover / long-press drag)
  → JS gesture listener in the injected engine (webview.part.dart IIFE)
    → fushiSelection.selectText(x, y, maxLen, fromHover)     reader_selection_scripts.dart:1153
      → getCharacterAtPoint(x, y)                            :654
        → getCaretRange(x, y, box)                           :581
      → selectFromPosition(node, offset, maxLen, x, y)       :1216   (forward scan, ≤400 chars)
        → buildSelectionPayload(x, y)                        :1274
      → fireTextSelected → callHandler('onTextSelected', json)  :1381-1385
  → Dart 'onTextSelected'                                    webview.part.dart:1984
    → _handleTextSelected(ReaderSelectionData.fromJson(...)) lookup.part.dart:141
      → _runLookupAndHighlight(text, rect)                   reader_fushi_page.dart:4104
        → searchDictionaryResult(term, rect, deferDisplay:true)  base_source_page.dart:314
          → appModel.searchDictionary(...)                   app_model.dart:5901
            → FushiDicts.instance.lookup(term, maxResults)   app_model.dart:6004
  → _highlightAndShowPopup → highlight eval + popup           lookup.part.dart:100
```

### 6.2 Gesture bridges

| Handler | Registration | Trigger |
|---|---|---|
| `onTextSelected` | `webview.part.dart:1984` | `fireTextSelected` (`reader_selection_scripts.dart:1384`) |
| `onSelectionMenu` | `:2007` | `fireSelectionMenu` (`reader_selection_scripts.dart:1396`) |
| `onTap` | `:2085` | `_gestureEnd` fallback when the tap gate is missing/closed (`webview.part.dart:1187`) |
| `onTapEmpty` | `:2135` | `selectText` hit nothing, `fromHover == false` (`reader_selection_scripts.dart:1173-1175`) |
| `onShiftHover` | `:2118` | JS `mousemove` leg (`webview.part.dart:1537-1547`) |
| `onPointerHoverReveal` | `:2113` | JS `pointermove` leg, chrome only (`:1527-1535`) |
| `onInternalLink` | `:2077` | JS document `click` on `a[href]` (`:1199-1210`) |
| `onImageTap`/`onImageContextMenu`/`onImageLongPress` | `:2502`/`:2525`/`:2539` | image gestures |
| `onSpreadTapEmpty`/`spreadReady`/`onSpreadKey` | `:2217`/`:2547`/`:2247` | spread document |
| `onCueTap`/`onPointerSeek`/`onLyricsPointerSeek` | `:2580`/`:2598`/`:2637` | audiobook / mouse bindings |

Fast path: if the JS-side mirror `window.__fushiTapGate {chrome, lookup, maxLen}` says chrome is
visible and tap-lookup is on, JS calls `fushiSelection.selectText` directly and skips the bridge
(`webview.part.dart:1176-1188`); otherwise the old `onTap → Dart → evaluateJavascript` route runs. The
mirror is written only by Dart (`_syncTapGateJs` `lookup.part.dart:54-71`, BUG-712 ① `:48-53`).

### 6.3 Point → character

`reader_selection_scripts.dart`: `visibleContentBox()` `:509-531` = body content box ∩ viewport
(BUG-1797 `:493-508`: paged mode puts adjacent pages physically in the body padding band, so
`caretPositionFromPoint` clamps a margin tap onto the neighbouring page). `charRangeVisible` `:538-552`
requires positive-area intersection. `inCharRange` `:553-568`, `charRangeDistanceSq` `:570-578`.
`getCaretRange` `:581-653`: (1) `caretPositionFromPoint` fast path only when it lands on a text node
`:591-602`; (2) `elementFromPoint` → nearest container → per-character exact + visibility test
`:603-620`; (3) nearest character within `max(6, size/2)` `:621-651` (TODO-916 ④); (4) last resort
`caretRangeFromPoint` `:652`. `getCharacterAtPoint` `:654-686` tries offsets `[caret, caret−1,
caret+1]` with pads `[0, 6]`, rejects furigana (`isFurigana` `:447-450`) and scan boundaries `:680-681`.

### 6.4 Forward scan

`selectText` `:1153-1208`: bail on `<a>` `:1154-1156` (BUG-737's reason); if `!fromHover`, a hidden
furigana ruby is *revealed* instead of looked up `:1157-1166`; no hit → clear, and fire `onTapEmpty`
only for real clicks `:1167-1177`; hover de-dup against the live matched ranges/wrappers `:1180-1194`;
same start position → no-op for hover, toggle-off for click `:1195-1205`; else `clearSelection()` then
`selectFromPosition` `:1206-1207`. `selectFromPosition` `:1216-1267`: non-Japanese hits rewind left to
the token start `:1220-1224`; walk forward across text nodes up to `maxLength` `:1232-1263`; stop at
`isScanStop` (`scanDelimiters.includes(char) || (scanNonJapaneseText===false &&
!isCodePointJapanese(...))`, `:402-405`); cross intra-word apostrophes (BUG-2056 `:410-446`); bridge
**one** intra-node whitespace under strict conditions so `listen to` can be a phrase entry without
gluing paragraphs (BUG-1773 `:386-398`, `:1244-1255`); store
`{startNode, startOffset, ranges, text}` `:1265`. `maxLength` is 400, set by Dart
(`lookup.part.dart:29`) and mirrored in the tap gate (`:62`).

### 6.5 Payload

`buildSelectionPayload(x, y)` `:1274-1378` is the single builder shared by tap, selection menu and
drag→lookup (`:1268-1273`). It emits `text`; `sentence` + `sentenceOffset` from
`getSentenceContext` `:687-…` scoped by `findParagraph` `:470-478` with `BLOCK_SELECTOR` `:469`
(TODO-956: extended blocks, never falls back to `document.body`); `rect` (`getSelectionRect` `:1366`,
manga group box `:1298-1333`); `normalizedOffset/Length` and sentence equivalents via
`getNormalizedOffset` `:1334-1350` (only when `window.fushiReader` exists); the separate UTF-16
`matchable*` offsets for audio `:1351-1357`; `audioCuePayload` from
`cueIdAtDomPoint(startNode, startOffset)` `:1367-1368`; `verticalWriting`/`mangaPageIndex` `:1285-1307`.
Sent as `callHandler('onTextSelected', JSON.stringify(payload))` `:1384`.

Dart reconstructs it with `ReaderSelectionData.fromJson`
(`fushi/lib/src/reader/reader_selection_data.dart:20-52`); field semantics and the explicit
learning-unit vs audio-matchable distinction at `:54-88`.

### 6.6 Dart: payload → popup

`_handleTextSelected` `fushi/lib/src/pages/implementations/reader_fushi/lookup.part.dart:141-293`:
empty text returns `:142-144`; remove the selection action bar `:145`; clear the mining draft so
context sentences don't leak between words `:146-149` (TODO-393); optional audiobook pause `:151-156`;
`selectionRect` from `data.rect` else screen centre `:158-173`; set `currentSentence` via
`resolveCurrentSentenceText(data.sentence, data.text)` (helper `reader_selection_scripts.dart:32`)
because an empty sentence made 收藏句子 report "no sentence selected" `:179-183` (TODO-956); lyrics
branch `:189-247` resolves the cue from `window.__lyricsCueContext` and returns; otherwise cue
resolution in three tiers — `audioCuePayload` `:256-261`, audio-coordinate `matchableOffset`
`:262-264`, sentence text `:265-267`; then `_runLookupAndHighlight(data.text, selectionRect)` `:270`;
then cache ranges + locked section index `:271-292`.

`_runLookupAndHighlight` `reader_fushi_page.dart:4104-4115`: `prunePopupStack(0)` →
`searchDictionaryResult(term, rect, deferDisplay: true)` → `_highlightAndShowPopup(count, rect)`.

`_highlightAndShowPopup` `lookup.part.dart:100-139` decouples popup display from the highlight eval
(BUG-717 ②): `showDeferredPopup(selectionRect: fallbackRect)` first (the popup is not serialised
behind the busy reader WebView), then the eval's refined word bbox re-anchors via
`reanchorTopPopup(rect, generation)` with a generation guard `:114-126`. Both `evaluateJavascript`
calls are individually try/caught because a half-disposed WebView throws `MissingPluginException`
(TODO-678/BUG-005 `:40-44`, `:128-132`).

`searchDictionaryResult` `fushi/lib/src/pages/base_source_page.dart:314-407`: bumps
`_searchGeneration` + stores the pending rect `:322-324`; `appModel.searchDictionary(searchTerm,
searchWithWildcards: false, overrideMaximumTerms: ...)` `:331-335`; drops stale results `:337`; pushes
history `:339`; `_popup.beginTop(term:, rect:, reuseWarmSlot: reuse, visible: false)` where `reuse`
requires exactly one hidden warm slot `:343-352`; `_popup.fillResult(item, result:,
allLoaded: !result.truncated)` `:359-363`; `deferDisplay` stores the item for `showDeferredPopup`
`:371-373`, otherwise shows with a render cover `:374-375` or immediately when reusing the warm slot
`:376-377`; `highlightCount = lookupHighlightCharCount(result:, searchTerm:, language:
JapaneseLanguage.instance)` `:382-386` (this is what JS is later told to highlight); optional
auto-read `:388-396`. `showDeferredPopup` `:533-554`; generation-checked `reanchorTopPopup` `:564-569`;
`prunePopupStack` `:1578`.

### 6.7 Highlighting

`highlightInvocation(count)` `reader_selection_scripts.dart:46-47` →
`window.fushiSelection.highlightSelection(count)`; the returned rect is parsed by
`highlightRectFromResult` `:290-308` (used `lookup.part.dart:122-125`). `highlightSelection` `:1721-…`;
CSS Custom Highlight API when available (`window.__fushiCssHighlightsSupported` `:359`), fallback
forces `buildNodeOffsets()` `:1873-1875`. App-drawn selection visuals: highlight name
`fushi-selection`, wrappers `.fushi-dict-highlight` `:1184`, `:369`, `:1455-1459`.

### 6.8 Hover lookup (two mutually exclusive legs)

**JS leg** (Android/Windows/Linux/iOS): `document.mousemove` fires `onShiftHover` when
`e.shiftKey || window.__hoverAutoLookup`, throttled by an 8 px squared-distance anchor
(`webview.part.dart:1536-1547`); Dart `onShiftHover` `:2118-2133` → `_selectTextAt(x, y, fromHover:
true)`. **Host leg** (macOS only): WebKit's mouse-tracking hit test against Flutter's mutator view
means the page never sees `mousemove` (BUG-2508
`fushi/lib/src/reader/reader_host_hover_lookup.dart:1-26`); a `MouseRegion` around the WebView
(`hostOwnsWebViewHoverLookup`, `webview.part.dart:2793-2808`) feeds
`ReaderHostHoverLookupGate.shouldLookup(...)` `reader_host_hover_lookup.dart:38-52` — same 8 px
threshold `:30`, same gating; `readerHostHoverPointInside` `:70-74` keeps out-of-box points from
clearing the selection. The JS leg is disabled via `window.__fushiHostHoverLookup` (`:1529`, `:1539`,
set from `C.hostHoverLookup` `webview.part.dart:817`). Both call `_selectTextAt` `lookup.part.dart:23-46`,
which evaluates `ReaderSelectionScripts.selectInvocation(x, y, 400, fromHover:)`
(`reader_selection_scripts.dart:39-44`).

### 6.9 Long-press drag selection

`longPressDragGestureScript({delayMs, slop})` `reader_selection_scripts.dart:64-150`: document-level
touch listener, arms after the long-press delay, `beginRangeSelection` `:105-106`,
`updateRangeSelection` on move `:120-121`, `endRangeSelection` on release `:139-140`; sets
`window.__fushiTextSelectDragActive` so page turns/boundary swipes yield `:59-60`.
`beginRangeSelection` `:1461-1472` paints the anchor glyph immediately; `updateRangeSelection`
`:1474-1489` builds the range with `collectRangeBetween` `:1416-1450` (orders positions with
`compareDocumentPosition`, walks with `createWalker`, so furigana/whitespace nodes are skipped);
`renderSelectionHighlight` `:1455-1459` re-renders per frame only on the custom-highlight path (the
wrapper fallback mutates the DOM and waits for the post-lookup pass). Release fires
`fireSelectionMenu` → `onSelectionMenu` → Dart `_handleSelectionMenu` (`webview.part.dart:2007-2024`),
which shows the Copy / Lookup bar (TODO-1317 rationale `reader_selection_scripts.dart:1387-1409`).

### 6.10 Popup rendering

The popup is its **own** `InAppWebView`: `DictionaryPopupWebView`
`fushi/lib/src/pages/implementations/dictionary_popup_webview.dart:178`, state `:363`, constructed
`:1624`, document `assets/popup/popup.html` `:1629`. Sub-resources (`popup.css`/`popup.js`/dict fonts)
are served through the same `fushi.local` host by a **separate** interceptor `:1755-1770`, with the
`getDictAsset` bridge `:1793`; font prefix `https://fushi.local/dictfonts/`
(`dictionary_webview_media.dart:34`) and the per-platform capability matrix (Android/Windows
`shouldInterceptRequest` vs Apple `WKURLSchemeHandler`) at `:36-93`. `_pushResults` `:1192-…` re-sends
static settings only when their revision changes, serializes entries with `buildPopupEntriesJs` `:1248`,
then calls `window.updatePopupIncremental()` (load more) or a full `renderPopup` `:1268-…`; the shared
settings body comes from `buildPopupSettingsJs` `:1204-1218`. Popup bridge handlers `:1793-2446`
(`popupRendered`, `tapOutside`, `popupZoomFont`, `scrolledToBottom`, `topPullReleased`, `mineEntry`,
`openInAnki`, `updateEntry`, `duplicateCheck`, `favoriteEntry`, `appendSentence`,
`sentenceContextPreview`, `textSelected`, `onLinkClick`, `resolveWordAudio`, …). Stack/reveal state
machine `fushi/lib/src/pages/implementations/dictionary_popup_controller.dart:125` (entry `:52`, warm
slot `:107`, `beginTop` `:357`, `fillResult` `:468`, `show` `:568`, `reanchorEntry` `:591`,
`markPendingReveal` `:609`); the reader renders it via `buildDictionary()`
`reader_fushi_page.dart:3402` → `base_source_page.dart:741` → `_buildPopupLayer` `:854`. Dismissal is
a full-screen Flutter barrier whose hover feeds continuous lookup on macOS —
`onDismissBarrierHover` `reader_fushi_page.dart:4239-…` with the coordinate mapping TODO-806 and the
gate at `:4227-4236`.

### 6.11 Native lookup call

`app_model.dart:6004-6007`: `FushiDicts.instance.lookup(searchTerm, maxResults: effectiveMaxTerms)`,
preceded by a Dart FFI cache lookup `:5964-5965` and followed by Dart-side popup JSON generation from
the same results `:6018-6023` (rather than re-running the C++ pipeline). Kanji lookups are queried
independently and attached `:5957-5962`, `:6032-6042`. `FushiDicts.lookup` defaults `scanLength = 16`
(`packages/fushi_dictionary/lib/src/engine/fushidicts.dart:632`, call `:640-658`).

---

## 7. Tokenization

Two different tokenizers exist; confusing them is the classic mistake.

### 7.1 Lookup tokenizer = the dictionary engine's longest-prefix scanner (native C++)

There is **no MeCab / Sudachi / kuromoji and no Dart morphological analyzer**. Word boundaries are a
side effect of dictionary matching:

- JS does **not** segment Japanese: `selectFromPosition` scans forward character-by-character up to
  400 chars and stops only at punctuation (`isScanStop` `reader_selection_scripts.dart:402-405`;
  `scanDelimiters` `:371`); non-Japanese hits only rewind to the token start `:1220-1224`. The whole
  scan buffer is handed to Dart.
- Dart passes the raw string to the native engine (`app_model.dart:6004`), which emits candidate
  prefixes and longest-prefix matches them: `scan_candidates(text, scan_length)` at
  `native/fushidicts/fushidicts_src/scan/word_scan.cpp:52-79` walks the window from `scan_length`
  (default 16 code points, `fushidicts.dart:632`) down to 1, refusing a cut between two
  “space-delimited letters” (`boundary_ok` `:67-70`, `is_space_delimited_letter` `:12-42`) so
  Latin/Greek/Cyrillic/Arabic/Hebrew/Armenian/Georgian words are never split, and dropping
  whitespace-terminated prefixes `:71-74`.
- The same contract from the Dart side: `JapaneseLanguage._lookupMatchedLength` at
  `packages/fushi_dictionary/lib/src/language/implementations/japanese_language.dart:52-67` does
  `lookup(text, maxResults: 1)` then `.first.matched.length`.
- Derived segmentation exists but is engine-backed, not independent:
  `JapaneseLanguage.textToWords` `:73-91` walks the string calling `_lookupMatchedLength`, falling
  back to one character (and to per-character when the engine is uninitialised `:74-76`). It serves
  texthooker / the Yomitan API (`app_model.dart:6391`, `:7712`, `yomitan_tokenize_adapter.dart:2-21`),
  **not** reader tap lookup.
- Consequences: boundaries are dictionary-dependent; the query string is a *prefix of the rendered
  text*, not a linguistic token; and a phrase like `listen to` can be one query because the scan
  crosses one whitespace and the engine emits `listen to`/`listen` as candidates (BUG-1773
  `reader_selection_scripts.dart:386-398`).

### 7.2 Alignment with rendered HTML text nodes

There is no per-node tokenization and no token→DOM index; alignment is positional:

- The scan records `ranges: [{node, start, end}]` — the exact text-node spans consumed
  (`reader_selection_scripts.dart:1259`, `:1265`); highlighting, favourites and mining all use those
  ranges or offsets derived from the same walk.
- `getNormalizedOffset(node, offset)` `:1334` converts a node position to a whole-chapter
  learning-unit offset using `window.fushiReader.nodeStartOffsets`, a `WeakMap` built by
  `buildNodeOffsets` (`reader_pagination_scripts.dart:1267-1276`) that accumulates
  `countChars(node.textContent)` `:1274`. Lookup uses the raw offset; persistence uses the normalised
  one — both from one walk, so they cannot disagree about *which* text, only about scale.
- `createWalker` `reader_selection_scripts.dart:479-492` is the shared traversal (`SHOW_TEXT`,
  rejecting furigana `:447-450` and whitespace-only nodes `:485-489`). The Dart counterpart must
  match: `EpubBook._removeRubyAnnotations` `epub_book.dart:151-156` removes `rt, rp, rtc` before
  plain text, as stated at `:85-88`.
- Sentence extraction is deliberately bounded by `findParagraph` (`reader_selection_scripts.dart:470-478`)
  so a sentence can never be the whole document.

### 7.3 Study-unit counting (a third, orthogonal definition)

Progress/statistics use “learning units”, not dictionary tokens: Dart `countStudyChars`
(`packages/fushi_engine/lib/stats/study_char_count.dart`, used by `EpubBook.chapterCharacterCount`
`epub_book.dart:136-138` and `countChapterChars` `reader_fushi_page.dart:1058-1064`); JS
`window.fushiStudyUnits` in `fushi/lib/src/reader/reader_study_unit_script.dart:33-102` (`classify`
`:43-47`, `isUnitEnd` `:57-74`, `count` `:77-98`), entered via
`fushiReader.countChars → fushiStudyUnits.count` (`reader_pagination_scripts.dart:1082-1084`). Parity
is enforced by a node-driven test (`reader_study_unit_script.dart:7-8`); the caliber version lives in
Dart (`kChapterCharCountCaliber = 4`, `epub_book.dart:811`) and the rule “bump the version when the
caliber changes or caches are never recomputed” is stated at `:789-811`. The matching/normalisation
whitelist (`isMatchableChar`/`normalizeText`/`readerRegexNegated`
`reader_pagination_scripts.dart:1075-1087`) is **frozen** and deliberately different from the counting
caliber, because it is the coordinate system for audiobook cue realignment (`foldNormalize`
`:1108-1119`) and image-only classification (`reader_study_unit_script.dart:23-28`).

---

## 8. Progress / anchors / sync

### 8.1 Restore anchor

`fushi/lib/src/reader/reader_restore_anchor.dart`: `ReaderRestoreAnchor` `:41-89` carries `progress`
(chapter fraction), `charOffset` (exact, `-1` = none), `charOffsetEnd` (one-shot, BUG-461) and
`fragment` (one-shot); `isChapterStart` `:69-71`. `restoreAnchorOnLiveProgress` `:99-112` is the only
state transition: while `restoreInFlight` the navigation target is preserved, afterwards live progress
takes ownership and the one-shot fields are dropped. The `:6-39` comment explains the bug: the anchor
used to be written only at navigation start, so a WebView rebuild after scrolling restored to the
chapter start and then persisted that regression. Reader fields: `_initialProgress`,
`_initialCharOffset`, `_initialCharOffsetEnd`, `_initialFragment`
(`reader_fushi_page.dart:1487-1494`), `_restoreInFlight` `:1480`.

### 8.2 Save

JS reports via `calculateProgress()` (`reader_pagination_scripts.dart:2660` paged, `:3439` other),
called from Dart at `:795`. `readerPositionSaveArgs({progress, charOffset})`
`reader_fushi_page.dart:1148-1156` quantises `normCharOffset = (progress*10000).round()` and maps
`charOffset < 0 → null`; the `-1` vs `null` distinction is load-bearing because `null` is what lets
`save` preserve an existing exact anchor — `-1` would overwrite it (BUG-285 history `:1140-1147`).
`_persistPosition` `fushi/lib/src/pages/implementations/reader_fushi/navigation.part.dart:1423-1497`:
suppressed during temporary jumps (`_suppressPositionPersist`, BUG-459) `:1430-1432`; requires a
resolved `_bookUid` (v82 key) and otherwise skips rather than writing an orphan `bookKey` row
`:1433-1439`; `ReaderPositionRepository(db).save(...)` `:1452-1468`, fail-open on error `:1469-1472`;
auto-marks completion on last chapter at progress ≥ 0.999, idempotently `:1479-1490`; forwards to media
tracking `:1491-1496`. `ReaderPositionRepository.save`
`packages/fushi_audio/lib/src/audiobook/reader_position_repository.dart:26-64` encodes the
exact-vs-fraction invariant: with no new exact anchor the stored anchor is preserved only if the
section is unchanged **and** the fraction has not moved, otherwise invalidated to `-1` `:47-56`; the
reasoning (a stale exact anchor wins on restore and lands the user at an old position) at `:34-46`.

### 8.3 Restore

On open the reader locates the book row, then queries the saved position in parallel with profile
settings and EPUB parsing (`reader_fushi_page.dart:2333-2354`), keyed by `EpubBooks.uid`. Conversion to
`_initialProgress`/`_initialCharOffset` at `:2549-2551` (`normCharOffset / 10000.0`,
`charOffset ?? -1`). The anchor travels to JS as `ReaderEngineConfig.initialProgress` /
`initialCharOffset` / `initialCharOffsetEnd` / `initialFragment` (`reader_engine_config.dart:53-56`);
the shell's ladder is `initialFragment → initialCharOffset (→ initialCharOffsetEnd) → restoreProgress`
(`reader_pagination_scripts.dart:1978-2001`). Completion is confirmed by
`onRestoreComplete(perfSnapshot, generation)` (`webview.part.dart:2026-2047`), which refuses
stale/mismatched generations. Late image loads re-anchor via `registerImageLateAnchor` /
`forceLoadPendingImages` (`reader_pagination_scripts.dart:1176-1189`, TODO-1349 / TODO-1229 案B).

### 8.4 Sync

Cross-device identity is `bookKey` (`sanitizeTtuFilename(title)`), **not** `uid` (`tables.dart:436-449`);
local child tables key on `uid` (v82 notes `:125-128`, `:143-145`). Because no `.epub` exists on disk,
transfer re-packages the extract dir (`epub_repackage.dart:21`) and `epubPath` must never be joined
with `extractDir` to locate a book (BUG-088, `book_file_location.dart:12-15`). Progress rows are also
written directly by the sync layer: `fushi/lib/src/sync/sync_manager.dart:536`,
`interconnect_book_progress_sync.dart:123`, `reader_history/remote.part.dart:856`. Re-adding a book
clears both tombstones in the insert transaction (`database_content_misc.part.dart:186-194`).

---

## 9. Dependencies

### 9.1 Document pipeline (Dart + pub)

| Package | Pin | Use | Citation |
|---|---|---|---|
| `archive` | `^3.6.1` | ZIP decode/extract; re-packaging for sync | `fushi/pubspec.yaml:32`, `packages/fushi_engine/pubspec.yaml:32`, `epub_parser.dart:28` |
| `xml` | `^6.3.0` | container/OPF/NCX/nav parsing | `packages/fushi_engine/pubspec.yaml`, `epub_parser.dart:6` |
| `html` | `^0.15.2` | chapter DOM parse (plain text, ruby, images) | `fushi/pubspec.yaml:106`, `epub_book.dart:7-8` |
| `path` | `^1.8.2` | canonicalize/normalize discipline | `epub_parser.dart:5` |
| `drift` | `>=2.33.0 <2.34.0` | DB | `fushi/pubspec.yaml` (drift entry) |
| `image` | `^4.3.0` | spread edge comparison | `epub_edge_matcher.dart:3` |
| `engine_paths` (internal) | — | documents root for `fushi_books` | `epub_storage.dart:38` |

### 9.2 Rendering

| Package | Pin | Use | Citation |
|---|---|---|---|
| `flutter_inappwebview` | `^6.1.5` | reader + popup WebViews | `fushi/pubspec.yaml:90` |
| `flutter_inappwebview_windows` | path dep (vendored fork) | Windows WebView2 | root `pubspec.yaml:22` |
| `flutter_inappwebview_android` | path dep (`third_party/`) | Android backend | root `pubspec.yaml:59-64` |
| `pdfrx` | pinned `2.4.5` | PDF rendering only | `fushi/pubspec.yaml:130-132` |
| `kana_kit` | `^2.0.0` | kana/kanji helpers | `japanese_language.dart:6` |

`pdfrx` is held at 2.4.5 because ≥2.4.6 pulls `image ^4.8.0` → `archive ^4.0.7` / `xml ^7.0.1`, which
would force an `archive` major migration for the EPUB parser (`fushi/pubspec.yaml:130-132`; the same
class of constraint at `:23-31`).

### 9.3 Native

- **`libfushidicts_ffi`** — the dictionary/tokenizer engine, loaded per platform at
  `packages/fushi_dictionary/lib/src/ffi/fushidicts_ffi_bindings.dart:7-10`
  (`libfushidicts_ffi.so` Android/Linux, `fushidicts_ffi.dll` Windows, `libfushidicts_ffi.dylib`
  macOS). Source in `native/fushidicts/` (`CMakeLists.txt`), including
  `fushidicts_src/scan/word_scan.cpp` and vendored `zstd`/`libdeflate`/`xxHash`/`utf8proc`/`glaze`/
  `unordered_dense`/`utfcpp`.
- `pdfrx` bundles PDFium (PDF path only). No MeCab / ONNX model / native tokenizer is involved in the
  novel lookup path; ONNX is the manga-OCR / ASR path (`packages/fushi_engine/lib/ocr/manga_ocr_*.dart`).

### 9.4 Assets

Dictionary popup `assets/popup/popup.html` (+ `popup.css`/`popup.js`), referenced
`dictionary_popup_webview.dart:1629`, served through the popup's own interceptor `:1755-1770`. Custom
reader fonts served from `fushi.local/fonts/<path>` with a whitelist
(`webview.part.dart:113-157`); font URL builder `reader_settings.dart:1065-1066`.

---

## 10. Complexity inventory — minimal desktop-only clone

### 10.1 Load-bearing files

`packages/fushi_engine/lib/epub/epub_parser.dart` (all OPF/spine/nav/NCX/cover semantics, namespace
lookup primitives, zip-slip boundary, case-preservation rules) · `epub_book.dart` (`EpubChapter` lazy
read, the single DOM-parse entry + self-closing normalisation, ruby stripping, image-only
classification, link/TOC canonicalisation, MIME predicate) · `epub_importer.dart` (staging, duplicate
policy, key derivation, atomic move, DB row assembly, `chaptersJson`) · `epub_storage.dart` (layout +
"`extract_dir` is truth") · `book_title_conflict.dart` (`DuplicatePolicy` + suffixed uniqueness `:83`) ·
`fushi/lib/src/reader/reader_selection_scripts.dart` (hit test + scan + payload + highlight + drag
select, §6) · `reader_pagination_scripts.dart` (column geometry, page step, alignment/phase, progress
maths, restore ladder) · `reader_content_styles.dart` (whole stylesheet: writing mode, multicol,
clip-path + leak overlay, furigana, vertical ruby) · `reader_resource_sanitizer.dart` (BUG-079/BUG-737
fix, lazy images, EPUB CSS de-prefixing) ·
`fushi/lib/src/pages/implementations/reader_fushi/webview.part.dart` (interception/serving, engine boot,
every bridge, gesture wiring) · `.../lookup.part.dart` (selection → lookup → popup orchestration) ·
`packages/fushi_dictionary/.../japanese_language.dart` + `native/fushidicts/{scan/word_scan.cpp, ffi
bindings}` (the actual tokenizer/dictionary query).

### 10.2 Must have vs optional

**Must have:** (1) ZIP extract + container/OPF/manifest/spine/`dc:*`/cover/TOC (EPUB 2 NCX + EPUB 3
nav); (2) `extractDir = <docs>/fushi_books/<sanitizedTitle>/` + a DB row with `bookKey`,
`chaptersJson`, `tocJson`, `extractDir`, `language` (`epubPath` metadata only); (3) lazy chapter read
+ UTF-8-lenient decode (`decodeEpubText` `epub_book.dart:673`); (4) any WebView with request
interception serving `https://fushi.local/epub/<href>` from `extractDir`, returning `text/html` for
content documents regardless of OPF media-type; (5) `sanitizeXhtml` (self-closing non-void → paired —
without it many real Japanese EPUBs are blank or un-lookupable); (6) CSS multicol pagination: one
scroll axis, `column-fill: auto`, computed page step, `paginate()` reporting `limit` at boundaries;
(7) writing-mode setting (`vertical-rl` default) on the body with turn axis and arrow/swipe direction
derived from it; (8) tap → character hit test (caret API + per-character fallback) → forward scan →
JSON → Dart → dictionary → popup WebView; (9) a dictionary engine with prefix-candidate scanning (a
hash lookup on the 16-codepoint window is **not** equivalent — `word_scan.cpp:52-79`); (10)
`ReaderPositions` (uid, section, normCharOffset, charOffset, updatedAt) with the exact-anchor staleness
rule; (11) ruby on **both** sides — JS skips `rt`/`rp`, Dart strips them for plain text, CSS must own
`ruby-position` (vertical EPUBs otherwise throw furigana the wrong way,
`reader_content_styles.dart:633-659`).

**Optional / droppable for v1:** spread + edge matching + image merge (`epub_spread_map.dart:95-116`);
VN mode (`reader_content_styles.dart:1053`); continuous mode (`reader_pagination_scripts.dart:3439`,
`:3558`); audiobook alignment / cues / lyrics / sasayaki (`reader_fushi/audiobook.part.dart`,
`lyrics.part.dart`); caret word navigation (`reader_caret_scripts.dart`, injected `webview.part.dart:801-806`);
macOS host hover leg (`webview.part.dart:1537-1547`); long-press drag selection + action bar
(`reader_selection_scripts.dart:64-150`); CSS editor + per-book CSS (`book_css_repository.dart`,
`book_custom_css`); image reveal / spoiler blur / image prefetch; E-ink theme, custom fonts, chrome
insets (`_einkOverrideCss` `:841`, font serving `:113-157`); statistics / media tracking; PDF, manga,
subtitle books; sync re-packaging.

### 10.3 Irreducible invariants

**One canonical href form** (case preserved, `../` and percent-encoding normalised — re-derived in four
places with three historical case-folding bugs: `epub_parser.dart:811-848`, `epub_book.dart:310-399`,
`webview.part.dart:162-198`); **one media-type predicate** (`isHtmlMediaType`, `epub_book.dart:844-849`)
for parser + interceptor; **one `chaptersJson` serializer** (`buildChaptersJson`,
`epub_importer.dart:237-254`); **one walker definition** (skip furigana + whitespace-only) shared by JS
selection and Dart plain text; **two coordinate systems that must never be substituted** —
learning-unit offsets (progress, favourites) vs audio-matchable UTF-16 offsets
(`reader_selection_data.dart:54-73`).

---

## 11. Gotchas — BUG-/TODO- comments a reimplementation must know

| # | Gotcha | What breaks | Citation |
|---|---|---|---|
| 1 | Self-closing non-void tags in XHTML served as `text/html` | BUG-2017/BUG-079 blank page (`<script/>` eats `<body>`); BUG-737 `<a id/>` adopts all prose and `selectText` bails on `closest('a')` → chapter un-lookupable | `epub_book.dart:113-127`, `:684-787`; `reader_resource_sanitizer.dart:30-55`, `:118-133` |
| 2 | Case folding via `p.canonicalize` used as a read path | BUG-1218: `oebps/...` keys do not exist on Android/Linux; spine items silently skipped, no log | `epub_parser.dart:811-837`; same trap on extract side TODO-739 `:277-288` |
| 3 | Extension-based content-document detection | BUG-1203/BUG-1199: any extension whitelist misses; always serve `text/html`, never `application/xhtml+xml` | `epub_book.dart:828-848`; `webview.part.dart:183-211` |
| 4 | Qualified-name XML lookup | Calibre `<opf:item>` → empty manifest → "spine contains no readable chapters" | `epub_parser.dart:399-420` |
| 5 | `rename(2)` onto a non-empty dir | BUG-564 `ENOTEMPTY`; TODO-1286 Android fuse rejects sibling renames too → stage `.tmp`, replace via `.bak`, copy+delete fallback | `epub_importer.dart:141-148`, `:332-340`, `:399-427` |
| 6 | Dropping label-less TOC/navPoint nodes | TODO: subtree lost → "chapter list incomplete" | `epub_parser.dart:722-727`, `:800-804` |
| 7 | Strict UTF-8 decode of legacy text | HBK-AUDIT-033: whole load aborts on Shift_JIS/EUC-JP | `epub_book.dart:664-682`, `book_css_repository.dart:11-13` |
| 8 | Character-count caliber changed without bumping the version | TODO-1192: cached counts never recomputed; JS `countChars` and Dart `countStudyChars` must stay in lockstep | `epub_book.dart:789-811` |
| 9 | Treating `epubPath` as a real on-disk file | BUG-088: sync silently skipped every upload; use `bookMainFilePath` | `book_file_location.dart:12-28` |
| 10 | Assuming `cover_path` has one meaning | extract-dir-relative href for EPUB vs relative filename for PDF | `epub_importer.dart:176-178`, `pdf_importer.dart:39-42` |
| 11 | Any synchronous throw in the setup IIFE | BUG-1017: stale `body{visibility:hidden}` = permanently blank book | `webview.part.dart:763-772` |
| 12 | Relying on native pan for page turns | TODO-114: finger-follow + snap-back reads as a sliding animation; needs `touch-action: none` | `reader_content_styles.dart:965-970` |
| 13 | Putting margins/font-size/insets into `column-gap` | TODO-729/753/792: pitch drifts → half-page jumps, premature chapter turns; BUG-2325 sub-pixel accumulation needs the `columnGap` tolerance in `alignToPage` | `reader_content_styles.dart:318-324`; `reader_pagination_scripts.dart:2465-2498` |
| 14 | Expecting `overflow:hidden` to hide the padding band | TODO-1285: needs `clip-path` **and** the `html::before` border overlay; hit-testing separately needs `charRangeVisible` (BUG-1797) | `reader_content_styles.dart:1003-1044`; `reader_selection_scripts.dart:493-552` |
| 15 | Collapsed viewport with a large font | TODO-743: raw `calc()` column width goes negative → columns overprint; `max(fontSizePx, …)` floor must stay paired CSS↔JS | `reader_content_styles.dart:121-145`, `:92-97` |
| 16 | Marking images lazy from post-`load` JS | TODO-perf/TODO-1339: too late; must be in the source bytes, and image-only / merged leading images must stay eager or geometry collapses and the chapter-start anchor skips the first image | `reader_resource_sanitizer.dart:72-100`; `webview.part.dart:355-365`, `:430-441` |
| 17 | Injecting the body engine into a spread document | BUG-1280: Android's shared `loadData` baseUrl caused two "tap empty" bridges to cancel out | `webview.part.dart:2900-2925` |
| 18 | WebKit ruby line-box inflation fix touching more than `rt` | BUG-2472/BUG-2482: the earlier `-webkit-line-box-contain` fix collapsed whole lines and blanked empty-line paragraphs | `reader_content_styles.dart:183-219` |
| 19 | Forgetting to reclaim OS focus after a WebView gesture | BUG-136: ESC stops exiting the reader; the list of bridges that still lack it is in a comment | `webview.part.dart:2514-2519`, `:2085-2165` |
| 20 | Rebuilding the WebView without a fresh restore anchor | TODO-2603/BUG-1386: restores to chapter start then persists that regression; today renderer death deliberately does **not** rebuild | `reader_restore_anchor.dart:6-39`; `webview.part.dart:2775-2786` |
| 21 | Passing `-1` (instead of `null`) as the exact anchor on save | BUG-162/BUG-285: overwrites a good exact anchor with "none", degrading restore to chapter-fraction granularity | `reader_fushi_page.dart:1140-1156`; `reader_position_repository.dart:34-56` |
| 22 | Persisting position during a temporary jump | BUG-459: favourite/mining jumps overwrite the real reading progress | `navigation.part.dart:1428-1432` |
| 23 | Assuming whitespace is a word boundary | BUG-1773: needs three predicates and single-whitespace bridging for phrases; BUG-2056: intra-word apostrophes must be crossed or `don’t`/`John’s` never match | `reader_selection_scripts.dart:386-446`, `:1237-1255` |
| 24 | Sentence extraction falling back to `document.body` | TODO-956: cross-block walk produces an empty sentence → "no sentence selected"; also needs the empty-sentence fallback to the selected word | `reader_selection_scripts.dart:462-478`; `lookup.part.dart:179-183` |
| 25 | Serialising popup display behind the reader highlight eval | BUG-717 ②: in-app lookup was several times slower than the external overlay; display first, re-anchor by generation later | `lookup.part.dart:100-139` |
| 26 | Treating `_controller != null` as "the WebView is alive" | BUG-005/TODO-678: a half-disposed WebView throws `MissingPluginException`; every `evaluateJavascript` needs its own try/catch | `lookup.part.dart:40-44`, `:128-132` |
| 27 | Letting both hover legs run on macOS | BUG-2508: WebKit never delivers `mousemove` under Flutter's mutator view; exactly one leg per platform | `reader_host_hover_lookup.dart:1-26`; `webview.part.dart:814-817` |
| 28 | Hand-copying the wheel-gesture helper into the spread page | BUG-1743/BUG-1745: the copy silently kept the old axis-based logic; one shared constant now | `webview.part.dart:3092-3105` |
| 29 | Dropping input during a chapter load | BUG-2424: must queue and replay at content-ready | `webview.part.dart:2395-2407`, `:2567-2570` |
| 30 | Batch/background import prompting for duplicates | BUG-443: scanning 50 files with `ask` is unusable; the sealed policy exists because the old two-flag pair had an undocumented fourth combination | `book_title_conflict.dart:25-60`, `:93-103` |
| 31 | Reporting "no pages" for a folder of volumes | BUG-1649: the verdict was mistaken for the data shape; `mangaBatchFolder` was the missing enum member | `import_carrier.dart:17-26` |
| 32 | Letting import errors escape the async zone / writing orphan rows | BUG-1117 (structured `runImport`), BUG-439 (failed EPUB generation must fail the whole subtitle import, not write an `SrtBooks` shell), BUG-483 (cover extraction race) | `import_flow_mixin.dart:40-88`; `book_import_dialog.dart:1038-1047`, `:1162-1171` |
| 33 | Returning the proposed (not suffixed) `bookKey` from an import callback | BUG-1503: callers key the wrong book | `packages/fushi_engine/lib/sync/local_library_host_service/books.part.dart:219-222` |
| 34 | Pure-image chapters and progress | TODO-1349: no matchable characters, so the physical end can be reached while progress disagrees; only a synthetic snapshot at the true chapter end | `webview.part.dart:1566-1567` |
| 35 | Linux | The EPUB renderer is unsupported on Linux | `webview.part.dart:1729-1742` |

---

## Appendix — where the novel code lives

`packages/fushi_engine/lib/epub/` — `epub_parser.dart`, `epub_book.dart`, `epub_importer.dart`,
`epub_storage.dart`, `reader_resource_host.dart`, `book_title_conflict.dart`;
`packages/fushi_engine/lib/sync/epub_repackage.dart`; `packages/fushi_engine/lib/media/audiobook/text_to_epub.dart`;
`fushi/lib/src/epub/` — `book_css_repository`, `book_file_location`, `epub_spread_map`,
`epub_spread_analyzer`, `epub_edge_matcher`; `fushi/lib/src/reader/` — `reader_selection_scripts`,
`reader_pagination_scripts`, `reader_content_styles`, `reader_resource_sanitizer`,
`reader_study_unit_script`, `reader_engine_config`, `reader_script_compactor`,
`reader_restore_anchor`, `reader_progress_state`, `reader_host_hover_lookup`, `reader_selection_data`;
`fushi/lib/src/pages/implementations/reader_fushi/` — `webview.part`, `lookup.part`,
`navigation.part`, `chrome.part`, `caret.part`, `audiobook.part`, `lyrics.part`, `mining.part`;
`fushi/lib/src/media/import/` — `import_carrier`, `sidecar_finder`, `srt_book_reimport`,
`import_flow_mixin`, `quick_import_section`; `fushi/lib/src/pdf/pdf_importer.dart`;
`packages/fushi_dictionary/lib/src/language/implementations/japanese_language.dart`;
`native/fushidicts/fushidicts_src/scan/word_scan.cpp`;
`packages/fushi_core/lib/src/database/tables.dart` (`EpubBooks`, `ReaderPositions`, …).
