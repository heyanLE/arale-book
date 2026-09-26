# 当前架构与数据流

核对日期：2026-09-26。状态和待办见[当前状态](current-state.md)。

## 代码导航

| 入口 | 责任 |
|---|---|
| [src/main/index.ts](../src/main/index.ts) | 创建窗口、服务、OCR providers 和 IPC |
| [src/shared/ipc.ts](../src/shared/ipc.ts)、[preload](../src/preload/index.ts) | IPC 契约与受限桥接 API |
| [src/main/ipc.ts](../src/main/ipc.ts) | 主进程 IPC 处理 |
| `src/core/` | EPUB/漫画解析、词典、分词、OCR 排序成块、词卡纯逻辑 |
| `src/main/library/` | 书库元数据、导入、每本书的词卡 |
| `src/main/reader/` | `arale://` 内容访问、EPUB 内容处理与桥接注入 |
| `src/renderer/reader/` | 漫画/EPUB UI、文字层与选择 |
| [src/main/extensions/service.ts](../src/main/extensions/service.ts) | JSONL 仓库、缓存、下载校验、安装与开发目录加载 |
| [src/main/ocr/service.ts](../src/main/ocr/service.ts) | 书级串行队列、进度、取消和文字层写盘 |
| [扩展 provider](../src/main/ocr/providers/extension.ts)、[runner](../src/main/ocr/runner.ts) | 按自描述启动进程，读取逐页 NDJSON |
| [设置 UI](../src/renderer/components/ExtensionsCard.tsx) | 仓库管理、安装/卸载与进度 |
| `native/arale-native/` | Rust 解包 sidecar；不是 OCR 引擎 |
| [engines](../engines/README.md) | 独立 Git submodule：OCR 源码、模型清单与归档构建 |

## OCR 链路

```text
书籍页图 → OcrService 队列
  ├─ system → Vision / Windows.Media.Ocr
  └─ arale_onnx_v1 → extension.json 的包内 Python
       → OpenCV/Mokuro 几何 → ORT 检测/编码/缓存解码
       → NDJSON 每页 lines（原图像素框、文本、朝向）
  → 应用排序/成块 → content/manga.json → 漫画文字层
```

契约以 [ocr-protocol.ts](../src/shared/ocr-protocol.ts)、[extensions.ts](../src/shared/extensions.ts)、[provider.ts](../src/main/ocr/provider.ts) 为准。runner 只输出行，应用负责阅读顺序和持久化。新扩展产出的引擎签名为 `arale_onnx_v1:v2`；已有文字层不会自动重算，用户需要强制重新识别。

## 仓库、安装和开发目录

- JSONL 源在 `engines/repositories/default.jsonl`，一行一个扩展；`release.assets` 按 `darwin-arm64` / `win32-x64` 选资产。
- 每个仓库单独缓存；合并时相同扩展 id 采用仓库列表中先出现的条目。默认仓库有 submodule 生成的本地索引回退。
- 有调试引擎时优先本地索引；正式包优先缓存，但较新的随包索引不会被旧缓存覆盖。
- 下载要求 HTTPS 和有效 SHA；先落 `.staging`，解包并检查自描述，之后换入安装目录。空 SHA 会拒绝安装。
- 源码运行从 `engines/arale_onnx_v1/build/dev-<platform>-<arch>/` 加载。调试应用包从 `Resources/debug-engines/` 加载；这种本地引擎不能在 UI 卸载。
- 正式包只复制 JSONL 到 `Resources/extensions/default.jsonl`，引擎由用户另行下载。
- 当前安装 id `ocr-arale_onnx_v1`、provider id `arale_onnx_v1` 是不同用途的稳定标识。

## 用户数据

以 [src/main/paths.ts](../src/main/paths.ts) 的 `app.getPath('userData')` 为准，不在代码中硬编码某台 Mac 的路径。

```text
<userData>/
  library/index.json
  library/<bookId>/content/        # arale:// 的可读根，含 manga.json
  library/<bookId>/cards.json      # 词卡按书存储
  library/<bookId>/original.*
  dictionaries/
  positions.json
  settings.json
  llm.json                        # 含本机 API key，不作为公开迁移材料
  extensions/repositories.json
  extensions/repositories/*.jsonl
  extensions/installed.json
  extensions/<extensionId>/
```

旧 `extensions/catalog.json` 的兼容回退还在服务中，不能据此认为应用源码仍维护一份旧 JSON 清单。UI 部分偏好保存在 localStorage。
