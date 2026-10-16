# 书籍导入与任务反馈

核对日期：2026-10-13。当前 Tauri 漫画合集导入与全局导入队列的依据。

## 合集和普通漫画

- RAR/CBR、ZIP/CBZ、7Z/CB7、TAR/CBT 外层没有可读图片、但包含子压缩包时，自动展开合集。子包按自然顺序处理，每卷独立入库，书名取内层卷名，保留各自原始压缩包；结果使用“外层路径 → 成员相对路径”追溯。
- 同类容器可以嵌套展开；最多 5 层、一次遍历最多 200 个输入包，超限条目报错，不生成空书。
- 已有图片的普通漫画包保持整包成书，不因为附带压缩包而拆分。文件夹、单张图片、mokuro 和顶层 EPUB 保留原有入口。
- 每卷单独发布。坏卷、图片解析失败或写入失败会显示对应原因；其他已成功的卷保留。失败书目录及正常结束的合集暂存自动清理，用户源文件只读、不删除。
- 合集内的 EPUB 暂不交给小说解析器，结果明确提示先解压后通过 EPUB 入口导入；顶层 `.epub` 仍支持文本和图片小说。

## 右下角任务队列

选定文件/文件夹或收到拖放、外部打开请求后，导入先加入同一个 FIFO 队列，立即广播任务状态。任务与 OCR、制卡共用右下角入口，导入可与这些任务并行，各导入文件之间按顺序执行。

运行任务显示原始文件名，以及当前检查文件、展开合集/解压分卷、整理图片、保存原文件和入库的阶段。整理图片时显示实际页数；没有可靠总量的解压阶段使用不定进度条，不伪造百分比。漫画解包、原图整理及原文件复制不持有书库全局锁，仅在读取默认值、发布索引时短暂取锁，因此可以切换页面并使用已有书籍。

等待项可“取消排队”；已经进行的原生解包不提供假停止按钮。完成后保留导入成功、部分失败、失败或取消结果，最多最近 20 项，用户可清除；部分失败默认展开各卷结果，成功书可直接打开，失败卷有具体原因。取消未开始任务不算导入错误。任务停靠条有状态播报，后台 Worker 异常会结束等待状态并提示检查已入库书籍。

队列保存在当前词典 Worker 会话中，切换应用内页面不会中断。窗口刷新后不恢复队列：已经发给原生后台的工作可能继续，未开始项需重新选择；已入库书籍保留。退出应用会中止未完成工作，当前不提供导入检查点续跑。强杀/断电的临时目录清理和恢复未专项验收，不能将会话队列描述为持久后台任务。

## 代码入口

| 文件 | 职责 |
|---|---|
| `src-tauri/src/importer.rs` | 容器识别、递归、自然排序、逐卷准备/清理、阶段及页数回调 |
| `src-tauri/src/lib.rs` | 在存储锁之外处理漫画导入，逐卷短锁发布并发送阶段事件 |
| `src/core/import/task-queue.ts` | Worker 会话 FIFO、进度、取消排队、结果与清除 |
| `src/shared/imports.ts`、`ipc.ts`、`api-bridge.ts` | 队列类型及读取/取消/清除契约 |
| `dictionary-worker.ts`、`tauri-bridge.ts`、`tauri-epub.ts` | 统一导入调度、原生阶段转发及 EPUB 阶段 |
| `OcrQueueDock.tsx`、`App.tsx` | 全局任务订阅、阶段、导入结果和书籍跳转 |

## 验证（2026-10-13）

平台：macOS arm64 / Node 22.22.2 / Cargo 1.98.1，均在本机。

- `npm run typecheck`、`npm run tauri:check`、`npm run build:renderer`：通过。
- `npm test`：427 项，426 通过、1 跳过、0 失败。新增 3 项导入队列回归覆盖入队前广播、FIFO、阶段/过期事件、部分失败、取消等待项、进行中任务不假取消、清除、失败后继续以及非法参数。
- `npm run tauri:test` 在沙盒内运行时本机 HTTP 测试因端口权限失败；使用正常环境 `CARGO_HOME="$PWD/.rust/cargo" RUSTUP_HOME="$PWD/.rust/rustup" PATH="$PWD/.rust/cargo/bin:$PATH" .rust/cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml --locked --offline` 重跑，36 通过、1 个本地样本测试忽略、0 失败。新增漫画回归覆盖自然顺序、坏卷隔离、普通图片包不拆分、发布失败清理、嵌套深度限制和源文件不变。
- 对用户样本 `Kyou_wa_kanojo_ga_inaikara_01-02.rar` 设置 `ARALE_IMPORT_COLLECTION`，执行上述 Cargo 命令并附加 `real_rar_collection_imports_two_independent_volumes -- --ignored --nocapture`：专项 1/1 通过。在临时书库生成第 01、02 卷两本独立漫画，各 171 页，原始 RAR 保留、暂存清理、整理图片阶段达到 171；没有写入用户实际书库。
- 内置浏览器用实际 `StatusBar`、`OcrQueueDock` 和队列类及测试处理器，验证即时入口、运行/排队、取消等待项、86/171 页数、部分失败及逐卷原因展示。截图保存在 `.tmp/import-analysis-2026-10-13/queue-running.png`、`queue-progress.png`、`queue-partial.png`、`queue-complete.png` 和 `queue-detail.png`，它们是组件测试数据，不代表真实 WebView/IPC 全链路 GUI 验收。
- 生产前端及 Rust debug 应用已构建；原生 API/解包由 Rust 回归和真实样本专项验证。Windows smoke 已新增导入队列、原生阶段和完成结果断言，但本轮未在 Windows 执行。Windows/WebView2、原生 WKWebView 的界面操作、安装包、强退恢复及大量合集性能未验收。引擎未修改。

构建与测试日志位于 `.tmp/import-analysis-2026-10-13/`，临时报告和样本不进入版本库。
