# 当前状态与接续任务

核对日期：2026-09-26。应用版本 `0.1.0`，OCR 扩展版本 `0.2.0`。
功能基线：应用提交 `91fc064`、文档整理前提交 `1b57c64`；引擎功能提交 `59eed53`。这些是定位历史的基线，当前 HEAD 用 `git log` 查看。

## 现在是什么

ARaLeBook 是 Electron + React/TypeScript 的本地漫画/EPUB 管理与日语学习阅读器。当前主流程包括导入、书库、漫画/小说阅读、点词/划词查询、词卡、词典分词、可选 OCR 与 OpenAI 兼容 LLM 分析。
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
| 发布 | ZIP 已在本机生成，尚未上传 Release；本轮本地提交尚未由本会话 push |

不要重新引入旧 Rust OCR 来代替当前默认方案，除非用户提出新的实现方向；当前 Windows 工作的目标是移植和验收现有 Python/ORT 包。

## 已验证与边界

以下是上一轮功能验证记录，本次文档整理未重新运行这些测试。

| 验证 | 已观察的结果 | 不能据此推断 |
|---|---|---|
| 类型与应用测试 | 类型检查通过；407 项中 402 通过、5 跳过 | 不是 Windows 或 GUI 全流程验证 |
| macOS 引擎 | 包内解释器、解压后的 ZIP、应用扩展服务均跑通单页 OCR | 不是所有 macOS 版本都测过 |
| KV cache 对照 | 同批 30 页 388 行文字和框与旧无缓存图完全一致 | 不是任意书籍都完全一致 |
| Mokuro 对照 | 380/387 配对行逐字一致，约 98.2% | 这是与参考程序的一致率，不是人工标注准确率 |
| 性能 | 8 线程、同批 30 页：126.4 秒 → 96.5 秒 | 运行时默认仍为 4 线程；不能把 8 线程测量当默认保证 |
| 应用打包 | macOS debug/release `--dir` 构建和资源分流检查通过 | 未做签名、公证、正式安装包发布 |
| GUI smoke | 该轮 Electron 在 CDP 可用前退出，未完成 | 原因尚未定案，不能认定是业务回归或声称已通过 |
| Windows | 引擎已交叉打包、ZIP 完整性检查通过、PE 依赖静态扫描完成 | 尚未在 Windows 启动或识别成功 |

macOS 应用打包配置下限为 11；当前 ONNX Runtime wheel 要求 macOS 14，扩展条目用 `minMacOS: 14` 限制安装。Windows 和 Linux 的应用构建配置存在，但运行/打包仍需逐平台验收。

## 下一步：Windows 兼容与修复

优先顺序及具体命令见 [Windows 交接](windows-handoff.md)。

1. push 两个仓库并搬迁 Windows OCR ZIP，恢复模型和 Windows 运行时。
2. 检查嵌入式 Python `_pth` 的 `ocr/` 搜索路径，再跑 `--probe` 和单页 OCR。
3. 在干净 Windows 上解决/验证 `msvcp140.dll` 条件依赖。
4. 修复 Rust **解包器**构建脚本的工具链路径、PATH 分隔符；修复应用打包的 `.exe` 资源和命令启动方式。
5. 验证导入、阅读、查词、OCR 队列/取消、系统 OCR、debug/release 安装包。
6. 验收后才开放 Windows 仓库资产并上传 Release；同时更新当前文档的证据。

## 其他已知限制

- 新增仓库能发现扩展条目，但 `src/main/index.ts` 目前只注册 `system` 和 `arale_onnx_v1` 两个 OCR provider；任意第三方 provider 的动态注册尚未实现。
- `.zip/.cbz` 整包读内存且超过 2 GB 拒绝；`.rar/.7z` 依赖 Rust 解包器。
- 词典支持 Yomitan；没有 MDX/StarDict/DSL、云同步和联网元数据抓取。
- 两张缓存解码图包含重复权重，当前包体积增加约 95 MiB；未做图合并或 int8 量化验收。
- ONNX runner 默认 CPU EP；存在 CoreML provider 不等于已完成 CoreML 性能/精度验收。
- 归档中的旧性能数字（尤其 Rust OCR、int8 目标体积）已不代表当前实现。
