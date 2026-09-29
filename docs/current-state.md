# 当前状态与接续任务

核对日期：2026-09-29。应用版本 `0.1.0`，OCR 扩展版本 `0.2.0`。
功能基线：应用提交 `91fc064`、文档整理前提交 `1b57c64`；引擎功能提交 `59eed53`。这些是定位历史的基线，当前 HEAD 用 `git log` 查看。

## 现在是什么

ARaLeBook 是 Electron + React/TypeScript 的本地漫画/EPUB 管理与日语学习阅读器。当前主流程包括导入、书库、漫画/小说阅读、点词/划词查询、词卡、词典分词、可选 OCR、多提供商翻译与 OpenAI 兼容 LLM 分析。
纯逻辑在 `src/core/`，Electron 服务在 `src/main/`，UI 在 `src/renderer/`。源码导航见[架构](architecture.md)。

## 已确定并实现的方向

| 事项 | 当前实现 |
|---|---|
| 系统 OCR | 按用户明确选择保留 macOS Vision / Windows.Media.Ocr |
| 可下载 OCR | `arale_onnx_v1` 使用包内 CPython + ONNX Runtime；用户运行包不含 PyTorch |
| 旧 OCR | 旧 PyTorch Python 桥与 Rust OCR 源码已删除；Rust 解包器仍保留 |
| 模型 | fp32 检测器、编码器、缓存首步/续步解码图 + 词表；权重在 submodule 内但 gitignore |
| 解码 | 默认使用 self/cross-attention KV cache，保留 beam search 口径 |
| OCR 仓库 | 一个 HTTPS JSONL 文件代表一个仓库；设置中可增删，默认当前引擎库 |
| 正式应用包 | 只携带从 submodule 取得的小型仓库索引，不携带可下载引擎 |
| 开发/调试包 | 存在 `build/dev-<platform>-<arch>/` 时直接加载；调试应用包会复制该目录 |
| 发布 | OCR ZIP 已在本机生成，尚未上传 Release；主项目和引擎库 `main` 已推送到 GitHub，当前设置与词卡 UX 本地分支尚未推送 |
| 翻译 | 词卡内支持整段/整框或选区翻译；提供 Bing 网页翻译（免 Key）、Microsoft、DeepL、Google、百度和 LibreTranslate，配置与密钥留在主进程；Bing 直接复刻网页 `translate()` 协议，不额外引入 npm 依赖，并显示后台返回的日文原文罗马音 |
| 词卡定位 | 弹窗在选区的下、上、右、左等候选位置中按遮挡面积选择位置；翻译/LLM 内容展开和窗口缩放时自动重新定位，用户手动拖动后保留手动位置 |
| 漫画学习候选 | 在现有分词页增加 Anki 制卡标签：Kuromoji 形态分析、社区 JLPT 参考等级、候选审核与短语补录；每书 `study-list.json` 保存人工选择，导出 UTF-8 Anki 文本。实现细节见[方案与状态](manga-vocabulary-anki-plan.md) |
| Anki Harness | 当前为五步：规则筛词 → 可选 AI 筛选 → 手动筛词 → R0–R3 AI 释义生成 → 制卡。F1–F3 和 R0–R3 在主进程串行后台队列执行，可离开页面；右下角与 OCR 共用任务弹层。DeepSeek 标准地址用 JSON Output，OpenAI 官方地址优先 JSON Schema，其余兼容端点尝试工具调用并按不兼容错误降级；每书记录实际 HTTP 和缓存 token。单任务内 LLM 批次默认并发 2、最多 3。第 5 步逐卡编辑、选择无图/文字框/整页并导出 `.apkg`。详见[筛选 UX](anki-filter-ux.md)、[Anki Harness](anki-harness.md)及[LLM 协议](llm-output-protocol.md)。 |
| 整书原始词表 | 漫画文字块和 EPUB 章节统一由 Kuromoji 按日语词形切分；Yomitan 词典只标记是否收录。助词、助动词、标点和未收录的单个假名不进入学习词表，但词位置信息仍保存在 `segments.json`。打开旧版逐字产物会自动重建；阅读时点词查询仍走词典扫描。 |
| 设置与词卡 UX | 设置按功能卡片排列，小说与漫画阅读器配置置于末尾；“词卡弹窗”卡片分翻译栏与 LLM 分析栏管理各自默认项及提示词。弹窗引擎下拉只列实际配置，顶部词语与编辑图标共用按钮。LLM/翻译仅新建时可设置名称及翻译提供商，Bing 免 Key 项常驻。词卡持久记录来源页/章，支持跳转与返回，三栏可收起。详见[交互说明](settings-wordcard-ux.md) |

不要重新引入旧 Rust OCR 来代替当前默认方案，除非用户提出新的实现方向；当前 Windows 工作的目标是移植和验收现有 Python/ORT 包。

## 已验证与边界

以下是上一轮功能验证记录，本次文档整理未重新运行这些测试。

| 验证 | 已观察的结果 | 不能据此推断 |
|---|---|---|
| 类型与应用测试 | Windows / Node 22.19.0 类型检查通过；400 项中 395 通过、5 跳过；Rust 50/50 通过 | 跳过项含真实 RAR 夹具与降级分支，不是这些外部样本已通过 |
| macOS 引擎 | 包内解释器、解压后的 ZIP、应用扩展服务均跑通单页 OCR | 不是所有 macOS 版本都测过 |
| KV cache 对照 | 同批 30 页 388 行文字和框与旧无缓存图完全一致 | 不是任意书籍都完全一致 |
| Mokuro 对照 | 380/387 配对行逐字一致，约 98.2% | 这是与参考程序的一致率，不是人工标注准确率 |
| 性能 | 8 线程、同批 30 页：126.4 秒 → 96.5 秒 | 运行时默认仍为 4 线程；不能把 8 线程测量当默认保证 |
| 应用打包 | macOS debug/release `--dir` 已有旧记录；Windows debug/release `--dir` 与 NSIS 安装包构建通过，资源分流与包内 sidecar/WinRT OCR 已检查 | Windows 安装包尚未在干净机器实际安装/卸载，也未发布或签名验收 |
| GUI smoke | Windows 普通 smoke 162/162；`ARALE_SMOKE_OCR=1` 真 OCR smoke 183/183，含 ONNX 4 页识别、系统 OCR 队列/进度/排队/取消 | 不是所有 Windows 版本、语言包或真实书籍的全量保证 |
| Windows | Windows 11 build 26200 上已修复嵌入式 Python `_pth` 与 WinRT PowerShell 5.1 编码/多页参数；30 页 ONNX OCR、系统 OCR、多引擎应用集成和 GUI 均运行成功 | 尚未验证干净 Windows 的 VC++ 条件依赖；Windows 与 Mac 基线存在少量识别/框差异 |

macOS 应用打包配置下限为 11；当前 ONNX Runtime wheel 要求 macOS 14，扩展条目用 `minMacOS: 14` 限制安装。Windows 和 Linux 的应用构建配置存在，但运行/打包仍需逐平台验收。

### 2026-09-27 翻译与词卡定位验证（Windows 11）

- `node .\node_modules\typescript\bin\tsc -p tsconfig.main.json --noEmit`、`tsconfig.renderer.json --noEmit` 与 `tsconfig.test.json` 均通过。
- `node --test "dist-test/tests/*.test.js"`：420 项中 415 通过、5 跳过、0 失败；其中 Bing 单测覆盖免 Key、网页临时参数解析、表单参数与会话复用，词卡定位单测覆盖下方、上方、侧边避让和视口边缘约束。
- `node .\node_modules\typescript\bin\tsc -p tsconfig.main.json; node scripts/bundle-preload.mjs; node .\node_modules\vite\bin\vite.js build`：主进程、preload 与 renderer 生产构建通过。
- 临时 `node -e` 脚本直接请求 Bing 原始接口并实例化 `TranslationService`，真实请求 `猫が好きです。`（`ja` → `zh-Hans`）：返回译文 `我喜欢猫。`、原文罗马音 `Neko ga suki desu.`，另有译文拼音；当前 UI 按需求只展示原文读音。
- 未验证范围：未做长时间/高频限流、验证码、各地区 Bing 子域、代理环境及离线恢复测试；Microsoft、DeepL、Google、百度与 LibreTranslate 本轮只有注入假 HTTP 的协议测试，没有使用真实用户 Key 联网调用；词卡避让尚未在不同 DPI、多显示器和所有内容长度下逐一做 GUI 人工验收。

### 2026-09-28 漫画制卡第一版验证（macOS / Node 24）

- TypeScript main、renderer、test 类型检查通过；主进程/preload/renderer 生产构建通过。
- `node --test 'dist-test/tests/*.test.js'`：432 项中 427 通过、5 跳过、0 失败。新测试覆盖 JLPT 同形异读与级别冲突、文字块偏移、Anki 转义、真实 Kuromoji、人工修改/短语/导出落盘及词义精确匹配。
- Electron GUI smoke 169/169 通过，覆盖漫画候选生成、保存与审核 UI 入口。正式 macOS 目录包启动验证 9/9 通过，实际从 `app.asar` 加载 Kuromoji 词典和 JLPT 数据，生成 40 个样例候选。
- 本地 171 页真实漫画文字层 / 2232 块，候选生成 1240 条、参考 JLPT 命中 554 条、约 294 毫秒（使用空释义回调，仅测形态分析与聚合）。这不是质量准确率或含真实词典释义的完整耗时。
- 尚未在 Anki 中实际导入，也未对真实漫画做人工标注质量评估；新 UI 未做人工视觉验收，Windows 目标系统未验收。

### 2026-09-28 设置与词卡 UX 验证（macOS / Node 22）

- `npm run typecheck`、`npm run build` 通过；`npm test`：435 项中 430 通过、5 跳过、0 失败，包含漫画与 EPUB 来源位置持久化、LLM 配置及 Key 单次保存断言。
- `npm run smoke`：最新 187/187 通过，覆盖词卡弹窗翻译/LLM 两栏配置、只有 Bing 时翻译下拉仅一项、词典下方单线分隔与顶部统一编辑按钮，以及此前的默认配置、Key 保存、来源页往返等流程。
- `npm run screenshot` 已在 macOS 生成设置页与漫画词卡截图并人工检查；当前布局和交互说明见[设置与词卡 UX](settings-wordcard-ux.md)。
- 未验证范围：Windows 上本轮新增交互、EPUB 章节跳转/返回的 GUI 自动验收，以及不同 DPI 和窄窗口的人工视觉检查；历史词卡没有来源位置，无法自动补回旧页号。

### 2026-09-28 整书分词修复验证（macOS / Node 22）

- `npm run typecheck`、`npm run build` 通过；`npm test`：437 项中 432 通过、5 跳过、0 失败，新增测试覆盖真实 Kuromoji 词位偏移、功能词过滤和旧产物自动升级。
- `npm run smoke`：188/188 通过，包括 EPUB 整书词表引擎标识、原文偏移、漫画制卡及词典点词查询。
- 本地 171 页/2232 文字块样本：空词典下旧算法产出 12840 个 token，其中 9553 个是未收录单个假名；形态分析产出 7243 个 token，过滤后的词表为 1222 个不同词项，未收录单假名词项为 0。此统计只说明切分粒度，不能当作人工标注准确率。
- 未验证范围：Windows 上本轮分词构建与运行、真实漫画人工标注质量、长篇 EPUB 的性能与词典覆盖率。

### 2026-09-28 Anki Harness 验证（macOS / Node 22）

- `npm run typecheck`、`npm run build` 通过；`npm test`：446 项中 441 通过、5 跳过。新增测试覆盖直接筛选、Harness 输出校验、R0 `.apkg`、F3 分歧、R3 待审、批次续跑、LLM 取消与旧草稿失效。
- `npm run smoke`：191/191，通过 Electron IPC 与 UI 检查筛选/制卡入口。Electron 主进程用本地 JPEG 原页和 OCR 像素框实际裁出有效 PNG；生成的 `.apkg` 已验证 SQLite 完整性、笔记、卡和媒体条目。
- 通过 GUI smoke 截取大窗口 Anki 页面并人工检查四步骤、候选区和审核区布局。
- `npm run pack:release -- --dir` 通过；从 macOS 正式包 `app.asar` 中实际加载 `sql.js` 并生成 `.apkg`。
- 未验证范围：Anki 桌面客户端导入及更新行为、Windows 上新版制卡、真实 LLM/翻译供应商的质量和费用、PNG/JPEG 以外页图的裁图，以及新工作流在窄窗口下的人工视觉检查。

### 2026-09-29 Anki Harness 批处理优化（macOS / Node 22）

- F1 每批 12 词；F2/F3 每批 8 词；R1/R2/R3 每批 6 卡。F3/R3 每批两轮请求。格式错误自动拆小批次，完成的子批次落盘后可续跑；异常长原文/译文输入截断并标记卡片待审。
- `npm run typecheck`、`npm run build` 通过；`npm test`：454 项中 449 通过、5 跳过。假模型验证 17 项 F2 与 17 卡 R1 各 3 次调用、7 项 F3 两次与 7 卡 R3 四次调用、错 ID/漏项、格式错及上下文超限缩批和失败续跑。
- `npm run smoke`：192/192，包含 Anki 页面按批次估算 LLM 调用数。未测真实模型的延迟、token 成本与批量答案正确率；Windows 和 Anki 客户端本轮未验证。

### 2026-09-29 LLM 筛选实时反馈（macOS / Node 22）

- 原实现虽按批次落盘，但候选勾选只在全书筛完后改变，长任务看似无效。现每批广播临时保留/排除/待审、累计调用和进度；折叠标题也显示进度。中断原因随检查点保存；中断后可只使用已完成的候选，未处理项暂不制卡，检查点保留以便续跑。
- `npm run typecheck`、`npm run build` 通过；`npm test`：455 项中 450 通过、5 跳过，覆盖批次事件与部分结果应用/续跑；`npm run smoke`：194/194，本地假 LLM 真实 Electron 请求验证中途可见 12/40 的结果且完成后正式应用。
- 未验证范围：真实远端模型在大书上的完整筛选耗时与质量、Windows 上本轮 UI/IPC。

### 2026-09-29 多层直接筛选与 LLM 提交工具（macOS / Node 22）

- 参考本机 `manga_anki` 作品筛选报告，将书内重复、词条类型、通用词频与人工例外拆为可预览的直接筛选层；词频 gzip 资源已随正式包进入 `app.asar`。旧候选读入时补 Zipf，细分词性等仍需重新生成。旧检查点遇规则变更不会被静默丢弃。
- F1–F3、R1–R3 的结构化结果通过强制函数调用提交；不支持工具的兼容端点回退纯 JSON，应用仍严格核对候选 ID。每书可选 1/2/3 个并发批次，默认 2，全应用 LLM 同时请求上限 4；R0 维持顺序翻译。
- `npm run typecheck`、`npm run build`、`npm run pack:release -- --dir` 通过；`npm test`：465 项中 460 通过、5 跳过；`npm run smoke`：197/197。Electron 冒烟覆盖筛选分层、并发选择与工具请求；正式包 `app.asar` 中检出 1,150,520 字节日语词频 gzip。
- 未验证范围：真实远端 LLM 的函数调用兼容性、并发限流与实际加速，Windows 上本轮运行，Anki 客户端导入。作品专名、词频未收录项和 OCR 错词仍需人工审核。

### 2026-09-29 选词 UX 改造（macOS / Node 22）

- 四步骤改为当前步骤单独展示；规则左侧编辑、右侧预览词表，逐词显示排除原因。未收录等级与等级冲突独立勾选，旧书仍读合并配置；新书生成后要先应用规则。AI 可跳过，完整 AI 的待审须人工决定后继续；人工保留/排除集中成三态控件。已有筛选检查点时，输入变更被阻止并提供续跑或明确放弃入口；只使用已完成判断的制卡捷径仍可用。
- `npm run typecheck`、`npm run build` 通过；`npm test` 466 项中 461 通过、5 跳过；`npm run smoke` 200/200，覆盖规则预览与正式选择分离、撤销、AI 任务、待审人工保留。实际界面截图已在 1366×768 与 760×900 检查，见[筛选 UX 文档](anki-filter-ux.md)。
- 未验证范围：Windows 目标系统本轮界面运行、真实 LLM 长书耗时/质量、屏幕阅读器与对比度定量检查、Anki 客户端实际导入。

### 2026-09-29 五步制卡与独立配图（macOS / Node 22）

- 第 3 步缩为手动保留/排除；第 4 步为 R0–R3 释义生成，翻译引擎和需要时的 LLM 配置放在档位下；第 5 步逐卡编辑正面、读音、原句、词义、句译、用法、语气、来源和原图出处，再组装导出。无图、文字框和整页配图由单独的按书设置控制，不会使释义草稿失效或触发模型调用。
- `npm run typecheck`、`npm run build` 通过；`npm test`：467 项中 462 通过、5 跳过；`npm run smoke`：205/205。假翻译服务通过真实 Electron IPC 两次请求生成 R0 草稿，第 5 步编辑后写入磁盘；切换整页/无图不增加外部请求。独立 Electron 主进程从本地 800×1200 PNG 生成 48,923 字节可解码的整页 JPEG。截图见[筛选 UX](anki-filter-ux.md)。
- 未验证范围：Windows 上本轮运行、真实 LLM/翻译供应商的结果与限流、Anki 桌面客户端实际导入三种配图包、长篇漫画的最终包体积。

### 2026-09-29 AI 后台任务队列（macOS / Node 22）

- F1–F3 与 R0–R3 任务由主进程 FIFO 串行执行，IPC 入队立即返回；每本书同时只允许一个任务，同一请求去重。任务内部沿用原有并发、逐批持久化与取消。右下角与 OCR 共用任务弹层：运行/排队进度、停止/取消、最近结果和返回原书制卡页。页面卸载、重新打开或渲染进程重载后可重新读取主进程队列快照。
- `npm run typecheck`、`npm run build` 通过；`npm test` 470 项中 465 通过、5 跳过；`npm run smoke` 209/209。真实 Electron GUI 验证离开 Anki 页去阅读漫画时任务继续、弹层显示 24/40 进度并能返回原书；停止任务后检查点仍在。截图见[筛选 UX](anki-filter-ux.md)。
- 队列本身只在当前应用进程中保留；退出应用后不自动重建任务，已落盘的批次可手动续跑。未验证真实远端 LLM/翻译限流、Windows 目标系统与长时间后台运行。

### 2026-09-29 LLM 返回协议与缓存用量（macOS / Node 22）

- Harness 结果仍统一校验；DeepSeek 标准地址改为 JSON Output，不再先发送与其默认 thinking 不兼容的指定工具请求。OpenAI 官方地址优先严格 JSON Schema，未知兼容端点沿用工具调用并在格式参数被拒时逐级降级。能力按配置/模型/schema 指纹保存 7 天；后台任务的 LLM 配置变化会阻止混用。
- 保存逻辑 Harness 次数、实际 HTTP 尝试、回退次数，以及供应商返回的缓存命中/未命中 token；界面只对已报告数据计算命中率。`npm run typecheck`、`npm run build` 通过；`npm test` 476 项中 471 通过、5 跳过；`npm run smoke` 210/210，假端点统计经 Electron IPC 落盘。详见[协议说明](llm-output-protocol.md)。
- 未用真实 DeepSeek/OpenAI Key 试跑新版请求；服务端缓存命中率、质量和费用仍需用户环境观察，Windows 目标系统未验收。

### 2026-09-29 手动筛词批量按钮（macOS / Node 22）

- 第 3 步把原先藏在列表菜单中的批量人工决定移到步骤主区域：当前列表全保留、当前列表全去除，并可撤销上次批量操作。范围是当前视图、搜索和等级条件匹配的全部词（含其他分页），按钮显示匹配数量；切“全部”视图可操作整本书。
- `npm run typecheck`、`npm run build` 通过；`npm test` 476 项中 471 通过、5 跳过；`npm run smoke` 212/212，在真实 Electron 中验证 AI 待审 13 词的全保留、全去除及撤销。截图见[筛选 UX](anki-filter-ux.md)。Windows 目标系统未验收。

## 下一步：Windows 兼容与修复

优先顺序及具体命令见 [Windows 交接](windows-handoff.md)。

1. push 两个仓库并搬迁 Windows OCR ZIP，恢复模型和 Windows 运行时。
2. `_pth`、`--probe`、30 页进程 OCR、应用 provider/队列与 GUI 已通过；继续分析 Windows 与 Mac 基线差异。
3. 在干净 Windows 上解决/验证 `msvcp140.dll` 条件依赖。
4. Rust **解包器**脚本、`.exe` 资源、Windows 命令启动和平台资源分流已修复；补测真实 RAR 夹具。
5. 导入、阅读、查词、OCR 队列/取消、系统 OCR、debug/release 目录包和 NSIS 构建已通过；仍需在干净机器实际安装/卸载 NSIS。
6. 完成干净环境与跨平台差异评估后，才开放 Windows 仓库资产并上传 Release；同时更新当前文档的证据。

## 其他已知限制

- 新增仓库能发现扩展条目，但 `src/main/index.ts` 目前只注册 `system` 和 `arale_onnx_v1` 两个 OCR provider；任意第三方 provider 的动态注册尚未实现。
- `.zip/.cbz` 整包读内存且超过 2 GB 拒绝；`.rar/.7z` 依赖 Rust 解包器。
- 词典支持 Yomitan；没有 MDX/StarDict/DSL、云同步和联网元数据抓取。
- 两张缓存解码图包含重复权重，当前包体积增加约 95 MiB；未做图合并或 int8 量化验收。
- ONNX runner 默认 CPU EP；存在 CoreML provider 不等于已完成 CoreML 性能/精度验收。
- 归档中的旧性能数字（尤其 Rust OCR、int8 目标体积）已不代表当前实现。
