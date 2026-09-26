# 03 — Dictionary, Word Segmentation (分词), and Click-to-Popup Lookup

Analysis of the Fushi / Hibiki immersion-learning app (`/Users/heyanle/Desktop/project/Fushi`).
Scope: dictionary engine, tokenizer, click→popup lookup chain, mining, integration points,
native boundary, minimal desktop clone inventory, and gotchas.

All citations are `path/file:LINE` relative to the Fushi repo root unless stated otherwise.
Nothing in the Fushi repo was modified.

---

## Executive summary (read this first)

1. **There is no morphological analyzer.** No MeCab, Sudachi, jieba, kuromoji, or Vibrato
   appears anywhere in Dart, C++, CMake, Gradle, or Xcode sources. The only hits in the tree
   are prose in `docs/` (`docs/specs/2026-05-16-multiplatform-design.md`,
   `docs/bugs/BUG-442-clipboard-long-text-crash.md`, etc.). Verified by
   `grep -ril "MeCab|sudachi|jieba|kuromoji|vibrato"` over all `*.dart`, `*.cpp`, `*.hpp`,
   `*.cmake`, `CMakeLists.txt`, `*.gradle`, `*.json`, `*.yaml`.

2. **Segmentation is greedy longest-match against the user's own dictionary index**, i.e. the
   dictionary *is* the tokenizer. See `packages/fushi_dictionary/lib/src/language/implementations/japanese_language.dart:73`
   (`textToWords` → repeated `FushiDicts.instance.lookup(...)` taking `results.first.matched.length`)
   and the native scan-side twin `native/fushidicts/fushidicts_src/scan/word_scan.cpp:52`
   (`scan_candidates` yields every prefix of the query down to length 1).

3. **The lookup engine is a ~10 kLOC C++23 library** (`native/fushidicts/`), a deep fork of
   `Manhhao/hoshidicts` (`native/fushidicts/UPSTREAM.md:9`), exposed to Dart over `dart:ffi`.
   It owns import (zip/MDX/StarDict/DSL parsing), an on-disk hash+bloom+blobs format,
   deinflection, ranking, and popup-JSON generation.

4. **The "popup" has three distinct renderers**, not one:
   - in-app Flutter overlay + `flutter_inappwebview` WebView (`dictionary_popup_layer.dart`,
     `dictionary_popup_webview.dart`, asset `fushi/assets/popup/popup.html`);
   - app-*outside* Windows native `WS_POPUP` HWND hosting its own WebView2
     (`fushi/windows/runner/global_lookup_window.cpp:1076`);
   - Android: a separate `PopupDictActivity` with a warm `FlutterEngine` running the
     `popupMain` Dart entrypoint (`fushi/android/app/src/main/java/app/fushi/reader/PopupDictActivity.kt:34`,
     `PopupEngineHolder.kt:27`).

5. **The single most load-bearing file for a clone is the C++ engine directory**; the single
   most load-bearing Dart file is
   `packages/fushi_dictionary/lib/src/language/language.dart` (result shaping + popup JSON).

---

## A) Dictionary engine — `packages/fushi_dictionary/lib/`

### A.1 Layers and the FFI seam

`packages/fushi_dictionary` is split into two barrels by *Flutter dependency*, not by feature:

| Barrel | Contents | Why |
|---|---|---|
| `lib/fushi_dictionary_core.dart` | `engine/fushidicts_models.dart`, `language/transform_description_i18n.dart`, `models/dictionary_entry.dart`, `models/dictionary_search_result.dart` | zero-Flutter subset consumed by the headless server (`packages/fushi_server`, `dart compile exe`) and pure-Dart engine (`packages/fushi_engine`). `fushi_dictionary_core.dart:1-16` explains that any `package:flutter/...` import would drag in `dart:ui`. |
| `lib/fushi_dictionary.dart` | everything else (engine, formats, language, frequency) | needs `material`, `file_picker`, platform plugins. Note `fushi_dictionary.dart:16-20`: the raw FFI bindings are deliberately **not** exported, because the `Ffi*` struct mirrors hold native-owned `Pointer<Utf8>` valid only between a call and its matching free. |

`lib/fushi_dictionary.dart:1` declares `library hibiki_dictionary;` — the old project name.

### A.2 `engine/dictionary.dart` — dictionary metadata model

- `enum DictionaryType { term, frequency, pitch, kanji }` — `engine/dictionary.dart:5`. These are
  the four native buckets; they map 1:1 to `fushidicts_add_{term,freq,pitch,kanji}_dict`.
- `enum DictionaryCollapseState { expanded, collapsed, inherit }` — `engine/dictionary.dart:14`,
  documented as BUG-2158: "no explicit collapse" is not the same as "expanded", because the
  global `collapse_dictionaries` default is true. Pre-fix a single `collapsedLanguages` list
  carried both meanings so the settings-page "unfold" button had no state to write.
- `kDictTypeProbeKey = 'typeProbe'`, `kDictTypeProbeVersion = '1'` — `engine/dictionary.dart:39,42`.
  The value is a *prober version*, not `'true'`, so bumping the version re-probes existing
  dictionaries. The comment at `:25-38` documents the failure mode: reverse-inferring "was
  probed" from `hasKanji` collapses "not probed" and "probed, nothing to change", so startup
  self-heal re-scanned every dictionary's full hash table on every launch — several 10k random
  page reads per dictionary on a cold mobile cache.
- `dictionaryDisplayNameOverridesOf(Iterable<Dictionary>)` — `engine/dictionary.dart:58`. Single
  derivation point of *real name → display name*, consumed by five call sites (popup injection,
  floating window, extension dispatch, storage usage, browser-extension CSS cache key).
- Key fields: `name` (primary key, disk dir name, engine load path, CSS map key,
  `data-dictionary` selector, media URL, Anki `{single-glossary-<name>}` token) vs `displayName`
  (display only) — `:102-135`. The comment at `:126-134` is explicit that renaming must not
  leak into any of those keys.
- `sourceLanguage` / `targetLanguage` come from yomitan `index.json` metadata
  (`:139`, `:145`); `effectiveSourceLanguage` / `effectiveTargetLanguage` give user override
  priority (`:149`, `:155`).
- `isTypeProbed` — `:176`. `copyWith` — `:189`, exists specifically to prevent silent
  user-setting loss: `DictionaryRepository._dictionaryToCompanion` writes `Value(...)` for
  *every* column, so a hand-constructed `Dictionary` that omits one writes an explicit NULL
  (`:180-188`).
- `isHidden(Language)` — `:209`; `collapseStateFor` / `collapseStateForCode` — `:219-232`
  ("expanded" is checked before "collapsed" deliberately, so overlapping lists from external
  writers give a defined answer).
- Online-update metadata: `revision` (`:246`, TODO-609), `indexUrl` (`:249`), `downloadUrl`
  (`:252`), `isUpdatable` (`:257`, a three-condition AND gate).

### A.3 `engine/dictionary_utils.dart` — 10-line shim

`importDictionaryViaFushidicts({zipPath, outputDir, breadcrumbDir})` → `FushiDicts.importDictionary`
(`engine/dictionary_utils.dart:3-9`). Nothing else.

### A.4 `engine/fushidicts.dart` — the Dart-side engine wrapper (814 lines)

Lifecycle:

- `FushiDicts()` — `engine/fushidicts.dart:142-154`. Calls `_bindings.create()`; guards
  `handle == nullptr` and throws `StateError('fushidicts_create returned nullptr ...')`. The
  comment at `:145-148` explains BUG-2110: the FFI guard converts native exceptions into zero
  returns, so `create` failure yields `nullptr` rather than `terminate`; `nullptr` is a non-null
  `Pointer` object, so `_handle!` does not stop it and every export would dereference it → SIGSEGV.
- Singleton: `static FushiDicts? _instance` (`:159`), `static FushiDicts get instance` (`:180`)
  which first settles any pending schedule.
- **Deferred, O(N)-not-O(N²) loading.** `_pending` (`:178`) with a long rationale at `:167-177`:
  metadata writes happen per-dictionary (import N → N writes; startup self-heal → per-dictionary),
  so an immediate rebuild would cost O(N²). `scheduleTyped({termPaths, freqPaths, pitchPaths,
  kanjiPaths})` (`:262`) only records the last intent; `initialize`/`initializeTyped`
  (`:227`, `:248`) apply immediately for the cases that need it (deleting dictionary
  directories, tests).
- `loadPendingAsync()` — `:323-370`. Loads into a **shadow instance**, yielding to the event loop
  (`await Future<void>.delayed(Duration.zero)`) after each dictionary, then atomically swaps.
  Rationale at `:308-322`: a single synchronous FFI burst freezes the main isolate, so the 12 s
  startup IO watchdog (`AppModel`) and the 20 s "loading too long" escape UI in `main.dart` —
  both `Timer`s — never fire. Yielding must use `Future.delayed` and not `await null`, because
  the latter only drains microtasks. A generation counter (`_generation`, `:299`) invalidates
  an in-flight shadow if intent changed; `_inFlightShadow` (`:306`) is registered so
  `releaseAllMappings` can free its file mappings too.
- `releaseAllMappings()` — `:441-453`. The rationale at `:430-440` is operationally critical:
  native `add_dict` `MapViewOfFile`s `hash.table` / `bloom.filter` / `blobs.bin` / `media.bin` /
  `media.idx` (`native/fushidicts/fushidicts_src/query.cpp:167-191`, `memory/memory.cpp`), and on
  Windows `DeleteFileW` fails with `ERROR_USER_MAPPED_FILE` (1224) while any view lives. So
  **any dictionary-directory deletion must call this first** (BUG-1756). It resets to an *empty
  but non-null* engine instead of `disposeInstance()`, so a concurrent lookup degrades to an
  empty result instead of null-checking `_instance!`.
- `isInitialized` — `:188` (`_instance != null || _pending != null`).

Loading & probing:

- `addTermDict/addFreqDict/addPitchDict/addKanjiDict(path)` — `:478-512`. Each converts the path
  with `toNativeUtf8(allocator: calloc)` and frees in `finally`.
- `probeDictContent(dir)` — `:522-530`, static/handle-free, returns bitmask bit0=has term,
  bit1=has kanji, 0=failure. Used to route mixed dictionaries into both buckets and to self-heal
  mislabeled imports (`:514-521`). Native implementation walks the hash table and reads record
  type bytes (`native/fushidicts/fushidicts_src/query.cpp:749-808`).
- `loadTransforms(json)` — `:532-539` → `fushidicts_load_transforms`.
- `importDictionary(zipPath, outputDir, {breadcrumbDir})` — `:544-585`. Runs inside
  `Isolate.run`. Comment at `:542-543`: the C++ side spawns a pthread with a 32 MB stack for deep
  recursion in zip/JSON parsing, so this is safe from any isolate. `breadcrumbDir` is TODO-892's
  crash breadcrumb.

Query API:

- `query(expression)` — `:588-607` → `fushidicts_query` (raw exact query, no deinflection).
- `queryKanji(character)` — `:610-629`.
- `defaultMaxResults = 16`, `defaultScanLength = 16` — `:631-632`. **These two numbers define the
  default ceiling: at most 16 scanned code points, at most 16 returned headwords.**
- `lookup(text, {maxResults, scanLength, frequencyDictionary, frequencyOrder, primaryReading})`
  — `:640-691`. Comment at `:636-639`: the optioned variant is dispatched only when an option is
  actually set, so the default path is the old export with byte-identical behaviour (upstream
  `bc62d2b` / `86c6e2f`). Currently **no settings UI consumes** `frequencyDictionary` /
  `frequencyOrder` / `primaryReading` — "pipeline first" (`:640`).
- `lookupPopupJson(text, {maxResults, scanLength, maxTerms})` — `:694-715` → returns `'[]'` on
  null pointer. This is the C++ single-source-of-truth popup JSON (same C++ as the JNI path,
  `:693`). **The in-app Flutter path no longer calls it** — see `app_model.dart:5975-5979`:
  generating popup JSON from the already-fetched `ffiResults` in Dart removed a second full C++
  query (scan × variants × deinflect × hash × sort × zstd) per lookup.
- `getStyles()` — `:718-735`; static `dictionaryStyles` cache `:455-468`, rebuilt on every
  apply (`_rebuildStylesCache`, `:460`).
- `getMediaFile(dictName, mediaPath)` — `:738-773`. HBK-AUDIT-100 (`:749-763`): native signals
  allocation failure as `size > 0, data == nullptr`; the contract stays `Uint8List?` so unguarded
  WebView callers degrade to 404 rather than crash, but a diagnostic is printed so OOM is
  distinguishable from not-found.
- `withPaths<T>(paths, action, {kanjiPaths})` — `:775-795`, scoped temporary handle for tests.
- `_utf8OrEmpty(Pointer<Utf8>)` — `:19-35`. Returns `''` for `nullptr`, and on `FormatException`
  re-decodes bytes up to the first NUL with `allowMalformed: true` — dictionaries imported from
  non-standard encodings otherwise crash every lookup with a strict `utf8.decode`.
- `preloadTransforms()` — `:192-213`. Reads `assets/transforms/manifest.json` (a JSON array of
  language codes) then `assets/transforms/<lang>.json`, caches the list, and replays it through
  `loadTransforms` on every new handle (`_loadCachedTransforms`, `:215-220`).

### A.5 Supported dictionary formats

Import is **entirely native**. The Dart `DictionaryFormat` subclasses are UI/packaging
descriptors only — every one of them delegates to C++ or is an explicit no-op stub:

| Dart class | `uniqueKey` | extensions | Dart-side status | Native status |
|---|---|---|---|---|
| `YomichanFormat` | `yomitan` | `zip` | real name/dir prep, `prepareEntries` stub | **full support** |
| `MdictFormat` | `mdict` | `zip`, `mdx` | extracts / copies, then throws or no-ops | **full support** (`.mdx`, `.mdd`) |
| `AbbyyLingvoFormat` | `abbyy_lingvo` | `dsl` | UTF-16 → UTF-8 transcode, `#NAME` parse | **full support** (`.dsl`) |
| `MigakuFormat` | `migaku` | `zip` | extract only; `_prepareEntriesMigakuStub` says *"No-op: fushidicts only supports Yomitan format"* | works only because Migaku zips are yomitan-layout |
| StarDict | *(no Dart class)* | `.ifo` | — | **full support** |

Citations: `formats/dictionary_format.dart:5-35` (abstract contract; `prepareEntries` takes a
`dynamic database` placeholder with the comment *"Previously took an Isar instance; will be
replaced by fushidicts (C++ FFI)"* at `:29-31`); `formats/yomichan_dictionary_format.dart:24-42`;
`formats/mdict_format.dart:12-23` and the `_prepareEntriesMdictStub` comment at `:70-76`
(*"Import handled by fushidicts C++ importer (auto-detects MDX format)"*, but note the function
above it at `:57-67` still says *"MDict reading via dict_reader has been removed ... Throw so
callers know this format is not yet functional"* — the two comments contradict each other, and
the native side does support MDX); `formats/abbyy_lingvo_format.dart:20-38`, stub `:70-74`;
`formats/migaku_dictionary_format.dart:13-24`, stub `:52-56`.

The authoritative dispatch is native — `native/fushidicts/fushidicts_src/importer.cpp:2106-2144`:

```
ext == ".mdx"  -> import_mdx
ext == ".dsl"  -> import_dsl
ext == ".ifo"  -> import_stardict
zip with index.json          -> import_yomitan
zip containing *.mdx         -> import_mdx_from_zip
zip containing *.ifo         -> import_stardict_from_zip
else -> { success=false, errors={"unsupported dictionary format"} }
```

Yomitan bank discovery — `importer.cpp:71-95` (`get_files`): `term_bank_*`, `kanji_bank_*`,
`term_meta_bank_*` / `kanji_meta_bank_*`, `tag_bank_*`; everything else except `styles.css` and
`index.json` becomes media. Uses `zip.logical_name(i)` so a wrapper directory
(`MyDict/term_bank_1.json`) still works — the comment at `:74-76` records the bug where matching
the raw name sent every bank into `media_files` and produced an "empty dictionary".

Type detection — `importer.cpp:97-129` (`detect_type`): term bank present wins over kanji bank
(a mixed JA-JA 国語辞典 with an embedded kanji appendix is fundamentally a term dictionary;
classifying it as kanji returned nothing for word lookup, `:98-105`). If no term/kanji banks,
the first meta bank's `mode` decides `frequency` / `pitch` / `ipa`. IPA must be classified as
`pitch` or the data is unreachable — `:118-124`, referencing upstream `918744d` and TODO-687.

Rich media: MDX `.mdd` companions plus numbered overflow parts are auto-mounted
(`importer.cpp:1521-1554`, `collect_sibling_mdd_paths` at `:1062`), loose sibling assets next to
an `.mdx` are folded into the same media store, and a sibling stylesheet is discovered by
scanning `<link>` tags rather than assuming `Foo.mdx → Foo.css` (`:1493-1503`, `read_sibling_css`
at `:1295-1306`).

### A.6 On-disk format and the exact lookup algorithm

**Disk layout** (`native/fushidicts/fushidicts_src/query.cpp:131-219`, `add_dict`):

- Import-complete/version marker files: `.fushidicts_2` (v2), `.fushidicts_1`, and legacy
  `.hoshidicts_1` — `query.cpp:118-127`. Reading accepts both the new and the pre-rename name;
  the comment at `:103-117` records that after a rename the write side only produced
  `.fushidicts_1` while users' disks held `.hoshidicts_1`, so `add_dict` returned early and
  **every one of 26 dictionaries silently stopped loading** (zero results with intact files).
  Reading old data is treated as migration code; user files are never rewritten, because that
  would break users rolling back.
  v2 adds kanji `stats` and optional `dict.zstd` trained dictionary (`:113-116`).
- `index.json` → `Index::title` used as the dictionary name. `:148-157` documents a real
  use-after-free: glaze parses strings zero-copy, so `Index::title` is a `string_view` into
  `index_buf`; reading it after the buffer left scope yielded `"<garbage> + <tail of title>"`,
  rendered as U+FFFD in the popup.
- `styles.css` → `dict.styles` (`:159-162`).
- `hash.table` (`:167-171`): `[u32 capacity][slot{u64 hash, u64 offset} × capacity]`.
- `bloom.filter` (`:177-181`): optional. Missing/corrupt → bloom stays empty and `contains` is
  always true (pass-through); the upstream "rebuild bloom if missing" migration was dropped
  because `build_to_file` failure would throw across the un-try/caught FFI entry (`:173-176`).
- `blobs.bin` (`:183-186`): the record + glossary blob store. Layout for the offset index:
  `[u32 count][u64 record_offset × count]`; each record starts with a type byte
  (0 = term, 1 = meta, 2 = kanji) — documented at `query.cpp:738-748`.
- `media.bin` + `media.idx` (`:188-191`); `media.idx` = `[u32 count][u64 record_offset × count]`
  sorted by path, binary-searched at query time (`:680-708`).
- `dict.zstd` (v2, `:195-203`): optional ZSTD trained dictionary, attached as `ZSTD_DDict`.

**Term lookup — `query_raw(expression)`** (`query.cpp:245-336`):

For each term dictionary: `data->table(expression)` gives an offset into `blobs.bin` (0 = miss).
Then for each of the `count` records: read the u64 record offset, read type byte, require
`type == 0`, read `expr_len:u16`, `expression`, `reading_len:u16`, `reading`. Accept if
`expr == expression || reading == expression` (`:279-281`) — **so the index is keyed on both
surface form and reading**, and a lookup by reading works. Then read `glossary_offset:u64`,
`glossary_size:u32`, `definition_tags`, `rules`, `term_tags`, and (v2 only) an `i32 score`
appended after `term_tags` (`:295-300`). Results accumulate into a
`std::map<pair<expression_view, reading_view>, TermResult>`, so different dictionaries'
identical `(expression, reading)` collapse into one `TermResult` with N glossaries, and their
`rules` are concatenated with a space (`:310-329`). Multi-dictionary `score` takes the max
(`:325-326`).

**Kanji lookup — `query_kanji(character)`** (`query.cpp:338-432`): same hash table, requires
`type == 2`, then `character`, `onyomi`, `kunyomi`, `radical`, `strokes`, `tags` (consumed but
unused — cursor alignment, `:379-380`), `meanings_offset/size`, and for v2 a `u8 stat_count`
followed by `u8 key_len`/key/`u16 val_len`/value pairs (`:394-409`). Meanings decompress to a
newline-joined string split into a list (`:411-426`).

**Deinflection-based lookup — `Lookup::lookup`** (`lookup.cpp:54-282`), the real entry point used
by click-to-popup. Pipeline:

1. **Candidate generation.** `scan_candidates(lookup_string, scan_length)` yields prefixes
   (`lookup.cpp:60`). `word_scan.cpp:52-79`: take the first `min(scan_length, text_len)` code
   points; walk `i` from `start` down to 1; cut at the `i`-th code point; keep the prefix iff
   (a) it is at end-of-string or the cut does not split two "space-delimited letters" and
   (b) the last code point is not whitespace. `is_space_delimited_letter` (`word_scan.cpp:12-42`)
   covers Latin / Greek / Cyrillic / Armenian / Hebrew / Arabic / Georgian only — deliberately
   **not** CJK, kana, Hangul, digits, punctuation, combining marks, or spaceless scripts, which
   fall back to the per-code-point behaviour.
   *Consequence with the defaults: the scanned window is the first 16 code points and the word
   returned is at most 16 code points.*
2. **Text pre-processing.** `text_processor::process(search_str)` returns a `std::map` of
   text-variant → step count (`lookup.cpp:61`). The processor chain (`text_processor.cpp:723-742`)
   fans out over each processor's options, keeping the minimum step count per produced variant:
   - Japanese chain (`text_processor.cpp:442-490`), in order: NFKC (`:448`), katakana→hiragana /
     hiragana→katakana (`:451-459`), emphatic-sequence collapse (`:462-465`, with the deliberate
     non-port of Yomitan's `full_collapse` documented at `:140-142` — it eats っ/ー and produces
     false hits like ヒットで→ひとで, and because it consumes more source text it necessarily wins
     the longest-match sort; BUG-1777), alphanumeric→fullwidth (`:466-469`), variant-kanji
     standardization (`:471-474`, data in `kanji_standardization_data.cpp`, 2135 lines),
     iteration-mark expansion (`:476-479`), fullwidth-digit→kanji-digit (`:481-486`).
   - Generic: ASCII/Latin-1/Greek/Cyrillic lowercase (`:180-199`), combining-mark / Arabic
     harakat·tatweel / Hebrew point stripping (`:203-221`), precomposed-diacritic → base
     (`:227-256`) as two *independent* {0,1} processors so both directions fan out (`:258-268`),
     apostrophe normalization to ASCII `'` **and** U+2019 (`:271-282`; BUG-2056 — U+2019 has no
     NFKC decomposition so `don’t` never matched ASCII-keyed entries or the five apostrophe rules
     in `assets/transforms/en.json`).
   - Korean chain appended **last** (`:712-721`): Hangul syllable → compatibility-jamo
     disassembly. The ordering invariant is documented at `:712-718`:
     `NFKC("ㅂㅜㄷㅡ") == "부드"`, so disassembly must run after NFKC or the early-exit range check
     will not recognize already-composed input.
3. **Deinflection.** `deinflector_.deinflect(variant.text)` (`lookup.cpp:63`) — see A.7.
4. **Query & merge.** `merge_query(query_text, deinflection)` (`lookup.cpp:67-102`) calls
   `query_.query_raw(query_text)` then `filter_by_pos`, and merges into
   `std::map<pair<expression, reading>, LookupResult>`. On collision it keeps the **longest
   `matched`**; on equal length it keeps the **lower `preprocessor_steps`** (`:77-93`). The
   comment at `:79-85` records BUG-2148's review finding: `process()` variants iterate in
   code-point order, so Hangul jamo-decomposed forms sort before the original and would
   otherwise win ties, inflating every Korean result's `preprocessor_steps` to 1.
5. **Hangul reassembly post-processing** (`lookup.cpp:104-118`): each deinflected form is
   queried in the compatibility-jamo domain *and* in its recomposed syllable form, because
   `ko.json` writes rules in the jamo domain while the dictionary index keys are precomposed.
   Both forms are queried rather than choosing one, since 116 of `ko.json`'s rules already write
   precomposed syllables in `toSuffix`. The `_utf8` variant has a byte-level pre-check that
   returns the input unchanged when it contains no compatibility jamo — one Japanese lookup
   produces dozens-to-hundreds of deinflected forms, so unconditional utf8↔utf32 round-trips are
   pure CPU burn (`text_processor.hpp` docs on `reassemble_hangul_utf8`, and BUG-1868).
6. **MDX/StarDict redirect-alias suppression** (`lookup.cpp:124-158`). Comment at `:124-139`:
   MDX/StarDict importers resolve `@@@LINK=` / `.syn` redirects by copying the target's
   definition under the inflected key, so looking up `belongs` yields both the alias exact hit
   (0 transforms, sorts first) and the deinflected lemma hit — making the popup header and the
   mined card carry the inflected surface form while Yomitan mines the lemma. The importer
   dedupes identical definitions by hash into **one compressed blob**, so within a dictionary an
   alias glossary and its lemma glossary share the same `compressed_data` pointer; the detector
   uses that byte-exact identity (`same_blob`, `:140-143`) and needs no re-import. Results whose
   glossaries all vanish are erased (`:158`).
7. **Frequency enrichment** — once, on the deduplicated set (`lookup.cpp:169-171`; BUG-1304
   measured ~69 `query_raw` calls per user lookup and 9.4 → 3.2 enrichments per lookup, ~5-9%
   end-to-end). `enrich_freq` (`query.cpp:440-496`) looks up `term.expression` in each frequency
   dictionary, requires record `type == 1` and `mode == "freq"`, parses the payload with
   `yomitan_parser::parse_frequency`, and drops entries whose `reading` is set and differs from
   the term's reading.
8. **Sorting** (`lookup.cpp:202-267`), applied via `std::ranges::partial_sort` to `max_results`
   *before* the resize. Comparator key order:
   1. `primary_reading` exact match first (`:207-214`);
   2. longer `matched` first, measured in code points via `utf8::distance` (`:216-220`);
   3. fewer `preprocessor_steps` (`:222-226`);
   4. shorter deinflection `trace` (`:228-232`);
   5. `term.expression == deinflected` first (`:234-238`);
   6. iterate **all** registered frequency dictionaries in registration order, ascending value,
      `INT_MAX` when absent (`:240-246`);
   7. if an explicit `frequency_dictionary` was requested, that dictionary's value decides,
      ascending or descending, present-before-absent (`:248-257`);
   8. higher `term.score` first (`:259-262`; v2 dictionaries persist it, v1 is always 0);
   9. `expression == reading` first (`:264-266`).
   The sort options are only reachable through `fushidicts_lookup_with_options`; the default
   `fushidicts_lookup` behaves exactly as before (`lookup.hpp:16-28`).
9. **Resize** to `max_results` (`:269-271`).
10. **Pitch enrichment and glossary materialization only for the survivors** (`:276-279`) —
    pitch is not read by the comparator so it can wait; this is explicit BUG-1304.

`filter_by_pos` (`lookup.cpp:284-292`): if the deinflection carries condition bits, erase any
term whose `rules` conditions do not intersect. `pos_to_conditions` treats the wildcard `"*"`
(used by MDX/StarDict/DSL simple dictionaries, which carry no POS) as **all bits set**, so
simple-dictionary terms survive any deinflected lookup instead of being dropped
(`deinflector.cpp:217-235`).

**Glossary decompression** — `query.cpp:618-645`. `ZSTD_getFrameContentSize`, a 64 MB ceiling
(`kMaxGlossarySize`, `:628`), then `ZSTD_decompress_usingDDict` with a `thread_local` reused
`ZSTD_DCtx` (`:61-64`, upstream `8993838` — materializing one popup decompresses dozens of
glossaries). `materialize(term)` (`:647-651`) fills `g.glossary` for each glossary.

**Media read** — `get_media_file_view` (`query.cpp:661-726`): normalize the path
(`fushidicts::normalize_media_path`), find the term dictionary by name, binary-search
`media.idx`, and fall back to a back-slash variant for legacy imports (`:715-722`).

### A.7 Deinflection for Japanese — how it actually works

Rules live in `assets/transforms/<lang>.json`, preloaded at startup
(`fushi/lib/main.dart:518`, `fushi/lib/popup_main.dart:43`), driven by
`assets/transforms/manifest.json`. Measured contents:

| file | transforms | conditions | rules |
|---|---|---|---|
| `ja.json` | 54 | 22 | **834** |
| `ko.json` | 450 | 15 | 2682 |
| `fr.json` | 9 | 5 | 2672 |
| `es.json` | 14 | 8 | 518 |
| `ar.json` | 42 | 26 | 587 |
| `en.json` | 16 | 7 | 98 |

(18 languages total; the manifest lists 18 entries and `transforms/i18n/` holds localized
descriptions.)

Loading — `deinflector.cpp:117-215`:

- JSON schema is `{language, conditions: {name: {name, isDictionaryForm, subConditions}},
  transforms: {key: {name, description, rules: [{type, fromSuffix, toSuffix, fromPrefix,
  toPrefix, from, to, conditionsIn, conditionsOut}]}}}`, mirrored by glaze metadata at
  `:51-95`.
- **Per-language condition bit allocation** (`:127-142`): each language gets its own bit
  numbering starting at 0, namespaced as `"<lang>:<condition>"`. Capped at 64 bits per language;
  overflow logs and returns 0 (`:129-135`).
- **Sub-condition expansion** is an iterative fixed point capped at 100 iterations (`:144-166`),
  so `v` accumulates the bits of `v1`, `v5`, `vk`, `vs`, `vz`. A cycle logs a warning.
- Bare POS tags accumulate bits across **all** languages (`|=`) into
  `pos_to_condition_cache_` (`:168-175`). The comment argues cross-language false positives are
  near-impossible because suffix matching routes by language.
- Rule kinds (`:191-212`): `suffix` → keyed on `fromSuffix`, may match anywhere including
  mid-word; `prefix` → keyed on `fromPrefix`; `wholeWord` → keyed on `from`, and only applies
  when the remaining prefix is empty (`is_whole_word`). `max_suffix_length_` /
  `max_prefix_length_` record the longest keys for the scan.

Search — `deinflect_recursive` (`deinflector.cpp:244-300`):

- Every intermediate form is emitted as a result *before* recursing (`:252`), so the original
  string is result 0 with the incoming condition bits.
- Length-1 strings and depth > `kMaxRecursionDepth = 10` (`deinflector.hpp:46`) stop.
- Suffix pass scans longest-to-shortest (`:257-278`): for `i` from `min(max_suffix_length_,
  text_len)` down to 1, take the last `i` code points, look up exact map, and for each rule:
  skip `is_whole_word` if the prefix is non-empty; skip if `conditions != 0 && !(conditions &
  rule.conditions_in)`; transform to `prefix + rule.to`; push the rule's `TransformGroup` onto
  the trace; recurse with `rule.conditions_out`; pop the trace.
- Prefix pass scans shortest-to-longest up to `text_len - 1` (`:281-300`), transform is
  `rule.to + remainder`.
- The **trace** is a `std::vector<TransformGroup>` of `{name, description}` pushed in
  *stripping* order (outermost inflection first). `DeinflectionResult` carries
  `{text, conditions, trace}` (`deinflector.hpp:14-18`).

Dart-side presentation of the trace — `packages/fushi_dictionary/lib/src/language/language.dart:431-448`
(`buildDeinflectionTags`): this is documented as **the single place in the whole app that
generates deinflection labels**; all three popup paths and the C++ `build_popup_json` must share
the semantics. The trace is **reversed** for display because the user reads the *joining* order,
not the *stripping* order: `当たっていた`'s trace is `[-た, -いる, -て]` and displays as
`-て « -いる « -た`, matching Yomitan. When the trace is empty but `matched != deinflected`,
it falls back to a single `matched → deinflected` tag — that is `lookup.cpp`'s **text-variant
normalization** (colour→color), which passes through no inflection rule, so it has neither a
trace nor a grammar description. That fallback branch is explicitly protected from deletion.

`deinflectionTagsToJson` (`:451`), `localizeDeinflectionTags` (`:463`, called **only at the
display boundary** — the persisted `extra` must store English so switching UI language works,
BUG-2038), `deinflectionTagsFromExtra` (`:478`), `buildLookupEntryExtra` (`:499-533`).

`lookupHeadwordKey(r)` (`:588-592`) is `'${expression}\n$effectiveReading'` where an empty
reading normalizes to the expression — BUG-791, because Yomitan treats an empty reading as
"reading == expression" and without normalization the same kana headword split into two headwords.

### A.8 Frequency ranking

Two layers rank by frequency, and they are deliberately different:

**Native, inside the lookup sort** (`lookup.cpp:29-47`, `:240-257`) uses the **raw** `value`
field of each frequency record, per dictionary, ascending, `INT_MAX` when absent. It only sees
`term.frequencies` that `enrich_freq` attached.

**Dart, for mining fields and Anki reordering** — `packages/fushi_dictionary/lib/src/frequency/frequency_rank.dart`,
documented at `:1-6` as the single source of truth shared by the Anki field
`{frequency-harmonic-rank}` (`FrequencyField`) and the new-card reordering
(`AnkiDeckReposition`):

- `FrequencyAggregate { harmonic, min }` — `:11-22`; `harmonic` is Yomitan's
  `frequency-harmonic-rank` = `floor(n / Σ(1/rank))`.
- `frequencyRankOf(value, display)` — `:28-35`. The **leading digits of `display` win**, then
  `value`; both must be positive. This handles JPDB-style dictionaries that use `value` as a
  sequence number and put the real rank in `displayValue`.
- `dictionaryFrequencyRank(frequencies)` — `:38-45`, takes the **minimum** rank within one
  dictionary across readings/inflections.
- `aggregateFrequencyRanks(ranks, mode)` — `:50-72`. Two documented numerical traps:
  (a) a single rank short-circuits, because `1/(1.0/n)` mis-rounds 5850 of the integers in
  `1..100000` down by one (`:52-54`); (b) when the harmonic mean lands within `1e-9` of an
  integer it is snapped, because the value became a **sort key** for the new-card queue and an
  off-by-one merged two cards into a tie, falling back to due order, and made
  `source: field` disagree with `source: dictionaries` (`:62-71`).

### A.9 Result ordering and deduplication — the Dart boundary

`buildResultFromLookup` (`language.dart:535-581`):

- `bestLength` = max `r.matched.length` (Dart UTF-16 length) — `:554-556`. This is the app-wide
  "matched span" truth used for popup highlighting.
- **Budget is measured in headwords, not glossary lines** — BUG-1472, `:543-550`. The engine's
  `max_results` is a headword budget, but this function used to count glossary lines against the
  same number. Because `query.cpp` merges different dictionaries' identical `(expr, reading)`
  into one `TermResult` with N glossaries, a high-frequency headword like 永遠/えいえん alone
  carries 7–26 lines, so loading a few dictionaries consumed the whole budget and later
  headwords (とわ / とこしえ) never entered the loop. User symptom: "looking up 永遠 only ever
  returns えいえん". The budget now counts distinct `lookupHeadwordKey`s (`:550-562`) and the
  truncation fact is surfaced explicitly as `DictionarySearchResult.truncated` (`:578`) rather
  than reverse-inferred (`dictionary_search_result.dart:40-50`).
- Glossaries are emitted per `_glossariesInDictionaryOrder(term.glossaries, dictionaryOrder)`
  (`:563-572`).

`_glossariesInDictionaryOrder` (`:772-792`): the native engine appends glossaries in
dictionary-registration order, which is an implementation detail, not part of the FFI payload;
a warm/independent lookup surface can hand this builder a stale ordering even though the
management page already exposes the new one. So the explicit current order is applied here, with
unknown dictionaries last and stable.

`buildPopupJsonFromLookup` (`:594-762`) is the popup-JSON builder shared by the in-app popup,
the app-external overlay, the browser extension, and mining. It hand-writes JSON into a
`StringBuffer` for speed. Details worth noting:

- Same headword budget rule as above (`:621-628`).
- **Hidden dictionaries are filtered at the source** (`:639`). Comment at `:631-638`: this filter
  used to live only in render-time JS driven by an injected `window.hiddenDictionaryNames`; the
  in-app WebView injected it but the extension's HTTP path never did, so disabled dictionaries
  still appeared (and were mined) in the extension. Moving the filter to the single data exit
  fixes app popup / global lookup window / browser extension / mining at once. It sits at the top
  of the loop so a hidden-dictionary-only headword neither creates an empty card nor consumes
  budget.
- `matched`/`trace` update rule (`:652-660`): for the popup path the **last qualifying
  deinflection wins**, deliberately (matched and trace stay consistent within one
  `FushiLookupResult`) — unlike the fallback path in `buildLookupEntriesJson`.
- Frequency dedup key is `dictName:value:display,...` (`:662-668`); pitch dedup key folds
  positions **and** patterns **and** transcriptions (`:669-680`) — IPA entries have no pitch
  accents and pattern-only accents have no numeric positions, so a positions-only key would
  collapse distinct records and drop all but the first.
- Glossary content is passed through as raw JSON when it starts with `[` or `{`, otherwise
  JSON-encoded as a string (`:682-690`).
- Deinflection tags in popup JSON are localized at this point (`:705-711`) with an explicit note
  that the persisted `extra` is not translated (BUG-2038).

`DictionarySearchResult` (`models/dictionary_search_result.dart`) carries `searchTerm`, `entries`,
`bestLength`, `scrollPosition`, `kanjiResults`, `truncated`, `headwordCount`, and a mutable
`popupJson`; `withKanjiResults` (`:78-90`) exists because the term fields are `final`.
`kanjiResults` is documented (`:60-64`) as orthogonal to the term index: a single kanji can be
both a term headword and a kanji entry, so the kanji bucket is queried independently
(`app_model.dart:5957-5962`) and attached to whatever term result comes back.

Kanji bucket results: `queryKanjiForTerm` (`app_model.dart:5895-5899`) is gated on
`isSingleKanji(searchTerm)`.

---

## B) Tokenizer / word segmentation (分词)

### B.1 There is no morphological analyzer

Exhaustive grep across `*.dart`, `*.cpp`, `*.hpp`, `*.cmake`, `CMakeLists.txt`, `*.gradle`,
`*.swift`, `*.kt`, `*.json`, `*.yaml`, `*.md`:

```
MeCab / mecab    -> only docs/: docs/specs/2026-05-16-multiplatform-design.md,
                    docs/plans/2026-05-16-phase0-monorepo-extraction.md,
                    docs/bugs/BUG-442-clipboard-long-text-crash.md,
                    docs/reviews/2026-05-29-deep-quality-audit.md,
                    docs/reviews/2026-05-17-multiplatform-plan-review.md
sudachi / Sudachi -> no hits
jieba             -> no hits
kuromoji          -> no hits
vibrato           -> no hits
lemmatiz          -> README.md, docs/release-notes/2.2.4.md, docs/readme/README.it.md (prose)
morpholog         -> no hits
```

So **there is no per-language pluggable tokenizer library and no native tokenizer binary**. The
`Language` abstraction exists (`language.dart:21`) but `textToWords` is implemented by dictionary
lookup, and only one implementation exists (`implementations/japanese_language.dart:17`); the
registry is hard-coded to it — `fushi/lib/src/models/app_model.dart:2376-2391`
(`availableLanguages = [JapaneseLanguage.instance]`). `JapaneseLanguage.instance` is referenced
directly 74 times across `packages/` and `fushi/lib/`, so the "pluggable" interface is structural,
not exercised.

`JapaneseLanguage.prepareResources()` is an **empty override** (`japanese_language.dart:69-70`) —
there is nothing to initialize because there is no tokenizer model.

### B.2 What actually segments, and where it lives twice

Segmentation exists at **two** layers, and they are complementary, not redundant:

**(1) Native, inside the lookup engine — prefix scanning.** `scan_candidates`
(`word_scan.cpp:52-79`) generates every prefix of the first `scan_length` (default 16) code
points that ends on a word boundary, longest first. The engine then returns the longest match.
This is what makes "click 永 and still hit 永遠" work: the caller passes a *suffix window*, not a
token.

**(2) Dart, for token boundaries the caller needs before/independently of a lookup.**
`JapaneseLanguage.textToWords` (`japanese_language.dart:73-91`):

```dart
List<String> textToWords(String text) {
  if (!FushiDicts.isInitialized || text.isEmpty) {
    return text.split('').where((c) => c.isNotEmpty).toList();   // per-char fallback
  }
  final words = <String>[];
  int pos = 0;
  while (pos < text.length) {
    final sub = text.substring(pos);
    final len = _lookupMatchedLength(sub);
    if (len > 0) { words.add(text.substring(pos, pos + len)); pos += len; }
    else { words.add(text[pos]); pos++; }
  }
  return words;
}
```

`_lookupMatchedLength(text)` (`:52-67`) calls `FushiDicts.instance.lookup(text, maxResults: 1)`
and returns `results.first.matched.length`, memoized in an LRU-ish `LinkedHashMap` of capacity
5000 keyed on the **first 20 characters** of the input (`:54`, `_maxMatchCache = 5000` at `:48`).
This is a **greedy longest-match segmenter with single-character fallback**, where the "lexicon"
is the concatenation of every loaded term dictionary.

Same mechanism, three more entry points:

- `wordFromIndex({text, index})` (`:94-102`) — the token starting at a character index.
- `getWordRange({selection})` (`:105-116`) — `TextRange(start: index, end: index + len)`.
- `getGuessHighlightLength({searchTerm})` (`:119-124`) — used to highlight before the lookup
  returns.

Base-class `Language.textToWords` is abstract (`language.dart:180`), and the base implementations
of `wordFromIndex` (`:191-253`), `getWordRange` (`:286-308`), `getGuessHighlight` (`:311-318`),
`getGuessHighlightLength` (`:321-330`), `getFinalHighlightLength` (`:333-347`), and
`getStartingIndex` (`:353-373`) all build a `wordTape`/`workingBuffer` from `textToWords` and
support the `isSpaceDelimited` case (`:71`) with `indexMaxDistance` (`:96`, capped-window
recursion at `:197-237`).

`getFinalHighlightLength` (`:333-347`): for non-space-delimited languages it is
`max(1, result?.bestLength ?? 0)` — i.e. **the engine's own longest-match length is the
highlight span**, which is why the app-wide "hit span" truth is `bestLength`.

Other `textToWords` consumers (i.e. places that genuinely want segmentation rather than a query
window): `app_model.dart:6391` (`openTextSegmentationDialog`), `app_model.dart:7712` (yomitan API
server `tokenizer:`), `texthooker_page.dart:482` and `:2178` (per-line cache, `:478` explains the
cache exists because line text is immutable by id), and `fushi/lib/src/sync/yomitan_tokenize_adapter.dart:1-25`
which wraps the tokenizer into the yomitan-api `tokenize` response shape
(`{id:"scan", source, dictionary:null, index, content:[[{text, reading}]]}`) with a
`ReadingResolver` that does a `maxResults: 1` lookup for the reading (`app_model.dart:7713-7717`).

### B.3 How a text string becomes a token with offsets, and how offsets map back

The interesting mapping is in the **reader's injected JS**, not in Dart. The reader renders EPUB
(and manga) inside a WebView; a tap or hover is translated to DOM coordinates, then to a
`(textNode, offset)` caret position, then to a **query string plus a range map**.

`fushi/lib/src/reader/reader_selection_scripts.dart`:

- `selectText(x, y, maxLength, fromHover)` — `:1153`. Resolves the caret via
  `document.caretRangeFromPoint` (`:652`), rejects non-text nodes (`:660`), and for hover reruns
  the same Latin-hit normalization so pre-lookup and post-lookup agree (`:1186-1191`). If the
  hit equals the current selection and `fromHover` is set, it returns `null` — this is the
  dedup基石 for "hold Shift and slide, the popup follows the cursor": one lookup per word, no
  flashing, no repeated FFI (`:1195-1205`).
- `selectFromPosition(node, offset, maxLength, x, y)` — `:1216-1267`:
  - If the hit character is **not** Japanese, walk `startOffset` back to a scan boundary
    (`:1220-1224`) — this is "expand a Latin hit left to its token start".
  - `findParagraph(node) || document.body`, then a `createWalker(container)` (`:479`) that walks
    **text nodes only** and skips furigana (`rt`/`rp`) and whitespace-only nodes.
  - Forward scan accumulating `text` up to `maxLength` characters, recording
    `ranges.push({node: scanNode, start, end})` per contributing text node (`:1259`).
    Stops: `isScanStop(char)` (`:402`) — the delimiter set, plus (when
    `window.scanNonJapaneseText === false`) any non-Japanese code point. Whitespace is
    deliberately **not** a stop (`:398`): in space-delimited languages a space is a
    *connector* between words, and treating it as a terminator would exclude
    `listen to` / `look forward to` phrase entries entirely; the engine already generates
    three-level whitespace candidates. The bridging rule at `:1244-1255` allows exactly one
    whitespace to be crossed, only within the same text node, only when content was already
    scanned from this node and the next character is scannable — so block-boundary whitespace
    never glues two paragraphs into one query. Known tradeoff documented at `:1248-1250`:
    `<b>listen</b> to` split by an inline tag is still not found.
    `isIntraWordApostrophe` (`:442`) is checked before the stop test so `don’t` is not cut to
    `don` (BUG-2056).
  - `this.selection = {startNode, startOffset, ranges, text}` (`:1265`) — **this is the token
    boundary → source element mapping**: `ranges` is a list of `(textNode, start, end)` triples
    that tile the query string.
- `buildSelectionPayload(x, y)` — `:1274-1378`. Emits the payload handed to Dart:
  `{matchableOffset, matchableLength, sentenceMatchableOffset, sentenceMatchableLength, text,
  sentence, rect, audioCuePayload, normalizedOffset, normalizedLength, sentenceOffset,
  sentenceNormalizedOffset, sentenceNormalizedLength, verticalWriting, mangaPageIndex}`.
  - `getNormalizedOffset(node, offset)` (`:1334`) maps the DOM caret to a **whole-book
    normalized character offset**; `normalizedLength` is `normalizedEnd - normalizedOffset`
    across the last range (`:1336-1340`) — i.e. multi-node selections are covered end-to-end.
  - `matchableRange(...)` (`:1352-1357`) yields the offset/length for the *matchable* (post
    normalization) domain, used for Anki `{sentence}` / study-unit alignment.
  - `rect` prefers the manga group rectangle over the tapped glyph (`:1366`,
    `mangaGroupRect` computed at `:1308-1332`).
  - `audioCuePayload` via `window.fushiReader.cueIdAtDomPoint` (`:1367`).
- `fireTextSelected(x, y)` — `:1381-1386` → `window.flutter_inappwebview.callHandler('onTextSelected', JSON.stringify(payload))`.
  `fireSelectionMenu` (`:1393-1398`) is the TODO-1317 drag-select variant that goes to a
  Copy/Lookup menu instead of straight to a lookup.
- Static Dart builders: `selectInvocation(x, y, maxLength, {fromHover})` at
  `reader_selection_scripts.dart:38-44`, `highlightInvocation(count)` at `:46`, `clearInvocation()`
  at `:48`, `resolveCurrentSentenceText(sentence, word)` at `:33`.

**The `maxLength` values actually used are 400**, not 24:
`fushi/lib/src/pages/implementations/reader_fushi/webview.part.dart:1185`
(`window.fushiSelection.selectText(x, y, tapGate.maxLen || 400, false)`) and
`fushi/lib/src/media/audiobook/lyrics_mode_html.dart:471`
(`window.fushiSelection.selectText(x, y, 400)`).

Dart receives it in `webview.part.dart:1991`:
`await _handleTextSelected(ReaderSelectionData.fromJson(payload))`, and the equivalent
`onSelectionMenu` route at `:2014`. `ReaderSelectionData` mirrors every field
(`fushi/lib/src/reader/reader_selection_data.dart:1-60`, with `fromJson` at `:19-52`).

**The other shape** — "given a line and a clicked character index, produce a query string" — is
`lookupQueryFromIndex` (`fushi/lib/src/lookup/sentence_extraction.dart:56-68`):

```dart
String lookupQueryFromIndex(String text, int charIndex, {int maxChars = kLookupQueryMaxChars})
```

with `kLookupQueryMaxChars = 24` (`:54`). The doc comment at `:44-55` is the design statement:
*"this is the unified shape of 'given a whole sentence + a cursor character offset → look up' for
the entire app: it does NOT tokenize; it hands 'from this character to maxChars characters later'
to the engine for longest matching. Clicking 永 still hits 永遠, clicking 遠 can look up 遠 alone —
using the tokenizer's whole word as the query string made the latter impossible (BUG-1478)."*
`kLookupQueryMaxChars` is described at `:48-53` as the ceiling needed for "the longest compound
word plus an inflectional tail"; 24 is comfortably above the practical maximum.

Note the interaction with the engine default: `scan_length` defaults to 16 code points
(`fushidicts.dart:632`), so even a 400-character reader selection or a 24-character query yields
at most a 16-code-point match.

### B.4 Where the token boundaries meet the source element, per media kind

| Media | Selection origin | Does it carry a range map? |
|---|---|---|
| EPUB reader | injected JS `fushiSelection.selectFromPosition` over DOM text nodes | yes — `ranges: [{node, start, end}]` (`reader_selection_scripts.dart:1259`) + whole-book `normalizedOffset/Length` (`:1334-1340`) |
| Manga / OCR overlay | the OCR overlay renders one DOM element per OCR box inside the manga WebView document (`mangaWindowDocument`), each carrying `data-manga-sentence`, `data-manga-sentence-group`, `data-ocr-orientation`, and the enclosing `.manga-page[data-page]` | yes — the JS walks up via `closest()` (`:1286-1307`) and computes a union bbox over all boxes in the same sentence group (`:1308-1332`); `mangaPageIndex` from `data-page` (`:1303`) |
| Video subtitles (WebView mode) | DOM subtitle layer in the video WebView | payload parsed by `parseWebVideoLookupPayload` (`web_video_fushi_page.dart:1199`) and `webVideoLookupAnchorScreenRect` (`:1207`) |
| Texthooker / galgame hook | plain text line + `charIndex` | no DOM; `lookupQueryFromIndex` (`texthooker_page.dart:1423`, `gal_ingame_lookup_controller.dart:1253`) |
| Global hotkey / clipboard | native UI Automation or injected Ctrl+C | flat text buffer + `{selStart, selLen}`; sentence derived purely in Dart (`sentence_extraction.dart:84-146`), mirroring the reader's DOM walk byte-for-byte on the delimiter tables (`kSentenceDelimiters = '。！？.!?\n\r'` at `:66`, `kTrailingSentenceChars` at `:70`) |

The manga case is the cleanest illustration: segmentation is *not* performed on OCR output.
The OCR provider produces text boxes with geometry; the overlay injects them as DOM elements with
`data-*` attributes; the **same** reader selection script then does the same
"expand + scan forward" tokenization as for EPUB. The manga-specific additions are only
geometry/sentence metadata (`manga_fushi_page.dart:245-280`, `dispatchMangaSelection`).

---

## C) The lookup chain (UI) — `fushi/lib/src/lookup/*` and `fushi/lib/src/dictionary/*`

### C.1 Files in the chain

| File | Lines | Role |
|---|---|---|
| `lookup/global_lookup_controller.dart` | 2664 | orchestrator, singleton; the only place that sequences capture → search → window → render |
| `lookup/global_lookup_channel.dart` | 175 | zero-churn **static facade** over `OverlayWindowChannel`, bound to the `global_lookup` MethodChannel (header at `:1-12`) |
| `lookup/overlay_window_channel.dart` | 450 | instance-level channel wrapper; `GlobalLookupRoute` immutable identity (`:22-45`), `GlobalLookupShowResult` (`:47-100`) |
| `lookup/global_lookup_render.dart` | 524 | builds the JS that renders one lookup card inside the host iframe |
| `lookup/global_lookup_layout.dart` | 418 | cascade geometry: `computeFrameRect`, `computeCascadeHeadroomSeed` |
| `lookup/global_lookup_stack.dart` | 325 | pure ordered-popup-stack model ported from Hoshi Android's `LookupPopupStack.kt` (`:1-20`) |
| `lookup/selection_capture_ffi.dart` | 261 | Windows/macOS foreground-selection capture |
| `lookup/sentence_extraction.dart` | 148 | flat-buffer sentence extraction + `lookupQueryFromIndex` |
| `lookup/overlay_bridge_handlers.dart` | 685 | deferred popup.js bridges (audio, favorite, mine, duplicate, open-in-Anki, overwrite, zoom) |
| `lookup/lookup_deep_link.dart` | 24 | `fushi://lookup?word=` parser |
| `lookup/effective_lookup_size.dart` | 140 | popup max width/height resolution + drag-resize math |
| `lookup/global_lookup_log.dart` | 25 | `glog`, privacy-conscious (never logs selection text) |
| `dictionary/dict_style_rules.dart` | 312 | structured style-rule table → CSS compiler |
| `dictionary/dict_resource_materializer.dart` | 236 | BUG-2504 "read 1 byte in a background isolate before mmap" guard |
| `dictionary/dict_style_preview_sample.dart` | 106 | settings preview |
| `dictionary/transform_description_locale.dart` | 72 | transform-description i18n |

### C.2 The full chain: hover/click in a reader → popup rendered

**Presentation routes (which renderer answers) — there are three, chosen by platform and surface:**

1. **In-app popup (all platforms).** Flutter overlay + `flutter_inappwebview` WebView, asset
   `fushi/assets/popup/popup.html` + `popup.js` + `popup.css`. Positioned by
   `calcPopupPosition` (`dictionary_popup_layer.dart:26-...`), which supports vertical-writing
   left/right avoidance (TODO-107) and top/bottom reserve. Host widget layer:
   `dictionary_popup_layer.dart` (1702 lines) over `dictionary_popup_webview.dart`
   (`InAppWebView` import at `:9`, controller at `:365`), with the shared controller in
   `dictionary_popup_controller.dart`. Media (`image://`, `dictmedia://`) is served by
   `dictionary_webview_media.dart`.
2. **App-external Windows overlay** — a native `WS_POPUP` window with its own WebView2:
   `fushi/windows/runner/global_lookup_window.cpp`. `CreateWindowExW` at `:1076-1088` with
   `WS_POPUP`; style comment at `:1071-1075` — **no `WS_EX_LAYERED`** (WebView2 brings its own
   composition surface and does not coexist with a layered window), `WS_EX_NOACTIVATE` so the
   foreground app keeps focus. Class name `L"FushiGlobalLookupWindow"` (`:45`). `PrewarmWebView`
   (`:1115-1149`) creates window + WebView2 off-screen at startup because the lazy first-lookup
   create chain was reported as "hotkey pressed but nothing appears". It uses a **dedicated
   WebView2 user-data folder** (`:400-419`) because WebView2 forbids two environments with the
   same folder, giving the overlay an independent profile from the in-app WebView. It also
   supports capture-suppression (`SetWindowDisplayAffinity`, `:21-28`), an own-region crop
   (`SetWindowRgn`, `:546-547` note), and a low-level mouse hook for hit testing / wheel
   forwarding (`:706-747`).
3. **Android** — a separate `PopupDictActivity` (`fushi/android/app/src/main/java/app/fushi/reader/PopupDictActivity.kt:34`,
   `FLAG_DIM_BEHIND` clearing at `:618`) backed by a cached warm `FlutterEngine` running the
   `popupMain` Dart entrypoint (`PopupEngineHolder.kt:14`, `:27`, `:122`).

There is **no** `desktop_multi_window` or multi-window plugin in `fushi/pubspec.yaml`; on desktop
`popupMain` / `floating_dict_main` are Android-side (and floating-subtitle) mechanisms, while
Windows/macOS/Linux app-external lookup goes through the native WebView2 overlay or stays in-app.

**Trigger → selection → token → query → popup, step by step (reader, hotkey, and galgame):**

*Path 1 — tap/hover inside the EPUB reader (in-app popup):*

1. Flutter pointer event → `window.fushiSelection.selectText(x, y, 400, fromHover)`
   (`reader_fushi/webview.part.dart:1185`).
2. JS resolves the caret, expands/skips per B.3, builds the query string + range map
   (`reader_selection_scripts.dart:1216-1267`), and calls
   `callHandler('onTextSelected', payload)` (`:1384`).
3. Dart: `webview.part.dart:1991` → `_handleTextSelected(ReaderSelectionData.fromJson(payload))`
   (`reader_fushi/lookup.part.dart:141`). It clears the mining draft (`:148`), optionally pauses
   the audiobook (`:153-157`), computes `selectionRect` from `data.rect` (`:160-173`), resolves
   the sentence with a non-empty contract (`:176-186`, TODO-956), and for lyrics mode pulls
   `window.__lyricsCueContext` (`:194-240`).
4. → `searchDictionaryResult({searchTerm, selectionRect, deferDisplay})`
   (`pages/base_source_page.dart:314`), which sets `_pendingSelectionRect`, calls
   `appModel.searchDictionary` (`:331`), and checks the `_searchGeneration` guard.
5. → `AppModel.searchDictionary` (`models/app_model.dart:5901-6055`):
   normalize → optional remote-first → cache key → `dictRepo.getCachedSearch` → FFI cache →
   `FushiDicts.instance.lookup(searchTerm, maxResults: effectiveMaxTerms)` (`:6004-6007`) →
   cache the FFI result → `buildResultFromLookup` (`:6010`) → `buildPopupJsonFromLookup`
   (`:6018`) → `withKanjiResults` (`:6024`).
   The comment at `:5988-6003` is important for clones: the engine cap **equals** the consumed
   headword budget, because `lookup.cpp` materializes (zstd-decompresses) only the surviving
   rows *after* `partial_sort` + `resize`, so passing a hard-coded 200 when only 10 are consumed
   meant decompressing 20× more than needed.
6. → `showDeferredPopup` / `_highlightAndShowPopup` (`reader_fushi/lookup.part.dart:100-141`).
   BUG-717 ② splits "show the popup" from "highlight in the source text": the popup is shown
   **immediately** with the raw selection rect, and the highlight `evaluateJavascript`
   (`highlightInvocation`, returning the refined whole-word bbox) re-anchors the popup
   asynchronously via `reanchorTopPopup(rect, generation)`. Pre-fix, the popup display was
   serialized behind an eval on the busy paginating reader WebView, which is why in-app lookup
   felt several times slower than the app-external overlay. The highlight eval is wrapped in
   try/catch for `MissingPluginException` on a half-destroyed WebView (BUG-005/TODO-678,
   `:127-140`).
7. Popup renders in `dictionary_popup_layer.dart` / `dictionary_popup_webview.dart`.
   Popup→Dart messages arrive on the WebView's JS handler and are dispatched in
   `_onJsMessage` (in-app) or `dictionary_popup_layer.dart`'s bridge.

*Path 2 — global hotkey / tray (app-external overlay):*

1. Global hotkey registered from the user's binding registry —
   `_registerHotKeysFromRegistry` (`global_lookup_controller.dart:383`),
   `_registerOneHotKey` (`:424`); mouse side-button trigger at `_registerMouseTriggerFromRegistry`
   (`:513`) and `setGlobalMouseTrigger` (`global_lookup_channel.dart:171-174`).
2. `triggerSelectionLookup({source})` (`:622`) / `_onHotKeyRouted` (`:632`) mints a
   `GlobalLookupRoute` epoch and runs the rest inside
   `GlobalLookupChannel.runWithRoute(route, ...)` (`global_lookup_channel.dart:41-42`), a zone
   value so Futures/Timers keep their original destination. `invalidateRoute` (`:53-61`) retires
   an epoch permanently; `isRouteValid` (`:63`) rejects stale continuations. This is the
   mechanism that stops a slow old lookup from painting over a new one.
   `_acceptsRoute` (`global_lookup_controller.dart:1248`) gates reverse callbacks.
3. Selection capture — two paths, in priority order:
   - **Native UI Automation / AX**: `captureForegroundContext(maxExpand: 600)`
     (`selection_capture_ffi.dart:172-231`) over
     `MethodChannel('app.fushi.reader/foreground_selection')` (`:43`); Windows side
     `fushi/windows/runner/foreground_selection.cpp`, macOS `AppDelegate.swift`. Returns the
     selected text **plus a bounded ±N-character window** and `{selStart, selLen}` inside it,
     then trims to the one sentence via `extractSentenceAt` (`sentence_extraction.dart:84`).
     Never throws: any error resolves to `null` (`:216-221`).
   - **Clipboard fallback**: `captureForegroundSelection({stillWanted})`
     (`selection_capture_ffi.dart:130-141`) saves the clipboard, clears it, injects a clean
     Ctrl+C over `user32.dll!keybd_event` resolved via `DynamicLibrary.open('user32.dll')`
     (`:28-31`), polls up to ~600 ms (`:180-195`), restores, and never logs body text (`:196-198`).
     `_injectCleanCopy` (`:236-248`) first releases Shift/Alt/LWin/RWin/Ctrl, because a global
     hotkey like Ctrl+Alt+D fires while the user still holds the modifiers and a naive injected
     Ctrl+C arrives as Ctrl+Alt+C.
     `_clipboardCaptureGate` (`:57-88`) serializes whole transactions — the comment at `:59-70`
     documents the data-loss bug: two overlapping runs would have B "save" the empty clipboard
     that A had just cleared.
4. `_lookupExternal(text, {sentence, anchorScreenRect, autoRead, miningHandler, consumeOutsideClicksOwnerHwnd})`
   — `global_lookup_controller.dart:899-1136`. Notably:
   - `hide(notify: false)` first, to collapse native `visible_`/`revealed_` and Dart `_revealed`
     to a known-hidden state (TODO-1079 D, `:913-923`).
   - `model.searchDictionary(searchTerm: text, searchWithWildcards: false)` (`:942`).
   - `_resetStackRoot(text, result)` (`:965`, defined at `:1938`) — a lookup resets the whole
     stack to a single root frame (TODO-867 P3c). A no-result lookup still seeds a root frame so
     the iframe shows popup.js's own no-results card.
   - Sizes the off-screen measurement window to the **cascade layout bounds**
     (`kGlobalLookupLayoutBoundsWidthFactor = 2.4`, `kGlobalLookupLayoutBoundsHeightFactor = 2.0`
     at `global_lookup_render.dart:167-168`) so a nested child has room during measurement
     (`:976-1001`).
   - `GlobalLookupChannel.showAt(x, y, width, height, atCursor, capWidth, capHeight,
     capOriginX, capOriginY)` (`:1011-1033`). When an anchor exists, the window is placed at
     `(anchor.left × dpr, (anchor.bottom + 4) × dpr)`; otherwise `atCursor: true`.
     The work-area cap is a **game viewport** for the galgame route, not the monitor work area
     (`:1004-1010`).
   - Converts the returned physical work area to CSS px with the **anchor monitor's** dpr, not
     the main window's (`:1057-1072`, TODO-893/BUG-859) — otherwise a mixed-scale multi-monitor
     setup mis-places nested cards.
   - `computeCascadeHeadroomSeed` (`:1091-1098`) reserves to the cursor monitor's work-area edge
     so a later up/left child at any depth lands inside the origin committed at the first reveal
     (TODO-1345/BUG-583). The `galCard` route deliberately uses `(0, 0)` instead, because it
     resizes an already-visible composition HWND in place and reserving from a non-zero game root
     to (0,0) recreated a fixed red range (BUG-1835).
   - `_renderStack(beginRoute: route)` (`:1101`, defined at `:2048`) — the render.
   - `_scheduleReadyDrivenSafety` (`:1122`, defined at `:1145`) — a READY-driven reveal fallback
     (450 ms steps, up to `_kReadySafetyMaxAttempts = 6` at `:203-204`) that reveals only after
     `isWebViewReady()` confirms the surface loaded, so a cold create chain cannot flash blank
     (TODO-1079 B).
5. Render script: `global_lookup_render.dart` builds `GlobalLookupFrameSettingsJs`
   (`:47-65`, `buildFrameSettingsJsParts` at `:70`), which **delegates the settings body to the
   in-app popup's single source of truth** `buildPopupSettingsJs(appModel, theme,
   PopupSettingsOptions(globalLookup: true))` (`:74-79`) and appends only the host reset hooks +
   `renderPopup()` (`:104`). Purpose stated at `:36-41`: the app-outside window stays in lock-step
   with the in-app popup (dictionary font, zoom clamp, `autoExpandRows`, all `window.*` flags) so
   the two can never drift. The top-level document is `fushi/assets/popup/global_lookup_host.html`
   — a bare iframe host with **zero** popup.js instance — and every card, including the single
   root, renders through `window.__globalLookupHost.renderStack` inside an iframe
   (BUG-802 note at `dictionary_popup_webview.dart:720`). The retired single-frame top-level
   `renderPopup` path is documented as removed at `global_lookup_render.dart:21-31`.
   Static settings (theme variables, dictionary fonts, dictionary styles, custom CSS, flags) are
   de-duplicated by revision per *physical host* (`global_lookup_render.dart:170-182`, BUG-1833):
   imported dictionary fonts are inline `data:` URLs and two CJK fonts can make the static segment
   tens of MB, so re-sending it every lookup meant piping tens of MB through the platform channel
   and re-parsing it in WebView2 only for the host to recognize the revision and discard it.
6. Reverse calls: `OverlayWindowChannel.setHandlers(...)` (`global_lookup_channel.dart:154-167`)
   wires `onGetMedia` (gaiji bytes), `onJsMessage`, `onOverlayHidden`, `onRoutedJsMessage`,
   `onRoutedOverlayHidden`, `onGlobalMouseTrigger`.
   `_resolveMedia` (`global_lookup_controller.dart:1232`) serves
   `image://?dictionary=&path=` and `dictmedia://<path>?dictionary=` via
   `FushiDicts.getMediaFile`, parsing shared with the in-app path
   (`GlobalLookupMediaRequest` at `:2589`, `parse` at `:2619`); `_normalizeMediaPath` at `:2610`.
   `_onJsMessage` (`:1382`) handles `staticSettingsRequired` (`:1394`), `captureReady` (`:1412`),
   nested word anchors (`_maybeHandleNestedWordAnchor`, `:1658`), and dispatches deferred
   bridges.
7. Nested lookup (clicking a word inside a popup card):
   `_dispatchNestedLookup` (`:1723`) → `_lookupNested` (`:1809-1936`) → `searchDictionary`
   (`:1823`) → highlights the searched word inside the parent card's realm and waits for the
   whole-word bbox (`_highlightAndAwaitWordAnchor`, `:1694`; BUG-2054 — the round-trip runs
   *before* the push so the child lands against the real word on its first render) →
   `resolveNestedLookupParent` re-resolves the immutable source id after the async boundary
   (`:1872-1878`) → `_pushChildFrame` (`:1970`) → `_renderStack()` (`:1907`).
   `pushLookupFrame` drops a no-result nested lookup (resultCount ≤ 0), so an empty nested search
   leaves the stack unchanged after the old descendants were pruned already (`global_lookup_stack.dart:1-20`).
   The stack model: index 0 is the root; closing child i truncates to `sublist(0, i+1)`; closing
   the root clears the stack; parent scroll/reselect kills all children and bumps a monotonic
   `clearSelectionSignal` (`global_lookup_stack.dart:15-20`, `GlobalLookupFrame` at `:29-75`).
8. Anchor geometry domain: `_applyOverlayBox` (`:2187`) drives native window size/region from the
   host-reported union bbox; `revealStack({dx, dy, width, height, geometryEpoch, left, top})`
   (`global_lookup_channel.dart:113-121`) is the C++ `RevealStack` entry that clamps into the work
   area; `_resetGeometryHandshakeForLookup` (`:2337`) retires the previous lookup's
   acknowledgements; `globalLookupCaptureReadyMatches` (`:2540`) closes the geometry A→B→A ABA
   hole by including the epoch in the identity even when dimensions repeat.

*Path 3 — Windows-only "no anchor rect" desktop convenience:*
`lookupText(text, {sentence, anchorScreenRect, autoRead, miningHandler})` (`:789`) →
`_lookupTextRouted` (`:814`) → either route self-closes (returning false so the caller falls
back) or `_lookupExternal`. `_activateRoute` (`:852`) + `_isCurrentRoute` (`:863`).

### C.3 Are the popups separate OS windows, in-app overlays, or WebView-embedded?

All three, depending on route and platform. Concretely:

| Surface | Window | Renderer | App-internal? |
|---|---|---|---|
| In-app reader / texthooker / video popup | Flutter overlay inside the main Flutter window | `flutter_inappwebview` WebView loading `assets/popup/popup.html` | yes |
| App-external global lookup (Windows) | **Separate native Win32 `WS_POPUP` HWND**, `WS_EX_NOACTIVATE`, `HWND_TOPMOST` | its **own WebView2** with a dedicated user-data folder | no |
| Clipboard panel (second bare-WebView2 window) | separate native window | same `popup.js`, different `MethodChannel` instance via `OverlayWindowChannel(target: ...)` | no |
| Floating lyric bar tap (Windows) | routes to the app-external overlay; Android route has its own `PopupDictActivity` | native WebView2 / Android Activity + warm engine | mixed |
| Android system text-selection "Process text" | `PopupDictActivity` (separate Activity) | `PopupDictionaryPage` inside a warm `FlutterEngine` | separate Task |
| Browser extension | HTTP to the app's yomitan-API-shaped endpoints | extension's own `popup.js` (vendored at `tools/browser-extension/vendor/popup.js`) | no |

The Android "Process text" entry is `PopupChannel.instance.init(onNewProcessText:)` in
`fushi/lib/popup_main.dart:78-110`; the word is resolved with
`JapaneseLanguage.instance.wordFromIndex` at `popup_main.dart:15-22` (`_extractWord`), and the
page is kept resident rather than rebuilt (TODO-951 symptom C comment at `popup_main.dart:225-232`):
a `ValueKey`-forced rebuild discarded `PopupDictionaryPage` (and its warm WebView) on every new
word, which users reported as a white flash. The new word is passed via
`searchTerm` + `searchGeneration` and `PopupDictionaryPage.didUpdateWidget` reuses the warm slot.
Anchor conversion physical→logical includes a status-bar translation (`popup_main.dart:126-155`).

Deep links: `lookupWordFromDeepLink(url)` (`lookup_deep_link.dart:18-32`) accepts
`fushi://lookup?word=<word>` and the legacy `hibiki://` scheme; producers are the mining export
HTML (popup.js `rewriteExportedGlossaryAnchors` rewrites internal cross-references into this deep
link), consumers are Android's `fushi://lookup` VIEW intent-filter and Windows' HKCU
`Software\Classes\fushi` protocol registration, both landing on the same parser.

Popup sizing: `effectiveLookupSize` (`effective_lookup_size.dart:40-52`) picks between a surface's
own size and the shared in-app size depending on `independent`; bounds are single-sourced with the
settings sliders at `kLookupPopupMinWidth = 250` … `kLookupPopupMaxWidth = 2000` and
`kLookupPopupMinHeight = 200` … `kLookupPopupMaxHeight = 1600` (`:57-60`).
`resolveDraggedLookupSize` (`:70`) divides by `uiScale` because the drag handle lives in the
scaled box; `resolveOverlayResizeFromDelta` (`:112`) uses the **difference** between drag-start and
drag-end physical window sizes because the transient overlay window is always larger than the
visible card (the reserve-to-edge margin is clipped by the region), so using absolute window size
made the recomputed size blow up and the card jump to a corner — documented at `:96-110`.

Style pipeline: `dict_style_rules.dart:1-6` states the architectural rule — the truth source is a
**structured rule table** (part + scope + property) and CSS is a compile product; visualization
output and hand-written CSS are stored separately and concatenated at injection (compiled first,
hand-written second, so hand-written wins). `DictStylePart` (`:23-...`) enumerates parts that each
map to a **measured, existing** stable selector via `dictStylePartSelector`, with no escape hatch
to arbitrary selectors. There is one deliberate redundancy: `dictStyleRulesCssPrefKey` is a
compiled CSS cache, needed because Android's separate popup Activity reads the prefs table
directly (`PopupDbReader.kt`) and cannot run the Dart compiler (`:14-21`).

---

## D) Recording / mining

How a looked-up word becomes an Anki card, end to end:

1. **Popup → Dart.** `popup.js`'s ➕ button calls the `mineEntry` bridge. In-app this is
   `DictionaryPageMixin.onMineEntry`; app-external it is dispatched by
   `maybeHandleOverlayDeferredBridge` (`overlay_bridge_handlers.dart:56-124`) whose
   `case 'mineEntry'` (`:75-83`) calls `_handleMineBridge` (`:304-...`).
2. **Payload shaping.** `_handleMineBridge` reads the first map argument into
   `Map<String, String> fields` and resolves the sentence via
   `resolveMineSentence(fields, sentenceContext)`. The comment at `:41-50` explains why
   `sentenceContext` is needed: JS `buildMinePayload` never sends a `sentence` for app-external
   surfaces because the source text lives in another app, so the controller's captured sentence
   (clipboard full text for the clipboard panel, UIA foreground sentence for the transient
   overlay) is the fallback. A JS-sent `fields['sentence']` still wins, so this never overrides
   real data.
3. **Dictionary media flush.** `writeDictionaryMediaCache(fields['dictionaryMedia'])` runs first
   (`:334`, and again in `_mineEntry` at `:381`) so gaiji bytes are already in the Anki media
   cache and HTML embeds render instead of degrading to alt text.
4. **Delegation or direct mine.** If a `miningHandler` was supplied (video/galgame surfaces that
   can attach a screenshot, sentence audio, or an exact line), the handler produces the reply:
   `reply = await miningHandler(fields: fields)` (`:354-356`) — a
   `Future<Map<String,Object?>> Function({required Map<String,String> fields, int? updateNoteId})`
   (`:30-34`). Otherwise `_mineEntry(model, fields, sentenceContext)` (`:375-...`) calls
   `model.platformServices.createAnkiRepository().mineEntry(rawPayloadJson: jsonEncode(fields),
   context: AnkiMiningContext(sentence: sentence, source: AnkiMiningSource.book))`.
5. **Reply shape.** `{ankiConnect: bool, noteId: int?, message?: String, duplicate?: bool}`.
   Success is `outcome.result == MineResult.success`; `noteId` is only meaningful on AnkiConnect
   (AnkiDroid degrades to `null` gracefully). BUG-1908 (`:396-404`): the app-external bare WebView
   has no Flutter toast (`FushiToast` returns early without an `Overlay`), so failures used to be
   **completely silent**; now a `message` comes back. BUG-1915 + TODO-448: an unknown outcome must
   not be repainted as success, and the popup must not re-query Anki after a failure to flip the
   button to ✓ — so `duplicate: true` distinguishes "card already exists" from "not made".
   The reply is pushed back to the right JS realm via the channel-bound
   `OverlayBridgeResolver` (`resolveBridge(id, value)`, `:8-9`, `:367-370`), i.e.
   `GlobalLookupChannel.resolveBridge` for the transient overlay or the panel's own channel.
6. **Stats.** `_recordMinedStats(model, fields, noteId, sentence)` records mined-count and
   mined-sentence on success, with source type from `overlayStatSourceType()`
   (`:283-289`): `kStatSourceGame` while a galgame session is running, else `kStatSourceBook`,
   sharing the `(expression, reading, sourceType)` unique key with the in-app favorite/star row.
7. **The rich-mining request model** lives in
   `packages/fushi_engine/lib/mining/immersion_mining_request.dart` (499 lines):
   `VideoMiningHistorySnapshot` (`:38-...`) captures primitive locator/title values *before*
   enqueue/await so a stale card cannot inherit a new episode's title/locator;
   `VideoMiningImageMode { gif, current_frame, subtitle_start, video_clip }` (`:82-...`) with
   `isStill` / `isVideoClip` and a `wireName` persistence key that must not change;
   `immersionMiningAudioExtensionFor({required bool isIOS})` (`:21`) returns `m4a` on iOS and
   `aac` elsewhere — the comment at `:9-19` records the exact failure: the bundled desktop
   `ffmpeg-min` muxer whitelist has only `adts`, so writing `.m4a` selected a nonexistent ipod
   muxer and `extractAudioSegmentViaFfmpeg` returned null, producing cards with image but no sound.
   `AnkiMiningContext` / `MineOutcome` / `AnkiMiningSource` / `CardSourceLink` come from
   `package:fushi_anki/fushi_anki_core.dart` (`:5-6`).
8. **Engine side.** `ImmersionMiningEngine.mine` (`fushi/lib/src/mining/immersion_mining_engine.dart:347`)
   builds `AnkiMiningContext` at `:652`, and one field comment at `:668` notes that a book that
   never reaches this engine renders an empty string. `external_window_mining.dart:11`
   describes `ImmersionMiningRequest.providedCoverBytes` (engine writes a temp file →
   `AnkiMiningContext.coverPath`) for window-capture surfaces.
9. **Anki backends.** `packages/fushi_anki/lib/` implements two:
   `ankiconnect/` (HTTP) and `ankidroid/` (intent), behind `base_anki_repository.dart`
   (`mineEntry`). Card templates/style come from `lapis_note_type.dart` / `lapis_blocks.dart` /
   `anki_template_render.dart`; media dedup from `anki_media_dedup.dart`.
10. **Galgame mining binding.** `fushi/lib/src/lookup/gal_ingame_mining_binding.dart` (65 lines)
    supplies the `OverlayMiningHandler` for the galgame route so a card carries the exact line,
    a game screenshot, and the sentence audio.

`OverlayMiningHandler`'s typedef (`overlay_bridge_handlers.dart:30-34`) is the seam: the transient
lookup window always does payload parsing and stats; the delegate only replaces the final
create/overwrite write.

---

## E) Integration points — where a lookup is invoked

### E.1 EPUB reader (`reader_fushi`)

| Step | Location |
|---|---|
| injected JS scan + payload + `onTextSelected` | `fushi/lib/src/reader/reader_selection_scripts.dart:1216-1267`, `:1274-1378`, `:1381-1386` |
| invocation site (tap / hover) | `fushi/lib/src/pages/implementations/reader_fushi/webview.part.dart:1185` |
| Dart receive | `fushi/lib/src/pages/implementations/reader_fushi/webview.part.dart:1991` (`onTextSelected`), `:2014` (`onSelectionMenu`) |
| handler | `fushi/lib/src/pages/implementations/reader_fushi/lookup.part.dart:141` (`_handleTextSelected`) |
| desktop right-click "search" menu | `fushi/lib/src/pages/implementations/reader_fushi/chrome.part.dart:400`; mobile context menu `webview.part.dart:1799` |
| mobile selection menu → lookup | `chrome.part.dart:448` (`_handleSelectionMenu`), `:606` reuses `_handleTextSelected` |
| state/sentence backfill from native selection | `chrome.part.dart:687` (`_fillLookupStateFromNativeSelection`) |
| dictionary search + popup display | `fushi/lib/src/pages/base_source_page.dart:314` (`searchDictionaryResult`) |
| load-more (headword-budget increment) | `base_source_page.dart:431` area (BUG-1478 comment at `:425-430`) |
| in-place navigation inside a popup card | `base_source_page.dart:481` (`navigatePopupInPlace`) |
| highlight + deferred popup display | `lookup.part.dart:100-141` (`_highlightAndShowPopup`) |
| sentence extraction (JS side) | `reader_selection_scripts.dart:1280` (`getSentenceContext`) |

### E.2 Manga / OCR overlay

| Step | Location |
|---|---|
| OCR overlay rendered as DOM inside the manga WebView (`mangaWindowDocument`) | `fushi/lib/src/media/manga/reader/manga_fushi_page.dart:340-350` area |
| OCR text-box DOM attributes read for sentence/orientation/page | `reader_selection_scripts.dart:1286-1307` |
| union bbox of the OCR sentence group | `reader_selection_scripts.dart:1308-1332` |
| selection dispatch (page, sentence, rect, search) | `fushi/lib/src/media/manga/reader/manga_fushi_page.dart:255-280` (`dispatchMangaSelection`) |
| search callback target | `searchDictionaryResult` on the same `base_source_page.dart:314` |
| mining page selection | `manga_fushi_page.dart:273` (`selectPageForMining(data.mangaPageIndex)`) |
| OCR inference | `fushi/lib/src/ocr/ocr_inference_ort.dart`, `system_ocr_channel.dart`, `manga_ocr_model_import.dart`; engine-side `packages/fushi_engine/lib/ocr/manga_ocr_service.dart` |
| page-image path for the card | `manga_fushi_page.dart:290-306` (`ensureMangaCoverPng`) |

Note: `manga_fushi_page.dart:87` explicitly states the page "does not own manga rendering,
interaction, or OCR overlay behavior" — the overlay is generated by `mangaWindowDocument` and the
selection pipeline is the shared `reader_fushi` one.

### E.3 Video / subtitle path

| Step | Location |
|---|---|
| DOM subtitle layer lookup (click or hover) | `fushi/lib/src/pages/implementations/web_video_fushi_page.dart:1199` (`_onDomLookup`), `:1208` (`GlobalLookupController.instance.lookupText(...)`) |
| windowed mode (WebView2 child covers Flutter popup → use the top-level lookup window) | `web_video_fushi_page.dart:1168-1174` |
| payload parse / anchor rect | `web_video_fushi_page.dart:1200` (`parseWebVideoLookupPayload`), `:1207` (`webVideoLookupAnchorScreenRect`) |
| term extraction from a cue | `web_video_fushi_page.dart:1154` (`subtitleLookupTerm(sentence, graphemeIndex)`) |
| lookup-anchor cue resolution | `web_video_fushi_page.dart:1157-1162` (`resolveVideoLookupAnchorCue`) |
| overlay enable/disable of the global lookup hidden handler | `web_video_fushi_page.dart:494-497`, `:545-546` |
| floating lyric bar tap → app-external overlay | `fushi/lib/src/media/audiobook/floating_lyric_lookup_routing.dart:42-68` (`tryFloatingLyricGlobalLookup` → `GlobalLookupController.instance.lookupText`) |
| floating lyric term extraction | `floating_lyric_lookup_routing.dart:26-37` (`floatingLyricSearchTerm`, prefers `Language.wordFromIndex`) |
| reader lyrics-mode tap | `fushi/lib/src/pages/implementations/reader_fushi/lyrics.part.dart:474` (`JapaneseLanguage.instance.wordFromIndex`) |
| audiobook floating lyric host | `fushi/lib/src/media/audiobook/floating_lyric_lookup_host.dart:156` (`wordFromIndex`) |

### E.4 Additional invocation surfaces (for completeness)

| Surface | Location |
|---|---|
| Texthooker per-character lookup | `fushi/lib/src/pages/implementations/texthooker_page.dart:1423` (`lookupQueryFromIndex`), `:1434` (`pushNestedPopup`) |
| Galgame in-game hook lookup | `fushi/lib/src/lookup/gal_ingame_lookup_controller.dart:1253` (`lookupQueryFromIndex`), `:1280` (`lookupText`) |
| Galgame attached-text overlay | `fushi/lib/src/lookup/gal_hook_text_overlay_controller.dart:1727` (`lookupText`), `:1724` (`wordFromIndex`) |
| Global hotkey origin | `fushi/lib/main.dart:608` (`GlobalLookupController.instance.start(appModel: appModel)`) |
| Yomitan-API HTTP lookup (browser extension) | `fushi/lib/src/sync/yomitan_api_server.dart:624` (`searchDictionary`), tokenize endpoint via `yomitan_tokenize_adapter.dart` |
| Remote/pairing lookup | `fushi/lib/src/sync/fushi_remote_lookup_client.dart:86`; wired at `app_model.dart:5924-5934` (remote-first) and `:6043-6053` (remote-after-local-miss) |

---

## F) Dependencies & native boundary

### F.1 Native libraries and where they live

| Library | Artifact names | Platform | Source | Built by |
|---|---|---|---|---|
| fushidicts C++ core | `fushidicts` (STATIC) | all | `native/fushidicts/fushidicts_src/**`, `fushidicts_include/**` | CMake `add_library(fushidicts STATIC ...)` at `native/fushidicts/CMakeLists.txt:74-90` |
| fushidicts FFI bridge | `fushidicts_ffi.dll` / `libfushidicts_ffi.dylib` / `libfushidicts_ffi.so`; **iOS: `libfushidicts_ffi_merged.a`** | all | `native/fushidicts/fushidicts_ffi.cpp` (745 lines) | `CMakeLists.txt:117-127`; iOS static + `merge_ios_archives.sh` (`CMakeLists.txt:153-169`) |
| fushidicts JNI bridge | `libfushidicts_jni.so` | Android only | `native/fushidicts/fushidicts_jni.cpp` (202 lines) | `CMakeLists.txt:180-197`; loaded by `System.loadLibrary("fushidicts_jni")` at `fushi/android/app/src/main/java/app/fushi/reader/FushiBridge.kt:17` |
| glaze (JSON) | static | all | `native/fushidicts/fushidicts_external/glaze` | `CMakeLists.txt:68` |
| zstd | `libzstd_static` | all | `.../zstd` | `CMakeLists.txt:69`, `:110` |
| unordered_dense | `unordered_dense` | all | `.../unordered_dense` | `CMakeLists.txt:70`, `:112` |
| libdeflate | `libdeflate_static` | all | `.../libdeflate` | `CMakeLists.txt:71`, `:111` (StarDict `.dict.dz` gz inflate) |
| utf8proc | `utf8proc::utf8proc` (vendored v2.11.3, commit 26dbf597) | all | `.../utf8proc` | `CMakeLists.txt:72`, `:113`; NFKC/NFC |
| utfcpp | header-only | all | `.../utfcpp/source` | include dir at `CMakeLists.txt:98` |
| xxHash | header-only | all | `.../xxHash` | include dir at `CMakeLists.txt:99`; `xxh3.h` used by importer |
| user32 `keybd_event` | system DLL | Windows | none (in-box) | resolved at runtime, `fushi/lib/src/lookup/selection_capture_ffi.dart:28-31` |
| WebView2 | system runtime | Windows | none (in-box / bootstrapper) | `fushi/windows/runner/global_lookup_window.cpp` |

**No prebuilt binaries are committed**: `find` for `*fushidicts*.dll|.so|.dylib` returns nothing in
the repo, and nothing matching `fushidicts` is in `.gitignore` either. Every platform compiles
the engine from `native/fushidicts/` as part of the app build.

Requirement checks: `CMakeLists.txt:22-41` requires **C++23 including `<expected>`**
(`FUSHIDICTS_HAS_STD_EXPECTED`, hard `FATAL_ERROR` if missing, because glaze needs
`std::expected`). MSVC adds `/utf-8 /Zc:__cplusplus /permissive-` and `NOMINMAX`
(`:44-47`). Linux forces `CMAKE_POSITION_INDEPENDENT_CODE ON` so static deps can be embedded
into the `.so` (`:8-10`).

### F.2 Per-platform build wiring

| Platform | Wiring |
|---|---|
| Windows | `add_subdirectory("${CMAKE_CURRENT_SOURCE_DIR}/../../native/fushidicts" ...)` at `fushi/windows/CMakeLists.txt:70-71`; installs the DLL next to the exe at `:125`. Export-all-symbols OFF (`native/fushidicts/CMakeLists.txt:50-52`); `PREFIX ""` / `OUTPUT_NAME "fushidicts_ffi"` at `:172-177` |
| Linux | `add_subdirectory` at `fushi/linux/CMakeLists.txt:82-83`; installs `libfushidicts_ffi.so` into the bundle lib dir at `:117-118`. Comment at `:77-81`: the library used to be missing entirely, so dictionary lookups silently failed |
| macOS | Xcode "Run Script" phase invoking CMake — `fushi/macos/Runner.xcodeproj/project.pbxproj:482`: `cmake -S "$FUSHIDICTS_SOURCE_DIR" -B "$FUSHIDICTS_BUILD_DIR" -DCMAKE_OSX_ARCHITECTURES=... -DCMAKE_OSX_DEPLOYMENT_TARGET=13.4`, then `cmake --build ... --target fushidicts_ffi`, then copies the dylib into `Frameworks/`, `install_name_tool -id @rpath/...`, and codesigns unless `CODE_SIGNING_ALLOWED=NO` |
| iOS | static archive merge: `fushi/ios/build_fushidicts_ffi.sh:45` (`cmake --build ... --target fushidicts_ffi`) driven by `project.pbxproj:321`; env vars `FUSHIDICTS_SOURCE_DIR` / `FUSHIDICTS_BUILD_DIR` / `FUSHIDICTS_MERGED_ARCHIVE` at `:419-421`, `:559-561`, `:593-595`. The merged archive is `force_load`ed into the Runner so `DynamicLibrary.process()` finds the symbols — `native/fushidicts/CMakeLists.txt:12-20` and `:149-168` |
| Android | `externalNativeBuild.cmake.path "../../../native/fushidicts/CMakeLists.txt"` at `fushi/android/app/build.gradle:171-175`; `cppFlags "-std=c++23"`, `-DANDROID_STL=c++_shared` at `:160-163`; links `log` (`CMakeLists.txt:104-106`) |
| CI | `.github/workflows/native-fushidicts-gate.yml` runs the MSVC ctest suite (17 tests under `native/fushidicts/tests/`) — the comment at `:1-13` notes `flutter build windows --debug` only *compiles* fushidicts_ffi and never runs its tests. Also built indirectly by `.github/workflows/build-multiplatform.yml` and `.github/workflows/release-desktop.yml` |

`native/fushidicts/tests/` contains 34 targeted C++ tests (`word_scan_test.cpp`,
`popup_json_deinflection_test.cpp`, `simple_dict_deinflection_test.cpp`, `en_apostrophe_lookup_test.cpp`,
`korean_hangul_lookup_test.cpp`, `mdx_*`, `zip_*`, `hash_truncated_table_guard_test.cpp`, …).

### F.3 FFI surface (Dart ↔ native C ABI)

Library handle resolution — `packages/fushi_dictionary/lib/src/ffi/fushidicts_ffi_bindings.dart:6-14`:

```dart
Platform.isAndroid -> DynamicLibrary.open('libfushidicts_ffi.so')
Platform.isWindows -> DynamicLibrary.open('fushidicts_ffi.dll')
Platform.isMacOS   -> DynamicLibrary.open('libfushidicts_ffi.dylib')
Platform.isLinux   -> DynamicLibrary.open('libfushidicts_ffi.so')
Platform.isIOS     -> DynamicLibrary.process()
else               -> UnsupportedError
```

(No explicit path — the loader relies on the platform's default search, so the artifact must be
next to the executable / in the bundle lib dir / in the Frameworks dir, which the build wiring
above guarantees.)

| Symbol | Dart typedef (name at binding line) | Signature |
|---|---|---|
| `fushidicts_create` | `create` (`:227`) | `Pointer<Void> Function()` |
| `fushidicts_destroy` | `destroy` (`:229`) | `void Function(Pointer<Void>)` |
| `fushidicts_add_term_dict` | `addTermDict` (`:231`) | `void Function(Pointer<Void>, Pointer<Utf8>)` |
| `fushidicts_add_freq_dict` | `addFreqDict` (`:233`) | same |
| `fushidicts_add_pitch_dict` | `addPitchDict` (`:235`) | same |
| `fushidicts_add_kanji_dict` | `addKanjiDict` (`:237`) | same |
| `fushidicts_load_transforms` | `loadTransforms` (`:239`) | `void Function(Pointer<Void>, Pointer<Utf8> json)` |
| `fushidicts_query` | `query` (`:242`) | `FfiQueryResult Function(Pointer<Void>, Pointer<Utf8> expression)` |
| `fushidicts_free_query_result` | `freeQueryResult` (`:245`) | `void Function(Pointer<FfiQueryResult>)` |
| `fushidicts_lookup` | `lookup` (`:248`) | `FfiLookupResults Function(Pointer<Void>, Pointer<Utf8> text, Int32 maxResults, Int32 scanLength)` |
| `fushidicts_lookup_with_options` | `lookupWithOptions` (`:251`) | `FfiLookupResults Function(Pointer<Void>, Pointer<Utf8>, Int32, Int32, Pointer<Utf8> freqDict, Int32 freqOrder, Pointer<Utf8> primaryReading)` |
| `fushidicts_free_lookup_results` | `freeLookupResults` (`:255`) | `void Function(Pointer<FfiLookupResults>)` |
| `fushidicts_get_styles` | `getStyles` (`:258`) | `FfiDictStyles Function(Pointer<Void>)` |
| `fushidicts_free_styles` | `freeStyles` (`:260`) | `void Function(Pointer<FfiDictStyles>)` |
| `fushidicts_get_media` | `getMedia` (`:262`) | `FfiMediaFile Function(Pointer<Void>, Pointer<Utf8> dictName, Pointer<Utf8> mediaPath)` |
| `fushidicts_free_media` | `freeMedia` (`:265`) | `void Function(Pointer<FfiMediaFile>)` |
| `fushidicts_query_kanji` | `queryKanji` (`:267`) | `FfiKanjiResults Function(Pointer<Void>, Pointer<Utf8> char)` |
| `fushidicts_free_kanji_results` | `freeKanjiResults` (`:270`) | `void Function(Pointer<FfiKanjiResults>)` |
| `fushidicts_lookup_popup_json` | `lookupPopupJson` (`:273`) | `Pointer<Utf8> Function(Pointer<Void>, Pointer<Utf8>, Int32, Int32, Int32 maxTerms)` |
| `fushidicts_free_string` | `freeString` (`:277`) | `void Function(Pointer<Utf8>)` |
| `fushidicts_import` | `import_` (`:218`) | `FfiImportResult Function(Pointer<Utf8> zipPath, Pointer<Utf8> outputDir, Pointer<Utf8> breadcrumbDir)` |
| `fushidicts_probe_dict_content` | `probeDictContent` (`:221`) | `Int32 Function(Pointer<Utf8> dir)` |
| `fushidicts_free_import_result` | `freeImportResult` (`:224`) | `void Function(Pointer<FfiImportResult>)` |

Struct mirrors (Dart `Struct` declarations) are at `fushidicts_ffi_bindings.dart:18-151`:
`FfiGlossary` `:18`, `FfiFrequency` `:25`, `FfiPitch` `:33` (field order strictly mirrors native
— see the comment at `:41-42`), `FfiTermResult` `:48`, `FfiQueryResult` `:63`,
`FfiTransformGroup` `:69`, `FfiLookupResult` `:74`, `FfiLookupResults` `:85`,
`FfiImportResult` `:91`, `FfiDictStyle` `:111`, `FfiDictStyles` `:116`, `FfiMediaFile` `:122`,
`FfiKanjiResult` `:128`, `FfiKanjiResults` `:147`.
The C-side mirrors are in `native/fushidicts/fushidicts_ffi.cpp:101-166`, and every export is
wrapped in `ffi_guard` / `ffi_guard_void` which convert exceptions into zero returns
(`fushidicts_ffi.cpp:431-437`, `:483`, `:605`, `:619`, `:664`, `:699`, `:727`); the
`FushidictsHandle` is `{DictionaryQuery query; Deinflector deinflector;}` (`:167-170`).
The legacy `fushidicts_lookup` is retained verbatim for ABI stability — the comment at
`fushidicts_ffi.cpp:616` says *"Never break ABI"*.

JNI equivalents for Android (`native/fushidicts/fushidicts_jni.cpp:87-190`):
`nativeCreate`, `nativeDestroy`, `nativeAddTermDict`, `nativeAddFreqDict`, `nativeAddPitchDict`,
`nativeAddKanjiDict`, `nativeLoadTransforms`, `nativeLookupJson`, `nativeQueryKanjiJson`,
`nativeGetStylesJson` — on class `app.fushi.reader.FushiBridge`.

Dart-side nil/error guards worth naming for a clone: `_utf8OrEmpty` (`fushidicts.dart:19-35`),
the `handle == nullptr` check in the constructor (`:149-152`), the `r.data == nullptr && r.size > 0`
OOM diagnostic (`:749-763`), and every import-result field conversion being null-safe because
native error branches leave `detected_type` / `title` / `error` NULL (`:559-562`, HBK-AUDIT-032).

---

## G) Minimal desktop clone inventory

Goal: "click a word → popup dictionary with segmentation" on macOS / Windows / Linux.

### G.1 Strictly required

| # | Component | Concrete artifact | Why required |
|---|---|---|---|
| 1 | **Lookup engine** | `native/fushidicts/` as a shared library, built by CMake (C++23 + `<expected>`) | owns the index, the prefix scanner, deinflection, ranking, and zstd glossary materialization. Nothing in Dart can substitute without reimplementing all of it |
| 1b | vendored deps | `native/fushidicts/fushidicts_external/{glaze,zstd,unordered_dense,libdeflate,utf8proc,utfcpp,xxHash}` | all vendored, no network fetch at build time |
| 2 | **FFI bindings** | `packages/fushi_dictionary/lib/src/ffi/fushidicts_ffi_bindings.dart` (306 lines) | the only place that knows the ABI; the struct field order must match `fushidicts_ffi.cpp` exactly |
| 3 | **Engine wrapper** | `packages/fushi_dictionary/lib/src/engine/fushidicts.dart` + `fushidicts_models.dart` | handle lifecycle, result conversion, `_utf8OrEmpty` tolerance, styles/media |
| 4 | **Dictionary descriptor** | `packages/fushi_dictionary/lib/src/engine/dictionary.dart` | type buckets, display name, collapse state are all consumed downstream |
| 5 | **Result shaping** | `packages/fushi_dictionary/lib/src/language/language.dart` — specifically `buildResultFromLookup` (`:535`), `lookupHeadwordKey` (`:588`), `buildPopupJsonFromLookup` (`:594`), `buildDeinflectionTags` (`:431`), `buildLookupEntryExtra` (`:499`), `_glossariesInDictionaryOrder` (`:772`) | this is where headword budgeting, deinflection labels, dedup, and the popup JSON contract live. **Load-bearing.** |
| 6 | **Japanese language impl** | `.../language/implementations/japanese_language.dart` + `language_utils.dart` + `ruby_text.dart` | `textToWords` / `wordFromIndex` (the Dart-side segmenter), furigana distribution, pitch widget |
| 7 | **Deinflection data** | `fushi/assets/transforms/manifest.json` + `ja.json` (54 transforms / 834 rules) + `transforms/i18n/**` | without it no inflected form resolves |
| 8 | **Popup web asset** | `fushi/assets/popup/popup.html`, `popup.js`, `popup.css` | the renderer. `popup.html` is loaded by InAppWebView |
| 9 | **Popup host** | one of: `dictionary_popup_layer.dart` + `dictionary_popup_webview.dart` (in-app Flutter overlay + InAppWebView) | the cheapest correct desktop renderer |
| 10 | **Search entry** | `AppModel.searchDictionary` (`fushi/lib/src/models/app_model.dart:5901`), or a reduced equivalent: `normalizeSearchTerm` → `FushiDicts.instance.lookup` → `buildResultFromLookup` → `buildPopupJsonFromLookup` | ~60 lines of the 150-line function are the minimum viable core (`:5908-5916`, `:5943-5947`, `:6004-6025`) |
| 11 | **Import path** | `FushiDicts.importDictionary` → `fushidicts_import`, plus a file picker | you need at least one way to get a dictionary onto disk |
| 12 | **Injection of results into popup.js** | the existing `_pushResults` / `buildPopupSettingsJs` machinery in `dictionary_popup_webview.dart` + `popup_settings_injection.dart` | popup.js needs the settings + entries JS body; sharing it is what keeps the surfaces from drifting |

### G.2 Optional / can be deferred

| Component | Deferrable because |
|---|---|
| `frequency_rank.dart` | only affects mining fields (`{frequency-harmonic-rank}`) and Anki new-card reordering. The native sort already ranks by raw frequency values (`lookup.cpp:240-257`) |
| Pitch dictionaries & `getPitchWidget` | `FushiPitchEntry` can stay empty; popup.js renders nothing |
| Kanji bucket (`fushidicts_add_kanji_dict`, `queryKanji`, `kanjiResults`) | the term index alone answers "click word → meaning" |
| IPA transcription dicts | shares the pitch path (`importer.cpp:118-124`) |
| MDX / StarDict / DSL importers | start with yomitan zips only; the dispatch in `importer.cpp:2117-2120` and the readers are separate compilation units |
| Dictionary media (`image://`, `dictmedia://`, `getMediaFile`) + `writeDictionaryMediaCache` | only affects gaiji/images and stylesheet fonts |
| `dict_style_rules.dart` style compiler | hand-written CSS injection is enough |
| The entire global-hotkey / app-external overlay (`global_lookup_controller.dart`, `selection_capture_ffi.dart`, `global_lookup_window.cpp`, `overlay_window_channel.dart`, `global_lookup_render.dart`, `global_lookup_layout.dart`, `global_lookup_stack.dart`) | ~5000 lines of Dart + a native Win32 window to support "look up in *another* app". In-editor click-to-popup needs none of it |
| Nested popup stack (`global_lookup_stack.dart`, `_lookupNested`, `renderStack`, `global_lookup_host.html`) | stack depth 1 is enough for a first version |
| Mining / Anki (`packages/fushi_anki`, `overlay_bridge_handlers.dart`, `immersion_mining_engine.dart`) | orthogonal to lookup |
| Downloader / update service (`dictionary_downloader.dart` 1026 lines, `dictionary_update_service.dart`) | only for the online catalog |
| Remote/pairing lookup (`fushi_remote_lookup_client.dart`, `app_model.dart:6068-6100`) | single-machine clone does not need it |
| Browser-extension server (`yomitan_api_server.dart`, `browser_extension_installer.dart`) | different product surface |
| `dict_resource_materializer.dart` | BUG-2504 iCloud/OneDrive dataless-file guard; not needed for local-disk-only installs |
| `popup_main.dart` / `floating_dict_main.dart` / `PopupDictActivity` | Android floating-subsurface hosts |
| `effective_lookup_size.dart` drag-resize math | fixed popup size is fine |
| Texthooker / galgame / video / audiobook integration points | E.2–E.4 are all optional call sites around the same core |

### G.3 Smallest viable desktop implementation

Build order that reaches "click word → popup with dictionary-aware segmentation":

1. **Engine + FFI.** Build `native/fushidicts` via CMake for the target OS (macOS needs
   `-DCMAKE_OSX_ARCHITECTURES`, mirroring `project.pbxproj:482`; Windows needs MSVC + C++23
   `<expected>`), produce `fushidicts_ffi.{dll,dylib,so}`, and place it beside the executable.
   Port: `fushidicts_ffi_bindings.dart`, `fushidicts.dart`, `fushidicts_models.dart`,
   `dictionary.dart`.
2. **Data.** Import one yomitan zip via `FushiDicts.importDictionary`, and call
   `preloadTransforms()` after reading `assets/transforms/manifest.json` + `ja.json`.
3. **Query.** `FushiDicts.instance.lookup(query, maxResults: 10)` →
   `buildResultFromLookup` → `buildPopupJsonFromLookup`. Segmenter (if you need tokens rather than
   a query window) is `_lookupMatchedLength` + `textToWords` — about 40 lines, no extra dependency.
4. **Trigger.** Render your text (Flutter rich text, or a WebView), map a tap to `(textNode/offset)`
   or `(line, charIndex)`, and produce the query string with the **reader's forward-scan rule**
   (stop at delimiters; cross at most one intra-node whitespace; do not cut inside Latin words)
   or simply with `lookupQueryFromIndex(text, index, maxChars: 24)`.
5. **Popup.** Flutter `OverlayEntry` / `Stack` + `InAppWebView` loading `assets/popup/popup.html`,
   injecting the settings+entries JS. Anchor from the tapped rect using the equivalent of
   `calcPopupPosition` (`dictionary_popup_layer.dart:26`).
6. **Skip** everything in G.2.

**Load-bearing files (absolute minimum set), in dependency order:**

| File | Why it cannot be skipped |
|---|---|
| `native/fushidicts/fushidicts_src/{query,lookup,deinflector,word_scan,text_processor,importer,memory,hash,mdx,stardict,json,zip,popup_json}.cpp` + `fushidicts_include/**` | the engine. `query.cpp` (808) + `lookup.cpp` (292) + `deinflector.cpp` (301) + `text_processor.cpp` (744) + `importer.cpp` (2145) are the irreducible core |
| `native/fushidicts/CMakeLists.txt` | C++23 requirement, deps, iOS/Android special cases |
| `packages/fushi_dictionary/lib/src/ffi/fushidicts_ffi_bindings.dart` | ABI |
| `packages/fushi_dictionary/lib/src/engine/fushidicts.dart` | handle + lifecycle + conversion |
| `packages/fushi_dictionary/lib/src/engine/fushidicts_models.dart` | result data classes |
| `packages/fushi_dictionary/lib/src/engine/dictionary.dart` | type buckets + display name |
| `packages/fushi_dictionary/lib/src/language/language.dart` | result shaping + **the popup JSON contract** |
| `packages/fushi_dictionary/lib/src/language/implementations/japanese_language.dart` | Dart-side segmenter |
| `packages/fushi_dictionary/lib/src/models/dictionary_entry.dart`, `dictionary_search_result.dart` | models |
| `fushi/assets/transforms/manifest.json`, `ja.json` | deinflection |
| `fushi/assets/popup/popup.html`, `popup.js`, `popup.css` | renderer |
| `fushi/lib/src/pages/implementations/dictionary_popup_webview.dart` | pushes settings + entries into popup.js |

The single highest-risk piece to re-derive is `buildPopupJsonFromLookup` (`language.dart:594-762`):
it is hand-serialized JSON whose exact key names (`expression`, `reading`, `matched`, `rules`,
`deinflectionTrace`, `glossaries[].{dictionary,content,definitionTags,termTags}`,
`frequencies[].{dictionary,frequencies[].{value,displayValue}}`,
`pitches[].{dictionary,pitchPositions,patterns,transcriptions}`) are a hard contract with
`popup.js` and with the C++ `build_popup_json` mirror (`native/fushidicts/fushidicts_src/popup_json.cpp`,
277 lines). A clone that keeps this function and `popup.js` untouched inherits the whole rendering
layer for free.

---

## H) Gotchas — BUG-/TODO- comments about dictionary / tokenizer / popup

### H.1 Dictionary engine & import

| Ref | File:line | Substance |
|---|---|---|
| BUG-2110 | `engine/fushidicts.dart:145-152` | FFI guard turns native exceptions into zero returns, so `create` failure returns `nullptr`, which is a non-null `Pointer`; without the explicit check every export dereferences it → SIGSEGV the guard cannot catch |
| BUG-1756 | `engine/fushidicts.dart:430-453` | native `MapViewOfFile` on `hash.table`/`bloom.filter`/`blobs.bin`/`media.bin`/`media.idx` keeps dictionary dirs undeletable on Windows (`ERROR_USER_MAPPED_FILE` 1224). **Every dictionary-directory delete must call `releaseAllMappings()` first**; also the pending schedule and in-flight shadow must be cleared before the early return, or the deleted dictionary's mappings grow back |
| BUG-171 | `app_model.dart:1908-1912` | the engine must be rebuilt even for an empty set, otherwise deleting the last dictionary leaves the old in-memory index live and lookups still hit (BUG-171) |
| BUG-2158 | `engine/dictionary.dart:7-23`, `:109-117`, `:202-203` | collapse needed three states, not a boolean; the settings-page "unfold" button was a no-op because the model had no state to write. `copyWith` had to be taught the new column |
| *(type probe)* | `engine/dictionary.dart:25-42` | reverse-inferring "probed" from results made startup re-scan every dictionary's whole hash table every launch (a pure-kanji dictionary can never satisfy the early-exit condition). Cold mobile cache + many dictionaries = app will not open |
| *(O(N²) loading)* | `engine/fushidicts.dart:167-178` | metadata writes are per-dictionary, so an immediate rebuild costs O(N²); the deferred schedule collapses N writes into 1 load. A caller that forgets the batching declaration silently degrades |
| *(watchdog deadlock)* | `engine/fushidicts.dart:308-322` | synchronous FFI loading blocks the main isolate so **all Timers stop firing** — both the 12 s IO watchdog and the 20 s escape UI silently fail. Must yield with `Future.delayed`, not `await null` (microtask yield does not reach the Timer queue) |
| HBK-AUDIT-032/097 | `engine/fushidicts.dart:16-18`, `:558-562` | native error/OOM branches leave string fields NULL; every conversion is null-guarded. A strict `utf8.decode` would also crash on dictionaries imported from non-standard encodings (`:22-34`) |
| HBK-AUDIT-100 | `engine/fushidicts.dart:749-763` | native reports allocation failure as `size > 0, data == nullptr`, which used to be indistinguishable from not-found; the contract stays nullable so WebView callers degrade to 404 rather than crash, but the true fix belongs in `fushidicts_ffi.cpp` |
| TODO-622 | `fushidicts.dart:514-530` | content probing must be handle-free so it can run before any query handle exists (startup type self-heal) |
| TODO-687 block3 | `importer.cpp:118-124` | a pure-IPA dictionary must classify as `pitch`, otherwise it falls through to `term`, is never registered as a pitch dict, and its data is unreachable. Upstream widened only the count branch and missed this |
| BUG-2152 | `query.cpp:519-540` | one dictionary contributes one `PitchEntry`, but a headword the dictionary splits into several entries (English `spoke` = noun + past of `speak`) hands the same notation back once per entry; the three downstream dedups all key on the whole entry, so a single entry carrying an internal duplicate is seen once and kept whole → `[/spəʊk/][/spəʊk/]` on the card |
| BUG-1304 | `lookup.cpp:160-171`, `:273-279`, `query.cpp:332-334` | frequency enrichment used to run inside every `query_raw` call (~69 per user lookup, measured) for results mostly discarded by dedup/sort/resize; measured 9.4 → 3.2 enrichments per lookup, ~5-9% end-to-end. Pitch enrichment and glossary materialization only happen after the resize |
| BUG-1665 | `lookup.cpp:124-158` | MDX/StarDict `@@@LINK=` redirect aliases surface as untransformed exact hits that outrank the real lemma, so the popup header and mined card carry the inflected surface form; detector uses the shared compressed-blob identity |
| BUG-1472 | `language.dart:543-550`, `:621-628` | the headword budget was being spent on glossary comment lines. A high-frequency headword alone carries 7–26 lines, so 永遠 always won and とわ/とこしえ never appeared. `DictionarySearchResult.truncated` was added so consumers stop reverse-inferring truncation from `entries.length` (`dictionary_search_result.dart:40-50`) |
| BUG-1478 | `sentence_extraction.dart:44-55`, `texthooker_page.dart:1415-1427`, `base_source_page.dart:425-430` | using the tokenizer's whole word as the query string makes "click 遠 to look up 遠 alone" impossible; and load-more must increment the **headword** budget, not `entries.length`, or one downward scroll re-fetches the whole dictionary |
| BUG-791 | `language.dart:585-592` | an empty reading is Yomitan-equivalent to "reading == expression"; without normalizing the headword grouping key the same kana headword splits into two headwords |
| BUG-2038 | `language.dart:458-462`, `:705-711` | transform descriptions must be stored in English in the persisted `extra` and translated only at the display boundary; baking the UI language in at write time makes language switching impossible |
| BUG-2056 | `text_processor.cpp:271-282`, `reader_selection_scripts.dart:405-450` | U+2019 has no NFKC decomposition, so `don’t` matched neither ASCII-keyed dictionary entries nor the five apostrophe transform rules; normalized to both `'` and `’` variants. On the JS scan side the apostrophe must be treated as intra-word |
| BUG-2148 | `lookup.cpp:79-118`, `text_processor.cpp:712-721` | `ko.json`'s 450 transforms are written in the Hangul jamo domain while the index keys are precomposed syllables, so **not one** Korean rule fired. Fix is disassemble→deinflect→reassemble, and the recomposed form must also be queried because 116 rules already write precomposed `toSuffix`. The tie-break on `preprocessor_steps` exists because jamo variants sort before the original in a `std::map` |
| BUG-1777 | `text_processor.cpp:138-142` | Yomitan's `full_collapse` mode is deliberately not ported: it eats a lone っ/ッ/ー, so ヒットで→ひとで (false hit 海星) and きって→きて, and because it consumes more source text it necessarily wins the longest-match sort |
| BUG-1868 | `text_processor.hpp` (`reassemble_hangul_utf8`) | unconditional utf8↔utf32 round-trips per deinflected form are pure CPU burn; a Japanese lookup produces dozens to hundreds of forms, and popup slowness has precedent |
| TODO-892 | `engine/fushidicts.dart:551-553` | native writes a synchronous `.import_step` crash breadcrumb; empty string disables it |
| TODO-609 | `engine/dictionary.dart:244-252` | online-update metadata (`revision` / `indexUrl` / `downloadUrl`) — three-condition gate for `isUpdatable` |
| BUG-2053 | `importer.cpp:78-80` | `__MACOSX/...` and `.DS_Store` must be excluded or they become dictionary media |
| BUG-1756 / rename | `query.cpp:103-127` | after the `hoshidicts` → `fushidicts` rename the write side produced only `.fushidicts_1` while users' disks held `.hoshidicts_1`, so `add_dict` returned early and **all 26 dictionaries silently stopped loading**. Read side accepts both names; user files are never rewritten (a rollback would then break) |

### H.2 Tokenizer / segmentation

| Ref | File:line | Substance |
|---|---|---|
| BUG-1773 | `reader_selection_scripts.dart:387-408`, `:1244-1255` | whitespace is not a word boundary synonym. `isScanStop` (real end-of-scan) must exclude whitespace so `listen to`-style phrase entries are reachable; a single intra-node whitespace may be crossed, but never across a block boundary. Known tradeoff: `<b>listen</b> to` is still not found |
| BUG-2056 | `reader_selection_scripts.dart:402-450` | the intra-word apostrophe check must run **before** the stop test |
| BUG-1478 | `sentence_extraction.dart:44-55` | "do not tokenize; hand the suffix window to the engine" is the deliberate design |
| TODO-1317 | `reader_selection_scripts.dart:1387-1398` | mobile long-press drag-select ends in a Copy/Lookup menu instead of an immediate lookup; the app-drawn CSS Custom Highlight selection is kept so plain-text copy and lookup coexist, and no native selection is ever created (TODO-1279) |
| BUG-2508 | `reader_host_hover_lookup.dart:1-35` | the reader's Shift-hover lookup had only one leg (JS `mousemove`), which is **dead on macOS**: WebKit's hit test only delivers `mouseMoved:` when the hit view is a WKWebView descendant, and the Flutter macOS embedder puts Flutter-painted regions into `FlutterMutatorView._hitTestIgnoreRegion`, so `hitTest:` returns nil. A host-side `PointerHoverEvent` leg is added, mutually exclusive with the JS leg so exactly one is live per platform (BUG-2031 discipline) |
| TODO-376 | `floating_lyric_lookup_routing.dart:21-37` | two desktop lyric-click routes had each grown their own segmentation; consolidated into `floatingLyricSearchTerm` to stop drift |
| *(no analyzer)* | repo-wide grep | there is no MeCab/Sudachi/jieba/kuromoji/Vibrato dependency; `JapaneseLanguage.prepareResources()` is an empty override (`japanese_language.dart:69-70`). Anyone expecting morphological POS or a per-language tokenizer plugin should look at `Language` (`language.dart:21`) but note only Japanese is registered (`app_model.dart:2376-2391`) |

### H.3 Popup / overlay / controller

| Ref | File:line | Substance |
|---|---|---|
| BUG-717 ② | `reader_fushi/lookup.part.dart:100-141` | popup display and source-text highlight were serialized behind a DOM eval on the busy paginating reader WebView, making in-app lookup several times slower than the app-external overlay. Now: show immediately with the raw rect, re-anchor asynchronously with a generation guard |
| BUG-767 | `lookup.part.dart:115-120` | multi-character deinflected matches highlight wider than the selection, so without re-anchoring the popup covers the looked-up word |
| BUG-005 / TODO-678 | `lookup.part.dart:127-140`, `lyrics.part.dart` | `evaluateJavascript` throws `MissingPluginException` on a half-destroyed WebView; the `_controller != null` guard is not enough because the per-instance method channel handler was already removed |
| BUG-1833 | `global_lookup_render.dart:170-182`, `global_lookup_controller.dart:1385-1392` | the static settings segment (theme + dictionary fonts + dictionary styles + custom CSS + flags) contains inline `data:` font URLs and can reach tens of MB; without per-host revision dedup every lookup pipes that through the platform channel and re-parses it, only for the host to discard it. Also, `galFrameDirty` fires up to dozens of times per second and `glog` is a synchronous `writeAsStringSync` + `flush:true`, so it is excluded from logging |
| BUG-859 / TODO-893 | `global_lookup_controller.dart:1057-1072` | the work area must be converted to CSS px with the **anchor monitor's** dpr; using the main window's dpr on a mixed-scale multi-monitor setup puts the cascade domain in the wrong scale (mis-placed nested cards, broken reserve-to-edge clamp) |
| TODO-893 (size) | `effective_lookup_size.dart:96-110` | the transient overlay window is always larger than the visible card (the reserve-to-edge margin is clipped by the window region), so using absolute window size to recompute the base size makes the card explode and jump to a work-area corner. Must use drag-start/end **deltas** |
| TODO-1345 / BUG-583 / BUG-670 | `global_lookup_controller.dart:1073-1098` | reserving only one card of headroom still moved the origin once when a deep cascade appeared, producing a 1-frame parent lurch. Reserving all the way to the work-area edge is the deterministic worst case; it stays clamp-safe because the reserved origin sits exactly on the C++ `RevealStack` clamp target. The `galCard` route must instead use `(0,0)` or it recreates a fixed red range (BUG-1835) |
| TODO-1079 (D) | `global_lookup_controller.dart:913-923` | native `visible_`/`revealed_` and Dart `_revealed` drift apart across lookups: an in-flight `Hide()` can swallow the next window, and a stale `revealed_` lets the foreground hook self-close the fresh card. An unconditional `hide(notify: false)` up front collapses both sides |
| TODO-1079 (B) | `global_lookup_controller.dart:1110-1122`, `:1138-1144` | a blind 450 ms reveal could show a not-yet-loaded WebView2 ("window present but blank"); the fallback must confirm `isWebViewReady()` first, rescheduling a bounded number of times |
| TODO-951 症状C | `popup_main.dart:212-221` | a `ValueKey`-forced rebuild discarded `PopupDictionaryPage` (and its warm WebView) on every new word → white flash on every lookup. Now the page is resident and takes the new word via `searchTerm` + `searchGeneration` |
| TODO-872 / TODO-708 | `popup_main.dart:73-90`, `:126-155` | two different screen coordinate systems: native glyph/subtitle rects have their origin at the physical screen top (including status bar) while the popup window's content origin is below the status bar; the translation subtracts the status-bar physical height before dividing by dpr |
| TODO-1188 / BUG-1908 | `overlay_bridge_handlers.dart:296-404` | the app-external bare WebView has no Flutter toast (`FushiToast` returns early without an `Overlay`), so mining failures were completely silent; now a `message` comes back. Failure diagnostics go to the log, not into the user-facing string |
| BUG-1915 / TODO-448 | `dictionary_popup_webview.dart:70-120` | an unknown mining outcome must not be repainted as success, and the popup must not re-query Anki after a failure to flip the button to ✓ |
| BUG-1833 (nested) | `global_lookup_render.dart:180-182` | the dedup state used to be assembled by each caller as a `Map<String, Set<int>>` while `buildStackRenderScript`'s parameter was **optional**, so the clipboard-panel path never passed it and the whole dedup was dead for that surface — every lookup (including every nested lookup inside the panel) re-sent the full static segment. Now the parameter is required |
| TODO-867 P3c | `global_lookup_render.dart:21-31`, `global_lookup_controller.dart:958-973` | the top-level document is now a bare iframe host with zero popup.js instance, so nothing can call `window.renderPopup()` at the top level; the single-frame lookup is stack depth 1 and renders through `renderStack` like any child. `beginLookup` must not be sent as a separate render — a cold/recovering WebView retains one complete pending render (last-wins) and the route prelude would be overwritten, leaving the host on desktop/0/0 |
| BUG-2054 | `global_lookup_controller.dart:1835-1847`, `:1694` | the child card must be placed against the highlighted word's real bbox on its **first** render; highlighting after the push causes a visible jump. Anything unusable must leave `anchorRect` untouched |
| BUG-802 | `dictionary_popup_webview.dart:720` | the popup renders every entry card as a separate **same-origin iframe** (`global_lookup_host.js`) |
| TODO-1152 | `dictionary_popup_webview.dart:750-770` | after `put_Bounds` grows the surface a compositor frame nudge is needed; iOS WKWebView can report `window.innerWidth == 0` (`:398`) |
| TODO-1651 | `dictionary_popup_webview.dart:322-330` | popup metrics are in **host CSS px**, and popup.js-side values must be converted consistently |
| BUG-865 | `android/.../PopupEngineHolder.kt:122` | the warm engine must be created with `applicationContext` so its registrant also registers the Anki channel, or `popupMain` cannot mine |
| TODO-426 | `dictionary_popup_webview.dart:35` | the "N sentences up / down" sentence-context selector was temporarily removed at the user's request (the mining draft still exists: TODO-393/382/763/766) |
| TODO-1066 | `selection_capture_ffi.dart:57-88`, `global_lookup_channel.dart:169-174` | clipboard capture is a cross-`await` transaction on a single global resource; overlapping runs destroy the user's clipboard (A saves old → A clears → B "saves" the empty value → A restores → B times out → B "restores" to empty). Must be serialized at the transaction layer, not the trigger layer, and the gate must advance regardless of success. The global mouse side-button trigger needs the same gate (skipping superseded captures while queued) or button chatter queues up to 600 ms transactions each |
| BUG-114 | `selection_capture_ffi.dart:178-181` | the Windows clipboard update is async and may be briefly locked by the source app; the poll is bounded at ~600 ms |
| BUG-1666 | `lookup_deep_link.dart:1-18` | the deep link is produced from exported glossary HTML, so it must parse both the current `fushi://` and the pre-rename `hibiki://` schemes, and both Android's intent filter and Windows' registered protocol converge on the same parser |
| BUG-1302 | `app_model.dart:6057-6081` | remote dictionary lookup is ordered **before** the local cache, so an offline/roaming/asleep paired device paid "3 s × candidates" of transport timeout on every lookup — reported as "lookup takes 4-5 seconds on some machines". A failure cooldown short-circuits it. Also: `await` must be inside the `try`, otherwise only synchronous throws are caught and async errors escape as uncaught |
| TODO-854 / TODO-1353 | `dictionary_popup_webview.dart:745-750`, `:596-684` | pull-down-to-close JS is single-sourced; Ctrl+wheel zoom delegates to the same font-size stepper as the toolbar A−/A+ (clamped to 8..72) so all four surfaces cannot drift |

---

## Appendix — one-page trace (the shortest correct mental model)

```
pointer @ (x,y)
  └─ reader JS  reader_selection_scripts.dart:1216  → caret → expand/scan → {text, ranges, sentence, rect, normalizedOffset…}
       └─ callHandler('onTextSelected')  :1384
            └─ Dart  reader_fushi/webview.part.dart:1991  → _handleTextSelected  lookup.part.dart:141
                 └─ searchDictionaryResult  base_source_page.dart:314
                      └─ AppModel.searchDictionary  app_model.dart:5901
                           ├─ normalizeSearchTerm
                           ├─ cache lookups (search cache, FFI cache)
                           ├─ FushiDicts.instance.lookup(term, maxResults: N)   fushidicts.dart:640
                           │    └─ FFI fushidicts_lookup → lookup.cpp:54
                           │         scan_candidates (word_scan.cpp:52)
                           │           → text_processor::process (variants)
                           │             → Deinflector::deinflect (depth ≤ 10, trace)
                           │               → DictionaryQuery::query_raw (hash.table → blobs.bin, keyed on expression OR reading)
                           │                 → filter_by_pos
                           │         dedup by (expression, reading), longest matched, fewest steps
                           │         redirect-alias suppression (shared zstd blob)
                           │         enrich_freq
                           │         partial_sort (reading → length → steps → trace → expr==deinflected → freq dicts → score → expr==reading)
                           │         resize(max_results) → enrich_pitch → materialize (zstd)
                           ├─ buildResultFromLookup  language.dart:535   (headword budget, dictionary order)
                           ├─ buildPopupJsonFromLookup  language.dart:594 (hidden-dict filter, dedup, localized deinflection labels)
                           └─ withKanjiResults
                 └─ show popup  (in-app overlay + InAppWebView | native WS_POPUP WebView2 | Android Activity)
                      └─ mineEntry bridge → OverlayMiningHandler | BaseAnkiRepository.mineEntry → Anki card
```
