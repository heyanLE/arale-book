# 当前状态与接续任务

2026-10-07 官网首版：参考 EasyBangumi 并应用用户指定的 frontend-design skill，新增独立 `site/` 静态页面、深浅主题、手机导航、功能介绍、查词示例、每夜/正式下载入口及 FAQ。版本从公开 GitHub Release 读取，未发布正式版时展示真实状态，网络失败使用带日期的核对快照；不显示草稿/缺包，不跳转不存在的 Latest。Windows Chrome 实际浏览器 32 项检查通过，320–1440px 无横向溢出，Vite 生产构建通过。已提供本地预览，尚未部署 GitHub Pages，macOS Safari/实际手机未验收，详见[官网预览](website.md)。

2026-10-06 首次 Nightly 已公开发布：[Nightly 2026.10.6](https://github.com/heyanLE/arale-book/releases/tag/nightly-2026.10.6)。[完整 CI](https://github.com/heyanLE/arale-book/actions/runs/37424997509) 在 Windows Server 2022 x64/macOS 15 arm64 上通过类型检查、Node 测试（各 405 通过/13 跳过）、Rust 测试（37/37、33/33）、安装包构建、严格源码与元数据校验、上传和发布；Windows NSIS 20.46 MiB、macOS DMG 27.52 MiB，公开清单与 GitHub 文件大小/SHA256 一致。已修复测试前缺少前端构建、误跟踪生成权限/Swift 二进制，补充封装有界重试、错误路径和索引回归检查。来源固定为 `d32daec2`，下载后安装/卸载和 macOS 实际运行未验收，命令与验证边界见[发布记录](nightly.md#首次发布通过2026-10-06)。

2026-10-05 每夜构建：新增 Windows x64/macOS arm64 日更 CI，日期版本 `YYYY.M.D`，源码与上次成功发布一致或当天已发布则跳过；冻结源码/引擎指针，两个平台通过后统一上传并公开 GitHub prerelease。设置显示原生版本/渠道/提交/批次时间，Nightly 可检查更新并打开对应下载页，开发版与正式版不检查。macOS Vision 工具新增 Resources 打包路径，前端兼容 Safari 17；本轮 Windows Node 413 通过/1 跳过、Rust 37/37、开发/Nightly 真实 WebView2 各 195/195、日期 NSIS 打包和 actionlint 通过。GitHub CI 首次运行、macOS 和下载后安装尚未验收，详见[每夜构建](nightly.md)。

2026-10-05 最新沉浸/批注方案：替换“文字编辑自动切换全屏/最大化”的过渡方案。Windows 使用精确覆盖当前显示器的无边框窗口，关闭无标题栏阴影；系统栏按钮通过本窗口全屏标记控制任务栏覆盖，窗口与客户区不变。macOS 使用当前 Space 的 simple fullscreen 与 presentation options，尚未运行验收。批注统一阅读/选择/画笔/橡皮擦/文字，工具不建空层，首份内容与自动层一次撤销；鼠标图标提交草稿返回阅读并保留沉浸，支持直接选择移动，橡皮只作用于当前画笔层。右上角纯图标并修正悬停对比度。Windows renderer/test 类型检查、Tauri Vite/debug、Rust 34/34、WebView2 GUI 192/192 通过；实际中英/A／あ模式切换、多显示器及其他 DPI、macOS/Linux、release/NSIS 待验收。详见 [跨平台方案与验证](reader-annotations.md)。

2026-10-05 最新阅读/制卡交互修正：设置按来源返回阅读器或词汇/制卡页，保留阅读位置与制卡表单；空详情栏按开启偏好保留，首次选书不再改变列表宽度。划词只显示鼠标旁的查词按钮，确认后查询，取消的异步结果不再弹卡；漫画与 EPUB 均支持。制卡重建候选回第 1 步，恢复时优先未完成任务，第 4 步区分续跑与全量重生成，第 5 步无草稿不可进入，待核对/暂缓统计已修正。Windows 外部 AI 直接打开任务目录，并转换 canonical 路径供 Shell 使用。renderer 类型检查/Vite、Node 405 通过/1 跳过、Rust 34/34、真实 WebView2 GUI 172/172、debug 构建通过；本轮未重打 release/NSIS。详情见 [制卡状态](anki-filter-ux.md#当前阶段恢复与重建2026-10-05)及[阅读交互](settings-wordcard-ux.md)。下方 UI 包大小对应此前产物。

2026-10-05 最新界面反馈：首页顶部取消选中态底部横线、恢复旧按钮样式；漫画底部恢复直接可见的排版/OCR 控件，按钮及下拉统一 24px。设置导航移进标题栏，与“重置界面偏好”同行。词卡删除“词典仅命中”说明；明鏡原词典包含换行，修正展示层以保留换行；LLM 分栏支持安全的 Markdown 展示。界面文案为简体中文，字体顺序改为中文优先，本机实测微软雅黑 UI。Windows renderer 类型检查/Vite、Node 404 通过（1 跳过）、WebView2 GUI 161/161、release/NSIS 构建通过，最新安装包 21,428,398 字节（20.44 MiB）。详情与未验证范围见 [词卡与设置 UX](settings-wordcard-ux.md#验证与边界)。下方同日界面整理记录为先前验证范围。

2026-10-05 当前版本：已删除旧 Electron 主进程、预加载、启动/打包脚本与依赖，应用唯一入口为 Tauri。共享业务测试改用 `tests/support/` 注入 Node 端口，测试端口不进入运行包；数据 identifier 保持稳定，本机现有书库继续使用原 Tauri 数据目录。书库/设置/词卡/阅读器布局已整理；Anki 列表按步骤显示状态与数量，支持暂缓及确认后跳到下一张；外部 AI 任务自动保存到 `temp/manual-ai/` 并提供打开文件夹、逐批复制提示词；图层默认只看当前页，展示页码/内容预览；沉浸文字草稿在失焦和输入法组合输入时保留。AnkiDroid 的 `note has 1 fields, expected 12` 已定位为旧 SQL.js 导出遇到候选 ID 的 NUL 字符截断，原桌面包 124 条笔记均只有 1 字段；当前 Tauri 原生 SQLite 包通过 Windows 官方 Anki 26.9.3 导入核心验证。本轮仅分析该导出错误，没有修改 ID、模板或导出规则。验证与边界见 [Tauri 状态](tauri-migration.md#仅保留-tauri-与界面整理2026-10-05)。

2026-10-05 本机数据修正：首次复制受 Codex MSIX 的 AppData 重定向影响，普通路径看到的是物理目录与 `LocalCache\Roaming` 的混合视图，不能据此认定用户正常启动可读取。现已通过本机 UNC 物理视图复制并逐文件 SHA 校验，保留原书库、真实空目标备份与错误影子目录备份。正式版 WebView2/CDP 实测 15 本书、15 个封面、4 部词典载入（87,073 条）、93 张词卡可读，无错误横幅；应用路径安全检查与运行逻辑未改。详情见 [本机一次性迁移](tauri-migration.md#本机一次性迁移2026-10-05)。

核对日期：2026-10-05。应用源码开发基础版本 `0.1.0`，Nightly 使用构建日期版本，OCR 扩展版本 `0.2.0`。

2026-10-05 最新决定：项目尚未发布，删除旧书库迁入设置卡片、IPC/Worker/类型、Rust 迁入事务/启动恢复及专用测试/夹具。已按用户要求一次性迁移本机实际数据：15 本漫画、4 部词典、93 张词卡、3 本批注、2 本分词记录、制卡记录和 4 个阅读位置，以及现有翻译/LLM/默认设置。3064 个文件共 2,276,547,903 字节，复制 SHA 校验一致、源文件复核未变，旧目录保留并备份复制前目标目录；Rust 后台只读加载实际数据与配置通过，不调用外部服务。应用不再提供旧版迁入入口，后续用户直接使用 Tauri 数据根。类型/Vite/debug 构建通过，Rust 32/32，隔离 GUI/Node 对照 155/155；release/NSIS 重建通过，安装包 21,374,847 字节（20.38 MiB），未安装验收。详情见 [本机一次性迁移](tauri-migration.md#本机一次性迁移2026-10-05)。下方第八阶段和界面调整记录保留历史范围，其迁入功能已撤除。

2026-10-05 界面调整：移除顶部常驻 Tauri 迁移提示；数据根保持独立，旧 Electron 书库仍在原目录，可通过设置页迁入。renderer 类型检查、Tauri Vite/debug 构建通过；未重跑整套 GUI，未覆盖正在运行的 release 或重打 NSIS，关闭旧窗口后用 `node scripts/tauri.mjs dev` 载入新页面。下方第八阶段包大小和全量测试记录对应调整前产物。

2026-10-05 Tauri 第八阶段：设置页手动迁入旧书库已接入，保留书籍/阅读位置/词卡/批注/分词/制卡记录及词典；书 ID/图片和章节路径保留，目标 dir 重绑定，旧 EPUB 缓存清洗重建。源目录只读、复制 SHA 校验、重复 ID 跳过、事务回滚/启动恢复已验证；密钥/配置、OCR 扩展、浏览器偏好仍单独配置。Windows：Node 541 项（536 通过、5 跳过）、Rust 41/41、迁入/服务/制卡/OCR 适配器 4/6/5/3 全通过、真实 WebView2 GUI/Node 对照 168/168。release 28.14 MiB，NSIS 21,419,329 字节（20.43 MiB），7-Zip 检查和包内 EXE 内容对照通过。正式数据尚未复制，默认仍 Electron。安装/卸载及关联验收未完成，详情见 [第八阶段验证](tauri-migration.md#第八阶段验证2026-10-05)。下方历史各阶段保留当时范围。

2026-10-05 Tauri 第七阶段：原生文件/编辑/视图/阅读/帮助菜单、书目录系统定位、专用 EPUB/漫画/Mokuro 文件关联配置已接入。第二实例按来源 cwd 解析相对路径，阅读/设置页也能导入，刷新期间暂存打开请求。Windows 原子 JSON 替换对临时占用有界重试，持续失败保留旧文件。Node 541 项（536 通过、5 跳过），Rust 32/32；真实 WebView2 GUI/Node 对照 155/155；服务/制卡/OCR 适配器 6/5/3 项全部通过。release EXE 约 28.00 MiB；NSIS 构建通过，最终 21,376,964 字节（20.39 MiB），包内 EXE SHA 与 release 一致；关联命令引号已通过 hook 修正。默认仍 Electron、预览独立书库；下一步为旧数据迁入、安装/卸载与安装后关联验收。命令、安装包结果与未验证范围见 [第七阶段验证](tauri-migration.md#第七阶段验证2026-10-05)。

2026-10-05 Tauri 第六阶段：Anki 制卡后台已接入。候选、F1–F3、五字段/A0–A4、有限修复、预算、截断卡片恢复、队列和自行 AI 共用原 TypeScript；Rust 管理原子检查点、书/文字层/词典版本检查、文件选择授权、配图与原生 SQLite APKG。首次 MD 任务保存直接记录实际目录；导出失败不标记成功。切换页面继续，窗口刷新或应用退出中断队列并保留检查点，需手动续跑；旧 Worker 不能写回，刷新会取消已登记的旧制卡 HTTP。默认仍 Electron、预览独立书库。下一步是旧书库迁入、菜单/文件关联/系统定位和 NSIS 验收。本轮 Node 541 项（536 通过、5 跳过），Rust 29/29，制卡/服务/OCR 适配器 5/6/3 项全部通过；真实 WebView2 GUI/Node 对照 150/150。release EXE 29,318,656 字节（约 27.96 MiB），未运行 release、未生成 NSIS。计数、命令与边界见 [第六阶段验证](tauri-migration.md#第六阶段验证2026-10-05)。

2026-10-05 Tauri 第五阶段：OCR/扩展已接入。Rust 保持书级 FIFO、NDJSON、原生进程树、进度/取消；Worker 复用原 TypeScript 成块、排序和 mokuro 序列化，取消保留已识别页及原有文字，提交前核对源数据。Windows 系统 OCR 与 submodule 的真实 Python/ORT 已运行，界面重载后任务可完成。JSONL 仓库、HTTPS 流式下载、大小/SHA/runner 校验、暂存发布、事务恢复和使用保护已接入；Windows 临时文件占用导致的目录发布失败改为有界重试，不删除目标以强行发布。引擎 submodule 未修改。默认仍 Electron、Tauri 独立书库，无运行时 Node；下一步是 Anki 存储/队列/自行 AI/导出。命令、最新计数、release 体积和未验证范围见 [第五阶段验证](tauri-migration.md#第五阶段验证2026-10-05)。

本阶段 Windows 验证：Node 541 项（536 通过、5 跳过），Rust 25/25，服务适配器 5/5、OCR 适配器 3/3；真实 WebView2 GUI/Node 对照 118/118，6 份 OCR 产物一致。release EXE 26,479,616 字节（约 25.25 MiB）；未运行 release、未生成 NSIS、未在 Tauri 真实下载官方引擎，也未重新验收 Electron GUI。

2026-10-04 Tauri 迁移第四阶段（Windows 11 x64）：翻译/LLM 已接入。六提供商协议与 Electron 共用，Rust 保存密钥、处理 HTTP/百度签名、端点校验、超时/取消；独立 Worker 保留提示词、结构化降级、能力缓存、token 预算/usage/cacheHit/cacheMiss 和截断文本。模型等待不持有书库存储锁，配置快照保留在途行为，双层 LLM 并发上限 4。Node 541 项中 536 通过、5 跳过；Rust 16/16；适配器 5/5；真实 WebView2 GUI/Node 对照 91/91，含词卡翻译/分析按钮；六供应商测试使用本地 HTTP 夹具，无真实付费调用。默认仍 Electron，Tauri 独立书库，无运行时 Node。OCR/扩展和完整 Anki 编排/截断卡片恢复/导出尚未迁移，下一步 OCR/扩展。release 结果与未验证范围见 [Tauri 迁移](tauri-migration.md)。

2026-10-04 Tauri 迁移第三阶段（Windows 11 x64 / Node 24.19.0 / rustc 1.96.0）：在漫画/图片、书库/进度、词卡/批注、手动词典与 Kuromoji 基础上，接入 EPUB 导入、章节阅读/排版、相对图片/字体、点词/划词、目录/链接/键盘跳转及 EPUB 整书分词。复用现有 TypeScript 解析与规则，Rust 管理解压/暂存/发布/源文件 SHA，通过独立 arale-book 协议、脚本 hash CSP 和不透明来源 iframe 服务章节；ZIP/TOC 路径避免重复解码。图片型 EPUB 保持小说格式，使用漫画阅读器与 ASCII 页图。默认仍是 Electron，预览独立书库，运行时无 Node。本轮 Node 541 项中 536 通过、5 跳过；Rust 13/13；真实 WebView2 GUI/Node 对照 69/69，三本 EPUB 的解析及测试 EPUB 完整分词/词表对照通过；最终 release 结果见 [Tauri 迁移](tauri-migration.md)。翻译/LLM、OCR/扩展、Anki 后台、完整安装包及旧数据迁入仍待接续；未重新验收 Electron GUI 或其他平台。下一步为翻译/LLM 后台，保留现有提示词、A0–A4 分流、缓存统计与截断恢复。

2026-10-03 词卡分栏偏好与多词典（Windows 11 / Node 24.19.0）：词典/翻译/LLM 三栏记忆应用级展开状态，跨词卡/书籍及重载沿用；空结果临时收起不覆盖偏好。多词典默认首部/已选来源，“展开更多”显示全部词典的完整结果，并可选择保存来源。`node node_modules/typescript/bin/tsc -p tsconfig.renderer.json --noEmit`、`node node_modules/vite/bin/vite.js build` 通过；`node scripts/smoke.mjs` 291/291，退出码 0，新增真实 IPC 导入三部词典、展开/收起、独立偏好及渲染重载验证，截图已检查。本轮只改 renderer/GUI，核心单测未重跑；未验证 macOS/Linux、正式安装包、窄窗口/多 DPI 及大量真实词典长释义的人工验收。详见[词卡 UX](settings-wordcard-ux.md)。

2026-10-03 沉浸侧栏与批注工具（Windows 11 / Node 24.19.0）：沉浸右上角提供画笔/橡皮擦/文字、完成编辑、侧栏和退出入口；可查看已保存词卡并打开弹窗，侧栏仍占独立空间。普通底部与沉浸工具复用逻辑及 SVG 图标。`node node_modules/typescript/bin/tsc -p tsconfig.renderer.json --noEmit`、`node node_modules/vite/bin/vite.js build` 通过；`node scripts/smoke.mjs` 280/280，退出码 0，普通/沉浸截图已检查。本轮仅改 renderer 与 GUI 脚本，核心单测未重跑；未验证其他平台、正式安装包、窄窗口/多 DPI 人工验收及文本 EPUB 沉浸侧栏的专项 GUI 操作。详见[批注图层](reader-annotations.md)。

2026-10-03 批注快捷工具（Windows 11 / Node 24.19.0）：底部常驻画笔/橡皮擦/文字，无需打开侧栏；画笔每次点击新建层，橡皮擦只擦当前/最近画笔层，文字点击工具后再点页图建层，放置前取消不留空层。`node node_modules/typescript/bin/tsc -p tsconfig.renderer.json --noEmit`、`node node_modules/vite/bin/vite.js build` 通过；`node scripts/smoke.mjs` 270/270，退出码 0，截图已检查。本轮仅改 renderer，核心测试沿用下面的同日图层验证；未验证其他平台、正式安装包及窄窗口/多 DPI 人工验收。详见[批注图层](reader-annotations.md)。

2026-10-03 阅读侧栏调整（Windows 11 / Node 24.19.0）：右上角改为“沉浸 → 侧边栏”，侧栏提供词卡夹/图层管理标签，词卡数量移到标签；图层管理从底部移到右侧，右键可直达，底部保留显示开关/编辑工具。renderer 类型检查及 Vite 生产构建通过，`node scripts/smoke.mjs` 263/263，退出码 0，含标签切换、批注保留和侧栏不覆盖阅读区；截图已检查。该轮仅改 UI，核心单测结果沿用下面的图层验证；未验证其他平台、正式安装包及窄窗口/多 DPI 人工验收。详见[批注图层](reader-annotations.md)。

2026-10-03 漫画/图片批注图层（Windows 11 / Node 24.19.0）：右键新建画笔与纯文字图层，底部显示开关与本书管理区，支持锁定/排序、原图坐标、整笔橡皮、多行/竖排/背景、文字移动/文本框调整、撤销重做及明确当前操作页。批注独立保存，不修改 OCR/原图/Anki；串行 revision 保存、错误保留草稿、原图失配隐藏及清空入口。main/renderer/test 类型检查与生产构建通过；`node --test --test-concurrency=1 "dist-test/tests/*.test.js"` 539 项、534 通过、5 跳过；`node scripts/smoke.mjs` 258/258，退出码 0。GUI 含真实指针/键盘、双页、界面重载及保存冲突；范围确认与关闭检查使用替身/合成事件，未验证系统关闭按钮、其他平台及正式安装包。使用方式、代码入口及验证边界见[批注图层](reader-annotations.md)。

2026-10-02 自行 AI 模式最新验证（Windows 11 / Node 24.19.0）：第 2/4 步可按每份 1–100 词导出 MD 和简短提示词，外部处理后逐份粘贴 JSON；校验批次/快照并持久进度，不调用应用内 LLM/翻译。类型检查及生产构建通过；`node --test --test-concurrency=1 "dist-test/tests/*.test.js"` 527 项、522 通过、5 跳过；`node scripts/smoke.mjs` 227/227，退出码 0。GUI 已验证模式切换、临时任务恢复/输入框导入及原文变更后的清除入口；原生目录窗口、真实外部模型语义质量和 Anki 客户端导入未验证，详见[自行 AI 模式](anki-harness.md#自行-ai-模式)。

2026-10-02 五字段制卡方案最新验证（Windows 11 / Node 24.19.0）：main/renderer/test 类型检查与生产构建通过；`node --test --test-concurrency=1 "dist-test/tests/*.test.js"` 520 项、515 通过、5 跳过；`node scripts/smoke.mjs` 222/222，退出码 0。字段、档位和罗马音试验范围见[Anki Harness](anki-harness.md)，本轮未验证真实供应商质量及 Anki 客户端导入。
功能基线：应用提交 `91fc064`、文档整理前提交 `1b57c64`；引擎功能提交 `59eed53`。这些是定位历史的基线，当前 HEAD 用 `git log` 查看。

## 现在是什么

2026-10-04：Tauri 第四阶段 debug/release 构建通过，release EXE 26,059,776 字节（约 24.85 MiB，含 Kuromoji 辞书与翻译/LLM HTTP 后台，功能未迁完）；命令与范围见 [迁移验证](tauri-migration.md)。运行验证覆盖 debug WebView2；release 运行、NSIS 与完整迁移安装包体积未验证。

ARaLeBook 是 Tauri + Rust + React/TypeScript 的本地漫画/EPUB 管理与日语学习阅读器。当前主流程包括导入、书库、漫画/小说阅读、点词/划词查询、词卡、词典分词、可选 OCR、多提供商翻译与 OpenAI 兼容 LLM 分析。
纯逻辑在 `src/core/`，原生后台在 `src-tauri/src/`，UI 在 `src/renderer/`。源码导航见[架构](architecture.md)。

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
| 发布 | 引擎仓库 `v0.2.0` 已公开，macOS/Windows 两个资产的 GitHub digest 与本地构建记录一致。Windows 已通过真实网络下载、应用安装和下载后单页 OCR；本地 JSONL 已补 Windows SHA，尚需提交/推送索引及应用改动。干净 Windows 的 VC++ 条件依赖仍未验收 |
| 翻译 | 词卡内支持整段/整框或选区翻译；提供 Bing 网页翻译（免 Key）、Microsoft、DeepL、Google、百度和 LibreTranslate，配置与密钥留在主进程；Bing 直接复刻网页 `translate()` 协议，不额外引入 npm 依赖，并显示后台返回的日文原文罗马音 |
| 词卡定位 | 弹窗在选区的下、上、右、左等候选位置中按遮挡面积选择位置；翻译/LLM 内容展开和窗口缩放时自动重新定位，用户手动拖动后保留手动位置 |
| 漫画/图片批注 | 画笔/文字图层按书管理、内容按页图保存，位于 OCR 文字层下面；底部常驻画笔建层/当前画笔层橡皮/文字点击放置工具及总开关，右键新建、右侧图层管理，支持锁定/排序、撤销、整笔橡皮、多行文字、几何缩放同步。`comic-annotations.json` 独立存储并校验 revision 与原图 SHA；文本 EPUB 暂不支持。详见[批注图层](reader-annotations.md) |
| 漫画学习候选 | 在现有分词页增加 Anki 制卡标签：Kuromoji 形态分析、社区 JLPT 参考等级、候选审核与短语补录；每书 `study-list.json` 保存人工选择，导出 UTF-8 Anki 文本。实现细节见[方案与状态](manga-vocabulary-anki-plan.md) |
| Anki Harness | 五步保留，第 4 步先选假名、本词含义、原句、句子含义、辞书形，再选 A0–A4：A0 本地，A1 词典多义＋翻译，A2 仅缺词调用 AI，A3 单义本地/多义及缺词语境选义，A4 全量语境分析。A1/A2 多义不强制待审，无词典的 AI 补全可通过并标来源；A3/A4 提供邻句、词典、辞书形及预先取得的句译，不额外复核，问题修复上限三次（A2 一次）。翻译配置显示能力，Bing 罗马音保守回退为假名，记录来源。未选字段不要求生成或审核，原句＋辞书形可零外部请求；新字段卡为 Anki v2，旧 R 为 v1。旧 A 检查点需显式重建，后台、预算、配图、1–3 并发沿用。详见[Anki Harness](anki-harness.md)及[LLM 协议](llm-output-protocol.md)。 |
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

macOS 应用打包配置下限为 11；当前 ONNX Runtime wheel 要求 macOS 14，扩展条目用 `minMacOS: 14` 限制安装。Windows x64 已完成本机运行、目录包/NSIS 构建与 OCR 正式下载安装验证，干净系统依赖和 NSIS 实际安装/卸载仍待验收；Linux 只有构建配置，尚无运行记录。

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

### 2026-09-29 词卡待审导出提示（macOS / Node 22）

- R1 生成的一本现有书有 183 张草稿，其中 20 张因 OCR 疑点、断句或歧义被模型标为待审；草稿数量和词单哈希一致，导出按钮禁用是既有审核门槛。第 5 步现默认显示“词卡待审”列表，列出逐卡原因和明确的导出禁用说明，最后一张通过审核后返回完整词单并恢复按钮。未改动这本书的持久数据。
- `npm run typecheck`、`npm run build` 通过；`npm test` 476 项中 471 通过、5 跳过；`npm run smoke` 214/214，使用隔离 Electron 数据目录验证待审卡拦截、原因显示、人工通过与按钮恢复。Windows 目标系统和 Anki 客户端导入本轮未验收。

### 2026-09-30 macOS OCR 草稿分发（macOS arm64）

- 引擎仓库 [v0.2.0 草稿 Release](https://github.com/heyanLE/arale-book-ocr-manga/releases/tag/untagged-f9d76c87bef99f6d63e5) 已上传且仅包含 `arale_onnx_v1-macos-arm64.zip`（GitHub 页面显示 Assets 1、688.85 MB、Draft）。本地 ZIP 为 722309909 字节，SHA-256 `9d83ceca86f6c5e29f635eba2b0b9ab03d06d5c9ff7bc9d09b7f0eb9de244539`，与 JSONL 一致；`unzip -tqq` 通过。草稿未公开，`v0.2.0` 标签会在正式发布时创建，当前应用内的计划下载 URL 仍不可用。
- Windows ZIP 未上传，JSONL 的 Windows SHA 保持空值；2026-10-01 已在 Windows x64 目标机重新构建并验证上传候选，详情见下节。仍未把它开放安装。

### 2026-10-01 Windows OCR 发布包整理（Windows 11）

- `node arale_onnx_v1/build.mjs --target win32-x64` 生成 `arale_onnx_v1-windows-x64.zip`：724,856,114 字节（约 691.3 MiB），SHA-256 `568783245c842a0726b7bafddb723ad8722873bf186a9f6fe67fabbd9a5c3027`；4,632 个文件，解包 1,043,229,186 字节（约 994.9 MiB）。
- 将最终 ZIP 解压到独立临时目录后，包内 `python/python.exe -s -u ocr/ocr_run.py --probe` 返回 `ok: true`；`python312._pth` 包含 `..\ocr`，五个模型文件 SHA 全部匹配 `model-manifest.json`。
- 用最终 ZIP 内运行时识别 `samples/ocr-fixture.png` 成功：800×1200、7 行日文；`node tools/audit-win-deps.mjs <解压目录>` 扫描 186 个 PE 文件，没有硬缺失，仍报告 `msvcp140.dll` 条件依赖。
- 未验证范围：干净 Windows 未安装 VC++ 运行库时的启动、从 GitHub Release 实际下载/安装、NSIS 安装/卸载和更大真实书籍。Windows 资产可先上传到草稿 Release，但 JSONL SHA 在完成发布验收前保持为空。

### 2026-10-01 正式 Release 下载与安装（Windows 11）

- GitHub API 确认 `v0.2.0` 为公开正式 Release，两平台资产大小及 SHA-256 均匹配构建记录；本地官方 JSONL 补入 Windows SHA 和 VC++ 运行库提示。
- 应用扩展下载改用 Electron 网络栈，遵循系统代理/PAC，继续流式落盘、HTTPS 重定向检查与 SHA 校验；修复重定向超限、断流挂起、无数据时无法取消及 Chromium 解压 HTTP gzip 后长度误判。安装时另校验清单字节数；同版本随包有效 SHA 可覆盖旧缓存空 SHA。
- 验收命令：`node node_modules/typescript/bin/tsc -p tsconfig.main.json`、renderer `--noEmit`、test 编译及 `node --test dist-test/tests/extension-download.test.js dist-test/tests/extensions.test.js`；相关测试 37/37 通过。
- 使用 `ARALE_VERIFY_PROXY=http://127.0.0.1:8400` 启动 `node_modules/electron/dist/electron.exe scripts/verify-ocr-download.cjs`：隔离扩展目录、无 debug 引擎，实际从 GitHub 下载 724,856,114 字节，通过 SHA/解压/安装记录，随后由 `ExtensionOcrEngine` 对 `samples/ocr-fixture.png` 输出 7 行。报告保留在 `.tmp/release-download-dYoo4A/report.json`（不提交）。代理仅在验收脚本中指定，应用未硬编码本机代理。
- 远端 JSONL 此次仍是旧空 SHA；隔离验收用更新后的本地索引覆盖同版本旧缓存。对所有用户开放还需推送引擎索引，旧应用可刷新仓库；应用下载器修复需新版应用。未验证 macOS 正式网络安装、镜像、干净 Windows VC++ 依赖及 NSIS 安装/卸载。

### 2026-10-02 Anki Harness 重构（Windows 11 / Node 24.19.0）

最后一次 GUI 冒烟的 219 个断言通过；退出清理临时目录遇到 Windows `EPERM`，退出码 1，详见 Harness 验证记录。

- 新 A0–A4 统一流水线已接入 IPC/UI/后台队列：优选例句、当前手动导入词典证据、直接语境生成、风险/全量复核、最多一次修复与 A3/A4 修复后再核查；可选提示存疑自动删除，核心问题仍待审。修复并不保证正确率提升，需人工样本评测。
- 新档位支持 token 估算/预算、每次新增卡数、同计划复用已完成卡；预算不足或数量超限暂缓。只导出已通过子集，更新实际导出的候选标记；改出处重置审核。词典、模型/端点/密钥与翻译配置变化不能混入旧待完成计划。没有自动下载词典，也没有修改用户正式词典库。
- 验证：`node node_modules/typescript/bin/tsc -p tsconfig.main.json`、renderer `--noEmit`、test 编译通过；`node scripts/bundle-preload.mjs` 和 `node node_modules/vite/bin/vite.js build` 通过；`node --test "dist-test/tests/*.test.js"` 499 项，494 通过、5 跳过、0 失败；`node scripts/smoke.mjs` Windows Electron GUI 219/219。完整命令与跳过项见 [Harness 验证](anki-harness.md)。
- 未验证：真实供应商输出质量/限流/费用、审核量和整卡准确率收益、Anki 客户端导入/更新、macOS/Linux 新版运行及完整多 DPI/窄窗口视觉验收。A0/A1/A2 本地结果明确标为词典参考，不宣称语境已确认；A4 仍用同一模型且能看到草稿。

## 下一步：Windows 兼容与修复

2026-10-02 后续 Anki 修复：A 生成/复核提高输出额度，单卡截断有界扩额；临时恢复已闭合且校验完整的条目，保留已通过卡，只对剩余项缩批，JSON 回退补完整 schema。Windows 类型/生产构建通过；针对测试 63/63，串行全量 507 项中 502 通过、5 跳过；GUI 219 个断言通过但退出清理仍报 `EPERM`。规则、并行回归的下载器失败记录与未验证范围见 [Harness](anki-harness.md#输出额度与临时截断恢复2026-10-02)。

优先顺序及具体命令见 [Windows 交接](windows-handoff.md)。

1. 提交/推送引擎索引及应用下载器改动；ZIP 已公开，不需重新上传。
2. `_pth`、`--probe`、30 页进程 OCR、应用 provider/队列与 GUI 已通过；继续分析 Windows 与 Mac 基线差异。
3. 在干净 Windows 上解决/验证 `msvcp140.dll` 条件依赖。
4. Rust **解包器**脚本、`.exe` 资源、Windows 命令启动和平台资源分流已修复；补测真实 RAR 夹具。
5. 导入、阅读、查词、OCR 队列/取消、系统 OCR、debug/release 目录包和 NSIS 构建已通过；仍需在干净机器实际安装/卸载 NSIS。
6. 继续干净环境与跨平台差异评估；公开下载与本机安装验收不代表这些测试已完成。

## 其他已知限制

2026-10-02 文档核对：主 README、引擎库/引擎目录 README 与开发命令页已同步 Windows 运行及构建记录；本轮仅改文档，未重新运行测试。上方按日期记录的 macOS“本轮 Windows 未验证”保留其历史含义，当前 Windows 覆盖范围以最新验证节和 README 为准。

- Electron 的 `src/main/index.ts` 目前只注册 `system` 和 `arale_onnx_v1` 两个 OCR provider；Tauri 根据已安装 manifest 的 `provides` 动态接入协议兼容 runner，本轮使用额外测试 provider 验证，未验收任意第三方真实引擎。
- `.zip/.cbz` 整包读内存且超过 2 GB 拒绝；`.rar/.7z` 依赖 Rust 解包器。
- 词典支持 Yomitan；没有 MDX/StarDict/DSL、云同步和联网元数据抓取。
- 两张缓存解码图包含重复权重，当前包体积增加约 95 MiB；未做图合并或 int8 量化验收。
- ONNX runner 默认 CPU EP；存在 CoreML provider 不等于已完成 CoreML 性能/精度验收。
- 归档中的旧性能数字（尤其 Rust OCR、int8 目标体积）已不代表当前实现。
