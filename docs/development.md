# 开发、构建与验证

核对日期：2026-10-02。所有命令默认从主仓库根运行；Windows 特有问题先读 [Windows 交接](windows-handoff.md)。本轮同步已有验收记录，未重新运行构建或测试。

## 取得代码与依赖

```bash
git clone --recurse-submodules git@github.com:heyanLE/arale-book.git
cd arale-book
npm ci
git submodule status
```

默认克隆主仓库 `main`。`.gitmodules` 使用 SSH，Windows 要能访问两个仓库。源码 clone 不包含模型、运行时或 OCR ZIP；恢复方式见交接文档。当前分支和未提交改动以两个仓库的 `git status` 为准。

没有 SSH 配置时，可在新目录用 HTTPS 克隆，并覆盖本地 submodule URL（不修改 `.gitmodules`）：

```powershell
git clone https://github.com/heyanLE/arale-book.git
cd arale-book
git submodule init
git config submodule.engines.url https://github.com/heyanLE/arale-book-ocr-manga.git
git submodule update --recursive
npm ci
```

Windows 已使用 Node 22.19.0 和 24.19.0 验证。Rust 解包器需要 Rust/MSVC 工具链；macOS Vision 的 Swift 工具不适用于 Windows。PowerShell 若拦截 `npm.ps1`，可使用 `npm.cmd`；若工具宿主没有 npm 启动器，可按下面的直接 Node 命令验证。

## 常用命令

| 命令 | 用途与边界 |
|---|---|
| `npm run typecheck` | 主进程/渲染进程类型检查 |
| `npm test` | 编译测试并跑 Node 测试；测试跳过项必须单列 |
| `npm run build` | 生成 main/preload/renderer 的 `dist/` |
| `npm start` | 先 build，再启动 Electron |
| `npm run samples` | 生成示例书籍 |
| `npm run build:native` | 优先仓库 `.rust/`，否则使用系统 Cargo；Windows 与 POSIX PATH 分隔符均支持 |
| `cargo build --manifest-path native/arale-native/Cargo.toml --release` | Windows 已装系统 Rust 后可直接构建解包器 |
| `npm run build:vision-ocr` | macOS 系统 OCR 组件 |
| `npm run pack:release -- --dir` | 正式布局目录包；含仓库索引，不含下载引擎 |
| `npm run pack:debug -- --dir` | 调试目录包；存在本地开发引擎时复制进去 |
| `npm run smoke` | 真 Electron GUI smoke；需先 build，不能仅用单测代替 |

`--dir` 构建通过不等于 DMG/NSIS 安装验收。Windows 的 `npm.cmd` / `electron-builder.cmd`、原生资源 `.exe` 路径和平台资源选择已修复并完成构建验证；仍须单独做干净机器安装/卸载。

## OCR 开发

```bash
node engines/arale_onnx_v1/build.mjs --target darwin-arm64 --debug
# Windows 对应 --target win32-x64
```

先恢复 ignored 的 `models/` 和 `runtime/<target>/`；构建会校验 [模型锁定清单](../engines/arale_onnx_v1/model-manifest.json)。修改的是 `engines/arale_onnx_v1/python/` 源码，之后重新生成开发目录。引擎专用命令和导出说明见[当前引擎文档](../engines/docs/current.md)。

环境开关：

- `ARALE_OCR_THREADS`：ORT intra-op 线程数，默认 **4**。8 线程性能记录只代表当时那台 Mac。
- `ARALE_OCR_KV_CACHE=0`：开发对照。需要本地旧 `manga-ocr-decoder.onnx`；它不在当前用户 ZIP 中。
- `ARALE_NATIVE_BIN`：指定解包器位置，见 `src/main/native/sidecar.ts`。
- 远端仓库 URL 覆盖开关存在于扩展服务中，但多仓库缓存键/覆盖行为未经专门验收，优先通过仓库 UI 配置实际 URL。

## 验证记录要求

记录命令、平台/CPU、运行时版本、线程数、模型哈希、输入页集合、成功/失败/跳过数量，并区分“构建”“进程推理”“应用集成”“GUI”“安装”五类结果。

Windows 既有 OCR 验证（Windows 11 build 26200 / Node 22.19.0）：Rust 50/50；普通 GUI smoke 162/162，通过 `ARALE_SMOKE_OCR=1` 的真 OCR smoke 183/183。Windows debug/release `--dir` 与 NSIS 构建通过；包内 sidecar、WinRT 多页 OCR 和 ONNX `--probe` 均已实际运行。2026-10-01 又完成正式 OCR Release 的真实下载/校验/安装及单页识别。

2026-10-02 Anki 重构验证（同 Windows 11 / Node 24.19.0）：类型检查与生产构建通过；单测 499 项中 494 通过、5 跳过、0 失败；GUI 219 个断言通过，最后一次退出清理 `.smoke-userdata` 时遇到 `EPERM`，该次命令退出码为 1。跳过项含原生工具缺失降级与真实 RAR 样本/下载用例；真实模型质量、Anki 客户端导入、干净 Windows VC++ 和 NSIS 安装/卸载仍未验证。

该次使用的直接命令（依次执行）：

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.main.json
node node_modules/typescript/bin/tsc -p tsconfig.renderer.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.test.json
node scripts/bundle-preload.mjs
node node_modules/vite/bin/vite.js build
node --test "dist-test/tests/*.test.js"
node scripts/smoke.mjs
```

PowerShell 的真 OCR 冒烟开关写法为 `$env:ARALE_SMOKE_OCR='1'`，再运行 `node scripts/smoke.mjs`；完成后用 `Remove-Item Env:ARALE_SMOKE_OCR` 清除。POSIX 的 `ARALE_SMOKE_OCR=1 npm run smoke` 不能直接照搬到 PowerShell。
Electron smoke 在 Windows 直接启动 `node_modules/electron/dist/electron.exe`，并从子进程环境移除 `ELECTRON_RUN_AS_NODE`。若工具宿主设置了该变量，不能把它继承给 Electron。

## 两仓库工作流

引擎变更先在 submodule 提交，主仓库再提交其 gitlink；推送也先引擎后应用。不要只提交主仓库后就认为引擎源码已同步。实际分支、提交和推送状态始终以两个仓库的 `git status` / `git log` 为准。
模型、运行时、归档及测试书籍不纳入 Git。日常改代码时同步对应当前文档；历史原文留在 `docs/archive/`。
