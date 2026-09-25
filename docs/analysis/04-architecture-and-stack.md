# Fushi / Hibiki — Application Architecture, Library Layer, Packaging & Build

**Scope.** Read-only analysis of `/Users/heyanle/Desktop/project/Fushi` (project "Fushi", formerly "Hibiki"), to decide **what to reuse vs rebuild for
a much smaller desktop-only (macOS arm64) app limited to comics + novels**.

**Method.** All numbers come from `find`/`wc -l`/`grep` over the working tree, excluding `build/`, `.dart_tool/`, `Pods/`. LOC = lines in `*.dart`.
Non-obvious claims cite `path/file.dart:LINE`. "not found" means a literal grep returned nothing — no speculation.

**Headline numbers**

| Metric | Value |
|---|---|
| Workspace member packages | 12 (`pubspec.yaml:20-32`) |
| Dart LOC under `fushi/lib` | **853,339** across 1,207 files |
| — of which generated i18n (`lib/i18n/strings.g.dart`, 17 locales) | **359,360** |
| Real app Dart LOC (app minus i18n) | ≈ **493,979** |
| Dart LOC under `packages/*/lib` | **241,294** across 437 files |
| Dart LOC under `fushi/test` | 691,902 across 3,203 files |
| Transitive dependencies (`pubspec.lock`) | **324** packages |
| Direct deps in `fushi/pubspec.yaml` | 112 runtime + 13 dev |
| Drift `schemaVersion` | **104** (`packages/fushi_core/lib/src/database/database.dart:737`) |
| Drift tables | **86** (`packages/fushi_core/lib/src/database/tables.dart`) |
| Generated Drift code | 91,773 LOC (`database.g.dart`) |
| Native toolchains embedded | fushidicts (C++), libtorrent, galgame hook, ONNX (non-Apple), libmpv, FFmpeg ×3, PDFium, 2 JVM runtimes, SQLite, WKWebView |

---

## A) Package / workspace layout

Root `pubspec.yaml` is a **pub workspace** (`name: fushi_workspace`, `:1`), SDK `>=3.8.0 <4.0.0` (`:5`). The `workspace:` list (`:20-32`) names 12
members; resolution happens once at the root. Three members deliberately *shadow* upstream pub.dev package names (`flutter_inappwebview_windows`,
`gamepads_android` from `packages/gamepads_android_stub`, `gamepads_windows`), so no `dependency_overrides` entry is permitted for them (`:7-19`,
`:39-43`). Melos 7 config lives in the same file (`:171-203`) because Melos 7 retired `melos.yaml`.

| Package | Purpose | LOC (lib) | Files | Key deps | UI-independent? |
|---|---|---|---|---|---|
| `fushi` (app) | Flutter app: pages, reader, settings, media library, lookup, mining | 853,339 | 1,207 | Flutter, drift, sqlite3_flutter_libs, flutter_riverpod, flutter_inappwebview, media_kit, just_audio, pdfrx, flutter_onnxruntime, hotkey_manager, window_manager, macos_ui, slang | No (it *is* the UI) |
| `fushi_core` | Shared models, **the Drift database**, language config, i18n primitives | 108,927 (91,773 generated) | 37 | `drift >=2.33.0 <2.34.0`, `sqlite3 >=3.4.0 <4.0.0`, `path` | **Yes — zero Flutter** (`packages/fushi_core/pubspec.yaml:8-15`) |
| `fushi_engine` | Pure-Dart engine: interconnect host (shelf), pairing/TLS, remote OCR jobs, manga OCR algorithms, video download pipeline, scraping/subtitle search, ffmpeg CLI backend | 86,838 | 257 | fushi_core, fushi_audio, fushi_anki, fushi_dictionary, fushi_platform, fushi_torrent, `shelf`, `dio`, `image`, `archive`, `youtube_explode_dart`, `ffi` | **Yes — zero Flutter** (§B) |
| `fushi_dictionary` | Dictionary engine + fushidicts FFI bindings, Yomitan/MDict/ABBYY/Migaku importers, Japanese deinflection/tokenization | 5,324 | 24 | Flutter, fushi_core, `ffi`, `kana_kit`, `file_picker`, `flutter_archive`, `dio`, `async_zip` | **Split**: `fushi_dictionary_core.dart` closure is Flutter-free; main barrel is not |
| `fushi_audio` | Playback/recording, audiobook matching, SRT/ASS parsing, `AudioCue` | 12,785 | 41 | Flutter, fushi_core, `just_audio`, `audio_session`, `drift`, `xml`, `flutter_charset_detector` | **Split**: `fushi_audio_core.dart` is Flutter-free |
| `fushi_anki` | Anki integration: abstract service, AnkiDroid + AnkiConnect repos | 13,438 | 20 | Flutter, fushi_core, `http`, `shared_preferences`, `ffi`, `archive` | **Split**: `fushi_anki_core.dart` is Flutter-free |
| `fushi_platform` | **5 abstract service interfaces only** | **45** | 6 | Flutter (declared; **no** `package:flutter` import in `lib/`) | Yes |
| `fushi_torrent` | libtorrent 2.x C-ABI FFI bindings + embedded engine | 2,255 | 6 | `ffi` only | Yes |
| `fushi_server` | Headless server: interconnect host, ASR, downloads, WebUI + admin API | 3,592 | 19 | fushi_core, fushi_engine, fushi_platform, `shelf`, `args`, `yaml` | Yes |
| `flutter_inappwebview_windows` | Vendored fork: Windows WebView2 implementation | 6,409 | 27 | Flutter, webview platform interface | No (plugin) |
| `gamepads_android_stub` (pkg `gamepads_android`) | Dart-only no-op preventing the real Android gamepads plugin from registering (it casts `MainActivity` unconditionally → launch crash) | 28 | 1 | Flutter, gamepads platform interface | No (shim) |
| `gamepads_windows` | Vendored fork of `gamepads_windows 0.3.0+1` fixing teardown use-after-free / off-thread channel calls / data races (BUG-116) | 0 Dart | 0 | Flutter, native C++ | No (plugin) |

Non-package trees: `native/fushidicts` (C++ tokenizer/dictionary, 4,012 files), `native/fushi_torrent` (20), `native/galgame_hook` (Windows-only,
423), `native/aidoku_runtime` (JVM, 9), `third_party/` (17 vendored packages), `tool/` (35 entries), `ci/` (`apply-patches.sh` + patches),
`.github/workflows/` (16 workflows).

---

## B) Layering — how the app depends on the packages

```
fushi (app)
 ├── fushi_core        (models + Drift DB)          — used everywhere
 ├── fushi_engine      (pure-Dart algorithms)       — imported by app AND fushi_server
 ├── fushi_dictionary  (FFI dictionary + importers) — app-only *full* barrel
 ├── fushi_audio       (playback + SRT parsing)     — app-only *full* barrel
 ├── fushi_anki        (Anki backends)              — app-only *full* barrel
 ├── fushi_platform    (5 abstract service ifaces)  — impls injected from app
 └── fushi_torrent     (libtorrent FFI)             — desktop downloads
```

`fushi_server` depends on `fushi_core` + `fushi_engine` + `fushi_platform` + `fushi_audio` (+ ASR git packages) and never on `fushi`
(`packages/fushi_server/pubspec.yaml:23-30`).

**`fushi_engine` is Flutter-free — verified.**

```
$ grep -rn "package:flutter" packages/fushi_engine/lib | wc -l
0
$ grep -rn "dart:ui"       packages/fushi_engine/lib | wc -l
9      # all 9 are doc comments in manga/mokuro_geometry.dart, which defines pure-Dart
       # Rect/Size/Offset stand-ins precisely because dart:ui is banned
```

`packages/fushi_engine/lib/media/manga/mokuro_geometry.dart:3-4` states the rule in-code: "引擎包会被 `dart compile exe`，闭包里不能有 `dart:ui`".
`fushi_engine/pubspec.yaml:9-14` documents that the package declares no `flutter` SDK, and the constraint is enforced by a **source-scanning guard
test**: `fushi/test/build/fushi_engine_purity_guard_test.dart:21-46` bans `package:flutter/`, `package:flutter_riverpod/`, `dart:ui`,
`package:path_provider/`, `package:shared_preferences/`, `package:media_kit`, `package:flutter_inappwebview`, `package:just_audio`,
`package:sqlite3_flutter_libs/`, and the three *full* barrels `fushi_audio/fushi_audio.dart`, `fushi_anki/fushi_anki.dart`,
`fushi_dictionary/fushi_dictionary.dart`.

**`fushi_core` is Flutter-free — verified** (`grep -rn "package:flutter" packages/fushi_core/lib` → 1 hit, a doc comment at
`packages/fushi_core/lib/src/utils/fushi_debug_print.dart:1`; the single `dart:ui` hit is the same comment's line 4).
`packages/fushi_core/pubspec.yaml:15-17`: "零 Flutter：本包被无头服务端消费， 不得依赖 flutter sdk / 任何 method-channel 插件"; sqlite3 native assembly is left to the
consumer. Its three runtime deps are `drift`, `sqlite3`, `path`; `flutter_test` is dev-only.

Consequently the engine may only consume the **`_core` sub-barrels** of the Flutter-declaring packages, and grep confirms that is what happens:
`package:fushi_audio/fushi_audio_core.dart`, `package:fushi_anki/fushi_anki_core.dart`, `package:fushi_dictionary/fushi_dictionary_core.dart`.
`packages/fushi_dictionary/lib/fushi_dictionary_core.dart:1-13` enumerates exactly which files are excluded and why (`engine/fushidicts.dart` pulls
`rootBundle`, `language/language.dart` pulls `material`, …).

**Host wiring.** Pure-Dart engine code still needs its host seams installed. That happens in `fushi/lib/src/engine_bindings.dart:72`
(`installEngineHostBindings()`): it assigns `fushiDebugPrint`, `engineLog`, `enginePaths = const AppPathsEngineBridge()` (`:32-44`, delegating the
three roots to `AppPaths`), image-cache evict/release hooks, the dictionary FFI unmap hook, the `ffmpegPlatformBackendProvider` (Kit on Android/iOS,
**CLI on desktop**, `:66-69`), the charset detector, audiobook storage, and the OCR isolate bootstrap. It is called from `main()`, not
`AppModel.initialise()`, because the popup-dictionary and floating-dictionary entrypoints bypass `initialise` (`:1-11`).

---

## C) State management

Grep over `fushi/lib` (files / total hits):

| Pattern | Files | Hits |
|---|---|---|
| `flutter_riverpod` import / any `riverpod` | 119 / 121 | 119 / 123 |
| Riverpod provider declarations (`NotifierProvider`/`StateProvider`/`Provider(`) | — | 165 |
| `Listenable` (incl. builders) | 82 | 310 |
| `ValueNotifier` | 60 | 253 |
| `ChangeNotifier` (33 `extends`/`with`) | 44 | 73 |
| `package:provider` | **0** | 0 |
| `flutter_bloc` | **0** | 0 |
| `get_it` | **0** | 0 |
| `package:signals` | **0** | 0 (60 "signals" hits are i18n strings) |

**Dominant pattern: Riverpod as the DI/scope container wrapping a small number of hand-written `ChangeNotifier` god-objects, with
`ValueNotifier`/`ChangeNotifier` for high-frequency local state.**

- Global DI is Riverpod: the root scope is installed in `main()` at `fushi/lib/main.dart:468-469`
(`UncontrolledProviderScope`); every page pulls state through it.
- The god-objects are Riverpod-*provided* but `ChangeNotifier`-*implemented*:
`final appProvider = ChangeNotifierProvider<AppModel>` (`fushi/lib/src/models/app_model.dart:257`) and `class AppModel with ChangeNotifier` (`:493`,
9,147 LOC); `creatorProvider` / `instantExportProvider` (`fushi/lib/src/models/creator_model.dart:8,16`); `themeProvider =
ChangeNotifierProvider<ThemeNotifier>` (`fushi/lib/src/models/theme_notifier.dart:1878`).
- Pages never take state by constructor: `BasePage extends ConsumerStatefulWidget`
(`fushi/lib/src/pages/base_page.dart:9`), `BasePageState<T> extends ConsumerState<T>` exposing `appModel` (`ref.watch(appProvider)`),
`appModelNoUpdate` (cached, `dispose`-safe) and `creatorModel` (`:22-58`). This is the single most load-bearing convention in the app.
- Newer features use Riverpod notifiers: `StateNotifierProvider<AnkiViewModel, AnkiUiState>`
(`fushi/lib/src/anki/anki_view_model.dart:621`), `StateNotifierProvider<ProfileViewModel, ProfileUiState>`
(`fushi/lib/src/profile/profile_view_model.dart:369`), `ChangeNotifierProvider<InterconnectDownloadManager>`
(`fushi/lib/src/sync/interconnect_download_manager.dart:363`), `Provider<ProfileRepository>` (`fushi/lib/src/profile/profile_view_model.dart:346`).
- Platform services are injected by a provider that **must** be overridden at the root:
`platformServicesProvider` (`fushi/lib/src/platform/platform_providers.dart:8-13`).

**What manages the media library?** Not Riverpod-native. Three mechanisms cooperate:

1. **`AppModel` (ChangeNotifier) is the media registry** — `MediaType`/`MediaSource` instances are
registered during initialise and looked up via `appModel.mediaTypes[...]` / `appModel.mediaSources[mediaType][...]`
(`fushi/lib/src/media/media_item.dart:128-136`). The DB handle is pushed into a static on `MediaSource` before any source initialises
(`fushi/lib/src/media/media_source.dart:95-99`).
2. **`MediaHistoryRepository extends ChangeNotifier`** (`fushi/lib/src/models/media_history_repository.dart:9`)
owns the in-memory `List<MediaItem>` cache, capped at 100 media / 60 search rows (`:13-15`), loaded once by `loadFromDb()` and exposed as
`List.unmodifiable`.
3. **Page-local `Future` caches + ad-hoc `ChangeNotifier`s.** The book shelf uses a *non-reactive*
`Future<void>? _shelfMapsFuture` (`fushi/lib/src/pages/implementations/reader_fushi_history_page.dart:283`) lazily assigned once (`:644`) and
reassigned by hand after every mutation (`:505`, `:521`, `:1167`, `:1877`, `:1900`, `:2650`). `MediaType` itself carries `tabRefreshNotifier` + a
`ScrollController` + `refreshTab()` (`fushi/lib/src/media/media_type.dart:31-39`), and `AppModel` holds a fistful of one-off notifiers
(`dictionaryEntriesNotifier`, `dictionarySearchAgainNotifier`, `dictionaryMenuNotifier`, `incognitoNotifier`, `databaseCloseNotifier` —
`fushi/lib/src/models/app_model.dart:1393-1429`).

Reading: the library layer is a **manual, imperative cache with hand-rolled invalidation** — the weakest part of the architecture and the part a
rewrite should most deliberately replace.

---

## D) Persistence

**Database: Drift over SQLite.** No Isar / Hive / ObjectBox / sqflite-as-primary (`grep -rn 'package:sqflite' fushi/lib packages` → 0 hits; the pod
appears only transitively in `Podfile.lock:110`).

| Evidence | Location |
|---|---|
| `drift` in every storage-touching pubspec | `packages/fushi_core/pubspec.yaml:16`, `packages/fushi_audio/pubspec.yaml:29`, `packages/fushi_engine/pubspec.yaml:41`, `fushi/pubspec.yaml:100` |
| `sqlite3` + `sqlite3_flutter_libs` (app assembles the native lib) | `packages/fushi_core/pubspec.yaml:17`, `fushi/pubspec.yaml:101-102` |
| `@DriftDatabase(tables: […86…])` | `packages/fushi_core/lib/src/database/database.dart:618-735` |
| `class FushiDatabase extends _$FushiDatabase with _FushiDbInfra, _FushiDbTagsSync, _FushiDbLibrary, _FushiDbPrefsMedia, _FushiDbContentMisc, _FushiDbStatistics, _FushiDbVideoDomain, _FushiDbUpdateFeed, _FushiDbMangaDownload` | `database.dart:736-744` |
| `int get schemaVersion => 104;` | `database.dart:737` |
| `shared_preferences` for bootstrap keys only | `fushi/pubspec.yaml:142`, `fushi/lib/src/storage/app_paths.dart:150` |

**Schema definition.** Everything is in one file: `packages/fushi_core/lib/src/database/tables.dart` (3,046 LOC, **86 `extends Table` classes**).
There are **no `.drift` files** (`find . -name '*.drift'` → not found); every table is a Dart class. Generated code is `database.g.dart` — **91,773
LOC**, 84% of `fushi_core`'s lib LOC. Tables that matter for comics+novels, with their line numbers: `MediaOpenHistory` (`:17`) — "continue reading":
PK `(mediaSource, mediaId)`, `openedAt`, `position`, `duration`, `snapshotJson`; `EpubBooks` (`:435`) — **the one table for all three book formats**
(§E); `ReaderPositions` `:122`; `Bookmarks` `:140`; `BookTags` `:501` (shared pool: `name` unique, `colorValue`, `sortOrder`); `TagAssignments` `:530`
(v79 unified tag↔host M2M over all media kinds); `Series` `:913` (**frozen legacy** — "勿再读写系列语义", `:963-967`); `ShelfEntries` `:936` (`(mediaType,
entryKey)` PK → `sortOrder`, `seriesId`; shelf ordering survives, series semantics do not); `MediaCollections` `:969` + `MediaCollectionItems`
`:1069`; the profile family `Profiles`/`ProfileSettings`/`MediaTypeProfiles`/ `BookProfiles`/`LanguageProfiles` `:550,559,575,586,604`;
`ReadingStatistics`/`ReadingHourlyLogs` `:157,181`; `Preferences` `:276` (`key` PK, `value` TEXT, `updatedAt` LWW clock); `DictionaryMetadata`/
`DictionaryHistory` `:306,369`; manga `MangaChapterStates`/`MangaDownloadJobs`/`MangaExtensions`/ `MangaOnlineSources` `:2791,2981,2704,2726`. The
`VideoMetadata*` (12 tables, `:1575-2436`), `VideoDownload*` (5) and `Galgame*` (3) families are **droppable**. Roughly ten further tables
(`SyncBaselines`, `*Tombstones`) exist purely for multi-device last-write-wins safety.

**Migrations.** One giant hand-written ladder inside `MigrationStrategy` (`database.dart:822`); the `onUpgrade` callback spans roughly **2,500
lines**. Structure: a long series of `if (from < N) { … }` steps for N = 2…104, each idempotent and guarded by
`_tableExists(...)`/`_columnExists(...)` (`:750-760` defines those helpers for drifted schemas). **Downgrade protection is explicit and
load-bearing**: `if (from > to) throw FushiDatabaseDowngradeException(...)` sits at the *top* of `onUpgrade` (`:825-838`), with a comment recording
that a previous build migrated/DROPped in that branch and "wiped users' libraries twice". Some steps are pinned to the front of the ladder regardless
of version number — v84 (`:849-853`) must run first because later steps use drift's typed API, which null-asserts on columns that do not exist yet.
Historical DDL is frozen verbatim as raw `customStatement('CREATE TABLE …')` where the Dart class has since been deleted (e.g. `book_tag_mappings`,
`:883-891`). There is **no `stepByStep` and no generated schema dumps**: one hand-written migration per schema bump, regenerated with `dart run
build_runner build` (`fushi/pubspec.yaml:178`, `packages/fushi_core/pubspec.yaml:21`).

**Where the library root lives on disk.** Two roots, resolved once at startup by `AppPaths` (`fushi/lib/src/storage/app_paths.dart:58`, `resolve()` at
`:80`):

| Root | Resolution | Contents |
|---|---|---|
| **documentsRoot** (content/library) | `getApplicationDocumentsDirectory()`, or `<dataRoot>/documents` when a custom data root is configured | `fushi_books/`, `audiobooks/`, `video_covers/`, … |
| **supportRoot** (DB) | `getApplicationSupportDirectory()`, or `<dataRoot>/support` | `fushi.db` (+ `-wal`/`-shm`), `local_audio_*.db` |
| **tempRoot** | `getTemporaryDirectory()` | scratch |

New installs default to `<platform Documents>/Fushi/data`; legacy flat installs (documents root = the shared `Documents` folder with 16+ app
directories spilled directly into it) are **frozen in place by a persisted anchor** and never auto-migrated (`documentsLayoutPrefKey` /
`documentsLayoutFlat` / `documentsLayoutNested`, `:159-186`; the container name is anchored too, `documentsContainerPrefKey`, `:191-193` — existing
installs keep `Hibiki`, new ones get `Fushi`). The layout is decided **once** by probing whether `supportRoot/fushi.db` (or legacy `hibiki.db`) exists
(`_ensureDocumentsLayoutDecided`, `:404-430`) and the verdict is written to `SharedPreferences` — deliberately *not* to the Drift `preferences` table,
because the DB is the thing being migrated (`:145-150`).

Owned subdirectories that migrate with the data root (`fushiOwnedDocumentsEntries`, `:544-572`, 23 entries): `audiobooks`, `fushi_books`,
`hoshi_books` (legacy name), `video_covers`, `game_covers`, `video_subtitles`, `mpv_shaders`, `mpv_scripts`, `remote_videos`, `videos`,
`anime_downloads`, `custom_fonts`, `fushiExport`, `hibikiExport`, `browser`, `thumbnails`, `dictionaryResources`, `dictionaryImportWorkingDirectory`,
`webArchive`, `recommended_pack`, `onboarding_tutorial`, `manual_torrents`, `card_source_drafts`. The engine-side contract is
`packages/fushi_engine/lib/foundation/engine_paths.dart` (94 LOC): three abstract roots plus derived helpers `videoCoversDirectory()`,
`videoSubtitlesDirectory()`, `epubBooksDirectory()` → `fushi_books`, `audiobooksDirectory()` (`:28-50`); the host installs `AppPathsEngineBridge`
(`fushi/lib/src/engine_bindings.dart:32-44`), and an uninstalled `enginePaths` throws rather than silently writing to the wrong directory
(`engine_paths.dart:88-92`).

**Per-platform differences.** The roots are `path_provider` values: on macOS documentsRoot is `~/Documents/Fushi/data` and supportRoot is
`~/Library/Application Support/<bundle-id>` — *not* a sandbox container, because the app ships unsandboxed (§H); on Windows,
`%USERPROFILE%\Documents\Fushi` + `%APPDATA%\<package>`; Linux uses XDG dirs; Android/iOS use the app-private sandbox. macOS additionally supports
*custom* roots through security-scoped bookmarks: `MacOSDataRootAccess` (`fushi/lib/src/storage/macos_data_root_access.dart`) stores a bookmark in
`SharedPreferences` under `data_root_bookmark` and calls `MethodChannel('app.fushi/data_root_access')` with `createBookmark`/`startAccessingBookmark`,
implemented in `fushi/macos/Runner/AppDelegate.swift` (`handleDataRootAccess`). Other notable behaviours: the `data_root` probe uses async
`exists().timeout(2s)` and **never** `existsSync()`, because a dropped network share would block the main isolate at startup (`:256-263`);
`data_root_migrator.dart` (1,665 LOC) rewrites absolute paths inside the DB when the root moves; `storage_usage_service.dart` (1,018 LOC) computes
per-category disk usage.

---

## E) Media library model

**`MediaItem` is json_serializable, not freezed — and only 174 lines.** `fushi/lib/src/media/media_item.dart:6-43`: `part 'media_item.g.dart'`,
`@JsonSerializable()` on `class MediaItem`, generated `media_item.g.dart` (**47 LOC**, pure `JsonSerializableGenerator`). There is **no freezed**
anywhere in the repo; `copyWith` is hand-written (`:140-173`). Fields (`:46-112`): `id?`, `mediaIdentifier`, `title`, `mediaTypeIdentifier`,
`mediaSourceIdentifier`, `base64Image?`, `imageUrl?`, `audioUrl?`, `author?`, `authorIdentifier?`, `extraUrl?`, `extra?`, `sourceMetadata?`,
`position`, `duration`, `canDelete` (final), `canEdit` (final). Identity is the derived `uniqueKey => '$mediaSourceIdentifier/$mediaIdentifier'`
(`:49`), and `==`/`hashCode` use only that (`:114-119`). There are deliberately no progress fields beyond position/duration — the class doc (`:8-14`)
says this keeps CRUD cheap. Persistence splits columns from JSON: `MediaOpenHistory` stores identity/position/duration as columns and the rest as
`snapshotJson`, with the codec reusing `MediaItem`'s generated JSON and stripping exactly 8 columned keys
(`fushi/lib/src/models/media_history_repository.dart:43-60`).

**`MediaType` — one per top-level domain, carrying its own home widget.** `fushi/lib/src/media/media_type.dart:6`: `abstract class MediaType with
ChangeNotifier`, with `uniqueKey`, `icon`, `outlinedIcon`, a `home` **Widget**, a `ScrollController`, and `tabRefreshNotifier`. Only **two** concrete
subclasses exist: `ReaderMediaType` (`uniqueKey: 'reader_media_type'`, home `HomeReaderPage` —
`fushi/lib/src/media/types/reader_media_type.dart:6-23`, 23 LOC) and `DictionaryMediaType` (`fushi/lib/src/media/types/dictionary_media_type.dart`, 23
LOC). Manga is **not** a `MediaType`; it is a `HomeTab` backed by `MangaLibraryPage` reusing the same `EpubBooks` table with `format='manga'`. Video
and games likewise bypass `MediaType` entirely.

**`MediaSource` — the per-source adapter contract.** `fushi/lib/src/media/media_source.dart` (888 LOC) defines `abstract class MediaSource` (`:39`)
with `uniqueKey`, `sourceName`, `mediaType`, `description`, `icon`, `implementsSearch`, `implementsHistory`, `overridesAutoImage/Audio`, localisation
maps, and an in-memory per-source preference cache written through to Drift under the namespaced key `src:<sourceId>:<key>` (`_dbPrefKey`; the frozen
format is documented as the single source of truth at `:28-36`). Concrete sources: `ReaderFushiSource` (EPUB/PDF/manga dispatch,
`fushi/lib/src/media/sources/reader_fushi_source.dart`, **2,114 LOC**), `MangaFushiSource` (147), `ReaderPdfSource` (97), and the abstract base
`ReaderMediaSource` (52).

**How manga vs epub differ inside one model.** The key decision: **all three book formats share the `EpubBooks` table and one book directory
`fushi_books/<bookKey>/`**; format is one enum column. `packages/fushi_core/lib/src/database/book_format.dart` defines `enum BookFormat {
epub('epub'), pdf('pdf'), manga('manga') }`, with an extensive rationale for *not* adding a CHECK constraint (SQLite cannot `ADD CONSTRAINT` without
rebuilding the core book table, and a mid-upgrade failure bricks the app). `EpubBooks.format` is TEXT defaulting to `'epub'` (`tables.dart:470-475`).
`BookFormat.isPagedImageBook` marks `pdf`/`manga` as page-indexed: for those rows `chapterCount` stores **pages** and `chaptersJson` is `'[]'`.
Column-level differences are nullable overrides on the same row: `format` (`:470-475`) routes to the reader; `mangaReadingMode` (`:478-482`, `null` =
auto-detect spread vs webtoon by page aspect, `'spread'`/`'webtoon'` = user override); `language` (`:462-468`, BCP-47, `null` = auto, same
null-means-auto semantics); `extractDir` (`:445`, `<bookKey>/` holding `manga.json`
+ `images/` for manga — `fushi/lib/src/media/manga/book_format_convert.dart:14`); `epubPath` (`:444`,
the PDF's absolute path for `format='pdf'`); `uid` (`:456-460`, machine-local stable identity added in v81 so retitling does not cascade-rename ten
child tables). So an EPUB row and a manga row are the *same Dart type*, differing by one string plus two nullable override columns;
`book_format.dart:2-4` calls `format` "阅读器路由的唯一真相源" (`'pdf'` → PDF reader, `'manga'` → manga reader, default → EPUB reader). A parallel enum exists
for collection/shelf membership and must not be confused with it: `MediaKind { epub, srt, video, game }`
(`packages/fushi_core/lib/src/database/media_kind.dart`). That file's header enumerates **six mutually incompatible string domains** in this repo
(`MediaKind`; `ActivityMediaKind` where `book ≠ epub`; `MediaSources.mediaKind`; `ProfileMediaKind` where `srtbook ≠ srt`; `SyncTombstoneKind`;
`StatSourceKind`), warns that mixing them is a data incident, and ships `media_kind_mappings.dart` for explicit conversion — a strong signal that a
lean app needs far fewer kind-enums.

**Collections / shelves / tags.** `Series` (`tables.dart:913`) and `ShelfEntries.seriesId` are frozen legacy — the container concept was superseded by
`MediaCollections` and series semantics must no longer be read or written (`:963-967`); `ShelfEntries` survives only for `sortOrder`.
`MediaCollections` (`:969`) is the live model: `collectionType` ∈ `'collection' | 'playlist'`, `coverSource` (borrow a member cover as
`'<mediaType>|<entryKey>'`), and its own `coverPath` column (v61/BUG-1211) so changing a collection cover does not rewrite every member. Deleting a
container cascades only through `MediaCollectionItems`, never the member items (Jellyfin "delete BoxSet ≠ delete LinkedChild"). `ShelfEntries`
(`:936`) has PK `(mediaType, entryKey)` and deliberately **no FK** to the three media tables, because remote/paired-peer entries have no local row;
orphans are cleaned by delete paths and filtered on read. `BookTags` + `TagAssignments` (`:501`, `:530`): v79 collapsed five identically-shaped
`*_tag_mappings` tables into one polymorphic `(mediaKind, entryKey, tagId)` table, keeping one shared tag pool and recording `addedAt` uniformly.
App-side UI: `fushi/lib/src/media/collections/` (1,975 LOC, incl. `collection_shelf_row.dart` 416, `collection_drag.dart` 390),
`fushi/lib/src/media/tags/tag_drop.dart` (94), and pages `collections_page.dart` (2,376), `media_collection_detail_page.dart` (2,825),
`tag_management_page.dart` (483).

---

## F) Navigation & pages

**Routing: plain Navigator 1.0, no router package.** Hits in `fushi/lib`: `Navigator.of(context).push` 53, `Navigator.push` 45, `MaterialPageRoute`
32, `showDialog` 45, `showModalBottomSheet` 9, `CupertinoPageRoute` 4, `PageRouteBuilder` 3. `go_router` / `auto_route` / `beamer` → **0**.
`onGenerateRoute` appears once and only inside a *comment* (`fushi/lib/src/platform/engine_deep_link_route_guard.dart:18`), which documents that
engine-pushed route information has no legal landing point — deep links are deliberately rejected. There is no named-route table; pages call
`showDialog` / `Navigator.of(context).push(MaterialPageRoute(...))` inline.

**The page framework.**

| Base | File | LOC | Notes |
|---|---|---|---|
| `BasePage` / `BasePageState<T>` | `fushi/lib/src/pages/base_page.dart` | 71 | `ConsumerStatefulWidget`; caches `appModel`/`creatorModel`, exposes `appModelNoUpdate` for `dispose`; `build()` deliberately not implemented so a missing override is a compile error |
| `BaseTabPage` / `BaseTabPageState` | `base_tab_page.dart` | 93 | tab inside the home shell; adds `mediaType` + current-source lookup (`:43`) |
| `BaseModuleTabPage` | `base_module_tab_page.dart` | 72 | module tab with settings integration (`HomeDashboardPage`) |
| `BaseSourcePage` / `BaseSourcePageState` | `base_source_page.dart` | **1,619** | the reader base — most reader plumbing lives here |
| `BaseHistoryPage` | `base_history_page.dart` | 103 | history/shelf base |
| `FushiPagePlaceholders` mixin | `fushi_page_placeholders.dart` | 67 | shared `buildLoading`/`buildError` |

A page must extend `BasePage`, return a state extending `BasePageState<Self>`, implement `build`, and read global state via `appModel` rather than
constructor injection. ~190 files under `pages/implementations/` follow this shape.

**Startup.** `fushi/lib/main.dart` (2,247 LOC) is the single entry (`main()` at `:169`, `runApp` at `:468-469`), with substantial pre-`runApp` work:
persisted sidebar/tab selection loaded before the first frame (`:220-240`), Windows sub-window resize gating (`:256`), window positioning and theme
install (`:364`, `:463`). `lib/src/startup/` is small (936 LOC) and mostly non-blocking concerns: `desktop_window_placement.dart` (383, restores
window size/position before the first frame and deliberately lives outside `AppModel` for that reason), `media_handle_registry.dart` (129, lets the
data-root migrator `await` release of libmpv file handles before renaming), `exit_flush_registry.dart` (110, needed because `setPreventClose(true)`
means `dispose()` never runs on window close), `loading_watchdog_view.dart` (92, loading UI + timeout escape hatch), `webview_prewarm.dart` (84),
`android_view_lifecycle.dart` (62), `test_environment.dart` (49), `observe_blank_detector.dart` (27). DB open / recovery / pref load / media
registration happen in `AppModel.initialise()` (error-log markers at `app_model.dart:2783`, `:3215`). `main.dart` also carries **three extra
entrypoints** — `popupMain()` (`:158`), `lib/popup_main.dart`, `lib/floating_dict_main.dart` — i.e. separate engines for the popup and floating
dictionary windows.

**Top-level screens.** One home shell: `HomePage extends BasePage` (`home_page.dart:343`), an `IndexedStack` of tabs. `enum HomeTab { home, books,
manga, video, games, downloads, dictionaries, browserExtension, settings }` (`:115-125`); the visible subset and order come from the pure function
`homeActiveTabs(ModuleVisibility)` (`:138-157`) and can be reversed by preference (`:175-193`). `games` is Windows-only, `browserExtension`
desktop-only, `home` and `settings` always present (safe fallback). macOS renders the same list through a **native sidebar** built in `main.dart`
(`:196-206`). `HomeDashboardPage extends BaseModuleTabPage` (`home_dashboard_page.dart:77`) is the "Continue" dashboard; its `_ContinueEntry` doc
(`:100-110`) records that the old `final bool isVideo` flag structurally could not hold a third media kind — hence `MediaKind`.

**Pages by feature area** (class · file · LOC):

| Area | Page |
|---|---|
| Library/shelf (books) | `ReaderFushiHistoryPage` · `pages/implementations/reader_fushi_history_page.dart` · 2,807 |
| Library shell (shelf/browse/sources/settings views) | `MediaLibraryShell`, `HomeReaderPage` · `pages/implementations/media_library_shell.dart`, `home_reader_page.dart` · — / 78 |
| Dashboard / continue-reading | `HomeDashboardPage` · `home_dashboard_page.dart` · 3,404 |
| Collections | `CollectionsPage` · `collections_page.dart` · 2,376 |
| Collection/series detail | `media_collection_detail_page.dart` · 2,825 |
| Manga library | `MangaLibraryPage` (shell, 85) + `manga_series_page.dart` (1,907) · `media/manga/` |
| **Series detail (manga)** | `media/manga/library/manga_series_page.dart` · 1,907 |
| **Novel reader** | `ReaderFushiPage extends BaseSourcePage` · `reader_fushi_page.dart` · 4,539, plus `reader_fushi/{chrome,webview,navigation,caret,audiobook,mining,lyrics,lookup}.part.dart` · 12,860 total |
| **Comic reader** | `media/manga/reader/manga_fushi_page.dart` · **4,297** (InAppWebView-based, same family) |
| PDF reader | `ReaderPdfPage` · `reader_pdf_page.dart` · 937 |
| Reader history | `ReaderFushiHistoryPage` · 2,807 |
| **Settings** | `FushiSettingsDialogPage` + `FushiSettingsContent` · `fushi_settings_page.dart` · 121 (schema in `lib/src/settings/`, §G) |
| **Dictionary management** | `DictionaryDialogPage` · `dictionary_dialog_page.dart` · 2,623; import `dictionary_dialog_import_page.dart` 78; settings `dictionary_settings_dialog_page.dart` 1,023; home tab `HomeDictionaryPage` 1,285 |
| Popup-dictionary surfaces | `dictionary_popup_webview.dart` 2,942, `dictionary_popup_layer.dart` 1,702, `dictionary_popup_native.dart`, `dictionary_popup_controller.dart`; plus `floating_dict_page.dart`, `popup_dictionary_page.dart` |
| **Import (media)** | `MediaSourcesPage`, `MangaImportDialog` (489), `media/import/` (1,498 incl. `real_path_directory_picker.dart` 556) |
| **Search** | `MangaGlobalSearchPage` (426) + source-level book search; no dedicated book search page |
| Statistics/history | `StatisticsCenterPage`, `ReadingStatisticsPage`, `VideoStatisticsPage` |
| Misc | `MediaItemDialogPage` (417), `TextSegmentationDialogPage` (240), `custom_fonts_page.dart` (1,947), `onboarding_wizard_page.dart` (2,354) |

**Scale.** `fushi/lib/src/pages/` = **149,498 LOC across 189 files**. Twenty largest: `video_fushi_page.dart` 8,737 · `home_video_page.dart` 7,879 ·
`reader_fushi_page.dart` 4,539 · `texthooker_page.dart` 3,521 · `home_dashboard_page.dart` 3,404 · `reader_fushi/chrome.part.dart` 3,282 ·
`anime_download_dialog.dart` 3,160 · `reader_fushi/webview.part.dart` 3,149 · `dictionary_popup_webview.dart` 2,942 · `home_page.dart` 2,877 ·
`media_collection_detail_page.dart` 2,825 · `reader_fushi_history_page.dart` 2,807 · `dictionary_dialog_page.dart` 2,623 ·
`video_fushi/subtitle.part.dart` 2,390 · `collections_page.dart` 2,376 · `onboarding_wizard_page.dart` 2,354 · `reader_fushi/audiobook.part.dart`
2,123 · `video_discovery_acquisition_dialogs.dart` 2,111 · `games_library_page.dart` 1,957 · `custom_fonts_page.dart` 1,947. Dialog conventions are ad
hoc — `showDialog`/`showModalBottomSheet` called at point of use, with no shared helper layer beyond `import_dialog_frame.dart` and
`master_detail_settings_sheet.dart`.

---

## G) Reader settings

**Per-source KV, namespaced by source id.** `class ReaderSettings` (`fushi/lib/src/reader/reader_settings.dart:69`) is the reader's settings object,
and it is **per media *source*, not per media type**, stored in the Drift `preferences` table under a namespaced key: `static final String _prefix =
dbSourcePrefKey(kReaderSourcePersistedKey, '')` → `'src:reader_fushi:'` (`:76`). `dbSourcePrefKey` lives in
`packages/fushi_engine/lib/media/media_pref_keys.dart` and is re-exported through `media_source.dart:28-36`, which calls the format "the single source
of truth" and a frozen persisted-key encoding. Mechanics: `ReaderSettings(this._db)` holds a `Map<String, dynamic> _cache` and writes through with
`_set<T>` → `_db.setPref('$_prefix$key', value.toString())` (`:165-175`); reads are **synchronous getters** over that cache, hydrated by
`applyPrefsSnapshot` (sync) / `loadFromPrefsSnapshot` (sync + migrations) (`:107-127`) — the doc at `:105-107` explains the sync path exists precisely
because the reader's getters are synchronous. In-place migrations run on load: `_migrateMargins` collapses
`first_dimension_margin`/`second_dimension_margin` into four `margin_*` keys (`:129-145`) and `_ensureResponsiveMarginDefaults` seeds defaults
(`:147-157`), deleting legacy keys. Defaults are single-sourced as class consts (`:82-89`) so `ReaderSettings`, `ReaderFushiSource` and the aggregator
cannot drift; values are clamped (`normalizeMarginPercent`, `:91-92`). `enum FontTarget { appUi, body, dictionary, videoSubtitle, gameLookup }`
(`:19-43`) with `isFontTargetAvailableOnPlatform` (`:47-53`) hiding `gameLookup` off Windows; each target persists its own `[{name,path,enabled}]`
list (guard: `test/reader/font_targets_wiring_guard_test.dart`).

**`ReaderEngineConfig` — per-navigation payload, not per-media-type.** `fushi/lib/src/reader/reader_engine_config.dart` (220 LOC) defines `@immutable
class ReaderEngineConfig` (`:21`), the per-navigation parameter object for the reader's JS engine: ~30 fields covering navigation generation, view
mode (`continuousMode`, `vnMode`, `vnClickAdvance`), lookup flags (`scanNonJapaneseText`, `hoverAutoLookup`, `hostHoverLookup` — the last is
**macOS-only**, `:87-91`), caret geometry, restore anchors (`initialProgress`/`initialCharOffset`/ `initialFragment`, precedence at `:107-110`),
margin/page geometry, image blur + revealed keys, and VN-shell plus audiobook cue data. The header comment (`:5-18`) records the architectural rule:
the engine JS is a **zero-interpolation static resource** served from `fushi.local` so V8 can cache the compiled script, and everything
navigation-dependent must go through this object instead of being interpolated into the script (the stated motivation is a measured median
`evalSetupScript` of 24 ms of pure fixed overhead before the change). Emission is `toJson()` (`:120`) + `toJsLiteral()` (`:213`);
`liveUpdateInvocation()` (`:174-206`) emits a small hot-update patch for margins/gesture thresholds so changing a setting does not force a chapter
reload. Guard: `test/reader/reader_engine_static_source_guard_test.dart`.

**The settings subsystem.** `fushi/lib/src/settings/` = 12,141 LOC / 33 files, laid out as a **declarative schema tree**, not per-media-type models:
`settings_schema_video.dart` (2,089), `settings_schema_reading.dart` (993), `settings_schema_lookup.dart` (984), `settings_schema_system.dart` (791),
`settings_schema_game.dart` (692), `settings_destination.dart` (619), `settings_schema_services.dart` (558), `settings_actions.dart` (488),
`settings_schema_card_creation.dart` (381), `settings_home_page.dart` (399), `settings_schema_listening.dart` (327), `settings_search.dart` (315),
`settings_schema_appearance.dart` (300), `settings_schema_downloads.dart` (298), `settings_schema.dart` (288), `material_settings_renderer.dart`
(270), `settings_schema_storage.dart` (253), `settings_schema_fields.dart` (245), `cupertino_settings_renderer.dart` (230),
`master_detail_settings_sheet.dart` (204), `settings_schema_manga.dart` (159), `settings_detail_page.dart` (144), `settings_section_container.dart`
(130), `settings_schema_manga_ocr.dart` (93), `settings_navigation_groups.dart` (74), `settings_expansion_state.dart` (56), `settings_context.dart`
(54, the `SettingsContext` bundle passed to schema builders), `settings_renderer.dart` (50), and three small
`settings_schema_{tracking,profiles}.dart`.

**The actual per-media-type mechanism is Profiles.** Granularity across media types is achieved by the profile system, not by per-type settings
classes. Tables `Profiles`, `ProfileSettings`, `MediaTypeProfiles`, `BookProfiles`, `LanguageProfiles` (`tables.dart:550-616`) let a named profile
overlay the `preferences` KV store; binding rows route "this media type → this profile", "this book → this profile", and "this content language → this
profile" (the last normalised so `ja` and `ja-JP` match — `tables.dart:596-615`). `fushi/lib/src/profile/` = 1,604 LOC;
`ProfileRepository.applyProfile` rewrites the live prefs snapshot (`profile_repository.dart:176`), `resolveProfileId` implements binding lookup
(`:398`), and `ProfileViewModel` exposes it to the UI (`profile_view_model.dart:369`). `PreferencesRepository extends ChangeNotifier implements
PrefStore` (`fushi/lib/src/models/preferences_repository.dart:94`, 3,060 LOC) is the façade over the `Preferences` table. **There is no
`MangaReaderSettings` / `NovelReaderSettings` type pair** — the manga reader persists through `media/manga/manga_view_prefs.dart` (62),
`manga_reading_mode.dart` (47) and the `EpubBooks.mangaReadingMode` column.

---

## H) Platform abstraction

**`fushi_platform` is a 45-LOC interface barrel.** `packages/fushi_platform/lib/fushi_platform.dart` (12 LOC) exports five abstract classes, all
method-signature-only: `PlatformDirectoryService` (7 LOC: `getExternalStorageDirectories`, `getDefaultPickerDirectories`, `excludeFromMediaScanner`),
`PlatformLifecycleService` (6: `restartApp`, `exitApp`, `moveTaskToBack`, `supportsRestart`), `PlatformClipboardService` (4: `copyToClipboard`,
`shouldShowCopyToast`), `PlatformPermissionService` (6: external-storage and camera check/request), `PlatformDeviceInfoService` (10: `sdkVersion`,
`deviceModel`, `manufacturer`). Two useful negative facts: the package declares `flutter` in its pubspec but **no file under
`packages/fushi_platform/lib` imports it** (`grep -rn "^import" packages/fushi_platform/lib` → exit 1, zero matches), and `fushi_platform.dart:3-7`
records that `TtsEngine` / `PlatformIntegration` / `StoragePaths` were **deleted** as dead pseudo-extensibility (HBK-AUDIT-136) — the abstraction has
already been pruned once for being speculative. There is one test (19 LOC).

**Concrete implementations live in the app, selected by a factory.** `fushi/lib/src/platform/platform_services.dart` (196 LOC) holds `class
PlatformServices` (`:28`): the five interfaces plus Anki-repository factories and three booleans (`isWindows`/`isDesktop`/`isIOS`).
`PlatformServices.forCurrentPlatform()` (`:154`) branches Android → iOS → desktop and instantiates `Android*Service` / `Ios*Service` /
`Desktop*Service`. It is constructed once in `main()` before `runApp` and injected into `AppModel` as a constructor parameter, explicitly so
`AppModel` never has to know its platform (`:22-27`). Desktop implementations live in `fushi/lib/src/platform/desktop/`.

**Desktop vs mobile in practice.** Platform branching is pervasive, not pooled: `Platform.isMacOS` appears **91×** across `fushi/lib` +
`packages/fushi_engine/lib`; all `Platform.is{Windows,Linux,Android,IOS}` together appear **367×** in `fushi/lib` alone. A small canonical helper set
exists: `isDesktopPlatform` / `isMobilePlatform` / `isAndroidPlatform` (`fushi/lib/src/utils/misc/platform_utils.dart:17-22`).
`fushi/lib/src/platform/` is 3,136 LOC / 31 files; the largest members are `gal_hook_text_overlay_channel.dart` (**1,774**, Windows-only galgame hook
— the single biggest platform file and utterly irrelevant to comics/novels), `platform_services.dart` (196), `windows_ime_guard.dart` (103),
`macos_fullscreen_state.dart` (87), `screen_brightness_controller.dart` (72), `floating_window_bounds.dart` (62), `floating_overlay_channel.dart`
(57), `selection_external_actions.dart` (57), `engine_deep_link_route_guard.dart` (45), `windows_ime_space_channel.dart` (45),
`windows_ime_space_dispatch.dart` (28), `source_url_channel.dart` (28).

**macOS-specific bits (target machine = macOS arm64).**

1. **The app is deliberately NOT sandboxed.** Both `fushi/macos/Runner/Release.entitlements` and
`DebugProfile.entitlements` **omit `com.apple.security.app-sandbox`**; the Release comment says this is required because in-app auto-update replaces
`/Applications/Fushi.app` and a sandbox cannot write there — accepted cost is no Mac App Store distribution. The remaining entitlements are kept
intentionally even though they are no-ops outside the sandbox: `files.user-selected.read-write`, `files.bookmarks.app-scope`, `network.client`,
`network.server`, `device.audio-input` (Debug adds `cs.allow-jit`).
2. **Deployment target `13.4`** — `fushi/macos/Podfile:1` (`platform :osx, '13.4'`), mirrored in the
fushidicts build phase as `MACOSX_DEPLOYMENT_TARGET:-13.4` (`fushi/macos/Runner.xcodeproj/project.pbxproj:482`).
3. **Custom data roots need security-scoped bookmarks**, and the `app.fushi/data_root_access` channel is
registered against `MacOSWindowUtilsViewController`'s *internal* engine messenger, not a top-level `FlutterViewController` (BUG-2075;
`fushi/macos/Runner/AppDelegate.swift`, `handleDataRootAccess`).
4. **Custom Swift channels**: `FushiSystemOcr` (Apple Vision, `apple/FushiSystemOcr.swift`, shared with
iOS), `FushiSpeechTranscriber` (macOS 26 SpeechAnalyzer), `app.fushi.reader/source_urls/stream`, `app.fushi.reader/foreground_selection`
(Accessibility/AX cross-process selection capture — its own comment notes it returns nil under the sandbox, kept fail-open with clipboard fallback),
and a test-only `app.fushi.test/input` channel gated on `FUSHI_TEST_INPUT`.
5. **`macos_window_utils` + `macos_ui`**: `MainFlutterWindow.awakeFromNib` installs
`MacOSWindowUtilsViewController()` and `MainFlutterWindowManipulator`, and plugins must be registered against *that* controller's engine
(`fushi/macos/Runner/MainFlutterWindow.swift`).
6. **Hidden test mode** `HIBIKI_TEST_HIDDEN` parks the window at `(-32000, -32000)`, sets `.accessory`
activation policy, and forces `canBecomeKey`/`canBecomeMain` false so integration tests can drive the real app without stealing focus.
7. **ONNX Runtime is deliberately absent on Apple.** `flutter_onnxruntime` is vendored specifically to
*drop* the ios/macos plugin-platform declarations (root `pubspec.yaml:131-138`) because upstream's podspec pinned `onnxruntime-objc 1.23` and forced
macOS 14 / iOS 16. Consequence: Apple builds have no local ONNX and manga OCR degrades to interconnect-host / Gemini cloud
(`isLocalOnnxRuntimeAvailable`). This is directly relevant — **a comic app on this stack cannot do local ONNX OCR on macOS without un-vendoring that
fork.**
8. **Aidoku + Mihon JVM runtimes are not wired into Xcode.** They are injected by CI post-build steps and
`script/build_and_run.sh`; BUG-2263 records that a plain `flutter build macos` yields an app whose `Contents/Resources/{aidoku_runtime,mihon_bridge}`
are **empty**, so both manga source systems die. Guards: `fushi/test/build/macos_mihon_bundle_guard_test.dart`,
`macos_aidoku_runtime_packaging_guard_test.dart`.
9. **The vendored fushidicts dylib is built by a Runner build phase**, not a pod: CMake configure + build +
copy into `$TARGET_BUILD_DIR/$FRAMEWORKS_FOLDER_PATH`, `install_name_tool -id @rpath/…`, then codesign (`project.pbxproj:482`; config vars at
`fushi/macos/Runner/Configs/AppInfo.xcconfig:16-20`).

---

## I) Build & tooling (macOS desktop)

**Exact commands.** `README.md:55-64` is canonical:

```bash
# From the repository root
bash tool/bootstrap.sh          # Windows PowerShell: .\tool\bootstrap.ps1
cd fushi
flutter build macos --release
```

`tool/bootstrap.sh` / `tool/bootstrap.ps1` collapse `flutter pub get` and `ci/apply-patches.sh` (`README.md:70`); the patch step matters because
several non-vendored packages are only fixed by patching the pub-cache (`melos bootstrap`'s post-hook does the same: root `pubspec.yaml:171-186`).
Also from `docs/agent/build.md:14-24`: `melos run analyze` / `melos run test` / `melos run build:android` (defined at root `pubspec.yaml:186-203` as
`melos exec -- "dart analyze --fatal-infos"`, `melos exec -- "flutter test"`, and the Android split-ABI release build).

**Full local macOS build + run, including the two JVM runtimes and ad-hoc signing:** `script/build_and_run.sh` (140 LOC). It requires Flutter at
`${FUSHI_FLUTTER_SDK:-$HOME/fvm/versions/3.41.6}` (`:14`), hard-fails off Darwin (`:35-38`), then `cd fushi && flutter build macos --debug|--release`
(`:52-56`), bundles `aidoku_runtime` with `FUSHI_AIDOKU_ARCHS=host|all` (`:60-63`), downloads/caches `mihon_bridge` with `FUSHI_MIHON_ARCHS=host`
(`:66-79`), `ditto`s it into `Contents/Resources/mihon_bridge` (`:88`), codesigns each Mach-O file (`:100-104`), runs
`tool/mihon/verify_desktop_runtime.sh` and `tool/aidoku/verify_macos_runtime.sh`, then `codesign --force --deep --sign - --preserve-metadata=… "$app"`
(`:110-113`). Output path: `fushi/build/macos/Build/Products/{Debug,Release}/fushi.app` (`:50`). Per `docs/agent/build.md` and `CLAUDE.md:12`, a fresh
worktree first needs `pwsh -File tool/setup_worktree.ps1` to copy local secret files, then bootstrap.

**Tests / analysis.** `CLAUDE.md:117`: `dart format` changed files + full `flutter analyze` (warnings are fatal in CI) + **targeted** `flutter test
<target> --no-pub`; the full suite runs only in PR CI ("本地不跑全量 测试门", decided 2026-09-06). Verdicts must rest on exit code **and** actual executed test
count, because `flutter test … | tail -N` masks build failures as passes (BUG-1157).

| SDK constraint | Location |
|---|---|
| `sdk: ">=3.8.0 <4.0.0"` | root `pubspec.yaml:5`; every member pubspec |
| `flutter: "^3.41.6"` | `fushi/pubspec.yaml:8` |
| Local toolchain pinned **3.41.6** (`.fvmrc`); **CI uses 3.44.0** | `CLAUDE.md:117` |
| Lockfile resolves `dart: ">=3.11.0 <4.0.0"`, `flutter: ">=3.41.6"` | `pubspec.lock:2563-2565` |
| App version | `2.7.0+1342` (`fushi/pubspec.yaml:5`) |

The README elsewhere claims "locked to Flutter 3.44.0 (Dart SDK `>=3.5.0 <4.0.0`)" (`README.md:70`), which contradicts `fushi/pubspec.yaml:6-8`;
**trust the pubspec**, the README line is stale.

**Code generation required before build.** `build_runner` + `drift_dev` + `json_serializable` (`fushi/pubspec.yaml:178,195,113`;
`packages/fushi_core/pubspec.yaml:21-22`); drift output alone is 91,773 LOC. `slang` generates `fushi/lib/i18n/strings.g.dart` (359,360 LOC). `ffigen`
is a dev dep of `fushi_torrent` (`packages/fushi_torrent/pubspec.yaml:10`). There is **no freezed** anywhere. `ci/apply-patches.sh` must also run (it
patches `archive` for `fushi_asr_onnx_ffi`'s constraint; root `pubspec.yaml:151-167`).

**Heavy native dependencies.** Root `pubspec.yaml:44-167` carries a long, carefully justified `dependency_overrides` list.

| Native dep | Mechanism (citation) | Relevance / verdict |
|---|---|---|
| **fushidicts** (C++) | Xcode build phase builds `native/fushidicts` → `libfushidicts_ffi.dylib` (`fushi/macos/Runner.xcodeproj/project.pbxproj:482`); `DynamicLibrary.open('libfushidicts_ffi.dylib')` (`packages/fushi_dictionary/lib/src/ffi/fushidicts_ffi_bindings.dart:9`) | **Required** for lookup + Japanese tokenization. **Reuse as-is** |
| **WKWebView** (`flutter_inappwebview` 6.1.5 + vendored Windows fork, `pubspec.yaml:90`, `:59-62`) | Both the novel reader and the comic reader are WebView pages; the comic reader uses `InAppWebView` (`media/manga/reader/manga_fushi_page.dart:4056`) | **Required.** Reuse; the Windows fork is irrelevant on macOS (and lacks `shouldOverrideUrlLoading`, BUG-117) |
| **SQLite** (`sqlite3_flutter_libs` + `sqlite3 3.52.0`, `Podfile.lock:113-128`, incl. fts5/rtree/session) | native-assets pod | **Required.** Reuse |
| **ONNX Runtime** — `flutter_onnxruntime` vendored specifically to *remove* Apple plugin declarations (`pubspec.yaml:131-138`); `onnxruntime-{c,objc} 1.23.0` linger in `Podfile.lock:86-90` but the plugin is excluded from the macOS plugin set | Manga OCR (RT-DETR detect + manga-ocr recognize) is the only reason ONNX exists; on macOS it degrades to cloud / interconnect-host | **Comics arguably need it**, but it is **disabled on macOS today** — budget a spike or un-vendor the fork |
| **libmpv / media_kit** (vendored `media_kit_libs_macos_video` fork → full-FFmpeg libmpv, TrueHD fix, `pubspec.yaml:88-109`) | — | Video only. **Drop** |
| **FFmpeg** — Android/iOS via vendored `ffmpeg_kit_flutter`; **desktop via CLI**: `CliFfmpegBackend` resolves `FUSHI_FFMPEG`/`HIBIKI_FFMPEG` → configured path → bundled → bare `ffmpeg` on PATH (`packages/fushi_engine/lib/media/video/ffmpeg_backend.dart:229-312`, `:528-557`); `third_party/ffmpeg-min/macos/{ffmpeg,ffprobe}` are prebuilt binaries | — | Video muxing only. **Drop** |
| **PDFium** (`pdfrx: 2.4.5` pinned for `archive`/`xml` compat, `pubspec.yaml:128-132`; `pdfium_flutter` pod `Podfile.lock:97`) | — | PDF only. **Drop** unless PDF-as-book is in scope |
| **libtorrent** (`native/fushi_torrent` C-ABI FFI, desktop-only) | — | Downloads only. **Drop** |
| **JVM runtimes (Aidoku / Mihon)** | Bundled post-build by CI/`script/build_and_run.sh`, **not** wired into Xcode — plain `flutter build macos` yields empty `Contents/Resources/{aidoku_runtime,mihon_bridge}` (BUG-2263) | Online manga sources only. **Drop** |
| **galgame hook** (`native/galgame_hook`, 423 files + `fushi/lib/src/platform/gal_hook_text_overlay_channel.dart`, 1,774 LOC) | — | Windows-only. **Drop** |
| **gamepads** (`gamepads` 0.1.10+2 + two vendored forks; Windows needs SDK ≥ 10.0.26100, `pubspec.yaml:55-60`) | — | **Drop** |
| **`macos_ui` + `macos_window_utils`** (native sidebar, transparent titlebar, `Podfile.lock:78-80`) | — | Optional shell polish |
| **MeCab** | **not found** — no `mecab`/`MeCab` in any Dart/YAML/gradle/CMake/markdown file | Tokenization is fushidicts instead |

Other mac-only pods pulled in by features a lean app would drop: `audio_service`, `audio_session`, `just_audio`, `record_macos`, `google_sign_in_ios`
+ `GoogleSignIn`/`GTMAppAuth`/`GTMSessionFetcher`, `bonsoir_darwin`, `flutter_local_notifications`, `share_plus`, `flutter_archive`, `sqflite`
(declared nowhere in Dart), `HotKey`, `window_manager`, `screen_retriever_macos`, `dynamic_color`, `appkit_ui_element_colors`, `clipboard_watcher`,
`desktop_drop`, `device_info_plus`, `file_picker`, `url_launcher_macos`, `wakelock_plus`, `gamepads_darwin`, `permission_handler_windows`
(`fushi/macos/Podfile.lock:2-142`, `fushi/macos/Flutter/GeneratedPluginRegistrant.swift`).

**Existing macOS build output: none.** `fushi/build/` contains only an empty `fushi/build/macos/` directory (0 bytes; `ls -la` and `du -sh` both
empty), and `find fushi/build -maxdepth 4 -name '*.app'` returns nothing. No prior `flutter build macos` has been run in this checkout.

**`third_party/` inventory (17 vendored packages):** `carousel_slider`, `desktop_drop`, `fading_edge_scrollview`, `ffmpeg-min` (prebuilt binaries),
`ffmpeg_kit_flutter` (506 files), `flutter_inappwebview_android` (232), `flutter_onnxruntime` (71), `jogamp`, `libplacebo-win` (39),
`m_extension_server` (461), `media_kit_libs_{android,ios,macos,windows}_video`, `media_kit_video` (147), `mihon-source-api`, `network_to_file_image`,
`permission_handler_windows`. **The whole tree is Windows/Android/iOS or video-centric except `flutter_onnxruntime` and `media_kit_libs_macos_video`**
— a macOS-only comics+novels app could drop essentially all of it, and with it the entire `ci/apply-patches.sh` pub-cache patching step.

**CI.** `.github/workflows/` has 16 workflows. Desktop: `release-desktop.yml` (Windows installer + macOS zip + iOS IPA; internally `apple needs:
windows` is intentionally serial), `build-multiplatform.yml` (per-platform compile gates, `flutter build macos --debug` at `:484`), `release.yml`
(Android), `release-server.yml`, plus native gates (`native-fushidicts-gate.yml`, `native-galgame-gate.yml`, `native-torrent-gate.yml`) and infra
(`libplacebo-win.yml`, `ffmpeg-min.yml`). Release channels are stable/beta/debug with a rolling `debug-rolling` tag and a hard ordering rule requiring
the migration-bridge APK before a formal release (`docs/agent/build.md`).

---

## J) Reuse assessment for a lean desktop-only (macOS) comics + novels app

| Package / module | Verdict | Justification |
|---|---|---|
| `fushi_core` — DB `FushiDatabase` + tables | **PORT (subset)** | The only place the library data model exists, but 86 tables × 104 migrations and 91,773 LOC of generated code is far too much. Port 15–20 tables (books, tags, collections, positions, bookmarks, stats, prefs, dictionary metadata) and start at `schemaVersion = 1`. |
| `fushi_core` — `MediaKind` / `BookFormat` / value-domain enums | **REUSE AS-IS** | Small, dependency-free, and the `BookFormat`/`MediaKind` split plus the "six incompatible string domains" warning (`media_kind.dart:1-17`) is hard-won discipline. Collapse to two enums. |
| `fushi_core` — migration ladder (`database.dart:822`+) | **REBUILD** | 104 hand-written steps exist only to serve existing users' legacy databases; pure liability for a new app. |
| `fushi_engine` (whole) | **PORT (selectively)** | Verified Flutter-free, so it *can* be reused as a pure-Dart dependency — but 86,838 LOC is ~63% video/media (`media/video` 37,470; `media/torrent` 8,971) plus `sync/` 19,305. Relevant: `epub/` 2,485, `media/manga/` 1,659, `ocr/` 4,074, `foundation/engine_paths.dart` 94, `dictionary/` 38, `mining/` 546. |
| `fushi_engine/epub/` (parser, importer, storage, book model) | **REUSE AS-IS** | 2,485 LOC of pure-Dart EPUB parsing/import — the single most valuable reuse candidate for a novel reader. |
| `fushi_engine/ocr/` (manga OCR: detector, recognizer, beam search, folder job) | **PORT** | Real algorithms (4,074 LOC) behind a clean `OcrInference` abstraction, but the ONNX session factory belongs to the host (`ocrSessionFactoryBuilder`) and the shipped macOS config has no local ONNX (`pubspec.yaml:131-138`). Port the algorithm; redo the macOS runtime story. |
| `fushi_engine/media/manga/` | **PORT** | Only 1,659 LOC; `mokuro_geometry.dart` even re-implements `Rect`/`Size`/`Offset` in pure Dart — a self-contained geometry core. |
| `fushi_engine` video/torrent/tracking/discovery/sync/asr/stats/updates | **DROP** | ~70k LOC serving video, torrents, cloud sync, ASR and scraping. |
| `fushi_engine/foundation/engine_paths.dart` | **REUSE AS-IS** | 94 LOC that cleanly separates three roots from derived subdirectories and refuses to guess when uninstalled. |
| `fushi_dictionary` | **PORT** | 5,324 LOC. `fushi_dictionary_core.dart` is already a Flutter-free sub-barrel; the FFI wrapper `fushidicts.dart` (814) + `language/` (1,368 incl. Japanese deinflection) + importers (`formats/` ~1,700) are the core of popup dictionary + segmentation. |
| `fushi_dictionary/formats/dictionary_downloader.dart` + `dictionary_update_service.dart` | **DROP** | 1,229 LOC of remote download/update infrastructure; a lean app can import local files. |
| `native/fushidicts` (C++) | **REUSE AS-IS** | The reason segmentation and popup lookup are fast and correct, and macOS already builds it from source via an Xcode phase. Rebuilding it is a multi-month project. |
| `fushi_audio` | **DROP** (port `_core` models only) | 12,785 LOC of playback/recording/audiobook/SRT — none of it needed, *except* that `fushi_engine` imports `fushi_audio_core` for `AudioCue`/`decodeTextBytes`; port those few classes and cut the edge. |
| `fushi_anki` | **PORT or DROP** | 13,438 LOC. "Popup dictionary" in this app effectively means Anki mining; port `fushi_anki_core` + AnkiConnect if you want card creation (desktop is AnkiConnect-only anyway — `platform_services.dart:190-196`), otherwise drop. |
| `fushi_platform` | **REBUILD** | 45 LOC of interfaces whose desktop impls are trivial; `PlatformServices` (196) also drags in Anki and Android/iOS services. A 50-line `dart:io` helper set is simpler for macOS-only. |
| `fushi_torrent` / `native/fushi_torrent`, `fushi_server` | **DROP** | Downloads only; headless host + WebUI + admin API. |
| `flutter_inappwebview_windows`, `gamepads_windows`, `gamepads_android_stub` | **DROP** | Windows/Android-specific vendored forks. |
| `third_party/*` (whole tree) | **DROP** | All Windows/Android/iOS or video-related except `flutter_onnxruntime` — and that one is *removed* from Apple builds. Dropping it also drops `ci/apply-patches.sh`. |
| App shell (`main.dart` 2,247 + `lib/src/startup/` 936) | **REBUILD** | Four entrypoints plus pre-`runApp` work for windows/theme/sidebar/Windows-resize-gating. Conceptually relevant only: `desktop_window_placement.dart` (383) and `exit_flush_registry.dart` (110). |
| App page framework (`BasePage` 71, `BaseTabPage` 93, `BaseSourcePage` 1,619, `FushiPagePlaceholders` 67) | **REBUILD** | `BaseSourcePage` is reader plumbing bound to the multi-source model; `BasePage` is trivial to re-derive. Copy the *pattern* (one `appModel` accessor, no constructor injection). |
| Novel reader (`reader_fushi_page.dart` 4,539 + `reader_fushi/` 12,860 + `lib/src/reader/` 20,938) | **PORT (heavily trimmed)** | ≈38k LOC, of which the actual engine is `reader_pagination_scripts.dart` (4,034), `reader_visual_novel_scripts.dart` (3,343), `reader_selection_scripts.dart` (1,890), `reader_content_styles.dart` (1,499). The `ReaderEngineConfig` "static JS + per-nav JSON" design (`reader_engine_config.dart:5-18`) is a genuinely good architecture worth preserving. Trim audiobook (2,123 + 581), lyrics, VN mode, gallery (1,282). |
| Comic reader (`manga_fushi_page.dart` 4,297) | **PORT (heavily trimmed)** | Same WebView engine family as the novel reader (`InAppWebView`, `:4056`) plus manga overlay HTML (1,554) and spread model (116). Drop the OCR wizard/settings (2,077), online sources (Mihon/Aidoku), downloads. |
| Media library shell (`media_source.dart` 888, `media_type.dart` 47, `media_history_repository.dart` 213, `reader_fushi_source.dart` 2,114, `media_item.dart` + `.g.dart` 221, `reader_fushi_history_page.dart` 2,807) | **REBUILD** | A generic multi-source framework built for video+audio+game+book+comic, of which only 2 `MediaType`s and 4 `MediaSource`s exist. The shelf's manual `Future` cache + ad-hoc notifiers + `refreshTab()` is the weakest code in the repo (§C). Replace with Riverpod `AsyncNotifier`/`StreamProvider` over a narrow repository; keep the `MediaOpenHistory` column/JSON split idea (`media_history_repository.dart:43-60`). |
| Collections / tags / shelf ordering (`media/collections/` 1,975, `media/tags/` 94, `collections_page.dart` 2,376, `media_collection_detail_page.dart` 2,825) | **PORT (simplify)** | The model is sound (`MediaCollections` + `MediaCollectionItems` + `ShelfEntries.sortOrder` + one polymorphic `TagAssignments`). Drop `Series` outright (frozen legacy, `tables.dart:963-967`). |
| Popup dictionary + lookup (`lib/src/lookup/` 12,929, `lib/src/dictionary/` 726, dictionary pages ~20,050, `dictionary_popup_*.dart`) | **PORT (trimmed)** | The novel-reader lookup path is the app's identity. Trim aggressively: `gal_attached_text_controller.dart` (2,217), `gal_hook_text_overlay_controller.dart` (2,077), `gal_ingame_lookup_controller.dart` (1,731) are all Windows-galgame. The portable core is `sentence_extraction.dart` (148), `global_lookup_render.dart` (524), `global_lookup_layout.dart` (418), `selection_capture_ffi.dart` (261). |
| Mining (`lib/src/mining/` 25,001) | **DROP or PORT narrowly** | Anki card-creation pipeline; the portable part is `fushi_engine/lib/mining/immersion_mining_request.dart` (546 LOC total for `mining/`). |
| Settings (`lib/src/settings/` 12,141 + `lib/src/profile/` 1,604 + `preferences_repository.dart` 3,060) | **REBUILD** | A declarative schema + three renderers + master/detail + search + a whole profile/binding system is disproportionate. Copy only `ReaderSettings`'s per-source namespaced KV (`src:reader_fushi:`) + sync getters over a prefs snapshot (`reader_settings.dart:69-127`, ~200 LOC of good design). |
| `lib/src/storage/` (5,315 LOC) | **PORT only `app_paths.dart` (656) + `macos_data_root_access.dart` (73)** | `app_paths.dart` encodes the flat/nested layout anchors, the "never `existsSync()` on a network root" rule (`:256-263`) and the data-root-before-DB ordering (`:145-150`) — all hard-won. Everything else (`data_root_migrator.dart` 1,665, `path_rebase_coverage.dart` 714, `legacy_support_dir_migration.dart` 420, `sandbox_relocation.dart` 304, `installer_data_root_bootstrap.dart` 246) exists to migrate *existing* installs: 3,600+ LOC a new app never needs. |
| i18n (`lib/i18n/strings.g.dart`, 359,360 LOC, 17 locales) | **REBUILD (slang)** | Keep the slang tool and 2–3 locales; do not import a 359k-line generated file. |
| `lib/src/sync/` (44,656), `updates/` (1,460), `asr_host/` (1,556), `creator/` (4,116), `anki/` (8,493), `controls/`, `shortcuts/` (8,550), `focus/` (2,260) | **DROP** | Cloud/LAN sync, auto-update, speech recognition, the card "creator" DSL, gamepad/touch control layouts and the elaborate focus system are optional for a desktop comics+novels reader. |

**Net recommendation.** Reuse: `fushidicts` (native), `fushi_dictionary` (minus the downloader), `fushi_engine/epub` + `ocr` + `media/manga` +
`engine_paths.dart`, the `BookFormat`/`MediaKind` value-domain discipline, the reader JS engine + `ReaderEngineConfig` design, `app_paths.dart`, and
the `ReaderSettings` KV pattern. Rebuild: the database, the library shell/state layer, the settings UI, the platform abstraction, and the app shell.
Drop: video, torrents, sync, audio, games, PDF (unless wanted), every Windows/Android vendored fork, and the migration ladder.

---

## K) Complexity budget for a minimal comics + novels desktop app

"Reused" = taken nearly verbatim; "New" = code you write.

| Capability | Reused from Fushi | Est. LOC reused | Est. LOC new | Notes |
|---|---|---|---|---|
| DB + models (library management) | `tables.dart` subset, `book_format.dart`, `media_kind.dart`, drift codegen | ~1,200 schema + ~15,000 generated | ~1,500 | ~18 tables instead of 86; `schemaVersion = 1`. Drop the ~10 tombstone/sync-baseline tables and all `Video*`/`Galgame*`/`Series`. |
| EPUB import / parse | `fushi_engine/epub/` | ~2,485 | ~200 | Pure Dart, zero Flutter — a direct win. |
| Novel reader | reader JS engine + portable subset of `lib/src/reader/` + `ReaderEngineConfig` | ~8,000–12,000 of 38,000 | ~4,000 | Keep pagination/selection/caret/CSS; drop VN mode (3,343), audiobook (2,704), lyrics, gallery. Needs a WebView plugin. |
| Comic reader | `manga_fushi_page.dart` trimmed + overlay HTML + spread model | ~3,000 of 4,297 | ~2,000 | Same WebView engine; drop OCR wizard (2,077), online sources, Mihon/Aidoku, downloads. |
| Comic import (image folders / archives) | `media/import` helpers, `book_format_convert.dart`, fushidicts archive helpers | ~300 | ~800 | Poorly separated in Fushi: most manga import logic lives in the app (`manga_import_dialog.dart` 489). |
| Segmentation (Japanese tokenization) | `fushi_dictionary/language/` + `native/fushidicts` (+ 306-LOC FFI bindings) | ~1,400 Dart + native | ~200 | fushidicts does the real work; the FFI binding is reusable as-is. |
| Dictionary import (Yomitan/MDict/ABBYY/Migaku) | `fushi_dictionary/formats/` minus downloader | ~1,700 | ~300 | Buys lookup, deinflection, frequency ranks and ruby text for free. |
| Popup dictionary UI | portable subset of `lookup/` + `dictionary_popup_webview.dart` + `sentence_extraction.dart` + `dict_style_rules.dart` | ~3,000 of 12,929 + ~2,942 | ~2,500 | The popup renders entry HTML/CSS in a WebView. |
| Library / shelf UI | `reader_fushi_history_page.dart` (concepts only) | ~500 | ~3,000 | Rebuild on Riverpod `StreamProvider`/`AsyncNotifier`; keep continue-reading via `MediaOpenHistory`. |
| Series / collection / tag UI | `collections_page.dart` concepts | ~300 | ~2,000 | Model reusable, UI should be rewritten. |
| Settings UI + persistence | `ReaderSettings` KV pattern, `ReaderEngineConfig` live update | ~400 | ~1,500 | The declarative schema tree (12,141) and profile system (1,604) are not worth porting. |
| App shell / navigation / window | `desktop_window_placement.dart`, `exit_flush_registry.dart` | ~500 | ~1,200 | Navigator 1.0 + a 2–3 destination shell. |
| Paths / data root | `app_paths.dart` + `macos_data_root_access.dart` | ~730 | ~100 | Port nearly verbatim; strip the legacy flat-layout branch if there are no existing users. |
| Dictionary management UI | `dictionary_dialog_page.dart` concepts | ~300 | ~1,500 | Import/delete/priority/CSS; global-lookup features are separable. |
| Search | source-level search + `SearchHistoryItems` | ~200 | ~600 | Local title/author search + full-text in books. |
| Packaging / build | Xcode build phase for `libfushidicts_ffi.dylib` (`project.pbxproj:482`), entitlements, deployment target | ~300 config | ~300 | No vendored forks, no patch step, no JVM runtimes, no media_kit. |

**Totals (order of magnitude).**

| Budget line | LOC |
|---|---|
| Reused (excl. generated drift code) | ~27,000–34,000 |
| Reused codegen (drift, ~18 tables) | ~15,000 (generated) |
| New code to write | **~23,000–27,000** |
| **Total hand-written own + reused** | **~50,000–60,000** |
| vs. Fushi `fushi/lib` hand-written | ~494,000 |
| Reduction | **≈ 8–10×** |

| Dependency budget | Fushi | Lean macOS comics+novels app |
|---|---|---|
| Direct runtime deps | 112 (`fushi/pubspec.yaml:10-176`) | **~20–25** |
| Transitive packages | 324 (`pubspec.lock`) | ~90–120 |
| Workspace member packages | 12 | **4–5** (`core`, `engine`, `dictionary`, app; optionally `anki`) |
| Native toolchains in the build | fushidicts, libtorrent, galgame hook, ONNX (+fork), libmpv (+2 forks), FFmpeg (Kit + CLI + slim binaries), PDFium, 2 JVM runtimes, SQLite, WebView2/WKWebView | **fushidicts, SQLite, WKWebView** (+ ONNX *only if* local manga OCR is in scope, and then only by un-vendoring `pubspec.yaml:131-138`) |
| `third_party/` vendored packages | 17 | **0** |
| Pub-cache patch step (`ci/apply-patches.sh`) | required | **not needed** |
| Drift schema versions to maintain | 104 | 1 |
| i18n locales | 17 (359k generated LOC) | 2–3 (~40k generated LOC) |

Indicative minimal dependency set: `flutter`, ported `fushi_core` + `fushi_engine` subset, `fushi_dictionary`, `drift` + `sqlite3` +
`sqlite3_flutter_libs`, `flutter_riverpod`, `flutter_inappwebview`, `path` + `path_provider`, `shared_preferences`, `file_picker`, `slang` +
`slang_flutter`, `desktop_drop`, optional `window_manager`, and `flutter_onnxruntime` **only if** local manga OCR is in scope.

**Biggest risks / unknowns.** (1) **ONNX is disabled on macOS by design** (`pubspec.yaml:131-138`), so local comic OCR on macOS arm64 is *unproven*
here — budget a spike. (2) **The reader and popup engines are WebView-based and heavily tuned**; `reader_engine_config.dart:5-18` shows the
static-script + per-nav-JSON split was a real performance fix (median `evalSetupScript` of 24 ms pure overhead before it), so any rebuild must
preserve that property or accept the regression. (3) **Shelf state is imperative and non-reactive** (§C) — rebuilding it on Riverpod is a design
change, not a port; plan for it rather than discovering it mid-implementation. (4) **`fushi_engine` is only nominally standalone**: it declares
dependencies on `fushi_audio`, `fushi_anki` and `fushi_dictionary` (`packages/fushi_engine/pubspec.yaml:17-26`) and imports their `_core` sub-barrels,
so pulling the engine out while dropping audio/anki requires cutting that edge and porting a few model classes. (5) **No macOS build has ever been
produced in this checkout** (`fushi/build/macos/` is empty), and several macOS-only mechanisms (bookmark channel, dylib build phase, Mihon/Aidoku
injection) are exercised only by CI — budget time for a first successful `flutter build macos`.
