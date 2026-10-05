# Windows 开发迁移交接

2026-10-05 新增日期 Nightly：只构建 Windows x64/macOS arm64，设置读取原生版本并检查 GitHub 每夜发布；开发版不请求更新。官方 Tauri CLI 2.12.1 已加入 npm 锁文件，本地打包不再依赖全局 cargo-tauri。Node 413 通过/1 跳过、Rust 37/37、开发/Nightly 真实 WebView2 各 195/195、日期 NSIS 打包和 actionlint 通过；GitHub CI 和 macOS 尚未验收。发布前须推送完整 Tauri/共享源码及锁文件，详见[每夜构建](nightly.md)。

2026-10-05 最新沉浸：使用普通无边框窗口精确覆盖当前显示器（包括客户区，沉浸期间关闭 Tao 无标题栏阴影），不随文字草稿切换最大化/全屏。右上角系统栏按钮切换任务栏覆盖，编辑框不自动失焦，页图不跳变；退出恢复窗口样式、原生 WINDOWPLACEMENT、菜单、阴影与调整大小能力，并清理自身系统栏标记。阅读/选择/画笔/橡皮擦/文字统一状态；首笔和非空文字才自动建层，鼠标图标提交草稿返回阅读并保持沉浸。Windows renderer/test 类型检查、Tauri Vite/debug、Rust 34/34、WebView2 GUI 192/192 通过，含原生任务栏前后覆盖、窗口/客户区范围、焦点和草稿、创建/取消/撤销、直接选择移动及完整退出恢复。真实系统输入法模式、多显示器/不同 DPI、macOS/Linux、release/NSIS 未验收。过渡的“文字编辑最大化”方案已移除，见 [批注与跨平台方案](reader-annotations.md)。

2026-10-05 最新交互修正：设置按来源返回阅读/制卡页，空详情栏保留布局；划词先按钮确认再查词；制卡重建回第一步，未完成任务优先恢复，续跑与全量重生成分开；外部 AI 在 Windows 直接打开批次目录。Windows debug/WebView2 172/172、Node 405 通过/1 跳过、Rust 34/34。此次未重打 release/NSIS，当前开发使用 `node scripts/tauri.mjs dev`；先关闭其他应用实例以免唤醒旧 release。见 [制卡阶段恢复](anki-filter-ux.md#当前阶段恢复与重建2026-10-05)。

2026-10-05 最新界面反馈已修正：首页/阅读器恢复原按钮样式，OCR 控件统一高度；设置导航并入标题栏；移除局部命中说明，词典保留原换行，LLM 支持 Markdown，界面字体改为中文优先。Windows 真实 WebView2 161/161，最新 NSIS 20.44 MiB；验证命令与边界见 [设置与词卡 UX](settings-wordcard-ux.md#验证与边界)。下方同日记录保留先前验收范围。

2026-10-05 当前版本：已删除旧 Electron 主进程、预加载、启动/打包脚本与依赖，应用唯一入口为 Tauri。共享业务测试改用 `tests/support/` 注入 Node 端口，测试端口不进入运行包；数据 identifier 保持稳定，本机现有书库继续使用原 Tauri 数据目录。书库/设置/词卡/阅读器布局已整理；Anki 列表按步骤显示状态与数量，支持暂缓及确认后跳到下一张；外部 AI 任务自动保存到 `temp/manual-ai/` 并提供打开文件夹、逐批复制提示词；图层默认只看当前页，展示页码/内容预览；沉浸文字草稿在失焦和输入法组合输入时保留。AnkiDroid 的 `note has 1 fields, expected 12` 已定位为旧 SQL.js 导出遇到候选 ID 的 NUL 字符截断，原桌面包 124 条笔记均只有 1 字段；当前 Tauri 原生 SQLite 包通过 Windows 官方 Anki 26.9.3 导入核心验证。本轮仅分析该导出错误，没有修改 ID、模板或导出规则。验证与边界见 [Tauri 状态](tauri-migration.md#仅保留-tauri-与界面整理2026-10-05)。

2026-10-05 本机数据修正：首次复制受 Codex MSIX 的 AppData 重定向影响，普通路径看到的是物理目录与 `LocalCache\Roaming` 的混合视图，不能据此认定用户正常启动可读取。现已通过本机 UNC 物理视图复制并逐文件 SHA 校验，保留原书库、真实空目标备份与错误影子目录备份。正式版 WebView2/CDP 实测 15 本书、15 个封面、4 部词典载入（87,073 条）、93 张词卡可读，无错误横幅；应用路径安全检查与运行逻辑未改。详情见 [本机一次性迁移](tauri-migration.md#本机一次性迁移2026-10-05)。

2026-10-05 最新决定：项目尚未发布，移除面向用户的旧书库迁入功能。本机 15 本漫画、4 部词典、93 张词卡、批注/分词/制卡记录、4 个阅读位置与现有服务配置已一次性复制到 Tauri 数据目录，源目录不变，复制前目标目录已备份。新用户直接使用当前版本；后续无需做旧版导入 UI。实际安装/卸载与关联验收仍待完成，下方第八阶段记录描述已被撤除的历史入口。

2026-10-05 第八阶段：设置页手动旧书库迁入已接入，源目录只读，保留书籍/进度/词卡/批注/分词/制卡记录与词典，EPUB 缓存重建。密钥/配置、OCR 扩展和浏览器偏好不迁入；恢复在书库载入前执行。Windows 隔离夹具验证和安装包结果见 [Tauri 迁移](tauri-migration.md)。正式用户数据尚未复制，实际安装/卸载与关联验收仍待完成。下文按日期保留旧阶段范围。

2026-10-05 第七阶段：原生菜单、书目录定位和专用文件关联配置已接入；真实第二实例相对路径在阅读时导入已验证。Windows JSON 原子替换遇到临时占用有界重试、持续占用保留旧文件。下一步是用户数据迁入、实际安装/卸载与安装后文件关联验收；当前命令、计数和包体积见 [Tauri 迁移](tauri-migration.md)。下段第六阶段与其后的 OCR/Electron 验证记录保留原范围。

2026-10-05：Tauri/Rust Windows 预览已接入漫画和 EPUB 导入/阅读、手动词典/查词、Kuromoji 整书分词、翻译/LLM、系统与 ONNX OCR、扩展安装/取消/移除；该段为历史迁移范围；当前默认只使用 Tauri，并沿用本机已迁移书库。Anki 候选/F/A 档位/自行 AI/原生 SQLite APKG 已接入，窗口刷新保留检查点但不自动续跑；下一步是用户数据迁入、系统集成和安装包验收。Rust canonicalize 的 Windows `\\?\` 路径需要在交给 WinRT 时转回普通绝对路径，安全校验仍用 canonical 路径。后续应用框架迁移先读 [Tauri 迁移](tauri-migration.md)，下方 OCR/Electron 交接仍保留原验收范围。

核对日期：2026-10-05。先读[当前状态](current-state.md)，再执行本页。本文是当前迁移步骤；旧版原文在 `archive/2026-09-26/`。下方提交号是此前迁移基线，当前工作区仍有后续未提交改动；本地提交不等于推送或发布。

## 1. 源码通过 Git 搬迁

- 应用仓库：`heyanLE/arale-book`。
- `engines/` 是独立仓库 `heyanLE/arale-book-ocr-manga` 的 submodule。
- `codex/windows-handoff` 是历史迁移分支；新设备从主仓库 `main` 克隆，主仓库记录引擎提交的准确指针。
- 此轮已先推送引擎库 `main`（`460b6b4`），再推送应用 `main`（`58412b7`）。后续引擎改动仍须先推引擎仓库，再更新并推送主仓库 gitlink。
- README 与设计笔记一并保存；`.workbuddy/` 是本地工具记忆，已忽略，不随源码提交。
- 小型 JSONL、model-manifest、源码、构建脚本和文档应提交；模型、运行时、ZIP、node_modules 和构建缓存不提交。

功能实现的历史基线提交：引擎 `59eed53`，主仓库功能与 submodule 指针 `91fc064`。在 Windows 用已配置 GitHub SSH key 的 Git 执行：

```powershell
git clone --branch main --recurse-submodules git@github.com:heyanLE/arale-book.git
cd arale-book
git submodule status
git rev-parse --short HEAD
git -C engines rev-parse --short HEAD
```

本轮预期主仓库为 `58412b7`、引擎 gitlink 为 `460b6b4`；若 GitHub 后续有新提交，以新 `main` 为准。已有 clone 时先检查未提交改动，再执行 `git switch main; git pull --ff-only origin main; git submodule update --init --recursive`。`.gitmodules` 的子仓库地址也是 SSH；仅把主仓库 clone URL 改为 HTTPS 不会自动改变子仓库地址。

clone 后 submodule 通常处于 detached HEAD。在 Windows 开始改引擎前，先检查 `git -C engines status`，需要时建立工作分支，例如：

```powershell
git -C engines switch -c codex/windows-fixes
```

## 2. 当前 Windows 发布 ZIP

构建机本地文件位置（大文件不随 clone 恢复，也可从正式 Release 获取）：

`engines/arale_onnx_v1/dist/arale_onnx_v1-windows-x64.zip`

- 724,856,114 字节，约 691.3 MiB。
- SHA-256：`568783245c842a0726b7bafddb723ad8722873bf186a9f6fe67fabbd9a5c3027`。
- 这是 2026-10-01 在 Windows x64 目标机从修正后的 runtime 重新生成并公开到 `v0.2.0` 的正式归档；实际校验值以[Windows 单平台构建记录](../engines/arale_onnx_v1/dist/catalog-entry-win32-x64.json)为准。本地 JSONL 已填 SHA，远端索引更新状态须另核实。
- 包含 fp32 检测器、编码器、KV cache 首步/续步解码器、词表，以及 Windows CPython 3.12 和平台依赖。
- 可从 [v0.2.0 Release](https://github.com/heyanLE/arale-book-ocr-manga/releases/tag/v0.2.0) 下载，或用移动硬盘、局域网共享复制已校验的 ZIP。
- 不要把 Mac 的 node_modules、Python runtime/darwin-arm64、.rust 或 native target 目录复制到 Windows 使用。

## 3. Windows 恢复引擎材料

以下假定源码在 `C:\src\arale-book`，ZIP 放在 `D:\transfer`。使用新 clone 的目录，避免覆盖已有开发材料。

```powershell
$repo = 'C:\src\arale-book'
$engine = Join-Path $repo 'engines\arale_onnx_v1'
$archive = 'D:\transfer\arale_onnx_v1-windows-x64.zip'
$record = Get-Content -LiteralPath (Join-Path $engine 'dist\catalog-entry-win32-x64.json') -Raw | ConvertFrom-Json
$expected = $record.sha256
$actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'OCR ZIP 校验失败，请重新传输' }

$bundle = Join-Path $engine 'build\dev-win32-x64'
Expand-Archive -LiteralPath $archive -DestinationPath $bundle

# 当前上传候选已包含该路径；这段兼容检查也能修复旧迁移 ZIP。
$pth = @(Get-ChildItem -LiteralPath (Join-Path $bundle 'python') -Filter 'python*._pth')
if ($pth.Count -ne 1) { throw '应当只有一个 python*._pth 文件' }
$lines = @(Get-Content -LiteralPath $pth[0].FullName)
if ($lines -notcontains '..\ocr') {
  Set-Content -LiteralPath $pth[0].FullName -Value ($lines + '..\ocr') -Encoding ascii
}

# 还原构建输入，之后改源码可重新生成开发目录和 ZIP。
$runtime = Join-Path $engine 'runtime\win32-x64'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
Copy-Item -LiteralPath (Join-Path $bundle 'models') -Destination (Join-Path $engine 'models') -Recurse
Copy-Item -LiteralPath (Join-Path $bundle 'python') -Destination (Join-Path $runtime 'python') -Recurse
Copy-Item -LiteralPath (Join-Path $bundle 'engine') -Destination (Join-Path $runtime 'engine') -Recurse

Set-Location $repo
node engines/arale_onnx_v1/build.mjs --target win32-x64 --debug

Push-Location $bundle
.\python\python.exe -s -u ocr\ocr_run.py --probe
Pop-Location
```

`--probe` 是 Windows 兼容性工作的第一个验收点；2026-09-26 已在 Windows 11 build 26200 通过，2026-10-01 又从最终上传候选 ZIP 解压后通过。若使用旧迁移 ZIP，`_pth` 修复必须在**复制到 `runtime/win32-x64` 前**完成，因为 `build.mjs` 只复制 runtime，不会自动补这一行。若迁移到别的机器失败，不要从系统 Python 安装包来掩盖自包含运行时的问题。源文件应修改 `engines/arale_onnx_v1/python/`，再重跑 `build.mjs --debug`，不要只改生成目录 `build/dev-win32-x64/ocr/`。

## 4. 应用依赖和原生解包器

在 Windows 安装 Git、Node.js 22 和 Windows Rust/MSVC 构建工具后：

```powershell
Set-Location C:\src\arale-book
npm ci
cargo build --manifest-path native/arale-native/Cargo.toml --release
npm run typecheck
npm test
npm start
```

此处 Rust 只用于 `.rar/.7z` 解包器，OCR 本身是包内 Python + ORT。`scripts/build-native.mjs` / `test-native.mjs` 已支持仓库 `.rust/` 和系统 Cargo，并使用平台 PATH 分隔符；Windows 上 `npm run build:native` 与 50 项 Rust 测试均已通过。

## 5. Windows 待修复与验收

1. **嵌入式 Python 搜索路径**：2026-09-26 在 Windows 11 build 26200 复现 `mokuro_compat` 导入失败；`prepare-runtime.mjs` 已改为校验唯一的 `python*._pth` 并补入 `..\ocr`。重新生成 debug 引擎后，包内 `--probe` 返回 `ok: true`。旧迁移 ZIP 自身仍缺该行，恢复后必须用修正过的 runtime 重新构建，不能直接把旧 ZIP 当作已修复发布物。
2. **VC++ 运行库**：新 headless OpenCV 已消除普通 OpenCV 的 Media Foundation 静态依赖。扫描 186 个 PE 文件没有硬缺失，但仍提示 `msvcp140.dll` 条件依赖；必须在干净 Windows 环境验证，不能仅凭开发机已装运行库判断可分发。
3. **应用打包脚本**：已按平台选择 `arale-native(.exe)`、Vision/WinRT 资源，并在 Windows 调用 `npm.cmd` / `electron-builder.cmd`；debug/release `--dir` 与 NSIS 构建通过。仍需在干净机器实际安装/卸载生成的 NSIS。
4. **功能验收**：包内 Python `--probe`、30 页 OCR、应用扩展服务、队列/取消、CBZ/EPUB/伪装 CBR 原生路径、系统 OCR 和 GUI smoke 已通过；真实 RAR/7Z 私有夹具、干净系统和实际安装仍待补测。
5. **仓库资产**：`v0.2.0` 已公开两个平台 ZIP。Windows 正式包已通过隔离应用下载/校验/解压/安装与下载后单页 OCR；本地 JSONL 已填写 SHA，待提交推送，远端旧索引仍为空。干净环境及 NSIS 验收未完成；索引包含可能需要 VC++ v14 x64 的提示。

2026-10-01 发布后补记：[v0.2.0](https://github.com/heyanLE/arale-book-ocr-manga/releases/tag/v0.2.0) 已公开，GitHub API 两平台 digest 与本地一致。`ARALE_VERIFY_PROXY=http://127.0.0.1:8400` + `node_modules/electron/dist/electron.exe scripts/verify-ocr-download.cjs` 已跑通 Windows 真实下载与安装（724,856,114 字节、SHA 匹配）和下载后 7 行 OCR。脚本不加载 debug 引擎，不改用户扩展目录；报告在 `.tmp/release-download-dYoo4A/report.json`。应用下载器使用系统代理/PAC，没有硬编码该代理。macOS 网络安装、干净 Windows VC++ 与 NSIS 仍待验收；推送索引后用户才可刷新取得 Windows SHA。

## 6. 可选搬迁材料

| 材料 | 用途 | 是否必需 |
|---|---|---|
| 本地 `models/manga-ocr-decoder.onnx`（约 112 MiB，旧无缓存图） | `ARALE_OCR_KV_CACHE=0` 对照性能/文字 | 若要继续做缓存回归，建议带 |
| `manga_anki/factory/.models/manga-ocr-base/` 整个目录（约 424 MiB） | 重新导出编码器/解码器，含配置和词表 | 只做 Windows 运行/打包修复不需要 |
| `manga_anki/factory/.models/mokuro-cache/manga-ocr/comictextdetector.pt`（约 76 MiB） | 重新导出检测器 | 按需 |
| 原始测试漫画或抽样页 | 复现 30 页质量/速度测试 | 建议私人传输，不进公开 Git 仓库 |

不要直接拷整个 `.arale-demo` 当新设备书库：其元数据可能含 Mac 绝对路径，也可能带本机配置。更稳妥的是把需要的原始书籍/页图单独复制，再导入新设备。

## 7. 当前验收基线

- 系统 OCR 保留；旧 PyTorch 与 Rust OCR 源码已移除。
- KV cache：30 页 / 388 行，文字和框与无缓存图完全一致；8 线程下约 126.4 秒 → 96.5 秒。
- 上述是 8 线程测量；运行时默认 4 线程。详细口径集中在[当前引擎文档](../engines/docs/current.md)。
- 对 Mokuro 0.2.5：同批抽样约 98.2% 配对文字逐字一致；并非全量质量保证。
- macOS 引擎 ZIP 688.8 MiB，Windows 本机构建上传候选 691.3 MiB；当前图为 fp32。
- Windows / Node 22.19.0 类型检查通过；400 项应用测试中 395 通过、5 跳过；Rust 50/50 通过。
- macOS 包内解释器、解压后的归档、应用扩展服务均已实际跑过单页 OCR。
- Windows GUI smoke 162/162 通过；开启 `ARALE_SMOKE_OCR=1` 后 183/183 通过，包含 ONNX 4 页真识别、Windows.Media.Ocr 队列/进度/排队/取消。WinRT 脚本必须保存为带 BOM 的 UTF-8，且用 `$args` 接多页参数，才能兼容 Windows PowerShell 5.1。
- 2026-09-26 Windows 11 build 26200 首轮进程验收：嵌入式 Python 3.12.10、ORT 1.30.0、OpenCV 5.0.0、NumPy 2.5.3；`node engines/arale_onnx_v1/build.mjs --target win32-x64 --debug` 与包内 `--probe` 通过。默认 4 线程跑迁移的 30 页耗时 118.948 秒，30/30 页成功、388 行；对缓存版 Mac 预期输出按同页同行比较，文字 379/388、框 343/388、方向 387/388 精确一致，8/30 页完全一致。该结果是 Windows 独立基线，差异尚未判定可接受。
- 同日生成 `ARaLeBook-0.1.0-setup.exe`（127,028,004 字节，SHA-256 `1bc95025f6a79abf1b80016eef220ed5f7a613d6e12be3bfd0482b09897f5e30`）。这是本地未签名/未发布构建记录，不代表已在干净机器完成安装验收。
- 换机前检查两个仓库的 `git status` 和远端分支，确认本地提交已经推送；不要只 clone 旧的远端 main 后就丢弃 Mac 工作区。

给后续会话的任务：阅读此文与 [当前引擎文档](../engines/docs/current.md)，优先在干净 Windows 验证 VC++ 条件依赖与 NSIS 安装/卸载，补真实 RAR/7Z 夹具，并评估 Windows/Mac OCR 输出差异。保持 Mokuro 文字结果与 KV cache 基线，不把 PyTorch 加回用户运行包。
