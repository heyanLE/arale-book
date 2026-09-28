# 开发、构建与验证

核对日期：2026-09-28。所有命令默认从主仓库根运行；Windows 特有问题先读 [Windows 交接](windows-handoff.md)。

## 取得代码与依赖

```bash
git clone --recurse-submodules git@github.com:heyanLE/arale-book.git
cd arale-book
npm ci
git submodule status
```

默认克隆主仓库 `main`。`.gitmodules` 使用 SSH，Windows 要能访问两个仓库。源码 clone 不包含模型、运行时或 OCR ZIP；恢复方式见交接文档。本次漫画制卡开发在本地 `codex/manga-vocabulary-anki` 分支，未推送时不能从 GitHub 克隆到。

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

本轮最后记录（Windows 11 build 26200 / Node 22.19.0）：类型检查通过；400 项测试中 395 通过、5 跳过；Rust 50/50 通过；普通 GUI smoke 162/162，通过 `ARALE_SMOKE_OCR=1` 的真 OCR smoke 183/183。Windows debug/release `--dir` 与 NSIS 构建通过；包内 sidecar、WinRT 多页 OCR 和 ONNX `--probe` 均已实际运行。
Electron smoke 在 Windows 直接启动 `node_modules/electron/dist/electron.exe`，并从子进程环境移除 `ELECTRON_RUN_AS_NODE`。若工具宿主设置了该变量，不能把它继承给 Electron。

## 两仓库工作流

引擎变更先在 submodule 提交，主仓库再提交其 gitlink；推送也先引擎后应用。不要只提交主仓库后就认为引擎源码已同步。当前分支为 `codex/windows-handoff`，实际状态始终以 `git status` / `git log` 为准。
模型、运行时、归档及测试书籍不纳入 Git。日常改代码时同步对应当前文档；历史原文留在 `docs/archive/`。
