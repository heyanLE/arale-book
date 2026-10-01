# Windows 开发迁移交接

核对日期：2026-10-01。先读[当前状态](current-state.md)，再执行本页。本文是当前迁移步骤；旧版原文在 `archive/2026-09-26/`。当前开发成果已合入并推送两仓库的 `main`；本地提交不等于推送或发布。

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

## 2. 必搬的大文件：一个现成 Windows ZIP

Mac 文件位置：

`engines/arale_onnx_v1/dist/arale_onnx_v1-windows-x64.zip`

- 724,064,723 字节，约 690.5 MiB。
- SHA-256：`df1371702cf27cb457d613e6edc5e992511f766198deb11ffb26418e58bd7107`。
- 这是本次迁移快照；以后重建 ZIP，实际校验值以[Windows 单平台构建记录](../engines/arale_onnx_v1/dist/catalog-entry-win32-x64.json)为准，不要从安装仓库中的空 SHA 取校验值。
- 包含 fp32 检测器、编码器、KV cache 首步/续步解码器、词表，以及 Windows CPython 3.12 和平台依赖。
- 用移动硬盘、U 盘、局域网共享或私人网盘复制即可。不必为了迁移先公开发布 Release。
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

# 迁移用的旧 ZIP 缺少这条路径；修复解压后的自带 Python，再用它生成新版包。
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

`--probe` 是 Windows 兼容性工作的第一个验收点；2026-09-26 已在 Windows 11 build 26200 通过。旧 ZIP 的 `_pth` 修复必须在**复制到 `runtime/win32-x64` 前**完成，因为 `build.mjs` 只复制 runtime，不会自动补这一行。若迁移到别的机器失败，不要从系统 Python 安装包来掩盖自包含运行时的问题。源文件应修改 `engines/arale_onnx_v1/python/`，再重跑 `build.mjs --debug`，不要只改生成目录 `build/dev-win32-x64/ocr/`。

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
5. **仓库资产**：Windows ZIP 是交叉构建，JSONL 的 Windows sha256 故意为空，应用拒绝安装。只有完成 Windows 真机验收后，才能写入真实 SHA 并上传 Release。主仓库和引擎库的源码先后推送，不代表 Release 已上传。

2026-09-30 补记：macOS arm64 ZIP 已上传到引擎仓库 `v0.2.0` **草稿** Release（仅一个资产），尚未公开或创建正式 tag；Windows ZIP 未上传。接手时可在同一草稿补 Windows 资产，但先完成干净 Windows 运行依赖、应用下载/安装和 NSIS 安装/卸载验收，再更新 JSONL 的 Windows SHA。草稿链接见[当前状态](current-state.md)。

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
- macOS 引擎 ZIP 688.8 MiB，Windows 交叉 ZIP 690.5 MiB；当前图为 fp32。
- Windows / Node 22.19.0 类型检查通过；400 项应用测试中 395 通过、5 跳过；Rust 50/50 通过。
- macOS 包内解释器、解压后的归档、应用扩展服务均已实际跑过单页 OCR。
- Windows GUI smoke 162/162 通过；开启 `ARALE_SMOKE_OCR=1` 后 183/183 通过，包含 ONNX 4 页真识别、Windows.Media.Ocr 队列/进度/排队/取消。WinRT 脚本必须保存为带 BOM 的 UTF-8，且用 `$args` 接多页参数，才能兼容 Windows PowerShell 5.1。
- 2026-09-26 Windows 11 build 26200 首轮进程验收：嵌入式 Python 3.12.10、ORT 1.30.0、OpenCV 5.0.0、NumPy 2.5.3；`node engines/arale_onnx_v1/build.mjs --target win32-x64 --debug` 与包内 `--probe` 通过。默认 4 线程跑迁移的 30 页耗时 118.948 秒，30/30 页成功、388 行；对缓存版 Mac 预期输出按同页同行比较，文字 379/388、框 343/388、方向 387/388 精确一致，8/30 页完全一致。该结果是 Windows 独立基线，差异尚未判定可接受。
- 同日生成 `ARaLeBook-0.1.0-setup.exe`（127,028,004 字节，SHA-256 `1bc95025f6a79abf1b80016eef220ed5f7a613d6e12be3bfd0482b09897f5e30`）。这是本地未签名/未发布构建记录，不代表已在干净机器完成安装验收。
- 换机前检查两个仓库的 `git status` 和远端分支，确认本地提交已经推送；不要只 clone 旧的远端 main 后就丢弃 Mac 工作区。

给后续会话的任务：阅读此文与 [当前引擎文档](../engines/docs/current.md)，优先在干净 Windows 验证 VC++ 条件依赖与 NSIS 安装/卸载，补真实 RAR/7Z 夹具，并评估 Windows/Mac OCR 输出差异。保持 Mokuro 文字结果与 KV cache 基线，不把 PyTorch 加回用户运行包。
