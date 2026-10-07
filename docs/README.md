# 开发文档入口

最后核对：2026-10-07。新上下文按以下顺序阅读即可继续工作。

应用使用 Tauri + Rust + React/TypeScript，旧主进程、预加载和 Electron 打包入口已删除。运行与安装命令见 [开发文档](development.md)，已接入范围与 Windows 验证见 [Tauri 状态](tauri-migration.md)。应用沿用本机已迁移的数据根；窗口刷新中断制卡并保留检查点，需手动续跑，切换应用内页面不停止任务。

日期版本的 Windows x64 / macOS arm64 每夜构建、GitHub 发布和设置更新检查见[每夜构建](nightly.md)；首次 [Nightly 2026.10.6](https://github.com/heyanLE/arale-book/releases/tag/nightly-2026.10.6) 已通过两平台 CI 并公开发布，下载后安装和 macOS 实际运行尚未验收，正式版发布暂未实现。

官网首版位于 `site/`，运行 `npm run site:dev` 本地预览；每夜/正式构建分别跳转 GitHub Release，正式版缺失和联网失败都有明确状态。GitHub Pages 首次 CI 构建/部署已通过，公开入口因账户主页继承的旧域名跳转到博客 404，域名处理待确认。页面、命令与验证边界见[官网与部署](website.md)。

1. [当前状态](current-state.md)：已完成的决策、验证边界、当前优先任务。
2. [Windows 迁移与待修事项](windows-handoff.md)：下一台设备恢复材料、启动与验收顺序。
3. [架构与数据流](architecture.md)：定位代码、IPC、存储及 OCR 分发契约。
4. [开发与验证命令](development.md)：运行、打包、测试及记录结果的方法。
5. 修改 OCR 时读 [引擎当前文档](../engines/docs/current.md)，其中集中维护模型、包体积和性能数据。

漫画分词与 Anki 制卡第一版的实现和后续事项见[方案与状态](manga-vocabulary-anki-plan.md)。
新版“规则筛词 → 可选 AI 筛选 → 手动筛词 → 五字段选择＋A0–A4 生成 → 已通过卡导出”的档位、翻译能力、罗马音回退、预算和边界见[Anki Harness](anki-harness.md)；旧 R0–R3 草稿与任务保留兼容。
AI 筛选与词卡内容生成在 Worker 任务队列后台运行，与 OCR 共用右下角入口；关闭页面不停止任务，具体状态与恢复边界见[Anki Harness](anki-harness.md)。
第 2/4 步也可选“自行 AI”：按数量自动生成临时目录中的任务 MD 与简短提示词，打开文件夹并逐批复制提示词，在外部 AI 处理后将 JSON 逐份粘贴回来；应用不调用 LLM/翻译，保存批次进度并校验输入快照。使用方式见[Anki Harness](anki-harness.md#自行-ai-模式)。
[LLM 结构化返回协议](llm-output-protocol.md)说明 DeepSeek/OpenAI/兼容端点的 JSON 或工具选择、降级和缓存用量统计。
筛选页交互、实现状态及新旧界面截图见[漫画词汇筛选 UX](anki-filter-ux.md)。
设置页、词卡来源跳转、三栏展开状态记忆及多词典“展开更多”的交互见[设置与词卡 UX](settings-wordcard-ux.md)。
漫画/图片阅读器的阅读/选择/画笔/橡皮擦/文字工具、延迟建层、右键新建、右侧栏的词卡夹/图层管理、当前页操作、保存/原图失配保护，以及 Windows/macOS 无边框沉浸与独立系统栏开关见[批注图层](reader-annotations.md)；沉浸时也可打开侧栏查看词卡，文本 EPUB 暂不支持批注。

本机迁移的首次复制受到 Codex MSIX AppData 重定向影响，2026-10-05 已修正真实物理目录并以正式版 WebView2 验证 15 本书、4 部词典和 93 张词卡；在 Codex 宿主内操作 AppData 时须核对物理路径，详见 [迁移记录](tauri-migration.md#本机一次性迁移2026-10-05)。

按迁移时用户确认，不保留面向用户的旧书库迁入功能。已将本机现有 15 本书、4 部词典、词卡/批注/学习记录与服务配置一次性复制到 Tauri 数据目录并校验，旧目录保留；以后直接使用当前版本的数据目录。原生菜单、文件管理器定位与专用文件关联配置保留，安装后的系统验收待完成。最新 Windows 验证见 [Tauri 迁移](tauri-migration.md)。

## 哪份资料是当前依据

| 信息 | 当前依据 |
|---|---|
| 应用行为、IPC、路径 | 当前检出的 `src/` 源码 |
| 构建命令与资源 | `package.json`、`scripts/`、`src-tauri/tauri.conf.json` |
| OCR 模型文件与哈希 | `engines/arale_onnx_v1/model-manifest.json` |
| 实际归档大小与哈希 | `engines/arale_onnx_v1/dist/catalog-entry-*.json` |
| 应用展示/安装的 OCR 资产 | `engines/repositories/default.jsonl` |
| 已验证与待验证状态 | 本目录当前文档 + 引擎当前文档，查看各自核对日期 |
| 图标素材维护 | [素材说明](../assets/arale-icons-v2/README.md) |

仓库索引的 SHA 不等于“已上传 Release”或“目标系统已验收”；这两件事须分别核实。

## 历史资料

[2026-09-26 归档](archive/2026-09-26/README.md)收录此前的 Fushi 分析、设计日志、Rust OCR 可行性、分发说明和旧交接文档，以及 README 快照。原文保留，不再维护；不要从全文搜索结果直接采信归档中的结论。
旧引擎文档在[引擎库归档](../engines/docs/archive/2026-09-26/README.md)。

后续维护当前文档时直接修订这些页面，不再创建多份同名“最新状态”。需要保存历史时按日期归档，并在此处说明取代关系。

2026-10-02 已同步主仓库与 submodule README 的 Windows 状态：本机阅读/制卡/OCR、正式引擎下载安装、目录包/NSIS 构建已有记录；干净系统依赖、NSIS 实际安装/卸载和 Anki 客户端导入仍待验收。历史按日期验证节中的“Windows 未测”只描述当时范围。
