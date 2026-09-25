![あられブック / ARaLeBook](build/icon.png)

# あられブック · ARaLeBook

> 桌面端的**漫画 + 小说**管理与阅读器，Calibre 风格。日语分词、点按弹出词卡、可选 OCR、可选 LLM 分析。

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-384%20unit%20%2B%20157%20smoke-brightgreen)](#验证)
[![Platform](https://img.shields.io/badge/platform-macOS%20arm64-lightgrey)](#已知限制)

## 名字的由来

**あられ**（阿拉蕾 / Arale）取自 [仲町あられ](https://bang-dream.com/artist/yumemita/nakamachi-arale/) ——
《BanG Dream!》企划乐队 **夢限大みゅーたいぷ** 的主唱，中文译名「仲町阿拉蕾」。
图标用的就是她的形象：金色双马尾 + 猫耳耳机。

> 本项目是**个人非商业项目**，与 Bushiroad / BanG Dream! 官方无任何关联。
> 图标使用的角色形象（仲町あられ）权利属于其原始权利方；若日后转为商业分发，
> 请自行处理授权。
>
> 图标（应用图标 + 工具栏头像）是**素材**，放在 `assets/arale-icons-v2/`：两张母图、
> 各尺寸 PNG、`icns`/`ico`、提示词与导出脚本。应用这边只负责同步、不负责生成——
> `npm run icon` 把素材拷到 `build/`（打包用）和渲染进程的品牌标记；
> `npm run icon:export` 才会用 `sips`/`iconutil` 从母图重导尺寸（仅 macOS）。
> 换成自己的图：改素材包里的母图，重跑这两条命令。

## 它是什么

一个**只做两件事**的本地阅读器：把漫画和小说管起来、读得舒服。没有云、没有账号、没有联网刮削，
所有内容都在你自己的磁盘上。

- **漫画**：CBZ / ZIP / **CBR / RAR / 7Z / CB7 / CBT** / 图片文件夹 / `.mokuro`。
  单页与双页跨页、**配对偏移 0–4**（解决「封面不该和扉页并排」）、**阅读方向 LTR/RTL**、
  缩放平移、mokuro 兼容文字层。
- **小说**：EPUB，章节导航 + 目录树 + 阅读位置记忆 + 字号/字体/行高/边距/**竖排**。
- **图片型小说**：整本都是插图/扫描页的 EPUB —— 书库里显示为小说，打开用漫画阅读器翻页。
- **查词（点击 / 划词）**：点正文里的词，或拖动框住一段文字。划词按**字符边界**精确取词，
  所以卡片上的词可以和词典里的辞书形不同（你框「食べました」，词典给「食べる」——这是对的）。
- **词卡**：可固定（同时开多张）、可改标题、可保存到这本书的**词卡夹**、可交给 LLM 分析。
  从短划到长时，当前词包含的已分析词会各占一栏。
- **文字识别（可选）**：**系统 OCR**（macOS Vision / Windows.Media.Ocr，零下载）或
  **manga-anki**（下载安装的扩展，质量更好）。识别是**串行队列**，右下角统一进度入口。
- **分词（可选）**：按当前词典给一本书切词并生成词表，可反复重新生成。
- **扩展**：体积大或平台相关的能力做成可下载安装的包（远端清单 + sha256 校验 + 流式下载）。

## 快速开始

```bash
npm install
npm run build:native          # Rust 解包器（.rar/.7z 必需）
npm run build:vision-ocr      # macOS 系统 OCR 小工具（可选）
npm run samples               # 生成示例书（仓库不存二进制资源）
npm start
```

首次使用：`文件 → 导入漫画 / 小说…`（<kbd>Cmd/Ctrl</kbd>+<kbd>O</kbd>），或直接把文件拖进窗口。

> **OCR 与 LLM 都是可选的。** 不跑 OCR，漫画就是纯图片——能看、能翻、能缩放，只是点不出词典。
> 随包已内嵌三部小词典（青空文庫熟語频率 / surasura 擬声語 / 複合語起源，共 ~1 MB），
> 首次启动自动装上，不需要你做任何事。

## 亮点

### 一套引擎无关的 OCR 协议，换来「换实现不用改应用」

三种 OCR 来源（macOS Vision、Windows.Media.Ocr、manga-anki 扩展）说**同一种 NDJSON**：

```
{"kind":"meta","engine":"…","languages":[…],"requested":[…]}
{"kind":"page","file":"…","ok":true,"width":W,"height":H,"lines":[{text,confidence,box,vertical}]}
{"kind":"probe","ok":true|false,"error":"…"}
```

排序与成块（日漫从右到左、mokuro 块语义）在应用侧的 `core/ocr/` 里做，**不在引擎里**。
于是扩展的 `runner` 就是一个进程协议，应用完全不知道它是 shell、Python 还是二进制——

> manga-anki 今天是一个 1.6 GB 的 Python 包（实测：site-packages 1077 MB + 模型 500 MB +
> 精简 CPython 47 MB，gzip 后 734 MB）。它的两个模型都是标准 PyTorch，理论上可以导出 ONNX
> 用 Rust 直接跑。届时**只需换一个归档、改一份 `extension.json`**，应用一行都不用动。
>
> 这两个归档已经能自动产出：`node vendor/ocr-manga-anki/build.mjs --target all`
> （macOS arm64 + Windows x64，各自自带解释器与依赖，装完零外部依赖）。

### 一个文字行/列 = 一个文字块（划词能对准字的前提）

mokuro 的 `block` 是**区域级**的：一个气泡、一段旁白，内部还有多行或多列。而
`manga_ocr.post_process()` 里有 `"".join(text.split())`，识别结果里的换行与空格会被全部吃掉——
「整块识别一次」拿到的是一坨没有分隔符的文字，行列结构彻底丢失。阅读器于是只能靠
`sqrt(W·H/N)` 猜这段文字排成了几行几列，猜错就是**划词高亮与文字对不上**。

所以 `scripts/ocr-bridge.py` 改成按 `comictextdetector` 给的行/列多边形**逐条裁、逐条识别**，
一个文字行/列一个 block（实测检测器本来就给了这些多边形：竖排 3 列就是 3 个 34×216 的窄高矩形）。
成块时打上 `single_line`（落盘为同名字段），几何层拿到它就直接线性映射、不再猜：

| 数据形状 | 面积推断 | 有 `single_line` |
|---|---|---|
| 竖排 40×222 / 7 字「この中だったら」 | 1 列（对） | 精确到每格 31.7px |
| 倾斜 20° 的行 / 8 字（手写体常见） | **2 行（错）** | 1 行，沿长边等分 |
| 竖排 36×98 / 5 字，字高 30 | **1 列（真值 2 列）** | 由生产者决定，不猜 |

在真实整本 171 页上量过：旧文字层是 1255 个区域块，新管线是 **2232 个文字块**；
即使有了逐行框，**仍有 206 个（9.2%）只靠面积推断会选错字**——`single_line` 就是补这一块。
端到端验证是拿真实页面派发 pointer 事件、量屏幕上高亮的矩形：8 页 70 次拖动（竖排/横排、
正向/反向、双页两侧）**全部落在期望的字符格上**。

顺带修掉一个会让人「修了个寂寞」的坑：`refine_mode=1` 会同时给出细化后的列和粗的原始块，
两者覆盖同一片像素（171 页里 23 页有）。粗框内部仍是多列，留着就照旧偏移，所以按
「至少包住 2 个别的块 + 文字字数正好是它们的拼接」把它丢掉——这是识别结果，不是启发式猜测。

### 划词是**跨方块**的（一个文字行/列一个方块 ⇒ 一句话换行就落在两块里）

既然一个文字行/列就是一个方块，**一句话只要换行、竖排只要换列，它就在两个方块里**。
所以划词不能锁在「按下时那一块」上——锚点记在起点，之后每次移动都用指针位置重新命中一块，
再把锚点到当前点之间的**所有**方块拼成一段（中间整块进来，这就是「跨矩形划词」）。

三个细节都是必需的：

- **矩形距离宽容度 24 CSS px**（`core/comic/selection.ts` 的 `SELECT_GAP_TOLERANCE_PX`）：
  行距、列距都是空白，没有宽容度就得精确压在字上，手一抖就断在空隙里，跨行根本拖不过去。
  取 **CSS** px 而不是原图像素，手感才跟屏幕一致、缩放多少都一样；指针跑到所有方块之外时
  **保持上一次落点**，不去吸附远处的块。
- **拼接处不放分隔符，并且把原文里的 `\r\n` 去掉**：日文换行本来不多一个字符，`\n` 跟着进
  词典/词卡/LLM 只会让连续匹配断掉。跨行选中「名前はまだ無い。どこで生れたかと」这种，
  取到的就是这一整串，中间没有换行。
- **指针捕获失败不能让拖动崩**：`setPointerCapture` 在指针不活跃时会抛 `NotFoundError`
  （合成事件、指针被系统取消都会踩到），现在统一走 `renderer/lib/pointer.ts` 的
  `capturePointer()`——抓不到只是收不到元素外的事件，不该变成一个未捕获异常。

验证分两层：`core/comic/selection.ts` 是纯函数，14 条单测钉住区间/偏移/去换行/宽容度；
端到端在真实 171 页漫画上派发 pointer 事件，断言**两块同时出现高亮**且取回的原文与
「两块拼接」逐字符相等（8/8），另有一条分步探针确认宽容度确实是 24px 在起作用。

### 词卡上的**子句分析**：AB 的卡要带上 A 的分析

同一句话里先分析过 A、再划到 AB 时，AB 的卡片上要能看到 A 那一栏（先短的，最后是当前词）。
这条规则在类型注释里写了很久，但旧实现**几乎永远不生效**，因为它的判据是「上下文必须逐字符
相同」——而划 A 与划 AB 的上下文本来就不一样（跨行划词之后 AB 的上下文是两块拼起来的），
重启应用后更只剩 `cards.json` 里的分析，而旧实现根本不读词卡：

```ts
if (!key.endsWith(`\u0000${context}`)) continue;   // 旧实现
```

现在判据只有一句话：**词包含**（`word.includes(candidate.word)`），上下文只用来在同一个词的
多条里选优（同一段 > 互相包含 > 更新）。几个必须一起成立的细节：

- **真相源是词卡**（`cards.json`，跨重启），会话缓存只补「分析过但还没保存」的那部分；
- **在已保存的卡上点「分析」要当场落盘**：否则答案只活在那个弹窗里，划到更长的词就带不出来；
- **卡上自己存的分析一律保留**，不再过「词包含」这道闸——卡顶部的词是**可编辑**的，用户改过词
  之后把旧分析悄悄藏起来比留着更让人困惑；
- **× 删的是「这个词的分析」**（这本书里所有卡片上的那份都删）。只删当前卡的话，包含关系
  下次打开又会把它带回来，用户看到的是「按了没用」；
- **栏可以往下长**：弹窗上限放到 88vh，单条分析不再各自滚动（一栏一个小滚动条会让人以为
  到底了，而下面其实还有别的分析）。

验证：`core/cards/analyses.ts` 是纯函数，11 条单测钉住包含/去重/优劣/顺序/空词/副本；
端到端用**本地桩模型**（`POST /v1/chat/completions` 的 20 行 Node 服务，本地服务不需要 key）
走完整链路——点文字块 → 保存词卡 → 点分析 → 断言弹窗里有模型输出、**`cards.json` 里也写进去了**；
再建一张 `前缀+那个词+后缀` 的卡从词卡夹打开，断言 A 的那一栏连正文一起被带出来；最后验证
在 AB 的卡上点 × 之后，A 自己的卡上也删掉了、关掉重开不会再回来。

### 系统 OCR 会先自检再报「可用」
macOS 的 `.accurate` 走系统的 `TextRecognition` 框架，依赖**按需下载**的识别资源；资源缺失时
`perform` 抛的是一句毫无信息量的 `Foundation._GenericObjCError 0`，而 `.fast` 仍然"能用"却
只会吐垃圾。所以引擎在 `status()` 时先跑一次 32×32 空白图的自检（约 50 ms），把
「171 页每一页都失败」提前到用户点按钮之前说清楚。

### 扩展：三条不可妥协的规则

**只允许 https**、**sha256 必填且校验不过就丢弃**、**流式落盘**（归档在 700 MB 级别）。
安装是「先落 `.staging`，最后一步 rename」——半成品是最糟的失败方式：界面会显示「已安装」，
启动 runner 时才发现缺文件。扩展**自己声明怎么跑**，runner 路径在安装时校验必须落在安装目录内，
所以清单被篡改也无法让应用执行系统上别处的可执行文件。

### 小数据内嵌、大数据下载

判断标准只有一条：**「离线可用的价值 ÷ 安装包体积」**。

| 内嵌（共 ~1 MB） | 走扩展下载 |
|---|---|
| 日语变形表 103 KB（没它「食べました→食べる」全查不到） | JMdict 各语言 15–35 MB |
| 异体字表 29 KB / 2122 条（`神`/`髙` NFKC 不折，不内嵌就是「词典明明有、点上去查不到」） | Jitendex 37 MB |
| 青空文庫熟語 878 KB / **169,623 条频率** | KANJIDIC 各语言 5 MB |
| surasura 擬声語 102 KB / 1422 条 | Pixiv 30 MB / Nico-Pixiv 55 MB |

### 设置是**默认值**，阅读时按书覆盖

设置页里的阅读器选项与 OCR 引擎是「新开一本书应该长什么样」；阅读器里改的写进
**按书覆盖**层，`effective = 默认 ∪ 本书覆盖`。同一本书每次打开都是你上次调好的样子，
而调它不会改掉默认值。

### 写下来的每个决定都带「为什么」

`src/**` 里的注释不解释「这行在做什么」，而是解释**为什么必须这么做**。踩过的坑都记在原地：

- 表头 `setPointerCapture` 会吃掉按钮的 `click`（× 点了没反应的根因）
- 划词高亮用原图绝对坐标渲染在方块内部 → 被 `overflow:hidden` 整片裁掉（DOM 在、看不见）
- 反向拖动区间不排序 → 一个字都不高亮
- 用 `block.lines` 当行列结构 → 竖排多列退化成按 y 线性取字
- 划词按「光标下那个字」取端点 → 总是多一个字（改成按**字符边界**）
- 频率词典只有 `term_meta_bank`、没有 `term_bank` → 旧导入器一律拒绝，于是**根本装不进去**

## 项目结构

```text
src/
├── core/              纯 TypeScript，不 import electron，可脱离 Electron 单测
│   ├── epub/          zip 读取、OPF/spine/nav 解析、纯文本抽取、图片型小说判据
│   ├── comic/         页枚举与自然序、mokuro/manga.json、双页配对、划词几何与跨方块选区
│   ├── cards/         词卡上的子句分析收集（A ⊆ AB 的包含、去重、顺序）
│   ├── dict/          归一化、异体字折叠、去屈折、扫描分词、Yomitan 导入
│   ├── ocr/           阅读顺序（三级）、成块 —— 引擎无关的那一半
│   ├── segment/       按单元切词与词表统计
│   └── util/          自然序、路径净化、原子 JSON、id
├── main/              Electron 主进程
│   ├── library/       store（索引 + 进度）、importer（两遍式 + 回滚）、cards（词卡）
│   ├── reader/        arale:// 协议、章节净化与桥接注入、内容服务
│   ├── ocr/           串行队列编排 + system / extension 两个引擎 + 统一 runner
│   ├── extensions/    清单、下载器（sha256 + 流式）、安装/卸载
│   ├── dict/          词典服务 + 随包内嵌词典安装
│   ├── llm/           chat completions 客户端（key 只进不出）
│   └── segment/       分词编排
├── preload/           contextBridge 暴露 window.arale
└── renderer/          React UI
    ├── views/         LibraryView / ReaderView / SegmentView
    ├── reader/        EpubReader / ComicReader / ComicTextLayer
    ├── dict/          词卡弹窗、词卡夹、状态中枢
    └── components/    工具栏、侧栏、书库网格、设置面板、扩展/LLM 卡片

native/
├── arale-native/       Rust 解包器（zip / rar RAR4+RAR5 / 7z / tar，流式）
├── arale-vision-ocr/   macOS 系统 OCR（Swift + Vision）
└── arale-winrt-ocr.ps1 Windows 系统 OCR（PowerShell + Windows.Media.Ocr）

scripts/ocr-bridge.py   manga-anki 管线的桥（NDJSON over stdout）
vendor/ocr-manga-anki/  **生成物**（gitignore）：build.mjs 打进度的 macOS/Windows 归档

assets/arale-icons-v2/  图标素材包（母图 + 各尺寸 PNG + icns/ico + 提示词）
build/                  图标导出件（`npm run icon` 生成）：icon.icns / icon.png / icon.ico
```

`core/**` 不碰 `electron`，所以解析、分词、去屈折、排序、划词几何全都能在纯 Node 里测；
`main/**` 只在函数体内用 `electron`（`paths.ts` / `events.ts` 延迟 `require`），
所以导入管线与 OCR 队列也能在纯 Node 里跑端到端测试。

## 验证

```bash
npm run typecheck        # main / renderer / test 三份类型检查
npm test                 # 348 单测（28 个文件）
npm run test:native      # Rust 解包器自己的 50 项单测
npm run smoke            # 147 项 GUI 端到端检查（起真 Electron）
ARALE_SMOKE_OCR=1 npm run smoke   # 额外打开真 OCR 用例
```

| 层 | 规模 |
|---|---|
| TypeScript / TSX | 21,579 行 / 87 个文件 |
| Rust | 2,669 行 |
| Swift + PowerShell | 534 行 |
| 测试 | 348 单测 + 147 项 GUI 冒烟 + 50 项 Rust |

漫画划词的命中与选区几何被抽成纯函数（`core/comic/text-geometry.ts`）并配了 20 条单测，
把竖排单列/多列、横排、字符边界、「高亮必须落在方块内」这些**只在特定数据形状下才错**的
情况逐个钉死——这一类问题靠 GUI 冒烟完全盖不住（DOM 节点在、屏幕上什么都看不见）。

## 已知限制

- **只验证了 macOS arm64**。Windows 的 `arale-winrt-ocr.ps1` 写好但**没在 Windows 上跑过**。
- **系统 OCR 在 macOS 上可能不可用**：`.accurate` 依赖系统按需下载的文字识别资源，
  开发机上实测就遇到了（自检会明确报出来，不会让你白跑一本）。
- **manga-anki 扩展的归档尚未发布**：随包清单里的条目是占位 sha256，安装会明确失败在校验那一步。
- `.zip` / `.cbz` 整体读入内存，单个 >2 GB 的包会被拒绝（`.rar`/`.7z` 走流式，无此限制）。
- 词典只支持 Yomitan 格式；MDX / StarDict / DSL 未实现。`kanji_bank` 不读（v1 只做词语查询）。
- 漫画 OCR 的准确率还不够：内置通用检测器在真实漫画上逐行命中约 23%，
  所以质量要靠 manga-anki 那套漫画专用管线。
- 左侧栏的「系列 / 作者」分面目前共用同一个 `search` 字段，所以天然只能单选，
  且选中后看起来像在搜索框里打了字。要真正的多选需要独立的 `{kind, value}` 过滤字段。
- 没有云同步、没有联网元数据刮削、单窗口。

## 许可与出处

本项目 GPL-3.0。**流程设计**参考自 Fushi（GPL-3.0），`docs/analysis/` 里是逐条对照的阅读笔记。

- `data/ja-transforms.json` 是 [Yomitan](https://github.com/yomitan/yomitan) 的日语去屈折数据（BSD-3-Clause）。
- `data/kanji-variants.json` 由 `scripts/make-kanji-variants.mjs` 从 yomidevs/kanji-processor（MIT）生成。
- `resources/dictionaries/` 内嵌的三部词典来自 [MarvNC/yomitan-dictionaries](https://github.com/MarvNC/yomitan-dictionaries)，
  各自许可见 `resources/dictionaries/manifest.json`。
- 本仓库不含任何词典正文以外的第三方数据；用户词典请自行安装。
- 图标所含角色形象见上文「名字的由来」的授权提醒。
