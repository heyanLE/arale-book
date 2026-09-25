# 什么在哪儿、谁分发给谁（分发与引擎关系图）

这份文档回答三个反复被问到的问题：**哪些东西要分发**、**哪些东西在项目里**、**它们和引擎是什么关系**。
所有体积都是本机实测。

---

## 一句话

**应用只认两份契约**：一套 NDJSON 协议 + 一份 `extension.json`。
引擎用什么语言写、装在哪、模型多大，应用一概不知道——所以引擎可以独立成仓库、独立发版、以后还能换成 Rust。

---

## 一、三层，别混在一起

```
① 应用            arale-book 仓库                   装机包几十 MB      用户下载（Release / 官网）
② 引擎            arale-book-ocr-manga 仓库         归档 ≈170 MB（Rust/ONNX 版）
                                                     用户点「安装」时下载（应用从 catalog 拉）
③ 运行时与模型     第三方，任何仓库都不放               约 1.9 GB         只在【构建 ②】时需要
```

③ 从不分发给用户——它被 **打进去** 变成 ②。用户机器上再也不需要 Python、torch、模型下载。

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
| 内置扩展清单（回退） | `resources/extensions/catalog.json` | ✔ | 1.6 KB | 远端拉不到时用 |
| 去屈折 / 异体字数据 | `data/{ja-transforms,kanji-variants}.json` | ✔ | 135 KB | 运行时（打进 asar） |
| Rust 解包器 | `native/arale-native/`（源码） | 源码 ✔ / `target/` ✘ | 二进制 ~2 MB | 运行时（extraResources） |
| 系统 OCR 小工具 | `native/arale-vision-ocr/`（含 149 KB 二进制）、`native/arale-winrt-ocr.ps1` | ✔ | 164 KB | 运行时（extraResources） |
| 本机演示库（含真实漫画） | `.arale-demo/` | ✘ | 444 MB | 开发自测 |

### 在 `arale-book-ocr-manga`（引擎库，**独立 + submodule**）

| 东西 | 进 git | 体积 | 谁用 |
|---|---|---|---|
| `arale_onnx_v1/`（Rust 引擎：Cargo 工程 + build.mjs） | ✔ | 源码 KB 级 | 扩展 runner 就是它编出的二进制 |
| `build.mjs`（装配 + 打包） | ✔ | 52 KB | 构建归档 |
| `launcher/ocr-run`、`README.md`、`LICENSE` | ✔ | 22 KB | 人 |
| `dist/catalog-entry-*.json` | ✔（构建产物，含真 sha） | 1.6 KB | 粘进应用 catalog |
| **`dist/*.zip`（两个归档）** | ✘ | **741 + 745 MiB** | **上传到 Release**，用户安装时下载 |

### 既不在任何一个仓库、也不分发给用户

| 东西 | 在哪 | 体积 | 用途 |
|---|---|---|---|
| 模型权重（manga-ocr-base + comictextdetector.pt） | 本地 manga_anki 检出 | 500 MB | 构建归档时打进去 |
| Python venv / site-packages | 同上 | 1.4 GB | 同上 |
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
                 │                                     bin/arale_onnx_v1（自带 ONNX Runtime）    │
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
- 引擎**不知道** mokuro、不知道阅读方向（只报朝向），也不写 `manga.json`；
- 归档**不知道**应用版本（见下面的缺口）。

**版本与兼容的现状（老实说）**

- 扩展**清单**有 `schemaVersion: 1`，不认识就拒绝加载；
- `manga.json` 里记了引擎签名（`arale_onnx_v1:v1`）；
- 但 **NDJSON 协议本身没有版本字段**：旧归档 + 新应用时，只能靠「认不出的行忽略掉」自然退化——不会崩，但也没有显式协商。如果这套东西要长期对外分发，**建议在 `meta` 行加 `protocol: 1`**，应用不认就明确报错（现在是靠巧合而不是靠约定）。

---

## 四、要真正「能装上」，还差三步（当前状态）

1. **远端清单地址指向不存在的组织**：`DEFAULT_CATALOG_URL = github.com/aralebook/extensions/...`（`src/main/extensions/service.ts`），不是你的账号 → 现在远端根本拉不到，只有随包那份回退清单生效；
2. **随包清单里 sha 是占位**（`0000…`、`bytes: 0`、只有 darwin）→ 点安装会**明确失败在校验那一步**（设计如此：宁可不装，也不装进一个没校验的东西）；
3. **归档还没上传到任何 Release**。

最小动作（三步，都不需要改代码逻辑）：

```
① 建一个放清单+归档的仓库（就用 arale-book-ocr-manga 的 Releases）
② 改 DEFAULT_CATALOG_URL（或让用户设 ARALE_EXTENSIONS_CATALOG_URL 指向你的清单）
③ 把构建脚本生成的库根 catalog.json（release{repo,tag,assets}）
   的内容粘进 catalog.json 的 extensions 数组（sha256/bytes 是构建时写出的真值）
```

---

## 四点五、已 mark 的后续项

引擎的后续形态（**分词引擎也要单独分发**、Rust 引擎剩余工作、模型分发形态、协议版本字段）
集中记在引擎库里：[`engines/docs/roadmap.md`](engines/docs/roadmap.md)。
放那边是因为这些事都发生在「引擎怎么被分发」这一层；应用侧只留这一行指针，避免两处维护。

---

## 五、用户机器上最终长什么样

```
/Applications/ARaLeBook.app/Contents/Resources/
├── app.asar                 应用代码 + data/ + resources/（词典与清单各有一份副本，约 1 MB 重复）
├── native/arale-native      Rust 解包器
├── native/arale-vision-ocr  macOS 系统 OCR 小工具
├── native/arale-winrt-ocr.ps1
├── extensions/catalog.json  扩展清单回退
└── dictionaries/*.zip       内嵌词典

~/Library/Application Support/aralebook/        ← 全部是用户数据，任何仓库里都没有
├── library/<bookId>/content/   书 + manga.json（文字层）
├── dictionaries/               用户词典（内嵌的三部装在这里）
├── cards.json                  词卡
├── settings.json / positions.json
├── extensions/ocr-arale_onnx_v1/  装好的引擎：bin/ + models/ + ONNX Runtime + extension.json
└── llm.json                    LLM 配置（**apiKey 明文**，只在主进程读；IPC 只回「有没有 key」）
```
