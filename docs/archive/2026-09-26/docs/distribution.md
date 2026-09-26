# 什么在哪儿、谁分发给谁（分发与引擎关系图）

这份文档回答三个反复被问到的问题：**哪些东西要分发**、**哪些东西在项目里**、**它们和引擎是什么关系**。
所有体积都是本机实测。

---

## 一句话

**应用只认两份契约**：一套 NDJSON 协议 + 一份 `extension.json`。
引擎用什么语言写、装在哪、模型多大，应用一概不知道。当前扩展使用包内 Python + ONNX Runtime，并通过独立 OCR 仓库分发。

---

## 一、三层，别混在一起

```
① 应用            arale-book 仓库                   装机包几十 MB      用户下载（Release / 官网）
② 引擎            arale-book-ocr-manga 仓库         包内 Python/ONNX 归档
                                                     用户点「安装」时从 JSONL 仓库选择归档
③ 构建输入        submodule 内 gitignore 的 models/、runtime/   构建机准备，打入 ②
```

③ 在构建机上准备后打进 ②。用户机器不需要自有 Python、PyTorch 或额外模型下载。

---

## 二、逐个说清楚

### 在 `arale-book`（应用仓库，已公开）

| 东西 | 目录 | 进 git | 体积 | 谁用 |
|---|---|---|---|---|
| 应用源码 | `src/` | ✔ | 1.1 MB | — |
| 测试 | `tests/`（33 个文件） | ✔ | — | `npm test` / `npm run smoke` |
| 脚本 | `scripts/` | ✔ | — | 开发、构建、打包 |
| 图标素材包（母图 + 各尺寸 + icns/ico） | `assets/arale-icons-v2/` | ✔ | 12 MB | 人 + `npm run icon` |
| 打包图标（同步产物） | `build/icon.{icns,png,ico}` | ✔ | 4.6 MB | electron-builder |
| 内嵌词典 ×3 | `resources/dictionaries/` | ✔ | 1.0 MB | 首次启动自动装进用户词典库 |
| 默认 OCR 仓库登记 | `src/main/extensions/service.ts` | ✔ | — | 首次使用时登记 submodule 的远端 JSONL |
| 去屈折 / 异体字数据 | `data/{ja-transforms,kanji-variants}.json` | ✔ | 135 KB | 运行时（打进 asar） |
| Rust 解包器 | `native/arale-native/`（源码） | 源码 ✔ / `target/` ✘ | 二进制 ~2 MB | 运行时（extraResources） |
| 系统 OCR 小工具 | `native/arale-vision-ocr/`（含 149 KB 二进制）、`native/arale-winrt-ocr.ps1` | ✔ | 164 KB | 运行时（extraResources） |
| 本机演示库（含真实漫画） | `.arale-demo/` | ✘ | 444 MB | 开发自测 |

### 在 `arale-book-ocr-manga`（引擎库，**独立 + submodule**）

| 东西 | 进 git | 体积 | 谁用 |
|---|---|---|---|
| `arale_onnx_v1/`（Python/ONNX：桥接脚本 + build.mjs） | ✔ | 源码 KB 级 | 扩展 runner 是归档内的 Python |
| `arale_onnx_v1/prepare-runtime.mjs`、`build.mjs` | ✔ | KB 级 | 准备包内 Python、打 ZIP |
| `README.md`、`LICENSE` | ✔ | KB 级 | 人 |
| `repositories/default.jsonl` | ✔（构建更新） | KB 级 | 应用默认 OCR 仓库，一行一个引擎 |
| `dist/*.zip`（macOS arm64、Windows x64） | ✘ | 约 689 / 691 MiB | 后续上传 Release；Windows 待真机验证 |

### 既不在任何一个仓库、也不分发给用户

| 东西 | 在哪 | 体积 | 用途 |
|---|---|---|---|
| fp32 ONNX 模型 | `engines/arale_onnx_v1/models/` | 约 530 MB | 从原始权重离线导出，打进归档 |
| 包内 Python 与 ORT 依赖 | `engines/arale_onnx_v1/runtime/<target>/` | 依平台而定 | 构建归档，不进 git |
| 归档中间产物 | `engines/arale_onnx_v1/{build,dist}` | 构建缓存（可重跑） |
| Swift 模块缓存 | `.vision-build/` | 961 MB | 构建 Vision 小工具 |

---

## 三、三者怎么连起来（关系）

```
                 ┌────────────────────────────── 应用（Electron 主进程）──────────────────────────────┐
   书库里的书 ──▶ │ OcrService（队列/进度/写盘）                                                   │
                 │      │                                                                        │
                 │      ├─ engine = system    ──▶ spawn  native/arale-vision-ocr（Swift）        │
                 │      │                             或 powershell arale-winrt-ocr.ps1           │
                 │      └─ engine = extension ──▶ spawn  <userData>/extensions/ocr-arale_onnx_v1/  │
                 │                                     python/bin/python3 + engine/onnxruntime │
                 │                    ▲                                                          │
                 │                    └── NDJSON（meta/page/probe/fatal）逐行                          │
                 │                                                                              │
                 │ 引擎只吐「行」(OcrLine: 文字+框+朝向)                                          │
                 │ 应用侧 blocksFromLines() 排序 + 成块 → content/manga.json                      │
                 └──────────────────────────────────────────────────────────────────────────────┘
```

**三份契约（改它们=破坏兼容，必须一起改）**

| 契约 | 文件 | 内容 |
|---|---|---|
| NDJSON 协议 | `src/shared/ocr-protocol.ts` | `meta` / `page`（lines: 文字+confidence+box+vertical）/ `probe` / `fatal` |
| 扩展自描述 | `src/shared/extensions.ts` + 归档内 `extension.json` | `runner.program/args/env`；路径安装时校验必须落在安装目录内 |
| 引擎接口 | `src/main/ocr/provider.ts` | `recognize(job, sink) → OcrPageOut[]`：**一本书进，进度与结果出** |

**谁不需要知道谁**

- 应用**不知道**引擎是 Python 还是二进制，也不知道它带了多少模型；
- 引擎复用 Mokuro 的几何和裁切，不知道应用的阅读方向，也不写 `manga.json`；
- 归档**不知道**应用版本（见下面的缺口）。

**版本与兼容的现状（老实说）**

- OCR 仓库是 JSONL，每行按扩展条目校验，重复 id 会拒绝；
- `manga.json` 里记了引擎签名（新扩展为 `arale_onnx_v1:v2`）；
- 但 **NDJSON 协议本身没有版本字段**：旧归档 + 新应用时，只能靠「认不出的行忽略掉」自然退化——不会崩，但也没有显式协商。如果这套东西要长期对外分发，**建议在 `meta` 行加 `protocol: 1`**，应用不认就明确报错（现在是靠巧合而不是靠约定）。

---

## 四、仓库与归档的发布步骤

1. 把 ONNX 模型放在 submodule 的 `arale_onnx_v1/models/`，包内 Python 与平台匹配的 ONNX Runtime 放在 `runtime/<target>/`。两处均被 gitignore 排除。
2. `node engines/arale_onnx_v1/build.mjs --target <target>` 生成 `dist/*.zip`，并更新 submodule 的 `repositories/default.jsonl` 中相应资产的 sha256/bytes。
3. 将 ZIP 上传到 JSONL 条目所写的 GitHub Release；提交 JSONL，确保远端 raw 地址可用。应用的仓库管理可添加其他 HTTPS JSONL 地址。

调试包走 `npm run pack:debug`，存在 `build/dev-<target>/` 时直接纳入引擎；正式发布走 `npm run pack:release`，不携带引擎。开发态 `npm start` 也可直接使用该目录。

---

## 四点五、已 mark 的后续项

引擎源码、Mokuro 对照验证和打包步骤见 [`engines/arale_onnx_v1/README.md`](../engines/arale_onnx_v1/README.md)。

---

## 五、用户机器上最终长什么样

```
/Applications/ARaLeBook.app/Contents/Resources/
├── app.asar                 应用代码 + data/ + resources/
├── native/arale-native      Rust 解包器
├── native/arale-vision-ocr  macOS 系统 OCR 小工具
├── native/arale-winrt-ocr.ps1
└── dictionaries/*.zip       内嵌词典

~/Library/Application Support/aralebook/        ← 全部是用户数据，任何仓库里都没有
├── library/<bookId>/content/   书 + manga.json（文字层）
├── dictionaries/               用户词典（内嵌的三部装在这里）
├── cards.json                  词卡
├── settings.json / positions.json
├── extensions/ocr-arale_onnx_v1/  装好的引擎：python/ + engine/ + models/ + extension.json
└── llm.json                    LLM 配置（**apiKey 明文**，只在主进程读；IPC 只回「有没有 key」）
```
