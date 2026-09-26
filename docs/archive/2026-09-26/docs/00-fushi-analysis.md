# Fushi 漫画 / 小说处理流程分析（总报告）

> 分析对象：`/Users/heyanle/Desktop/project/Fushi`（Flutter/Dart，pub workspace，应用代码约 49.4 万行 Dart + 约 1 万行 C++）
> 分析方式：只读代码走查，所有结论带 `文件:行号` 引用。
> 四份深挖子报告：
> - [`01-manga-pipeline.md`](./analysis/01-manga-pipeline.md) — 漫画载体、页序、mokuro 文字层、OCR
> - [`02-novel-epub-pipeline.md`](./analysis/02-novel-epub-pipeline.md) — EPUB 解析、渲染、选择与查词
> - [`03-dictionary-tokenizer-lookup.md`](./analysis/03-dictionary-tokenizer-lookup.md) — 词典引擎、分词、弹窗
> - [`04-architecture-and-stack.md`](./analysis/04-architecture-and-stack.md) — 分层、状态、持久化、构建

---

## 0. 一句话结论

Fushi 把**漫画和小说当成同一种东西**：都是 `EpubBooks` 表里的一行、都住在
`fushi_books/<bookKey>/` 目录、**都用同一个 WebView 阅读器渲染**。两者唯一的区别是
`format` 字段（`epub` / `pdf` / `manga`）加两个可空覆盖列。

它们真正共享的是**一条「文字 → 分词 → 词典 → 弹窗」的管线**，而「分词」在 Fushi 里
**不是形态素分析**，而是「拿词典当分词表做最长匹配扫描」。这一点是理解整个项目的钥匙，
也是最容易被误判的地方——项目里没有 MeCab、没有 Sudachi、没有 jieba（`analysis/03` §B）。

```
                 ┌──────────────────────── 共用的下游 ────────────────────────┐
小说: .epub ─► 解包 OPF/spine ─┐                                              │
                              ├─► EpubBooks 一行 ─► WebView 章节 HTML ─┐      │
漫画: .mokuro/.cbz/文件夹 ────┘   fushi_books/<key>/                    ├─► 点字 │
     └─► 页图 + manga.json(文字框) ─► WebView 页图 + 透明文字层 ────────┘   │
                                                                          ▼
                          hoshidicts(C++ FFI) ◄─ 扫描候选词 ◄─ 字符偏移 ─┘
                                    │
                                    ▼
                             独立弹窗窗口 / 浮层
```

---

## 1. 漫画流程

### 1.1 入口与载体判定

三个导入函数都收口在 `packages/fushi_engine/lib/media/manga/manga_importer.dart`：

| 入口 | 位置 | 输入 |
|---|---|---|
| `importFromMokuroPath` | `manga_importer.dart:219` | `.mokuro` 清单 + 同级页图 |
| `importFromImageFolder` | `manga_importer.dart:81` | 一文件夹页图（无文字层） |
| `importFromMangaJson` | `manga_importer.dart:300` | 内部 `manga.json`（自研 OCR 的产物） |

前两者共用同一个**两遍式内核** `_copyAndInsert`（`manga_importer.dart:344`）：

1. **第一遍纯校验**（零副作用）：规划每页目标相对路径（sanitize + 保留子目录 + 去重 +
   防 `..` 穿越），并确认源图真的存在（`planMangaDestRels`，`manga_importer.dart:156`）；
2. **第二遍落盘**：逐页拷贝 + 写 `manga.json` + 插一行 + 写活动事件；任一步失败就
   **回滚已插的行与已建目录**（`manga_importer.dart:416-432`）。

> 为什么值得抄：两遍拆分不是为了好看。调用方必须在**建目录和问用户同名冲突之前**跑完
> 校验，否则一次注定失败的导入会先弹一个同名弹窗、再留下一个空书目录。

UI 层走 `fushi/lib/src/media/manga/manga_module.dart` 这个 facade。

**扩展名与判定**（`packages/fushi_engine/lib/media/media_extensions.dart:22`）：

- 页图基集 `kImageExtensionsBase = {.jpg .jpeg .png .webp .gif .bmp}`——这是**唯一一份**
  图片扩展名表，导入和 OCR 白名单都从它取（BUG-1121 就是因为两处各写一遍，`.bmp`
  漫画导入能收、OCR 却静默跳过）。
- 拖放白名单 `{mokuro, cbz, cbr, rar, cb7}`（`drop_classification.dart:91`）。
- `.zip` / `.epub` 是**歧义扩展名**，必须真开包看一眼内容（`looksLikeImageArchive`，
  `manga_archive_importer.dart:268`），且这一步放在后台 isolate 里
  （`image_archive_probe.dart:66`）——因为用户真的会把词典 `.zip` 拖进来。
- `.rar/.cbr/.cb7` 纯 Dart 无解，**外调 `7za`**（`manga_archive_importer.dart:107`）。

### 1.2 落盘布局

```
<appDocDir>/fushi_books/<bookKey>/
    manga.json          ← 页/文字框结构；DB 里 EpubBooks.epubPath 就是 "manga.json"
    images/
        <源子目录>/p001.jpg   ← 保留源压缩包的目录结构（不拍平）
```

DB 层面就是一行 `EpubBooks`（`manga_importer.dart:383`）：

| 列 | 漫画里的含义 |
|---|---|
| `bookKey` | 净化后的标题，**主键** |
| `epubPath` | `"manga.json"` |
| `extractDir` | 书目录绝对路径 |
| `coverPath` | 第一页页图的相对路径 |
| `chapterCount` | 页数 |
| `chaptersJson` | `'[]'` |
| `format` | `'manga'` |

在线章节另有 `chapters/<sha256(chapterKey)[:24]>/`；整卷 OCR 产物落在被扫描目录的
`manga_ocr_out/{manga.json,_pages/<引擎签名>/…}`。

### 1.3 页序

`enumerateMangaPages`（`packages/fushi_engine/lib/ocr/manga_ocr_folder_job.dart:121`）
递归到 6 层，按**相对路径自然序**排序（`naturalCompare`，`manga_ocr_folder_job.dart:77`）。
自然序的关键 tie-break：数值相等时**位数少的在前**（`p1.jpg` < `p001.jpg`），
这样比较结果是全序，页序不会在不同 ICU 版本间抖动。

> 递归深度不是常数：mokuro.moe 的卷 CBZ 顶层带一个 `<卷名>/` 目录，页图落在
> `images/<卷名>/001.jpg`（第 2 层）。旧实现只认「顶层 + 一层子目录」，整卷一页都扫不到。

### 1.4 文字层（这是漫画学习的核心资产）

`mokuro_payload.dart` 定义了唯一的内存形状 `MokuroPayload{images, ocr}`：

| 类型 | 字段 | 说明 |
|---|---|---|
| `MokuroImage` | `url` / `size` / `blocks` | `url` 是保留子目录的正斜杠相对路径 |
| `MokuroBlock` | `rectangle`(`box`) / `isVertical` / `fontSize` / `zIndex` / `lines` / `linesCoords?` / `regions?` | `lines.join('')` 是整块文本 |
| `MokuroSize` | `width` / `height` | **单元是原图像素** |
| `MangaOcrTextRegion` | `rectangle` / `utf16Start` / `utf16End` | 字符级命中框，索引 `lines.join()` |

两个生产者（外部 `.mokuro` 与自研 OCR）都产出它，`parseMokuro` 与 `parseMangaJson`
分别解析两种 JSON 键名，`mangaPayloadToJson` 序列化回 `manga.json`。

**页图根是「解析」出来的，不是常量**：`resolveMokuroPageRoot`
（`mokuro_payload.dart:178`）处理两种并存惯例——

- 惯例 A：`img_path` 自带卷名前缀（`vol1/p001.jpg`）→ 根 = `.mokuro` 同级；
- 惯例 B：卷子目录布局，`img_path` 是裸文件名 → 根 = `<卷名>/`。

BUG-1830 的根因就是三个消费方（本地导入 / 准入判定 / 远端扫描）各自把惯例 A 硬编码，
惯例 B 的卷必然报 `Missing manga page image`。修法是三处共用同一个纯函数 + 注入的
存在性探针。

### 1.5 渲染与命中测试

**不是 Flutter widget，是 `InAppWebView` 里的一层 HTML**。`manga_overlay_html.dart`（1554 行）
给每个 `MokuroBlock` 生成一个 `%` 定位的透明 `<p class="ocr-box">`：

- 字号用 `cqi`（容器查询单位），不是 `%`；
- `regions` 存在时逐字符生成 `<span class="ocr-char">`；否则由 `lines` / `lines_coords` 推导；
- 竖排靠 `writing-mode: vertical-rl`；
- **命中测试 = `document.elementsFromPoint` + 4px 容差 + 面积最小者胜**
  （`manga_overlay_html.dart:1170-1193`）。注意 `z_index` **不参与**命中判定；
- 选中后经 `fushiSelection.selectFromPosition(node, 0, 40, x, y)` → JS 通道
  `onTextSelected` → 词典。

RTL 必须**反转 DOM 顺序**，只反转输入数组是不够的。

### 1.6 自研 OCR（可选，非主干）

18 个文件约 4.1k 行：检测（PP-OCR 行检测）→ 阅读顺序排序 → 识别（ONNX Runtime 或
路由到云端/互联主机）→ 组 `MokuroPayload` 写盘。逐页断点缓存。

> **对桌面端的重要提醒**：Apple 平台上的 ONNX Runtime 被**刻意禁用**（root
> `pubspec.yaml:131-138` 的 vendored fork 专门删掉了 ios/macos 插件声明），所以
> macOS 本地漫画 OCR 在 Fushi 里是**未验证**状态。任何「桌面端也要本地 OCR」的计划
> 都要先做一个 spike。

---

## 2. 小说（EPUB）流程

### 2.1 入口与解析

四个门都收口到 `EpubImporter`（`book_import_dialog.dart:1106`、discovery 自动导入、
来源库扫描、sync）。分类器是纯函数 `classifyImportCarrier`
（`fushi/lib/src/media/import/import_carrier.dart:106-145`），`.pdf` 在文本分支**之前**
提前返回。

`packages/fushi_engine/lib/epub/epub_parser.dart`（922 行）：

- `package:archive` 的 `ZipDecoder(verify: true)` + `package:xml`；
- `container.xml` → `.opf` → `manifest` → `spine`；章节 XHTML **惰性**读取
  （`EpubChapter.lazy`，首次访问才读）；
- TOC 走 nav（EPUB3）或 NCX（EPUB2）;
- 封面三层兜底；`dc:language` 进记录。

**两条必须记住的规则**：

1. 所有 XML 查找都用 `namespace: '*'`。Calibre 产出的 `<opf:item>` 在严格命名空间
   匹配下会让**整次导入失败**。
2. zip-slip 用 `canonicalize` **校验**、但用 `normalize` **写入**——用 canonicalize 写
   会把大小写规范化掉（BUG-1218）。

### 2.2 落盘与数据

**解包一切，`.epub` 不留盘**（BUG-088；同步时按需重新打包，
`epub_repackage.dart:21`）。写到同一套 `fushi_books/<bookKey>/`。替换是
`.tmp-<ts>` → `.bak-<ts>` 的原子替换，带 copy+delete 回退。

`EpubBooks` 的主键 `bookKey = sanitizeTtuFilename(title)` 是**跨设备身份**；
v81 加的 `uid` 才是本地子表用的键。`chaptersJson` 是唯一序列化契约：
`{id, href, mediaType, characters, charCaliber}`。

阅读位置：`ReaderPositions(book_uid, section_index, norm_char_offset 0..10000, char_offset)`。
`char_offset` 默认 `-1`，**存盘时必须把 `-1` 映射成 NULL**——否则会把一个本来精确的
锚点覆盖成「无」（BUG-285）。

### 2.3 渲染

`flutter_inappwebview ^6.1.5`（Windows/Android 各有 vendored fork）。
**不起本地服务器**：拦截虚拟 host `fushi.local`（Apple 用自定义 scheme `fushi-reader`，
其它平台 `shouldInterceptRequest`）。

翻页 = CSS 多栏（`column-width` / `column-gap` / `column-fill: auto`）+ JS 赋
`scrollLeft`/`scrollTop`。`alignToPage` 有相位与 `columnGap` 容差来处理亚像素漂移
（TODO-729/753/792）。

**书写方向是用户设置，不是从书里推出来的**（默认 `vertical-rl`）。
引擎 JS 是静态/记忆化的；每次导航的变量走 JSON `ReaderEngineConfig`。

### 2.4 「点击 → 查词」的完整链路

这是两份报告的交叉点，也是你最关心的功能：

```
tap
 └─ JS 快路径 window.__fushiTapGate
     └─ fushiSelection.selectText              reader_selection_scripts.dart:1153
         ├─ getCharacterAtPoint / getCaretRange
         │     └─ 对 body 内容盒做可见性判定   (BUG-1797)
         └─ 前向扫描 ≤400 字符
             └─ buildSelectionPayload
                 └─ callHandler('onTextSelected')          :1384
                     └─ Dart onTextSelected        webview.part.dart:1984
                         └─ _handleTextSelected    lookup.part.dart:141
                             └─ _runLookupAndHighlight  reader_fushi_page.dart:4104
                                 └─ searchDictionaryResult  base_source_page.dart:314
                                     └─ appModel.searchDictionary  app_model.dart:5901
                                         └─ FushiDicts.instance.lookup  app_model.dart:6004
```

漫画那条路径在前半段不同（命中框来自 mokuro 的 `regions`/`box`），从
`dispatchMangaSelection` 之后汇入同一条。

### 2.5 弹窗的三种形态

`analysis/03` §C 考证得很清楚，桌面端相关的是：

| 平台 | 实现 |
|---|---|
| 应用内 | Flutter 浮层 + `InAppWebView` 加载 `assets/popup/popup.html` |
| **Windows（应用外）** | 原生 `WS_POPUP` HWND + 自己的 WebView2（`global_lookup_window.cpp:1076`） |
| Android | 独立 `PopupDictActivity` + 常驻 FlutterEngine 跑 `popupMain` |

**没有用 `desktop_multi_window` 插件**——Windows 那个窗口是手写原生代码。

---

## 3. 分词与词典

### 3.1 没有形态素分析器

全仓 grep `mecab|sudachi|jieba|kuromoji|vibrato` **只在文档散文里命中**，代码里没有。

真正的「分词」是**拿词典索引做最长前缀匹配**：

- Dart 侧：`JapaneseLanguage.textToWords` / `_lookupMatchedLength`
  （`japanese_language.dart:52-91`）调 `FushiDicts.lookup(maxResults: 1)`；
- 原生侧：`scan_candidates`（`native/fushidicts/fushidicts_src/scan/word_scan.cpp:52`），
  从当前位置取前 `min(scan_length, 长度)` 个**码点**（默认 16）为最长窗口，逐步缩短，
  产出由长到短的候选前缀。

`word_scan.hpp` 里那条规则值得抄下来：**禁止把切点落在两个「空格分词类字母」之间**
（拉丁/西里尔/希腊/阿拉伯/希伯来/亚美尼亚/格鲁吉亚），这样不会在单词中间切出无意义的
词头片段；CJK 汉字/假名/谚文不属于该类，所以日语逐码点切、行为不变；以空白结尾的前缀
属冗余，丢弃。

> **直接后果**：词典里没有的词**无法被分词**。这是设计取舍，不是 bug。想要真正的中文
> 分词就得引入另一套东西。

### 3.2 词典引擎是 ~10k 行的 C++23

`native/fushidicts/`，是 [Manhhao/hoshidicts](https://github.com/Manhhao/hoshidicts) 的
**深度 fork**（`native/fushidicts/UPSTREAM.md:9`），经 `dart:ffi` 暴露。它自己实现了：

- **导入**：Yomitan（zip bank）、MDX + mdd、StarDict `.ifo`、DSL；
- **落盘格式**：hash + bloom + blobs 的 `.fushidicts_2`；
- **查询**：标准化 → 去屈折 → 精确查询 → 排序 → popup JSON。

查询算法（`lookup.cpp:54-282`）：
`scan_candidates` → `text_processor::process`（NFKC / 撇号 / 谚文 / 变音符扇出）→
`Deinflector::deinflect`（深度 ≤10，带 trace）→ `query_raw`（hash.table → blobs.bin，
按**词形或读音**查）→ 按 `(expression, reading)` 去重（保留最长匹配、最少预处理步数）→
重定向别名抑制 → 频率富化 → 9 键 `partial_sort` → 截断 → pitch → zstd 物化。

**没有任何预编译二进制入库**：每个平台都从源码 CMake 构建
（Windows `CMakeLists.txt:70`、Linux `:82`、macOS Xcode 阶段、iOS
`build_fushidicts_ffi.sh:45`、Android `build.gradle:171`）。

### 3.3 去屈折数据

`fushi/assets/transforms/ja.json`（104 KB，Yomitan 格式）：

```json
{ "language": "ja",
  "conditions": { "v1": {"name":"Ichidan verb","isDictionaryForm":true,...}, ... },
  "transforms": { "-ます": { "name":"-ます", "description":"...",
      "rules": [{ "type":"suffix", "fromSuffix":"ます", "toSuffix":"",
                  "conditionsIn":["v"], "conditionsOut":["v1"] }] } } }
```

`conditions` 有 `subConditions` 树（`v5` → `v5d`/`v5s` → …），**必须递归展开**，
否则五段动词整体不去屈折。

---

## 4. 工程教训（重实现时最容易踩的）

按「重实现的代价」排序，前 10 条：

| # | 教训 | 出处 |
|---|---|---|
| 1 | mokuro 的 `img_path` 有两种目录惯例，**必须解析**而不是硬编码同级 | BUG-1830 |
| 2 | 图片扩展名表只能有一份，导入与 OCR 共用 | BUG-1121 |
| 3 | 阅读位置 `-1` 必须映射成 NULL 再存盘，否则毁掉精确锚点 | BUG-285 |
| 4 | XML 查找一律 `namespace:'*'`，否则 Calibre 的 `<opf:item>` 直接导入失败 | analysis 02 §2 |
| 5 | 漫画文字层几何必须**像素显式**：字号 = `fontSize × scale`，不能 `%`/`cqw`/`0cqi` | analysis 01 §10 |
| 6 | RTL 要反转 DOM 顺序，不是只反转输入数组 | analysis 01 §3 |
| 7 | `lines.join('')` 的 UTF-16 偏移是跨语言契约，渲染侧与词典侧都要用同一口径 | analysis 03 §C |
| 8 | zip-slip：canonicalize 校验、normalize 写入 | BUG-1218 |
| 9 | 断言筛选/可见性判定要带容差，否则 padding 带会漏出可点区域 | BUG-1797 / TODO-1285 |
| 10 | Apple 上 ONNX Runtime 被刻意禁用；别假设 macOS 能本地 OCR | root `pubspec.yaml:131-138` |

---

## 5. 对 fushi_lite 的取舍

### 5.1 继承什么

| Fushi 的做法 | fushi_lite 的做法 | 理由 |
|---|---|---|
| 漫画/小说同表同目录，靠 `format` 区分 | **同**（`BookRecord.format`） | 书架/进度/删除/封面只有一条实现 |
| 两遍式导入 + 失败回滚 | **同**（`importer.ts` 的 `rollback`） | 不留半成品书 |
| `.mokuro` / `manga.json` 文字层格式 | **同**（`core/comic/mokuro.ts`） | 直接吃现成的 mokuro 语料 |
| 自然序页序 + 位数 tie-break | **同**（`core/util/natural-sort.ts` 逐行移植） | 全序，跨平台稳定 |
| `scan_candidates` 最长匹配分词 | **同**（`core/dict/scanner.ts` 移植） | 无原生依赖，纯 TS 可测 |
| Yomitan 去屈折数据 | **同**（`data/ja-transforms.json` 直接拿来） | 数据是事实标准 |
| WebView 渲染 EPUB | **同，但用 Chromium 的 iframe** | Electron 自带，不需要 WebView 插件 |
| 文字层用 HTML 浮层 | **同** | 缩放/命中/竖排都靠 CSS 最省事 |

### 5.2 不继承什么

| Fushi 的东西 | 为什么不要 |
|---|---|
| 视频 / 番剧 / 音声 / Galgame hook / torrent / 同步 | 你的需求只要漫画 + 小说 |
| 86 张表的 Drift（schemaVersion 104，2500 行手写迁移） | 桌面单机不需要；一个 JSON 索引 + 每本一份 `book.json` 就够，且单本可恢复 |
| Riverpod + 两个 9000 行 `ChangeNotifier` 神对象 | 桌面单窗口，React state + IPC 更直接 |
| 17 个 vendored `third_party` fork | 全是移动端/Windows 视频链路的补丁 |
| 10k 行 C++23 词典引擎（CMake + FFI） | 本机没有 cmake；纯 TS 的 Yomitan + 最长匹配已经覆盖「点词查义」 |
| 应用外原生弹窗 HWND | Electron 里做一个可拖拽的浮层窗口更省事，且跨平台一致 |
| 17 种语言 i18n 生成代码（35.9 万行） | 只做中日英界面文案，手写 |

### 5.3 一句话风险提示

Fushi 的**漫画阅读器本身是 HTML/CSS/JS 写在 WebView 里的**——这正好是 Electron 的
原生能力。所以「漫画文字层 + 点击查词」在 Electron 里不但可行，而且比在 Flutter 里
更自然。真正需要自制的是**词典引擎**，而它恰好是 Fushi 整个项目里**唯一无法在 macOS
上开箱构建**的部分（缺 cmake/Xcode）。选 Electron + 纯 TS 词典是这套环境下唯一
「今天就能跑起来」的组合。
