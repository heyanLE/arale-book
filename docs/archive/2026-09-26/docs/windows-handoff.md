# Windows 开发迁移交接

日期：2026-09-26。迁移改动整理在两个仓库的 `codex/windows-handoff` 分支；本地提交不等于推送或发布。

## 1. 源码通过 Git 搬迁

- 应用仓库：`heyanLE/arale-book`。
- `engines/` 是独立仓库 `heyanLE/arale-book-ocr-manga` 的 submodule。
- 两个仓库的迁移工作分支均为 `codex/windows-handoff`；主仓库记录引擎提交的准确指针。
- 必须先 push 引擎分支，再 push 主仓库分支。否则 Windows clone 得不到这次引擎实现。
- README 与设计笔记一并保存；`.workbuddy/` 是本地工具记忆，已忽略，不随源码提交。
- 小型 JSONL、model-manifest、源码、构建脚本和文档应提交；模型、运行时、ZIP、node_modules 和构建缓存不提交。

已整理的功能提交：引擎 `59eed53`，主仓库功能与 submodule 指针 `91fc064`。换机前按顺序推送：

```bash
git -C engines push -u origin codex/windows-handoff
git push -u origin codex/windows-handoff
```

两个仓库均 push 后，在 Windows 用已配置 GitHub SSH key 的 Git 执行：

```powershell
git clone --branch codex/windows-handoff --recurse-submodules git@github.com:heyanLE/arale-book.git
cd arale-book
git submodule status
```

若推的是其他分支，将 `--branch` 改成实际分支名。`.gitmodules` 的子仓库地址也是 SSH；仅把主仓库 clone URL 改为 HTTPS 不会自动改变子仓库地址。

在 Windows 开始改引擎前，给 detached submodule 建工作分支，例如：

```powershell
git -C engines switch -c codex/windows-fixes
```

## 2. 必搬的大文件：一个现成 Windows ZIP

Mac 文件位置：

`engines/arale_onnx_v1/dist/arale_onnx_v1-windows-x64.zip`

- 724,064,723 字节，约 690.5 MiB。
- SHA-256：`df1371702cf27cb457d613e6edc5e992511f766198deb11ffb26418e58bd7107`。
- 包含 fp32 检测器、编码器、KV cache 首步/续步解码器、词表，以及 Windows CPython 3.12 和平台依赖。
- 用移动硬盘、U 盘、局域网共享或私人网盘复制即可。不必为了迁移先公开发布 Release。
- 不要把 Mac 的 node_modules、Python runtime/darwin-arm64、.rust 或 native target 目录复制到 Windows 使用。

## 3. Windows 恢复引擎材料

以下假定源码在 `C:\src\arale-book`，ZIP 放在 `D:\transfer`。使用新 clone 的目录，避免覆盖已有开发材料。

```powershell
$repo = 'C:\src\arale-book'
$engine = Join-Path $repo 'engines\arale_onnx_v1'
$archive = 'D:\transfer\arale_onnx_v1-windows-x64.zip'
$expected = 'df1371702cf27cb457d613e6edc5e992511f766198deb11ffb26418e58bd7107'
$actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'OCR ZIP 校验失败，请重新传输' }

$bundle = Join-Path $engine 'build\dev-win32-x64'
Expand-Archive -LiteralPath $archive -DestinationPath $bundle

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

`--probe` 是 Windows 兼容性工作的第一个验收点，尚未在 Windows 上通过。若失败，先处理下面的已知问题；不要从系统 Python 安装包来掩盖自包含运行时的问题。源文件应修改 `engines/arale_onnx_v1/python/`，再重跑 `build.mjs --debug`，不要只改生成目录 `build/dev-win32-x64/ocr/`。

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

此处 Rust 只用于 `.rar/.7z` 解包器，OCR 本身是包内 Python + ORT。暂用上述直接 cargo 命令：现有 `scripts/build-native.mjs` / `test-native.mjs` 仍假设 Mac 上的 `.rust/cargo/bin/cargo` 和冒号 PATH 分隔符，需要在 Windows 修正。

## 5. Windows 待修复与验收

1. **嵌入式 Python 搜索路径**：当前 `python312._pth` 只列标准库、`.`、`..\engine` 和 `..\`，没有 `..\ocr`。需在 Windows 检查 `mokuro_compat` 能否导入；若失败，在 `prepare-runtime.mjs` 中生成正确的 `_pth`（包含 `..\ocr`），修复要落回源码/运行时准备流程。
2. **VC++ 运行库**：新 headless OpenCV 已消除普通 OpenCV 的 Media Foundation 静态依赖。扫描 186 个 PE 文件没有硬缺失，但仍提示 `msvcp140.dll` 条件依赖；必须在干净 Windows 环境验证，不能仅凭开发机已装运行库判断可分发。
3. **应用打包脚本**：`scripts/pack.mjs` / `electron-builder.yml` 仍有 `arale-native` 未加 `.exe` 的资源路径、Mac Vision 资源和 Mac 输出说明；Node `spawnSync('npm', ...)` / `.bin/electron-builder` 也需要按 Windows 命令启动方式验证。
4. **功能验收**：包内 Python `--probe` → 单页 OCR → 应用扩展服务 → 队列/取消 → CBZ/EPUB/RAR/7Z 导入 → 系统 OCR → debug/release 安装包。
5. **仓库资产**：Windows ZIP 是交叉构建，JSONL 的 Windows sha256 故意为空，应用拒绝安装。只有完成 Windows 真机验收后，才能写入真实 SHA 并上传 Release。主仓库和引擎库的源码先后推送，不代表 Release 已上传。

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
- 对 Mokuro 0.2.5：同批抽样约 98.2% 配对文字逐字一致；并非全量质量保证。
- macOS 引擎 ZIP 688.8 MiB，Windows 交叉 ZIP 690.5 MiB；当前图为 fp32。
- 类型检查通过；407 项应用测试中 402 通过、5 跳过。
- macOS 包内解释器、解压后的归档、应用扩展服务均已实际跑过单页 OCR。
- Windows 尚无运行验收；当前 Mac 工具环境中的 GUI smoke 在 Electron 启动前退出，未完成 GUI 验收。
- 换机前检查两个仓库的 `git status` 和远端分支，确认本地提交已经推送；不要只 clone 旧的远端 main 后就丢弃 Mac 工作区。

给 Windows 上新会话的任务：阅读此文与 `engines/arale_onnx_v1/README.md`，先恢复大文件，修复 `_pth`/原生构建/打包兼容性，再用包内解释器和真实 OCR 完成 Windows 验收。保持 Mokuro 文字结果与 KV cache 基线，不把 PyTorch 加回用户运行包。
