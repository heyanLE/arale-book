# 当前架构与数据流

核对日期：2026-10-05。状态和待办见[当前状态](current-state.md)。

Tauri 使用自身 `app_data_dir()`，没有旧版数据迁入 UI、IPC、Worker 分支或启动迁入恢复器。本机开发数据已通过仓库外的一次性操作复制到该目录，保留书 ID/学习侧文件并重绑定 dir；未来用户直接在当前版本导入书籍。旧 Electron 目录与复制前目标目录备份保留，应用不自动读取它们。

系统菜单与书目录定位在 `src-tauri/src/system.rs`；菜单发送共享 `shell:command`，首次启动/第二实例将存在的路径按来源 cwd 转绝对路径，`lib.rs` 在渲染器就绪前和重载时暂存请求。`App.tsx` 全局接收 `shell:openFiles`，因此外部文件导入不依赖 LibraryView 是否挂载。专用文件关联由安装包配置声明，开发入口不修改系统关联。

应用只有 Tauri 入口，`src-tauri/` 是原生 Rust 后台，`shared/api-bridge.ts` 提供 AraleApi 映射。renderer 等原生事件就绪后挂载。漫画/EPUB 导入与阅读、书库/进度、词卡存储、漫画批注、手动词典和整书分词已接入，漫画解包直接链接 Rust 库；翻译/LLM、OCR/扩展已接入；Anki 共享编排与原生保存/导出已接入。数据 identifier 保持稳定以继续使用已迁移的本机书库。见 [迁移范围与验证](tauri-migration.md)。

Anki 候选服务、F/A 编排、任务队列和 APKG 模板已抽到 `core/study/service.ts` / `runner.ts` / `task-queue.ts` / `apkg.ts`，通过 `StudyRuntime` 注入平台读写，Node 测试端口移至 `tests/support/study/`，应用不携带旧服务。Tauri 的独立 `study-worker.ts` 复用同一实现，通过词典 Worker 查询与原版一致的排序/截断结果；JLPT 和 Zipf 包内数据不需网络。`study.rs` 持有 Worker session、书 lease、源/词典指纹与词单 revision，禁止旧 Worker 覆盖新保存；原生仅允许固定 Anki schema 和三个参数化 INSERT，使用 bundled SQLite 校验并返回集合字节，ZIP/模板/GUID 仍由共享模块生成。截图核对文字框及 UTF-16 偏移，用 canonical 路径读取原图；APKG/TSV 导出只写用户选定的授权路径，外部 AI 任务直接写应用临时任务目录，外部文件成功后才保存 exportedAt。队列状态写 `study-queue.json`，刷新/应用重启将 active/pending 标中断并保留检查点，需要人工续跑；视图切换继续运行。

Tauri 的 `ocr.rs` 持有书级 FIFO、NDJSON 读取、原生进程与取消；Windows 使用 Job Object，结束时清理整棵 OCR 子进程树。`tauri-ocr.ts` 在 services Worker 内复用原 `parseOcrStreamLine`、`blocksFromLines` 和 mokuro 序列化，不依赖 Node。识别后读取原生 pending、转换并提交；重载界面重新接取 pending，写盘前核对页图列表、阅读方向和旧文字层。`extensions.rs` 管理 JSONL/缓存、HTTPS 流式校验、受限 ZIP 解压、manifest/runner 校验、安装 journal 与回滚；lease 防止使用中的引擎被覆盖。现有 Python/ORT 和系统脚本保持不变，细节见迁移文档。

翻译/LLM 协议统一在 `core/services/llm.ts` / `translation.ts`，通过 `ServiceRuntime` 注入 IO/哈希/随机数。Node 测试端口在 `tests/support/`，不进入应用产物。Tauri 使用独立 `services-worker.ts`，与词典/Kuromoji CPU 工作分开；Worker 仅取得密钥存在标记、配置签名和快照，由 `src-tauri/src/services.rs` 在已配置端点注入真实密钥、百度签名并发送 HTTP。原提示词、结构化协议降级、能力缓存、预算、cacheHit/cacheMiss 和截断文本沿用；HTTP 不持有书库存储锁，Worker 和 Rust 各有限额 4 的 LLM 队列。Anki 编排在独立 study Worker 内复用上述服务，保持相同提示词和预算规则。

Tauri EPUB 由同一 Worker 的 `tauri-epub.ts` 复用 `core/epub/parser.ts`、图片型小说判定和原章节清洗/样式；`zip-memory.ts` 与 Node 磁盘适配器分开。Rust `epub.rs` 解压到暂存目录，完整解析后发布，保存原始 content、预处理 reader HTML、章节文本与原文 SHA。服务章节时注入编译期同源的 reader bridge，CSP 只放行该脚本 hash。`arale-book` 单独服务章节、样式/图片/字体，iframe 在 Tauri 中仅允许 scripts，使用不透明来源，命令显式受本地 shell capability 限制。章节点击、划词、目录、位置及 Kuromoji 分词沿用原契约；详情和平台验证边界见迁移文档。

Tauri 词典链由 `tauri-bridge.ts` 把 `dict:*` / `segment:*` 转发给单例 Worker。`core/dict/model.ts` / `glossary.ts` 供浏览器 Worker 使用；小型规则文件的 Node 适配器 `data-source.ts` 在 Vite Worker 构建时替换为原始 JSON，Worker 构建拒绝 `node:*` 导入。Kuromoji 使用官方浏览器构建及同一份 IPADIC gzip，词典索引与词表计算不会在 React 线程执行。Rust `dictionaries.rs` 管理暂存/发布、元数据和磁盘内容，`segments.rs` 校验源文本指纹和 UTF-16 token 区间后写 `segments.json`。Anki 使用独立 study Worker，保持查词和 HTTP Worker 响应。

Anki 第 2/4 步的自行 AI 文件/返回协议在 `src/core/study/manual-ai.ts`，study Worker 内的 `StudyService` 管理固定快照、文件写入和原子批次导入，`ManualAiPanel.tsx` 提供数量、提示词、粘贴结果和恢复界面。通过 `study:manualAiExport/Import/Clear` IPC 连接，本书 `workflow.manualAi` 保存进度；不调用 LLM/翻译服务。见[使用与验证](anki-harness.md#自行-ai-模式)。

漫画批注由 `shared/annotations.ts` 定义 v1 契约，`core/comic/annotation-store.ts` 串行保存及撤销，`src-tauri/src/annotations.rs` 验证 revision/原图签名并原子写盘。`annotations:read/write` 接入 `ComicAnnotationCanvas` 与 `ComicAnnotationControls`；SVG 在原图上方、OCR 命中层下方，阅读时穿透鼠标、编辑时停用查词与边缘翻页。`ReaderView` 提供统一右侧栏，词卡夹和图层管理用标签切换，并负责沉浸浮动栏的侧栏/退出入口；沉浸时保留已展开侧栏。`ComicAnnotationManager` 和沉浸栏的 `ComicAnnotationQuickTools` 通过 portal 渲染，与漫画画布及底部工具共享控制器；快捷工具复用禁用条件及 SVG 图标。`useAnnotations` 管理待放置状态与最近画笔层，文字点击页图后才创建层，工具切换先提交草稿。数据不进入 OCR、分词及 Anki，快捷工具沿用现有存储契约。详见[批注图层](reader-annotations.md)。

## 代码导航

词卡三栏偏好由 `renderer/lib/reader-settings.ts` 的 `wordCardSections` 保存及校验，`useSettings` 订阅并同步到各 `WordCardPopup`。空结果的临时收起与单卡“展开更多”留在组件内，不覆盖持久偏好。词典结果按 `dictionaryId` 分组，默认显示首部/已选来源，展开更多仅改变展示范围，不重新查询；选择来源仍走既有词卡保存逻辑。

| 入口 | 责任 |
|---|---|
| [src-tauri/src/lib.rs](../src-tauri/src/lib.rs) | 创建窗口、服务、OCR providers 和 IPC |
| [src/shared/ipc.ts](../src/shared/ipc.ts)、[受限 API 桥接](../src/shared/api-bridge.ts) | Tauri/Worker 契约与受限桥接 API |
| [src-tauri/src/lib.rs](../src-tauri/src/lib.rs) | 原生 IPC 分发 |
| `src/core/` | EPUB/漫画解析、词典、分词、OCR 排序成块、词卡纯逻辑 |
| `src-tauri/src/storage.rs`、`src-tauri/src/importer.rs` | 书库元数据、导入、每本书的词卡 |
| `src-tauri/src/epub.rs`、`src/core/epub/html-inject.ts` | `arale://` 内容访问、EPUB 内容处理与桥接注入 |
| `src/renderer/reader/` | 漫画/EPUB UI、文字层与选择 |
| [src-tauri/src/extensions.rs](../src-tauri/src/extensions.rs) | JSONL 仓库、缓存、下载校验、安装与开发目录加载 |
| [src-tauri/src/ocr.rs](../src-tauri/src/ocr.rs) | 书级串行队列、进度、取消和文字层写盘 |
| [学习候选服务](../src/core/study/service.ts)、[审核 UI](../src/renderer/views/StudyPanel.tsx) | Kuromoji 候选、JLPT 参考匹配、每书选择与 Anki 文本导出 |
| [Harness](../src/core/study/harness.ts)、[字段与分流](../src/core/study/pipeline.ts)、[罗马音转换](../src/core/study/reading.ts)、[Worker 编排](../src/core/study/runner.ts)、[Anki 打包](../src/core/study/apkg.ts) | 五字段选择、A0–A4 词典/翻译/LLM 分流、有限修复与预算、已通过卡 `.apkg` v2；旧 R0–R3/v1 保留兼容，详见[档位与评估](anki-harness.md) |
| [整书分词服务](../src/renderer/lib/tauri-segments.ts)、[形态结果映射](../src/core/segment/morph.ts) | 漫画文字块和 EPUB 章节用 Kuromoji 切词，词典只标记收录；旧产物按引擎标识自动重建 |
| [扩展 provider](../src-tauri/src/ocr.rs)、[runner](../src-tauri/src/ocr.rs) | 按自描述启动进程，读取逐页 NDJSON |
| [设置 UI](../src/renderer/components/SettingsPanel.tsx)、[OCR 扩展卡片](../src/renderer/components/ExtensionsCard.tsx) | 通用/小说/漫画设置，OCR 默认与扩展仓库管理 |
| `native/arale-native/` | Rust 解包库；不是 OCR 引擎 |
| [engines](../engines/README.md) | 独立 Git submodule：OCR 源码、模型清单与归档构建 |

## OCR 链路

```text
书籍页图 → OcrService 队列
  ├─ system → Vision / Windows.Media.Ocr
  └─ arale_onnx_v1 → extension.json 的包内 Python
       → OpenCV/Mokuro 几何 → ORT 检测/编码/缓存解码
       → NDJSON 每页 lines（原图像素框、文本、朝向）
  → 应用排序/成块 → content/manga.json → 漫画文字层
```

契约以 [ocr-protocol.ts](../src/shared/ocr-protocol.ts)、[extensions.ts](../src/shared/extensions.ts)、[provider.ts](../src/core/ocr/types.ts) 为准。runner 只输出行，应用负责阅读顺序和持久化。新扩展产出的引擎签名为 `arale_onnx_v1:v2`；已有文字层不会自动重算，用户需要强制重新识别。

## 仓库、安装和开发目录

- JSONL 源在 `engines/repositories/default.jsonl`，一行一个扩展；`release.assets` 按 `darwin-arm64` / `win32-x64` 选资产。
- 每个仓库单独缓存；合并时相同扩展 id 采用仓库列表中先出现的条目。默认仓库有 submodule 生成的本地索引回退。
- 有调试引擎时优先本地索引；正式包优先缓存，但较新的随包索引不会被旧缓存覆盖。
- 下载要求 HTTPS 和有效 SHA；先落 `.staging`，解包并检查自描述，之后换入安装目录。空 SHA 会拒绝安装。
- 源码运行从 `engines/arale_onnx_v1/build/dev-<platform>-<arch>/` 加载。开发态可以从 submodule 的已构建开发目录加载；这种本地引擎不能在 UI 卸载。
- 正式包由 Rust 构建嵌入 JSONL 仓库索引，引擎由用户另行下载。
- 当前安装 id `ocr-arale_onnx_v1`、provider id `arale_onnx_v1` 是不同用途的稳定标识。

## 用户数据

以 [src-tauri/src/lib.rs](../src-tauri/src/lib.rs) 的 Tauri `app_data_dir()` 为准，不在代码中硬编码某台 Mac 的路径。

```text
<userData>/
  library/index.json
  library/<bookId>/content/        # arale:// 的可读根，含 manga.json
  library/<bookId>/cards.json      # 词卡按书存储
  library/<bookId>/comic-annotations.json # 本书图层及按页保存的批注，独立于 OCR
  library/<bookId>/segments.json   # 可重生成的原始分词结果
  library/<bookId>/study-list.json # 漫画制卡候选与人工审核结果
  library/<bookId>/original.*
  dictionaries/
  positions.json
  settings.json
  llm.json                        # 含本机 API key，不作为公开迁移材料
  extensions/repositories.json
  extensions/repositories/*.jsonl
  extensions/installed.json
  extensions/<extensionId>/
  temp/manual-ai/aralebook-<kind>-<sessionId>/ # 外部 AI 批次 MD 与 prompts.md
```

新保存的词卡带来源页/章；旧卡没有此字段时读为 null。设置页的默认 OCR 引擎与漫画每书的 OCR 覆盖值是两层状态，不互斥；实现与交互见[设置与词卡 UX](settings-wordcard-ux.md)。

旧 `extensions/catalog.json` 的兼容回退还在服务中，不能据此认为应用源码仍维护一份旧 JSON 清单。UI 部分偏好保存在 localStorage。
