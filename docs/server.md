# Arale Server 与本地／远程书库

2026-10-19：第一版服务端已接入现有桌面客户端。本轮目标是本机跑通服务器 URL 配置、独立书源、远程漫画阅读、进度同步与服务端后台 OCR；没有连接或改动实际 NAS。

2026-10-20：已在实体 Ubuntu x86_64 NAS 独立部署 Docker 服务，实际远程读图、进度同步、后台 OCR 与重启持久化均通过。书库使用 Arale 专用目录；本次仅放入两页验收样本，未使用其他阅读服务的书库或个人漫画。平台、命令与边界见[实体 NAS 验收](server-docker.md#实体-nas-验收2026-10-20)。

## 使用

在仓库根目录使用 Node 22.13+（本轮为 22.22.2）和 Rust 工具链：

```bash
npm ci
npm run build:native
npm run server:build
npm run server:start -- --library ./server-library --data ./.arale-server
```

`server-library` 放原始漫画压缩包或图片文件夹；`data` 存放服务端 SQLite、页图副本、文字层与 OCR 检查点，必须与扫描目录互不包含。默认监听 `127.0.0.1:3737`。首次启动自动生成 `data/access-token`，控制台只显示文件位置，令牌内容不写日志；也可通过 `ARALE_SERVER_TOKEN` 提供至少 16 字符的令牌。

桌面端打开「设置 → 服务器与书源」，填写名称、`http://127.0.0.1:3737` 和令牌，点击「测试连接／验证并保存」。返回书库后在顶部「书源」选择服务器，或在设置中点击「使用此书库」。切回「本地书库」即可继续使用原有数据。

启动时自动扫描，也可在服务器设置卡片中手动扫描。扫描任务后台执行；设置卡片显示扫描状态和错误，客户端轮询到扫描完成后刷新当前远程书库，顶部也保留手动刷新入口。导入按钮只用于本地书库；远程新增书籍先放入服务端扫描目录。

本机已有 `engines/arale_onnx_v1/build/dev-<平台>-<架构>/extension.json` 时自动选用其 OCR runner。也可显式指定：

```bash
npm run server:start -- --library /path/to/comics --data /path/to/arale-data \
  --ocr-manifest /path/to/installed-ocr/extension.json \
  --extractor /path/to/arale-native --host 127.0.0.1 --port 3737
```

对应环境变量为 `ARALE_SERVER_LIBRARY`、`ARALE_SERVER_DATA`、`ARALE_OCR_MANIFEST`、`ARALE_EXTRACTOR`、`ARALE_SERVER_HOST`、`ARALE_SERVER_PORT`、`ARALE_SERVER_NAME`。NAS／容器后续可通过 `--host 0.0.0.0` 监听局域网，并在可信网络或 HTTPS 反向代理后访问。客户端支持带路径前缀的 URL，拒绝 URL 内账号、查询参数、片段与重定向；修改地址必须重填令牌，保存时核对原服务器身份。

Linux Docker／Compose 与独立 Linux CPU OCR 运行环境现已提供，部署、目录／令牌配置和双架构验证记录见[Linux OCR 与 NAS Docker 部署](server-docker.md)。现有 macOS／Windows 桌面引擎包仍保持原分发方式；服务端不依赖桌面窗口、客户端 Worker 或 Anki。

## 数据归属与兼容

| 内容 | 原本地书库 | 服务器书库 |
|---|---|---|
| 书籍 ID／目录 | 原 `bk_*` 和 `library/<id>` 不变 | `rs_<serverId>_<bookId>`，独立 `remote-cache/<id>` |
| 原始漫画 | 客户端原有文件不变 | 读取扫描目录，页图发布到服务端数据目录的不可变内容版本 |
| 阅读位置 | 原 `positions.json` 不变 | 服务端 SQLite + 客户端持久待同步队列 |
| OCR | 原本地引擎与队列不变 | 服务端独立进程、SQLite 检查点、原子发布文字层 |
| 词典、LLM／翻译配置 | 本机既有数据 | 继续复用本机配置 |
| 词卡、分词、批注、Anki 草稿 | 原书目录与原逻辑 | 保存在独立远程缓存书目录，复用同一原生逻辑 |
| 书签、摘录、笔记、阅读／学习统计 | 原 `reading-journal.json` | 继续记录在本机同一日志，使用带服务器命名空间的书 ID |
| 阅读方向 | 本地书元数据 | 本机 `preferences.json` 覆盖，不改服务器元数据 |

没有迁移、移动、上传或重写现有本地书库。相同文件同时在本地与服务端时是两份独立记录；本地学习资料不会自动挂到远程书，也不会同步到另一台客户端。不要把客户端整个数据根当作服务端数据根或原始漫画扫描目录。

连接配置保存在客户端 `remote/servers.json`，原生层注入 Bearer 令牌；返回渲染层的连接信息只有 `hasToken`。`remote/catalog.json` 是远程元数据缓存，`remote/outbox.json` 只索引有待同步／冲突的书籍，避免轮询遍历所有书的进度文件。移除连接保留缓存和本机学习资料，重新连接同一服务器沿用稳定书 ID。

原图经原生 HTTP 按需下载，校验清单中的字节数和 SHA-256 后原子落盘，再通过现有被动图片 `arale://` 协议提供；服务端绝对路径不进入客户端清单。离线时可阅读已缓存页面，未缓存页面需要恢复连接。没有整书下载、缓存配额或自动清理；手工清理前要注意远程缓存书目录也含本机学习资料。

OCR 文字层转换复用 `core/ocr/convert.ts`，服务端与本地 Worker 使用相同的排序、块合并和 manga.json 序列化。远程文字层缓存后，查词／分词／制卡仍走原流程；制卡验证和截图会先补齐所需原图。批注可使用已校验清单里的原图指纹绑定尚未下载的页面，已缓存文件仍实际验算指纹。

## 进度同步

每份位置包含内容版本、服务器修订号、设备 ID 和幂等操作 ID。客户端先原子保存待上报位置，再发送请求；断网不丢本机位置，重连轮询时重试。请求已经成功但响应丢失时，使用原操作 ID 取回相同回执，然后才发送下一份位置。

服务器按修订号比较后写入，支持正常回读；同一页的重复上报不增加修订号。两台设备从不同状态继续时返回 409 和当前服务器位置，两边位置均保留；应用顶部提供「采用本机位置／采用服务器位置」。采用服务器位置后先返回书库再重新打开，旧阅读器卸载时不会把已放弃位置重新提交。

漫画页清单变化会产生新内容版本。旧内容版本的待同步位置不会覆盖新版本；没有待同步修改时，重新打开新版本从未定位状态开始。遇到内容版本冲突，提示先刷新书库，再通过「从新版第一页开始」重新定位；旧的两边位置原子保存到本机 `progress-conflict-history.json`。第一版未做页内容重排匹配，不把旧版页码自动套到新版。

## 后台 OCR 与恢复

任务入队后由服务器 FIFO 串行运行，一本书同一内容版本同时只有一个活动任务。客户端关闭、切书源或离开阅读页都不停止服务器任务。客户端约每 3 秒轮询队列；完成后先缓存文字层，再发布现有 `ocr:done` 事件，阅读器刷新文字层。

SQLite 保存任务、尝试次数、逐页成功结果；检查点按书、内容版本、页 ID 与实际模型／runner 指纹隔离。服务端重启后把运行中的任务重新排队，只处理缺页。重新识别会清除该版本检查点；取消后保留已发布文字层。返回失败／缺页的进程不会发布不完整的新层，漫画内容变更也阻止旧结果成为当前版本。队列入队重试和活动任务去重共享持久回执，任务完成后仍保持幂等。

一个服务端数据目录只能运行一个服务进程，使用定期更新的文件租约防止两个 OCR worker 同时写入。租约按修改时间过期，容器重建改变主机名／PID 也能恢复，容器启动最多等待约 15 秒恢复异常退出的锁；旧版 PID 锁仅在确认本机原进程退出时迁移。服务端数据库为 SQLite WAL，启动不自动重建坏库。备份时停止服务并保存整个服务端数据目录及原始漫画目录；客户端学习资料需另备份其数据根。

## 接口与代码

接口前缀 `/api/v1`，除 `/health` 外均需 `Authorization: Bearer <token>`。第一版固定单一 `owner` 空间，尚无多账号权限系统。

| 接口 | 用途 |
|---|---|
| `GET /info`、`GET /state` | 服务器身份、API 能力、扫描状态、任务 |
| `GET /books`、`GET /books/:id` | 漫画清单、页清单、内容版本 |
| `GET /books/:id/pages/:pageId?revision=…` | 认证图片流、ETag、版本校验 |
| `GET /books/:id/ocr?revision=…` | 当前文字层和文字层修订号 |
| `GET /books/:id/progress`、`PUT /books/:id/progress` | 读取位置、带修订号与幂等键的同步 |
| `POST /books/:id/ocr-jobs` | OCR 入队／重识别 |
| `POST /jobs/:id/cancel` | 取消服务器任务 |
| `POST /library/scan` | 后台扫描书库 |

`server/src/{app,storage,library,ocr}.ts` 分别处理 HTTP、SQLite、扫描发布与任务；`src-tauri/src/remote.rs` 负责连接、凭据、HTTP、缓存和进度重试；`core/remote-transport.ts` 按书 ID 分发请求与合并队列，当前选中书源只影响书库列表和默认 OCR 能力。原本地导入、词典、阅读记录、批注和 study Worker 的 API 保留。

## 验证：2026-10-19

平台：macOS arm64，Node 22.22.2，Cargo 1.98.1。测试使用临时书库、独立服务端目录和独立客户端数据根，不读取或写入正式个人书库。

- `npm run typecheck`：renderer、core/tests、server 类型检查通过。
- `npm run server:build`、`npm run build:native`：服务端 bundle 与原生解包器 release 从源码构建通过。解包器补齐仓库工具链的探测环境；沙盒首次下载缺失 Rust 依赖失败，在允许访问配置代理的环境重跑通过。
- `RUST_TEST_THREADS=1 npm run tauri:test`：Vite 生产构建、Rust 编译通过；Rust 45 通过、2 忽略。忽略项分别为需要外部真实 RAR 的既有测试和需要活服务器的远程测试；后者由下述集成命令单独实际执行。
- `npm test`：442 项，441 通过、1 跳过，0 失败；涵盖本地路由不变、按书 ID 路由远程操作、队列合并、完成发布顺序与本机阅读方向偏好。
- `node scripts/test-tauri-ocr.mjs`：3/3；`node scripts/test-tauri-study.mjs`：6/6。后者包含预期的磁盘失败注入日志，最终断言通过。
- `npm run server:test -- --native`：19/19；真实 HTTP + 两个真实 Rust 客户端验证图片／文字层、分词输入、本地文件字节不变、偏好持久化、进度 CAS 冲突／采用远端／断网重试／内容版本冲突重新定位与历史保留，以及 OCR 检查点重启恢复、请求别名幂等与取消。服务器监听本机回环端口需在允许监听的环境运行；沙盒内首次因 `EPERM` 失败后在授权环境重跑通过。
- `npm run server:test -- --real --native`：17/17；使用已有 ONNX 包实际识别 `samples/ocr-fixture.png` 两页。独立客户端子进程提交请求后立即退出，服务器继续完成识别，第二个原生客户端实际读取文字层和原图，并验证同步与本地数据隔离。
- 真实 React App／SettingsPanel／LibraryView／ComicReader 浏览器夹具连接本机真实服务，操作验证保存连接、切换书源、远程阅读、后台 OCR 入队后切回本地、完成后读到文字层与页码恢复。夹具替代原生 IPC，不等于 macOS WebView GUI 验收。原生窗口通过调试进程尝试启动，CUA 未能绑定窗口，未把这次尝试记录为 GUI 通过。

界面证据：[服务器设置](images/server-2026-10-19/connection.png)、[远程阅读](images/server-2026-10-19/reader.png)。截图使用隔离测试 URL 与样本，不含个人漫画或访问令牌。

尚未验证 Linux／NAS／Windows 目标机运行、反向代理／HTTPS、完整原生 WebView GUI、多用户、超大书库和长时间压力；本轮没有发布安装包或部署到实际 NAS。首版远程书源仅支持漫画，现有本地 EPUB 继续使用原实现。上传／双向迁移、本机学习资料跨设备同步、远程 EPUB、整书离线与缓存管理留待后续。
