# 开发、构建与验证

Windows x64/macOS arm64 每夜构建及日期版本规则见[每夜构建](nightly.md)。npm 已锁定官方 Tauri CLI，本地打包入口为 `node scripts/tauri.mjs pack`，不要求全局安装 cargo-tauri。

核对日期：2026-10-05。所有命令默认从主仓库根运行；Windows 特有问题先读 [Windows 交接](windows-handoff.md)。下方记录保留原验证日期；Tauri 预览命令及本轮验证见 [迁移文档](tauri-migration.md)。

已按用户要求删除旧书库迁入功能和专用测试/夹具。本机开发数据通过一次性本地操作迁到 Tauri 数据根，工具与报告仅放在忽略的 `.tmp/`，不进入应用或发布包。普通 `smoke-tauri.mjs` 仍使用隔离书库，验证原生菜单/第二实例、阅读、词典、分词、制卡和 OCR；命令与最新记录见 [Tauri 迁移](tauri-migration.md)。

2026-10-05 Anki/Tauri 第六阶段增加 `node scripts/test-tauri-study.mjs`（`npm run tauri:study:test`），覆盖异步保存顺序、导出/检查点失败、重复入队与取消、首次自行 AI 目录保存。最新 Windows 验证计数、GUI/Node 字段对照、release EXE 与未验证范围统一见 [第六阶段验证](tauri-migration.md#第六阶段验证2026-10-05)。

Windows 从 Codex MSIX 宿主启动工具时，`AppData` 可能被重定向，进程不带包身份也不能单独证明不存在目录虚拟化。开发/验证优先使用项目内隔离数据根；处理本机真实数据要另核对物理目录和应用实际加载结果，不能只依赖普通路径枚举或后台单测。Tauri debug 菜单可用 Ctrl+Shift+I 打开 DevTools；WebView2 可通过 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<本机端口>` 配合 CDP 调试，验证结束应关闭调试实例并清除该环境变量后重新启动。

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
| `npm run typecheck` | 渲染进程与共享业务/测试端口的类型检查 |
| `npm test` | 清理旧测试产物，编译并运行当前 Node 测试 |
| `npm start` / `node scripts/tauri.mjs dev` | 构建前端与 Kuromoji 资源，运行 Tauri debug 程序 |
| `npm run build` / `node scripts/tauri.mjs build` | 构建 Tauri release 程序，运行时无 Node.js |
| `npm run pack` / `node scripts/tauri.mjs pack` | Tauri CLI 生成 NSIS 安装包；不等于安装验收 |
| `npm run tauri:test` | Rust 后台测试 |
| `npm run smoke` | Windows 隔离 WebView2 GUI smoke，先构建前端/debug 和 Node 测试端口 |
| `npm run tauri:services:test` | 服务适配器协议、缓存、预算、截断、并发、取消测试 |
| `npm run tauri:ocr:test` | OCR 成块、旧页保留、转换错误、重载协调测试 |
| `npm run tauri:study:test` | 制卡检查点、导出授权、取消与外部 AI 适配器测试 |
| `npm run build:vision-ocr` | macOS 系统 OCR 组件；Windows 不需要 |

Windows 使用 Rust/MSVC 与 WebView2。Tauri 原生解包库直接链接到应用，无须另外打包 Node.js 或解包 sidecar。构建通过不能写成安装/卸载验收通过。

## OCR 开发

Tauri debug 自动加载本机 `engines/arale_onnx_v1/build/dev-<platform>-<arch>/extension.json`，正式 release 只使用已安装扩展；`ARALE_TAURI_NO_DEV_ENGINE=1` 仅用于隔离测试关闭自动发现。若 release 窗口仍开着，单实例机制会让新 debug 启动只唤醒已有 release；先关闭当前窗口，再执行 `node scripts/tauri.mjs dev`。

```bash
node engines/arale_onnx_v1/build.mjs --target darwin-arm64 --debug
# Windows 对应 --target win32-x64
```

先恢复 ignored 的 `models/` 和 `runtime/<target>/`；构建会校验 [模型锁定清单](../engines/arale_onnx_v1/model-manifest.json)。修改的是 `engines/arale_onnx_v1/python/` 源码，之后重新生成开发目录。引擎专用命令和导出说明见[当前引擎文档](../engines/docs/current.md)。

环境开关：

- `ARALE_OCR_THREADS`：ORT intra-op 线程数，默认 **4**。8 线程性能记录只代表当时那台 Mac。
- `ARALE_OCR_KV_CACHE=0`：开发对照。需要本地旧 `manga-ocr-decoder.onnx`；它不在当前用户 ZIP 中。
- 解包由 `native/arale-native` 库直接提供，测试 CLI 的构建见 `scripts/build-native.mjs`。
- 远端仓库 URL 覆盖开关存在于扩展服务中，但多仓库缓存键/覆盖行为未经专门验收，优先通过仓库 UI 配置实际 URL。

## 验证记录要求

记录命令、平台/CPU、运行时版本、线程数、模型哈希、输入页集合、成功/失败/跳过数量，并区分“构建”“进程推理”“应用集成”“GUI”“安装”五类结果。

Windows 既有 OCR 验证（Windows 11 build 26200 / Node 22.19.0）：Rust 50/50；普通 GUI smoke 162/162，通过 `ARALE_SMOKE_OCR=1` 的真 OCR smoke 183/183。Windows debug/release `--dir` 与 NSIS 构建通过；包内 sidecar、WinRT 多页 OCR 和 ONNX `--probe` 均已实际运行。2026-10-01 又完成正式 OCR Release 的真实下载/校验/安装及单页识别。

2026-10-02 Anki 重构验证（同 Windows 11 / Node 24.19.0）：类型检查与生产构建通过；单测 499 项中 494 通过、5 跳过、0 失败；GUI 219 个断言通过，最后一次退出清理 `.smoke-userdata` 时遇到 `EPERM`，该次命令退出码为 1。跳过项含原生工具缺失降级与真实 RAR 样本/下载用例；真实模型质量、Anki 客户端导入、干净 Windows VC++ 和 NSIS 安装/卸载仍未验证。

上述是旧框架的历史运行记录，其脚本已退役。当前验证按本页“常用命令”执行；Tauri 的最新运行、构建和安装边界见 [当前状态](current-state.md)。

## 两仓库工作流

引擎变更先在 submodule 提交，主仓库再提交其 gitlink；推送也先引擎后应用。不要只提交主仓库后就认为引擎源码已同步。实际分支、提交和推送状态始终以两个仓库的 `git status` / `git log` 为准。
模型、运行时、归档及测试书籍不纳入 Git。日常改代码时同步对应当前文档；历史原文留在 `docs/archive/`。
