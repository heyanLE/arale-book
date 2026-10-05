# Tauri 迁移

核对日期：2026-10-05。目标是 React/TypeScript 界面 + Tauri 2/Rust 后台，用户运行包不携带 Node.js 或 Electron。Node.js 仍用于开发时的 Vite、TypeScript 和测试。目前应用只使用 Tauri，旧框架代码与入口已删除；安装后的系统集成仍待验收。

## 仅保留 Tauri 与界面整理（2026-10-05）

同日最新沉浸重构：Windows 无边框窗口精确覆盖显示器，关闭 Tao 阴影内边距；系统栏按钮通过自己的 HWND 全屏标记及 NonRudeHWND 控制任务栏覆盖，不调整窗口/客户区。macOS 接入当前 Space 的 simple fullscreen 与 NSApplication presentation options，未运行验收。批注单一工具状态，延迟自动建层并与首份内容一起撤销，直接选择移动、明确擦除目标、鼠标图标提交草稿恢复阅读；沉浸按钮统一纯图标并修正悬停。`node node_modules/typescript/bin/tsc -p tsconfig.renderer.json --noEmit`、`tsconfig.test.json --noEmit`、`ARALE_TAURI_BUILD=1` 的 Vite 构建、`cargo check/build/test --manifest-path src-tauri/Cargo.toml --offline` 通过，Rust 34/34；Windows 宿主 Node 22.19.0 的 `node scripts/smoke-tauri.mjs` 192/192 通过。GUI 原生查询确认任务栏的前后覆盖、窗口与客户区整屏及退出恢复，DOM 验证草稿/焦点/组合键及工具事务；未实际操作中英/A／あ模式、其他平台、多显示器/不同 DPI，未重打 release/NSIS。旧“文字编辑自动最大化”方案已替换。见 [跨平台方案](reader-annotations.md)。

同日最新阅读/制卡修正：设置按来源返回，书库保留空详情面板，划词先显示确认按钮；制卡恢复优先未完成任务、重建回第一步、续跑与全量生成分开；Windows 任务目录转换普通 Shell 路径并直接打开。最新 debug 构建、Node 405 通过/1 跳过、Rust 34/34、WebView2 172/172，通过实际资源管理器窗口确认任务目录打开；本轮没有重打 release/NSIS。详见 [交互状态](anki-filter-ux.md#当前阶段恢复与重建2026-10-05)，下方包大小属于之前的产物。

Windows 11；共享测试/类型检查使用 Node 24.19.0，宿主外的真实 GUI/打包使用 Node 22.19.0：删除 `src/main/`、`src/preload/`、旧构建配置、Electron 依赖和专用脚本。共享业务仍用于 Tauri Worker；Node 测试端口位于 `tests/support/`，不打入应用。Kuromoji 作为明确依赖保留，SQL.js 和 7z 夹具工具仅用于开发测试。`npm start/build/pack` 均指向 Tauri，README 修订现有框架、运行和平台说明，没有追加功能章节。identifier 不变，防止换成空书库。

界面整理覆盖书库标题/作者/卷号展示、隐藏无选择的详情栏、优先阅读操作、统一 SVG 图标/尺寸/对比度、设置分组导航、词卡搜索及页/章筛选、不可用引擎提示，以及 Anki 各步骤分类、证据预览、字段问题突出显示和确认/暂缓后进入下一张。外部 AI 生成在应用临时目录，逐批复制提示词；图层按页预览及跳转；沉浸文字失焦保留草稿，恢复窗口焦点后继续编辑，组合输入不误触完成。

同日后续反馈：首页和阅读器恢复旧按钮风格，取消选中态底部横线；阅读器排版与 OCR 恢复直接显示，底部按钮/下拉统一 24px。设置导航并入“重置界面偏好”所在标题栏；移除词卡局部命中说明，修正明鏡纯文本释义换行，LLM 分栏支持安全的 Markdown。简体中文界面字体改为中文优先，本机实测 Microsoft YaHei UI。renderer 类型检查、Vite、`node scripts/test.mjs` 404 通过/1 跳过、`cargo build --manifest-path src-tauri/Cargo.toml`、WebView2 `node scripts/smoke-tauri.mjs` 161/161 通过；本轮未改 Rust 逻辑、未重跑 Rust 单测。`node scripts/tauri.mjs pack` 最新 EXE 29,412,864 字节，NSIS 21,428,398 字节（20.44 MiB）；截图 `.tmp/ui-style-review-2026-10-05/` 已检查。平台/Node 版本沿用本节说明；未验证其他平台、不同 DPI 和实际安装/卸载。下方为此前同日的完整整理验证记录。

验证：

- `node node_modules/typescript/bin/tsc -p tsconfig.renderer.json --noEmit`、`tsconfig.test.json --noEmit` 和 Vite 构建通过。
- `node scripts/test.mjs`：403 项，402 通过、1 跳过、0 失败；已清除旧编译测试，计数不包含退役的 Electron 测试。
- `cargo test --manifest-path src-tauri/Cargo.toml`：33/33。服务/OCR/制卡适配器 `test-tauri-services.mjs`、`test-tauri-ocr.mjs`、`test-tauri-study.mjs`：分别 6/3/5 项通过。
- `cargo build --manifest-path src-tauri/Cargo.toml` + `node scripts/smoke-tauri.mjs`：隔离真实 WebView2 GUI/Node 对照 160/160，含沉浸文字失焦/恢复焦点、组合输入、图层预览、自动任务目录，以及原生 APKG 字段原始字节检查。最后的导航文案/证据 HTML 展示另经重编译后的真实 GUI 检查；暂缓一张卡后待核对/可导出均为 0、暂缓为 1，确认后可导出恢复 1，分类数量没有重复计入。
- WebView2/CDP 截图检查 1440×900、1024×640 和深色主题的书库、详情、设置、阅读器图层、Anki 审核及外部 AI 批次。截图在忽略目录 `.tmp/ui-verification-2026-10-05/`，没有页面横向溢出或错误横幅。
- `node scripts/tauri.mjs pack`：release 和 NSIS 构建通过。EXE 29,374,464 字节（28.01 MiB），`ARaLeBook_0.1.0_x64-setup.exe` 21,389,772 字节（20.40 MiB）；包不包含 Node.js/Electron。尚未实际安装/卸载。
- 正式版运行后只读核对本机原数据：15 本书、4 部词典（87,073 条）、93 张词卡；没有错误横幅，制卡与 OCR 队列均无活动任务。
- 只读检查用户桌面旧 APKG：124 条笔记各 1 字段，模型要求 12；官方 Anki 26.9.3 复现相同错误。相同输入 SQL.js 会截断，原生 SQLite 保留 12 字段；真实 Tauri smoke 导出包通过 Windows 官方 Anki 导入核心。未修改模板、ID 或导出生成规则，说明见 [导入分析](anki-harness.md)。

未验证：AnkiDroid 真机导入、真实 Windows 输入法选择面板/多显示器/不同 DPI、真实外部 AI 语义质量、macOS/Linux 当前版本运行、干净机器依赖、安装/卸载与安装后文件关联。本轮输入法验证使用真实 WebView2 中的合成失焦/焦点/组合键事件，不能视作系统输入法面板验收。

## 当前范围

`src-tauri/` 是原生 Rust 后台，复用 React 界面与共享业务编排。`node scripts/tauri.mjs dev`（或 `npm start`）构建并启动当前应用，`node scripts/tauri.mjs pack` 生成 Tauri 安装包。

| 功能 | 当前 Tauri 状态 |
|---|---|
| 窗口、IPC、事件订阅、全屏 | 已接入；原生拖放、命令行文件接入同一事件桥接 |
| 书库列表、搜索、标签、元数据、阅读位置 | Rust JSON 存储；结构字段不接受 UI 修改 |
| 漫画 ZIP/CBZ、RAR/CBR、7Z/CB7、TAR/CBT | 直接链接现有 Rust 解包库；GUI 已验证 CBZ，其他格式尚无完整 Tauri 导入 GUI 验证 |
| 图片/文件夹、mokuro 清单 | Rust 导入、自然页序、尺寸、ASCII 路径和文字层重映射；目录有单测，系统选择窗口/手动拖放未验收 |
| 漫画阅读、已有文字层 | 复用 ComicReader；`arale` 图片协议已运行，拒绝越界及非图片资源 |
| 词卡存储 | 按书读取/新增/编辑/删除、去重和来源保存接入；查词 Worker 已接入原词卡弹窗 |
| 批注 | Rust 校验、原子保存、revision 冲突、原图 SHA 与失配保护；真实 UI 画笔建层并自动保存已验证 |
| EPUB | 已接入 `.epub` ZIP 导入、OPF/container/nav/NCX、章节清洗/排版、图片/字体、目录/键盘/链接跳转、点词/划词与进度；图片型 EPUB 使用漫画阅读器 |
| 手动词典、查词 | Rust 导入 Yomitan ZIP、管理启用/删除；Worker 复用行解析、索引、去屈折、异体字、读音、词频，返回前清洗释义 HTML。预览不自动安装词典 |
| Kuromoji、漫画/EPUB 整书分词 | Worker 使用原 Kuromoji/IPADIC，复用 UTF-16 映射/词表；进度、取消、清除、源文本指纹校验及原子产物保存已接入；EPUB 一个 spine 项一个单元 |
| 翻译/LLM | Rust 保存密钥与 HTTP；独立 Worker 复用六提供商协议、原提示词、缓存用量、结构化返回/降级与截断文本；真实词卡按钮已验证 |
| OCR/扩展 | Rust 书级 FIFO/NDJSON/进程树取消；Worker 复用原成块与排序，支持漫画和图片型 EPUB；JSONL 仓库/流式 HTTPS/大小与 SHA/安装恢复/使用保护已接入 |
| Anki Harness | 独立 study Worker 复用候选/F/A/预算/截断恢复/自行 AI；Rust 保存、文件选择、截图与原生 SQLite APKG；切换页面继续，刷新或应用退出后手动续跑检查点 |
| 原生菜单、系统文件管理器定位 | 已接入文件/编辑/视图/阅读/帮助菜单；书目录按 ID 校验后调用系统定位；Windows 范围见第七阶段验证 |
| 文件关联 | 已配置 EPUB、CBZ/CBR/CB7/CBT、Mokuro；需要安装包注册，开发启动不注册 |

顶部常驻迁移提示和面向用户的旧书库迁入功能已移除。Anki 制卡、原生菜单已接入；安装后的系统验收尚未完成。可以手动导入 Yomitan ZIP，新用户直接使用当前版本的数据目录；本机现有开发数据已一次性复制，应用没有自动复制旧书库、密钥或扩展的逻辑。

## 数据隔离

identifier 为 `com.aralebook.tauri.preview`，使用 Tauri `app_data_dir()`；Windows 通常是 `%APPDATA%\com.aralebook.tauri.preview\`，以运行界面显示的书库目录为准。原 Electron 数据根仍保留，应用不自动读取它；本机现有数据已按用户授权一次性复制到 Tauri 根，详见下方记录。

沿用 `library/index.json`、每书 `book.json`/`cards.json`/`comic-annotations.json`、`segments.json`、`study-list.json` 与 `positions.json` 布局。没有面向用户的旧版迁入设置、IPC/Worker/事务或启动恢复逻辑；新用户直接导入书籍并使用当前数据根。WebView 不自动继承 Electron localStorage 偏好。

仅 debug 构建接受 `ARALE_TAURI_USERDATA`。GUI smoke 使用 `.tmp/tauri-smoke-*/userdata`；release 不注册测试命令/注入脚本，也不接受该目录覆盖。损坏 JSON 报错并保留原文件；原子写在同目录生成临时文件并替换，失败不先删除旧文件。

## 命令与代码

Windows 需要 Rust/MSVC 和 WebView2，先安装主仓库 Node 依赖：

```powershell
node scripts/tauri.mjs dev     # Vite build + cargo run，真实预览，不提供 HMR
node scripts/tauri.mjs check   # Rust 检查
node scripts/tauri.mjs test    # Rust 后台测试
node scripts/tauri.mjs build   # Vite build + cargo build --release，仅生成程序
node scripts/smoke-tauri.mjs   # 先 cargo build；Windows 隔离 GUI 测试
node scripts/test-tauri-services.mjs # 浏览器服务适配器测试
node scripts/test-tauri-ocr.mjs # 浏览器 OCR 转换适配器测试
node scripts/test-tauri-study.mjs # 浏览器制卡适配器的失败/取消/保存顺序测试
$env:ARALE_TAURI_SMOKE_OCR='1'; node scripts/smoke-tauri.mjs # 再验真实开发包 Python/ORT
```

对应 npm 命令为 `tauri:dev/check/test/build/smoke` 和 `tauri:services:test/ocr:test/study:test`。安装包命令 `node scripts/tauri.mjs pack` / `npm run tauri:pack` 需要官方 CLI：`cargo install tauri-cli --locked`；也可安装到项目内：`cargo install tauri-cli --locked --root .tmp/tauri-cli`，脚本优先使用该目录的 CLI。若系统临时目录不稳定，先设置 `$env:CARGO_TARGET_DIR = Join-Path (Get-Location) '.tmp/tauri-cli-target'`，安装后 `Remove-Item Env:CARGO_TARGET_DIR`，避免影响应用构建产物位置。Windows 配置 NSIS + `downloadBootstrapper`，缺少 WebView2 时在线安装；不把整个运行时、Node、OCR 或 `.tmp` 打入包。最新构建结果见本机一次性迁移记录；构建成功不等于实际安装/卸载通过。

- `shared/api-bridge.ts`：Electron preload 与 Tauri 共用完整 AraleApi 方法映射。
- `renderer/lib/tauri-bridge.ts`：安装 transport，原生事件监听就绪后挂载 UI；保留数字订阅号，原生拖放直接提供路径，浏览器 File 不伪造磁盘路径。
- `src-tauri/src/lib.rs`：IPC、单实例、通知、图片/独立 EPUB 协议、能力快照；IO 在后台线程执行，存储锁串行化操作。
- `src-tauri/src/system.rs`：原生菜单、外部路径归一化、书目录定位；翻页方向键保留阅读器处理，避免全局菜单抢占输入框或右翻漫画方向。
- `storage.rs`/`importer.rs`/`cards.rs`/`annotations.rs`：JSON/书库、导入、词卡、批注。
- `ocr.rs`/`extensions.rs` 与 `renderer/lib/tauri-ocr.ts`：原生识别队列、扩展安装事务和共享文字层转换。
- `native/arale-native/src/lib.rs`：复用解包实现，原 CLI 仍保留。

## 后续顺序

1. **词典/形态分析**：已接入手动词典及漫画分词；大型 Jitendex 的内存/IPC 压力、词典 IO 锁粒度和中途重载任务的恢复仍需后续验证。保持同一分词算法，暂不换 Rust 分词器。
2. **EPUB**：本轮已接入，Windows 范围见下。大型/非标准书、其他压缩容器、旧书库迁入和跨平台来源隔离仍需验证。
3. **翻译/LLM**：已接入，范围及测试见第四阶段。提示词/提供商协议与 Electron 共用；完整 Anki 编排与导出已在第六阶段接入，见本页最新验证。
4. **OCR/扩展**：已接入，Windows 范围见第五阶段；Rust 启动现有 Python/系统工具，不重写引擎 submodule/Python/ORT。真实远程正式包下载、代理/PAC、全书压力及跨平台仍待专项验收。
5. **Anki**：候选/检查点/跨视图任务、自行 AI 文件、预算/修复、截图和 SQLite/APKG。做新旧对照并保留旧进度兼容。
6. **切换/发布**：不保留面向用户的旧版迁入功能，本机数据已一次性复制并校验。后续验收安装/卸载、文件关联、全流程稳定性和偏好；关键流程通过后切换默认入口、移除 Electron 依赖，再验收 macOS/Linux。

## 系统集成与外部文件

菜单通过原有 `shell:command` 交给共享 React 阅读器；全屏直接操作原生窗口。Windows 撤销/重做使用固定 WebView 脚本，文本控件执行文本撤销，阅读区沿用批注快捷键；Ctrl+Z 本身继续由控件/阅读器处理。开发者工具只在 debug 菜单显示。

首次启动和第二实例都按各自启动目录解析相对文件，支持空格、中文、日文与 `--` 后的字面文件名，过滤不存在路径并去重；导入格式校验仍由原导入器完成。渲染器就绪前或刷新中暂存路径，恢复后发送。`shell:openFiles` 改由 App 接收，阅读、设置、分词页打开时也可导入，当前阅读保持不跳转。原生拖放使用同一接收者。

“在文件夹中显示”只接受书 ID，忽略书记录里可伪造的 `dir`；canonical 路径须位于当前书库。Windows 使用 [SHOpenFolderAndSelectItems](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shopenfolderandselectitems) 打开父目录并选中书目录，不拼接 Explorer 命令行。macOS 保留 `open -R`，Linux 打开书目录，其他平台未运行验收。

按 [Tauri 文件关联配置](https://v2.tauri.app/reference/config/#fileassociation) 声明专用书籍/文字层扩展；通用 ZIP/RAR/JSON/图片仍可手动导入。仅打包或开发运行不会更改本机注册表；安装后的关联和双击流程仍需实际验收。

预览的 ProgID 使用 `ARaLeBook.TauriPreview.Epub/Comic/Mokuro`。CLI 2.12.1 生成的 NSIS 关联命令只给 `%1` 加引号，程序路径没有引号；`nsis-hooks.nsh` 在注册后为本预览的三类命令与图标路径补齐引号，兼容安装目录空格，保留官方关联备份/卸载逻辑。安装脚本已构建并静态核对，尚未以真实注册表验收。

Windows JSON 原子替换遇到错误 5/32/33 时，以 25/50/100/200/400 毫秒有界重试同一临时文件，不预先删除旧文件；持续占用仍返回失败。该处理适用于制卡检查点等现有 JSON 保存，不改变后台失败状态与手动恢复规则。

## 本机一次性迁移（2026-10-05）

平台：Windows 11 x64 / Node 24.19.0 / rustc 1.96.0。项目尚未发布，用户要求一次性处理本机数据，不保留面向用户的旧版兼容迁入功能。已删除 `MigrationCard`、迁入 IPC/Worker/类型、Rust 模块/启动恢复、专用脚本/夹具和 npm 命令；原书籍导入与 EPUB 阅读缓存准备逻辑保留。

**首次复制的环境问题已修正。** Codex 的 MSIX 宿主将 AppData 写入重定向到 `%LOCALAPPDATA%\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Roaming`。普通目录读取能看到混合视图，但用户从桌面正常启动的 Tauri 仍读到空书库；词典根 canonicalize 到真实目录、子目录 canonicalize 到影子目录，导致“路径越界”。并非词典格式或安全检查失效，不应放宽路径保护。该行为参见 [微软 MSIX 运行与虚拟化说明](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes)。

2026-10-05 使用 `\\localhost\C$\Users\eke_l\AppData\Roaming` 的本机物理视图确认：旧根有 15 本漫画（无 EPUB）、4 部词典，真实 Tauri 目标为空。该路径只用于本次已授权操作，不进入应用或发布配置；书籍 dir 仍写正常的 `C:\Users\eke_l\AppData\Roaming\com.aralebook.tauri.preview`。完成逐文件校验后，将错误影子根另改名备份，避免其继续遮盖真实目录。正常关闭当前应用后，使用忽略的 `.tmp/` 一次性工具复制到同盘暂存、逐文件核对 SHA/大小、重绑定 book/index 的 dir、合并阅读位置并复核源文件；将原目标改名备份后发布完整暂存根。旧根不写入、不删除，原目标备份为 `com.aralebook.tauri.preview.backup-<uuid>`。没有修改运行时数据根，也没有自动迁入逻辑。

结果：3064 文件，2,276,547,903 字节，15 本书、4 部词典、93 张词卡、3 本批注、2 本分词、制卡记录与 4 个阅读位置保留；复制现有 `settings.json`、`llm.json`、`translation.json`、LLM 能力记录，密钥未输出日志。未搬迁 Electron 浏览器缓存/localStorage；旧目录只有扩展仓库/暂存，没有已安装 OCR 扩展，不复制这些暂存内容。

早先临时 Rust 只读校验（已从源码移除）验证了复制视图的内容，未发现宿主虚拟化，不能证明真实目录已迁移。修正后的物理复制报告为 `.tmp/current-pc-library-physical-migration-report.json`，源文件复核未变；真实空目标备份后缀 `abcfa9e7-a417-4e27-9fee-ac5f816e74f2`，错误影子根备份后缀 `a3f54ad1-6260-4d59-a425-02ed61849e4c`。本次旧数据没有 EPUB，未执行旧 EPUB 一次性迁入验证。

Windows 11 x64、2026-10-05：`.tmp/verify-release-library.mjs` 通过 WebView2/CDP 读取当前 release 的真实界面和 IPC，实测书库接口/DOM 各 15 本、15 个封面解码成功、词典 Worker 已载入 4 部（87,073 条词条）、93 张词卡可读、无错误横幅；截图 `.tmp/release-real-library.png` 已检查，报告 `.tmp/release-real-library-report.json`。临时 debug 诊断也通过相同四项检查，随后还原原诊断入口并重新 `cargo build --manifest-path src-tauri/Cargo.toml`。只修正本机数据和文档，没有修改应用逻辑、放宽路径保护或重打安装包；不调用付费 LLM/翻译。

验证（同平台、2026-10-05）：main/renderer 类型检查与 Tauri Vite 构建通过；`cargo test --manifest-path src-tauri/Cargo.toml` **32/32**，`cargo build` 通过；移除专用迁入测试后剩余原测试全部通过。`node scripts/smoke-tauri.mjs` **155/155**，隔离书库验证原菜单/第二实例、词典/分词/漫画/EPUB、制卡/导出/HTTP/OCR 及 Node 对照，5 份系统/测试 OCR 产物一致。默认未重跑真实 Python/ORT；本轮没有修改共享核心规则，未重跑 Node 核心/适配器单测。临时实际数据只读校验首次断言将词典 IPC 字符串当成数组，改为按原契约 JSON 解析后通过，没有为此修改应用契约。

`node scripts/tauri.mjs pack` 完成 release/NSIS，退出码 0。最新版 release EXE **29,358,592 字节（28.00 MiB）**；NSIS **21,374,847 字节（20.38 MiB）**，SHA-256 `b869b69cf591e37e289ecf9c9e335d5dbeef970726a38621ac98335482c7a12e`。7-Zip `t` 与主 EXE 提取通过，归一化官方 NSIS bundle 标记后包内 EXE 与 release 逐字节一致。安装包未包含个人书库/密钥，数据只在本机 AppData；未运行 NSIS 安装/卸载或更改文件关联。

日志 `.tmp/tauri-local-library-{vite,rust,debug,gui,pack,package-test,package-extract}.log`；真实数据报告与只读校验日志见上。本次已补正式版真实书库显示/词典载入验证；仍未验证：真实漫画逐页人工阅读、干净 Windows/其他平台、安装/卸载与安装后关联。默认 Electron 开发入口仍保留，启动 Tauri 使用 `node scripts/tauri.mjs dev` 或本轮重新构建的 release EXE；无需再点旧版迁入按钮。

## 第八阶段验证（2026-10-05）

**历史范围：本节描述此前临时实现的旧书库迁入入口；该功能现已按用户要求撤除。计数、文件和包体积只对应当时产物，不能作为当前结构依据。**

后续界面调整（Windows 11 x64，2026-10-05）：移除 App 顶部常驻「Tauri 迁移预览…」提示及对应样式，smoke 就绪判断改为实际 `.app` 根节点。renderer 类型检查、Tauri Vite 构建与 debug 构建通过；未新增或重跑整套 GUI/核心测试。当前正在运行的 release 使用编译时嵌入页面，需要关闭窗口后启动重新构建的 debug（`node scripts/tauri.mjs dev`）才能看到变化；本次未覆盖运行中的 release EXE 或重打 NSIS。数据目录保持隔离，旧书库需在设置页手动迁入。下方包大小和完整验收计数对应本界面调整前的第八阶段产物。

平台：Windows 11 x64 / Node 24.19.0 / rustc 1.96.0 / Tauri CLI 2.12.1 / WebView2 154.0.4258.53。

- `node node_modules/typescript/bin/tsc -p tsconfig.main.json --noEmit`、renderer `--noEmit` 与 test 编译通过。
- `node --test --test-concurrency=1 "dist-test/tests/*.test.js"`：541 项，536 通过、5 跳过、0 失败。
- `cargo test --manifest-path src-tauri/Cargo.toml`：41/41，新增 9 项迁入测试。包括源/目标路径和 sidecar 保留、重复跳过、源文件及进度变化、损坏索引/路径越界/目录重叠、Windows junction、索引持续占用的发布回滚、未提交/已提交 journal 的启动恢复，以及外部修改/标记不符时保留恢复记录。原 EPUB 导入/读取测试继续通过。
- `node scripts/test-tauri-migration.mjs`：4/4，纯浏览器 bundle 验证缓存清洗/原路径/缺章占位、全部 EPUB 处理后才发布、四个失败点清理及清理失败不掩盖原错误。`test-tauri-services.mjs`、`test-tauri-study.mjs`、`test-tauri-ocr.mjs`：6/5/3 项全部通过。
- Tauri Vite 生产构建、`cargo build` 通过。`node scripts/smoke-tauri.mjs`：最终 **168/168**，退出码 0。设置页迁入旧漫画、文本 EPUB、图片型 EPUB 与词典；词卡 ID/来源/注释、批注 revision/页图 SHA、阅读位置与图片路径保留；即时查词、重复全跳过、旧 EPUB 缓存清洗和实际打开、界面刷新后保留通过。Node 校验源目录所有文件 SHA 完全不变，四种学习 sidecar 字节一致，目标密钥/扩展未被旧数据替换；迁入词典查词与原 Node 一致。
- 原菜单/第二实例、词典/分词/Anki/HTTP/OCR 对照继续通过。默认 smoke 未重跑真实 Python/ORT，5 份系统/测试 OCR 产物一致。旧查词证据按捕获时的词典 ID 快照构建 Node 索引，新增迁入词典另行对照，避免新词典改变 dictionaryCount 干扰旧证据。
- 首次 GUI 夹具在准备跨刷新测试的 OCR 运行期间迁入，被任务保护拒绝；调整为先迁入后启动该 OCR。旧目录生成改用共享 ZIP 归一化结果，避免夹具中文/百分号章节路径与元数据不一致。最终全流程通过。
- Electron renderer 单独输出至 `.tmp/electron-renderer-check` 的 Vite 构建通过，避免影响 Cargo 嵌入的 Tauri renderer；本轮未重新运行 Electron GUI。
- `node scripts/tauri.mjs pack` 使用项目内官方 CLI 与 NSIS 缓存，在允许访问工具缓存的进程中一次完成 release/NSIS，退出码 0。release EXE **29,511,680 字节（28.14 MiB）**；NSIS `src-tauri/target/release/bundle/nsis/ARaLeBook Tauri Preview_0.1.0_x64-setup.exe` 为 **21,419,329 字节（20.43 MiB）**，SHA-256 `dbfee79816c83a30cff4a6264f37df676e96a06a7a3f3b82c319545d90fd9a48`。
- 7-Zip `t` 与只提取主 EXE 均通过。包内 EXE 与 release 大小相同，仅官方 bundler 将 `__TAURI_BUNDLE_TYPE_VAR_UNK` 改成 `...NSS` 的三个字节不同；按本机官方 bundler 源码归一化此标记后逐字节一致，包内 EXE SHA 为 `e1ac4f322508d87ceb47b44d12e6c672f3268502cb770a0644c152628b889e8a`。CLI 在打包后恢复原 release，因此不宣称原始 SHA 相同；没有运行安装程序或注册文件关联。

未验证：正式用户数据迁入、系统目录选择窗口人工操作（GUI 用 debug 隔离目录选择）、接近上限的大库/非标准旧 EPUB/大型词典、实际断电及磁盘满、窗口刷新发生在发布临界点的 GUI、跨视图离开设置时的专项迁入 GUI、release 实际运行、NSIS 安装/卸载/关联双击、干净 Windows、macOS/Linux、Electron GUI 回归、浏览器偏好/密钥迁入、真实付费服务及 Anki Desktop 导入。恢复和持续占用由 Rust 夹具验证；没有运行安装程序，也没有读取或复制正式 Electron 书库。

日志在 `.tmp/tauri-migration-{tests,rust-all,node,debug,vite,gui,pack,electron-vite,package-test,package-extract}.log`；GUI 使用临时隔离目录并在结束时校验清理路径。

## 第七阶段验证（2026-10-05）

平台：Windows 11 x64 / Node 24.19.0 / rustc 1.96.0 / Tauri CLI 2.12.1 / WebView2 154.0.4258.53。

- `node node_modules/typescript/bin/tsc -p tsconfig.main.json --noEmit`、renderer `--noEmit` 与 test 编译通过。
- `node --test --test-concurrency=1 "dist-test/tests/*.test.js"`：541 项，536 通过、5 跳过、0 失败。
- `cargo test --manifest-path src-tauri/Cargo.toml`：32/32。新增来源 cwd/Unicode/空格/参数过滤/去重、按 ID 定位并忽略伪造 dir、临时占用重试/持续占用保留旧文件验证。
- `node scripts/test-tauri-services.mjs`、`test-tauri-study.mjs`、`test-tauri-ocr.mjs`：6/5/3 项全部通过。
- Tauri Vite 生产构建、`cargo check`、`cargo build` 通过；`node scripts/smoke-tauri.mjs` 最终 155/155，退出码 0。验证真实 native menu 安装与共用处理器打开设置/搜索、全屏进入退出、翻页/缩放事件；第二个原生进程从不同 cwd 以中文/空格/方括号/分号相对文件名打开书籍，阅读视图保持且导入成功。原 Anki/词典/EPUB/分词/翻译/OCR GUI 与 Node 对照继续通过，本次默认 smoke 没有重跑真实 Python/ORT，5 份系统/测试 OCR 产物一致。
- GUI 第一次回归在 `study-queue.json` 原子替换出现 Windows 错误 5；加入同一临时文件的有限重试及持续拒绝保护测试后完整回归通过。没有删除目标来强行保存。
- 官方 CLI 项目内安装命令：`cargo install tauri-cli --locked --root .tmp/tauri-cli`。首次系统临时编译目录消失；设置 `CARGO_TARGET_DIR` 到 `.tmp/tauri-cli-target` 后成功，未更改全局 PATH。应用打包进程不继承该设置。
- release EXE：29,357,568 字节，约 28.00 MiB。`node scripts/tauri.mjs pack` 的第一次构建成功但默认沙箱阻止官方 NSIS 工具网络下载；允许联网构建后继续，最终安装包结果记录在本节下方。
- 安装包构建后的脚本检查发现未引用程序路径、通用文件类型名称可能冲突；改为预览专用 ProgID 和 post-install 引号修正 hook，再构建最终安装包。没有运行安装程序或写入本机文件关联。
- 最终 release 由 `node scripts/tauri.mjs pack` 按新配置构建；NSIS 工具缓存的访问/下载需脱离默认沙箱，随后用 `.tmp/tauri-cli/bin/cargo-tauri.exe bundle --config src-tauri/tauri.conf.json` 生成最终包，退出码 0。重复 bundle 对已经写入 NSIS 类型的 EXE 发出 `__TAURI_BUNDLE_TYPE` 找不到的警告；此预览未接入 updater，不作为更新验收。
- 最终 NSIS：`src-tauri/target/release/bundle/nsis/ARaLeBook Tauri Preview_0.1.0_x64-setup.exe`，**21,376,964 字节（20.39 MiB）**，SHA-256 `59dcee2d4f0518ddb5fac21472773585b1ab834d2e5e63ff030f901d092e2207`。7-Zip `t` 检查通过；只解出主程序后，其 SHA 与 release EXE 一致。包内是主程序和 NSIS 插件，没有独立 Electron/Node/OCR 扩展。生成脚本包含本地 hook、六个扩展及对应卸载宏。辅助 `/PPO` 预处理检查因插件解析失败未通过，不能把该命令写成通过；完整 `makensis` 编译已通过。
- 对照本机现存 `release/ARaLeBook-0.1.0-setup.exe` 的 127,028,004 字节（121.14 MiB），本预览安装包约少 100.76 MiB、83.17%。这是两个本地产物的大小比较；预览数据迁入和安装验收未完成，不能据此称完全替代版已发布。WebView2 缺失时仍需下载运行时，OCR 扩展按需另装。

未验证：release 实际运行、NSIS 安装/卸载、注册表关联与双击启动、系统原生菜单鼠标/快捷键逐项人工操作、剪贴板/文字撤销和画笔撤销的专项 GUI、文件管理器实际选中目录、刷新瞬间的外部打开竞态、首次启动参数的专项 GUI、macOS/Linux 与干净 Windows、Electron GUI 回归、旧书库/密钥/浏览器偏好迁入、真实付费供应商、Anki Desktop 导入。菜单测试通过 debug 入口调用同一 native handler；路径与原子保存保护有 Rust 测试，不能据此称系统定位界面或安装关联已验收。开发运行与打包没有实际注册文件关联，也没有复制正式用户数据。

日志在 `.tmp/tauri-system-{core-tests,rust-tests,study-tests,services-tests,ocr-tests,vite,debug,gui,cli-install,pack,bundle,package-test,package-extract}.log`；GUI 使用临时独立书库，结束按已核对的项目 `.tmp` 范围清理。引擎 submodule 没有修改。

## 词典与分词边界

用户手动选择 ZIP；Rust 仅解压最浅 `index.json` 同目录的 `term_bank_N.json` / `term_meta_bank_N.json`，支持 wrapper 和只有频率的包。媒体、音调、汉字库、标签说明保持原版边界，不解压。单 bank 上限 256 MiB、必要 JSON 总上限 2 GiB；这是导入保护，不代表这么大的包已通过性能测试。

共享解析器跳过坏行/坏 bank，词条和频率数据沿用 `<id>/terms.json`、`freq.json`、`meta.json`。暂存在 `.imports/<id>`，写完再发布；失败不展示半本词典，启动时在确认路径范围后清理未完成暂存目录。词典变更串行，离屏索引完成后整体替换。较大数据仍按词典整体经过 IPC/装入内存，JSON 写盘已用 BufWriter 减少小写入，保留 flush/sync/同目录原子替换。Rust IO 仍共享存储锁；本轮没有把“大词典不会阻塞任何本地请求”作为保证。

Worker 生命周期覆盖整个窗口，切换视图继续工作。已完成产物跨重载保留；正在进行的分词在渲染重载/退出时停止，不恢复半成品。取消保留旧产物，清除会等待当前任务收尾再删除。写盘前重新核对 OCR 源文本指纹，并校验 token 可按 UTF-16 偏移切回原文；整书文字层每轮只读取一次。生成器和词表字段兼容 Electron，现有正确产物可复用。

`tauri.mjs dev/build/pack` 设置 `ARALE_TAURI_BUILD=1`，Vite 复制 Kuromoji 的 12 个 gzip 辞书以及 Apache/IPADIC 许可文件，约 16.97 MiB 辞书资源。普通 Electron Vite 构建不复制这些资产。Rust 构建/测试需要 renderer 文件稳定，不要同时重建/清空 `dist/renderer`；GUI smoke 开始前检查辞书资产存在。Worker 使用 [Kuromoji 官方浏览器构建](https://github.com/takuyaa/kuromoji.js#browser)，不携带 Node 运行时。

## EPUB 与来源隔离

`epub.rs` 负责受限 ZIP 解压、暂存与文件操作；`tauri-epub.ts` 在同一 Worker 中复用现有 TypeScript EPUB 解析、图片型小说判定及 `html-inject.ts` 章节清洗/样式。`zip-memory.ts` 保存纯 ZIP 接口，`zip-reader.ts` 保留原 Node 磁盘 API；图片资源路径解析也不再依赖 Node。文本与图片型 EPUB 都保持 `format: epub`，后者有 `readerMode: comic`，生成 ASCII 页图副本，原章节资源保留。

导入暂存在数据根的 `epub-imports/<id>`，预处理完成后才发布到书库。原 ZIP 保存为 `original.epub`，原资源在 `content/`，清洗后的章节在 `reader/`，`epub-reader.json` 保存相对路径、纯文本和原文件 SHA。索引发布失败会回滚新书目录；启动时清理已确认范围内的未完成暂存。单成员 256 MiB、解压总量 2 GiB、常见章节/元数据原文累计 64 MiB，预处理 HTML+纯文本累计也限制为 64 MiB。这是保护上限，不是大型书性能验收。拒绝目录穿越、符号链接和名称冲突；ZIP 成员只解码一次，已解码的 parser/TOC 路径先做直接匹配。

章节协议独立为 `arale-book://localhost/<id>/<href>`，Windows 使用 `http://arale-book.localhost/<id>/<href>`，支持相对 CSS/图像/字体与白名单媒体；不服务 JS、书库 JSON 或其他任意文件。`arale` 保持被动图片入口。Rust 在请求章节时注入可信 reader bridge，避免在每章缓存/IPC 中重复脚本；`build.rs` 从同一共享脚本提取源码，CSP 只允许该脚本的 SHA-256。Tauri iframe sandbox 仅有 `allow-scripts`，不透明来源，原生命令通过 AppManifest 和本地 shell capability 显式授权。debug smoke 才额外注入测试脚本及对应 hash；release 不包含这些测试入口。实现依据见 [Tauri capability 文档](https://v2.tauri.app/security/capabilities/)；该文档指出 Linux/Android 无法区分 iframe 与所属窗口，当前仅验证 Windows，不能据此宣称其他平台隔离通过。

章节原文件变化时拒绝使用过期文本，提示重新导入；分词输入读取整书缓存一次，逐章核对原文件 SHA，提交时再次核对源指纹和 UTF-16 偏移。已有旧 EPUB 如果没有预处理缓存需重新导入，尚未提供自动数据迁入。当前仅开放 `.epub` ZIP；原生 RAR/7Z/TAR 中的 EPUB、套娃书包和其他入口的结构推断尚未迁移。加密/DRM 书不在验收范围，媒体播放也没有专项运行验收。

## 前两阶段验证记录（2026-10-04）

Windows 11 x64 / Node 24.19.0 / rustc 1.96.0 / WebView2 154.0.4258.53：

- `node node_modules/typescript/bin/tsc -p tsconfig.main.json`、renderer `--noEmit`、test 编译、`node scripts/bundle-preload.mjs` 通过。
- `$env:ARALE_TAURI_BUILD='1'; node node_modules/vite/bin/vite.js build`：Worker 和离线辞书构建通过，没有 Node 模块外置警告；Worker 构建拒绝 Node/Electron 导入。
- `node --test --test-concurrency=1 "dist-test/tests/*.test.js"`：541 项，536 通过、5 跳过、0 失败。包含原词典/去屈折/异体字/释义清洗的回归，适配器仍保留 Node 环境变量覆盖。
- `cargo test --manifest-path src-tauri/Cargo.toml --offline`：10/10，增加词典暂存/格式/频率-only/路径/媒体过滤/兼容落盘、分词 UTF-16/原文变化/损坏文件/清除验证。
- `cargo build --manifest-path src-tauri/Cargo.toml --offline` 和 `node scripts/smoke-tauri.mjs`：真实 WebView2 GUI 与 Node 结果对照，45/45，退出码 0；覆盖词典 wrapper/频率-only/坏行/HTML 清洗、启用/删除、原词卡点击弹窗、分词取消/清除/重载以及前阶段书库/批注。8 组查词结果与 Node 对照（对 Node 释义应用同一安全清洗），样例漫画全部分词单元与词表逐字段一致。三部真实仓库词典共 1,644 词条 + 169,623 原始频率行，新增测试词典另 3 词条；导入+索引单次 debug 观察从无缓冲写盘的 52,005 ms 降为 BufWriter 后 9,314 ms。后者测试同时有 release 编译，非受控性能基准，不是任意词典耗时保证。
- `cargo build --manifest-path src-tauri/Cargo.toml --release --offline`：本轮 Windows release 构建通过，程序 24,910,848 字节（约 23.76 MiB，含 Kuromoji 辞书）。这是未迁完功能的 EXE，不是完整安装包；未运行 release 或生成 NSIS。
- `ARALE_TAURI_BUILD=0` 的普通 Vite 构建通过（`--outDir C:/project/aralebook/.tmp/electron-renderer-check`），未复制 Kuromoji gzip；该验证没有覆盖 Electron GUI。
- 第一阶段：解包库 43/43 + CLI 50/50，GUI 23/23；本轮未修改解包库。
- 原 Electron GUI 第一阶段 CDP 等待超时；本轮未终止用户现有进程、未修改系统调试策略，未把历史 291/291 当作本轮结果。

未验证：大型 Jitendex/用户词典的全量内存性能、正在分词时渲染重载后的任务恢复、完整旧书库迁入、NSIS、release 运行、系统对话框/手动拖放、其他漫画格式的 Tauri GUI、待迁移后台、macOS/Linux、多 DPI 与人工视觉。此前 20–40 MiB 安装包范围仍是完整迁移后的估算，不能用不完整预览证明。

## 第三阶段验证（2026-10-04）

Windows 11 x64 / Node 24.19.0 / rustc 1.96.0 / WebView2 154.0.4258.53。本轮未修改 OCR 引擎或解包 submodule。

- `node node_modules/typescript/bin/tsc -p tsconfig.main.json`、renderer `--noEmit`、test 编译及 `node scripts/bundle-preload.mjs` 通过；`node --test --test-concurrency=1 "dist-test/tests/*.test.js"` 为 541 项、536 通过、5 跳过、0 失败（日志 `.tmp/tauri-epub-core-tests.log`）。共享 ZIP/EPUB/图片型小说规则的回归通过。
- `$env:ARALE_TAURI_BUILD='1'; node node_modules/vite/bin/vite.js build` 通过，Worker 不依赖 Node/Electron；`ARALE_TAURI_BUILD=0` 的普通 Vite 构建也通过，输出 `.tmp/electron-renderer-check`，不复制 Kuromoji gzip。该检查没有覆盖 Electron GUI。
- `cargo test --manifest-path src-tauri/Cargo.toml --offline`：13/13，新增 EPUB 暂存/发布、重复与越界成员、原文变化、资源类型、UTF-16、CSP hash、索引发布失败回滚及启动清理。
- `cargo build --manifest-path src-tauri/Cargo.toml --offline` + `node scripts/smoke-tauri.mjs`：真实 WebView2 GUI/Node 对照 **69/69，退出码 0**。覆盖仓库小说与图片型 EPUB、含脚本/字体/图片/百分号路径的测试书、实际 DOM 点词/划词、目录/链接/键盘跳转、图片型 EPUB 实际页图显示、滚动进度、词卡来源和重载恢复。三本书的 metadata/spine/TOC/章节文本与原 Node 解析逐字段一致；测试 EPUB 的完整分词单元/词表与原 Node Kuromoji 一致，原漫画与 8 组查词对照也通过。隔离探测的 IPC 可能不返回，测试设定等待上限，并核对原生书库元数据未被书页修改。
- `cargo build --manifest-path src-tauri/Cargo.toml --release --offline`：Windows release 构建通过，EXE **25,109,504 字节，约 23.95 MiB**，含 Kuromoji 辞书，仍是功能未迁完的程序。没有运行 release 或生成/安装 NSIS，不能作为完整安装包大小。

未验证：大型/非标准/DRM EPUB、媒体播放、其他压缩容器中的 EPUB、完整旧数据迁入、待迁移后台、release 运行、NSIS/干净系统安装、Electron GUI、macOS/Linux 来源隔离及人工视觉/多 DPI。下一步为翻译/LLM 后台，保持提供商协议、提示词/预算、缓存统计和截断恢复，再迁移 OCR/扩展及 Anki。


## 翻译与 LLM（第四阶段）

`core/services/runtime.ts` 将协议与平台读写分开；Electron 仍用 Node 原子 JSON、crypto 和 fetch，原 `main/llm/service.ts` / `translation/service.ts` 路径保持兼容。Tauri 的独立 services Worker 复用同一服务，词典导入/Kuromoji 不占用该 Worker。Rust `services.rs` 管理 `llm.json`、`translation.json`、`llm-output-capabilities.json`，采用同目录原子替换；密钥存储仍与原版一致为本地明文，只向 Worker 返回存在标记、SHA 签名和设置 revision，不返回已保存密钥。名称/提供商身份不可随编辑修改，未显式替换的密钥保留，损坏文件报错并保留。

提供商包括 Bing 网页、Microsoft、DeepL、Google、百度、LibreTranslate。Bing 临时参数/会话、免 Key、罗马音、验证码/401 重取参数与性别去偏分支沿用；百度 MD5 在 Rust 用真实密钥重新签名。Rust 仅向配置对应的 HTTP(S) 端点注入密钥；禁止 URL 登录信息、跨来源重定向和任意带密钥请求，Bing 只允许官方 HTTPS 域/翻译路径。请求/响应各限制 8 MiB，错误不带含密钥的 URL，并清除响应回显的密钥。HTTP 期间不持有书库或配置锁；等待队列后再次核对 revision。全局 LLM 上限保持 4，Worker 和 Rust 都限制，防止界面重载绕开上限。请求 30/120 秒超时，AbortSignal 转为原生取消，可取消正在等待/进行的请求；词卡本身尚无新取消按钮。

使用 reqwest native-tls（Windows Schannel）和 system-proxy/socks，按其[官方说明](https://docs.rs/reqwest/0.13.5/reqwest/#proxies)支持环境变量及 Windows 系统代理；本轮没有验证真实 HTTPS/代理证书/企业 PAC 或 SOCKS 环境。Bing 测试仅在 debug + smoke 开关同时开启时映射到 127.0.0.1 HTTP 夹具；release 不包含该映射。

翻译成功结果缓存在当前 Worker 内，设置/密钥变更后失效，界面重载不保留译文缓存。LLM 保留原 system/user 提示词、温度、官方 max_completion_tokens/兼容 max_tokens、工具/schema/JSON 降级、格式能力磁盘缓存、tokenAllowance 预留及实际 usage 修正、cacheHit/cacheMiss、finish_reason=length 失败和 truncatedText。已付费的成功回答不会因能力缓存写盘失败被丢弃。网络失败仍返回结构化错误；请求快照不因同名配置中途编辑而改变。重载不恢复已发起调用；旧调用可能在原生超时前继续执行，原生并发限制仍生效。第四阶段尚未接入 Anki 任务；A0–A4、卡片恢复、预算队列和导出验收见第六阶段。

## 第四阶段验证（2026-10-04）

Windows 11 x64 / Node 24.19.0 / rustc 1.96.0 / WebView2 154.0.4258.53：

- main/renderer/test TypeScript 检查与编译、preload 打包、Tauri 和独立目录 Electron Vite 构建通过；Worker 构建继续拒绝 Node/Electron 导入。
- `node --test --test-concurrency=1 "dist-test/tests/*.test.js"`：541 项，536 通过、5 跳过、0 失败，含原翻译/LLM/Anki 协议回归。
- `node scripts/test-tauri-services.mjs`：5/5，覆盖工具→JSON 降级、能力缓存复用、输出预算与缓存 token、截断文本/实际 usage、8 请求峰值 4、AbortSignal→原生取消及网络失败。
- `cargo test --manifest-path src-tauri/Cargo.toml --offline`：16/16；新增密钥仅留原生、配置身份/乐观 revision/损坏文件、端点边界、真实 HTTP 密钥注入、百度签名、回显过滤、取消竞态与在途取消/存储可访问。
- `cargo build --manifest-path src-tauri/Cargo.toml --offline` + `node scripts/smoke-tauri.mjs`：真实 WebView2 GUI/Node 对照 91/91，退出码 0。六提供商均通过 Rust HTTP 连本地夹具；核对 headers/query、百度 MD5、译文缓存、Bing 罗马音、LLM 提示词/usage/截断、配置保存/重载和在途请求下书库/设置可操作；实际词卡“翻译”“分析”按钮展示译文与 Markdown。漫画、三本 EPUB、词典、分词、批注、来源隔离和 Node 对照回归通过。
- `cargo build --manifest-path src-tauri/Cargo.toml --release --offline`：Windows release 构建通过；EXE **26,059,776 字节，约 24.85 MiB**，含 Kuromoji 辞书及翻译/LLM HTTP 后台；较第三阶段增加约 0.91 MiB。未运行 release 或生成/安装 NSIS，不是完整安装包大小。

未验证：真实 Bing/付费提供商语义质量、TLS/地区/代理/限流/验证码实网、全量模型工具兼容、长时间运行、完整 Anki/OCR 后台、真实系统设置交互人工验收、release 运行、NSIS/干净系统、Electron GUI、其他平台及多 DPI。下一步迁移现有 OCR/扩展进程和下载/队列，再接 Anki 存储/后台/导出，最后迁移用户数据和安装包。

## OCR 与扩展（第五阶段）

`src-tauri/src/ocr.rs` 保持全窗口一个书级 FIFO，入队时捕获 provider；工作/切换视图不持有长期书库存储锁。Windows 内嵌现有 WinRT PowerShell 脚本，写入预览数据目录时保留 UTF-8 BOM；通过自检显示实际语言能力，本机使用 en-US 回退，不能称为日语语言包验收。图片路径先 canonicalize 检查范围，再去除 WinRT 不支持的 `\\?\` 前缀。扩展直接启动原 manifest runner 和包内 Python/ORT；开发模式可加载 `engines/arale_onnx_v1/build/dev-win32-x64`，release 只认已安装包，不包含开发运行时或模型。

Rust 读取受限 NDJSON、处理分片/UTF-8/EOF 尾行、报告进度；Windows Job Object 随结束/取消关闭，杀掉 OCR 及其子进程，不启动可见终端。识别后 `tauri-ocr.ts` 在 services Worker 内复用同一 `parseOcrStreamLine`、`blocksFromLines`、旧页合并与 mokuro 序列化；`relative-path.ts` 提供原纯路径规则，Node `paths.ts` 公共入口保留。失败/空输出页保留旧文字；取消只替换已识别非空页，并记录取消状态。文字层写入前再核对页图列表、阅读方向、原文字层，变化时拒绝覆盖。这里没有逐图内容 SHA 校验，也没有修改批注文件。

原生任务跨渲染重载继续运行；新 Worker 在 ready 时接取待转换结果，token 防止重复/过期提交，转换错误或 120 秒无回应时保留旧产物。整个应用退出后队列不恢复，尚无 OCR 检查点或断点续跑。识别中的书不能删除，等待中的任务可直接取消；引擎 lease 阻止正在使用的扩展被覆盖或移除。

`extensions.rs` 沿用默认 JSONL、仓库增删/缓存以及 `installed.json` 和 `<id>/extension.json` 布局；默认仓库全部移除后不会自动恢复。原生 HTTPS 下载支持镜像与最多五次 HTTPS 重定向、30 秒无响应/无数据超时和取消；下载上限 2 GiB，发布前核对清单大小及 SHA256。暂存在 `.staging`，拒绝越界、链接、重复及 Windows 设备/路径别名；解压单文件 1 GiB、总量 4 GiB、最多 100,000 成员，解压过程中也响应取消。manifest 的 id/version/provides 必须匹配，runner 必须在包内。安装串行，依赖按拓扑顺序处理，已成功安装的依赖不会随上层失败自动卸载。

发布/删除写 transaction journal，旧目录暂存为 previous，索引原子保存后才清理；失败或启动发现未提交事务时恢复旧包。Windows 对临时文件占用造成的目录重命名错误（5/32/33）有界重试同一操作，最终失败仍保留/恢复数据，不先删除目标。该处理也用于 EPUB 发布/回滚，并用真实拒绝共享删除的文件句柄验证。扩展下载沿用 reqwest native-tls/system-proxy/socks；真实 GitHub/PAC/代理验收仍待补。

## 第五阶段验证（2026-10-05）

Windows 11 x64 / Node 24.19.0 / rustc 1.96.0 / WebView2 154.0.4258.53；本轮未修改引擎 submodule。

- main/renderer/test TypeScript 检查与编译、preload、Tauri Vite 和输出到独立目录的普通 Electron Vite 构建通过；Worker 无 Node/Electron 外置模块。
- `node --test --test-concurrency=1 "dist-test/tests/*.test.js"`：541 项，536 通过、5 跳过、0 失败，日志 `.tmp/tauri-ocr-core-tests.log`。`node scripts/test-tauri-services.mjs` 5/5；`node scripts/test-tauri-ocr.mjs` 3/3，覆盖保留旧页、成块/元数据、重复接取与转换错误。
- `cargo test --manifest-path src-tauri/Cargo.toml --offline`：25/25，新增 JSONL/依赖循环、ZIP/Windows 路径、manifest/runner、安装/删除中断恢复、NDJSON 分片/EOF、源数据与页身份、取消后实际子进程退出、Windows 临时文件占用；日志 `.tmp/tauri-ocr-rust-tests.log`。
- `cargo build --manifest-path src-tauri/Cargo.toml --offline` + `$env:ARALE_TAURI_SMOKE_OCR='1'; node scripts/smoke-tauri.mjs`：真实 WebView2 GUI/Node 对照 **118/118，退出码 0**，日志 `.tmp/tauri-ocr-gui.log`。覆盖仓库移除/刷新、大小与 SHA/manifest、下载取消、安装与移除、OCR 进度/FIFO/排队取消/保留旧页、使用保护、源数据冲突、漫画/图片 EPUB、真实 WinRT OCR、开发包 Python/ORT 和界面重载；6 份完整/取消/系统/ONNX文字层与原 Node 规则逐字段一致。扩展网络验收通过 debug-only 127.0.0.1 夹具映射，未从远端下载正式引擎；Python/ORT 使用现有 submodule 开发包，未修改或重新导出模型。首次系统 OCR 遇到 verbatim 路径失败已修正；复测遇到 EPUB 目录发布临时拒绝访问，有界重试和真实文件占用单测通过后，最终全量通过。不能用一次通过宣称任意外部文件占用都能恢复。
- `cargo build --manifest-path src-tauri/Cargo.toml --release --offline`：Windows release 构建通过，EXE **26,479,616 字节，约 25.25 MiB**，含 Kuromoji 辞书、HTTP、系统 OCR 脚本及扩展管理；较第四阶段增加约 0.40 MiB。未运行 release 或生成/安装 NSIS；仍非完整迁移安装包。

未验证：Tauri 从真实远端下载/安装官方 724 MB 包、网络代理/PAC/镜像重定向、干净系统 VC++/语言依赖、大书与长时间队列、应用退出后恢复、完整旧数据迁入、Anki 后台、release 运行、NSIS 安装包/安装卸载、Electron GUI、macOS/Linux 及多 DPI 人工视觉。历史 Electron 的正式引擎下载验收不等于 Tauri 下载验收；完整迁移安装包体积仍不能由当前 EXE 推定。


## Anki 制卡（第六阶段）

原候选、F1–F3、A0–A4/旧 R、五字段、预算、有限修复、截断恢复与自行 AI 协议抽成共享 `core/study` 实现，Electron `main/study` 保留 Node 适配器。Tauri 单例 study Worker 持有任务，词典查询通过既有 dictionary Worker，保持原查词排序与返回范围；包内 JLPT/wordfreq 及归因许可证随构建复制。独立 Worker 不依赖 Node、Electron 或浏览器 SQL.js，原 LLM 提示词与并发限制未更改。

Rust `study.rs` 管理每书 `study-list.json`、原生队列快照、Worker session 与书 lease；保存同时核对词单 revision、文字层/分词/页列表/阅读方向和词典元数据指纹。OCR/删除/分词更新等不能并发修改同一本书。失败保留旧文件；已完成检查点先落盘，再发进度/完成事件。这里未增加逐图字节 SHA 或完整任务请求的原生断点调度。

切换阅读器、制卡面板或设置页不会终止任务。**刷新整个窗口、Worker 被替换或应用退出后不自动继续付费调用**：启动把旧 active/pending 标为中断，保留已保存的筛词/释义检查点，用户按原参数手动续跑；同名配置已改变时按原规则要求明确丢弃不兼容检查点。刷新会取消已登记的旧制卡 HTTP，旧 session 的保存/请求拒绝；取消已发出的调用不保证供应商不计费。普通词卡翻译/分析的在途请求仍遵循第四阶段边界。

TSV/APKG 使用原生保存对话框，自行 AI 使用目录对话框；Rust 只写当前 session 获得的文件/目录 grant。MD 全部写出后保存任务，首次保存就记录真实目录；写出失败不保存完成状态。APKG 的固定 schema 由共享模板在 build 时提取，Rust `rusqlite` bundled SQLite 只接受三个固定参数化 INSERT，拒绝任意 SQL，并运行 integrity_check；共享 TS 写 ZIP、卡面、遮罩、字段与稳定 GUID/model/deck ID。配图从原图裁文字框 PNG（最长边 1600）或整页 JPEG（最长边 2600、质量 86），核对原文/UTF-16/路径范围，图像 SHA 命名；Rust 与 Electron 编码器的图像字节可以不同。文件原子写出成功后才保存 exportedAt，若后续词单提交失败，文件可能已存在但不能报导出成功。

## 第六阶段验证（2026-10-05）

Windows 11 x64 / Node 24.19.0 / rustc 1.96.0 / WebView2 154.0.4258.53；没有修改引擎 submodule，没有真实付费调用。

- main/renderer/test TypeScript 检查与编译、preload 打包、Tauri Vite 及 `.tmp/electron-renderer-check` 普通 Vite 构建通过；Worker 构建拒绝 Node/Electron 导入。
- `node --test --test-concurrency=1 "dist-test/tests/*.test.js"`：541 项、536 通过、5 跳过、0 失败；其中学习候选/编排/队列/自行 AI/APKG 79 项通过。日志 `.tmp/tauri-study-core-tests.log` 与 `.tmp/tauri-study-shared-tests.log`。
- `node scripts/test-tauri-study.mjs`：5/5，候选/Zipf、A0 无外部调用、检查点先于完成、写出失败不标 exportedAt、保存失败不返回成功、重复入队、原生 HTTP 取消与书 lease 释放、首次 MD 保存实际目录；`.tmp/tauri-study-worker-tests.log`。服务适配器 6/6（新增配置签名变化不发翻译请求），OCR 适配器 3/3。
- `cargo test --manifest-path src-tauri/Cargo.toml --offline`：29/29，新增 SQLite 固定 SQL/完整性、词单 revision/源/词典冲突和损坏文件、Worker session/lease、中断队列历史；`.tmp/tauri-study-rust-tests.log`。
- `cargo build --manifest-path src-tauri/Cargo.toml --offline` + `$env:ARALE_TAURI_SMOKE_OCR='1'; node scripts/smoke-tauri.mjs`：真实 WebView2 GUI/Node 对照 **150/150，退出码 0**；`.tmp/tauri-study-gui.log`。覆盖 A0–A4、F1–F3、五字段、预算暂缓、截断 tool 输出恢复完整卡片及 usage、MD 写出/非法结果拒绝/合法导入、TSV、none/crop/page APKG、窗口刷新中断/检查点/手动重跑。候选、假名、JLPT、Zipf 和词典释义与原 Node 完整对照；三种 APKG 的 SQLite integrity、notes/cards 字段、稳定身份一致，图片格式/命名及实际 MD/TSV 文件检查通过。六份 OCR 产物、EPUB、词典与批注回归通过，含本机 WinRT 与现有开发包 Python/ORT。GUI 制卡验证通过 AraleApi/事件桥接，未逐一点击全部制卡页面按钮；系统文件对话框以 debug 授权路径替代。
- `cargo build --manifest-path src-tauri/Cargo.toml --release --offline`：Windows release 构建通过，EXE **29,318,656 字节，约 27.96 MiB**，增加包内学习数据、共享编排和原生 SQLite；比第五阶段增加约 2.71 MiB。日志 `.tmp/tauri-study-release.log`。未运行 release 或生成/安装 NSIS，此体积不是安装包体积。

未验证：Anki 桌面客户端实际导入/更新、真实模型/翻译质量与费用、系统对话框的人工选择/取消、长书/大型词典/大量配图的内存和 IO 压力、异常 Worker 崩溃后不刷新窗口的立即恢复、完整旧书库迁入、release 实际运行、NSIS 安装/卸载、文件关联/完整菜单/系统定位、Electron GUI、macOS/Linux 和多 DPI 人工视觉。当前 EXE 不能作为完整安装包体积。
