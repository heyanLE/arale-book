# 开发、构建与验证

核对日期：2026-09-26。所有命令默认从主仓库根运行；Windows 特有问题先读 [Windows 交接](windows-handoff.md)。

## 取得代码与依赖

```bash
git clone --branch codex/windows-handoff --recurse-submodules git@github.com:heyanLE/arale-book.git
cd arale-book
npm ci
git submodule status
```

前提是两个仓库的分支已 push。`.gitmodules` 使用 SSH，Windows 要能访问两个仓库。源码 clone 不包含模型、运行时或 OCR ZIP；恢复方式见交接文档。

## 常用命令

| 命令 | 用途与边界 |
|---|---|
| `npm run typecheck` | 主进程/渲染进程类型检查 |
| `npm test` | 编译测试并跑 Node 测试；测试跳过项必须单列 |
| `npm run build` | 生成 main/preload/renderer 的 `dist/` |
| `npm start` | 先 build，再启动 Electron |
| `npm run samples` | 生成示例书籍 |
| `npm run build:native` | 目前按 Mac 本地 `.rust` 工具链布局构建解包器；Windows 待修 |
| `cargo build --manifest-path native/arale-native/Cargo.toml --release` | Windows 已装系统 Rust 后可直接构建解包器 |
| `npm run build:vision-ocr` | macOS 系统 OCR 组件 |
| `npm run pack:release -- --dir` | 正式布局目录包；含仓库索引，不含下载引擎 |
| `npm run pack:debug -- --dir` | 调试目录包；存在本地开发引擎时复制进去 |
| `npm run smoke` | 真 Electron GUI smoke；需先 build，不能仅用单测代替 |

`--dir` 构建通过不等于 DMG/NSIS 安装验收。Windows 的 `npm` 子进程启动、原生资源 `.exe` 路径和平台资源选择仍待修复。

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

本轮最后记录：类型检查通过；407 项测试中 402 通过、5 跳过；两平台 ZIP CRC/SHA 检查通过；macOS 进程推理和扩展 provider 已跑通。GUI smoke 在 Electron 暴露 CDP 前退出，Windows 尚未运行。
排查 Electron 启动时检查环境变量 `ELECTRON_RUN_AS_NODE`；如果被工具宿主设置，需要从启动进程环境移除后重试。这是排障候选，尚未确认它就是上述退出的根因。

## 两仓库工作流

引擎变更先在 submodule 提交，主仓库再提交其 gitlink；推送也先引擎后应用。不要只提交主仓库后就认为引擎源码已同步。当前分支为 `codex/windows-handoff`，实际状态始终以 `git status` / `git log` 为准。
模型、运行时、归档及测试书籍不纳入 Git。日常改代码时同步对应当前文档；历史原文留在 `docs/archive/`。
