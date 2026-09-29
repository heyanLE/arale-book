# 开发文档入口

最后核对：2026-09-29。新上下文按以下顺序阅读即可继续工作。

1. [当前状态](current-state.md)：已完成的决策、验证边界、当前优先任务。
2. [Windows 迁移与待修事项](windows-handoff.md)：下一台设备恢复材料、启动与验收顺序。
3. [架构与数据流](architecture.md)：定位代码、IPC、存储及 OCR 分发契约。
4. [开发与验证命令](development.md)：运行、打包、测试及记录结果的方法。
5. 修改 OCR 时读 [引擎当前文档](../engines/docs/current.md)，其中集中维护模型、包体积和性能数据。

漫画分词与 Anki 制卡第一版的实现和后续事项见[方案与状态](manga-vocabulary-anki-plan.md)。
新版“规则筛词 → 可选 AI 筛选 → 手动筛词 → R0–R3 释义生成 → 制卡导出”的档位、评估和边界见[Anki Harness](anki-harness.md)。
AI 筛选与释义生成在主进程任务队列后台运行，与 OCR 共用右下角入口；关闭页面不停止任务，具体状态与恢复边界见[Anki Harness](anki-harness.md)。
筛选页交互、实现状态及新旧界面截图见[漫画词汇筛选 UX](anki-filter-ux.md)。
设置页与词卡来源跳转的交互见[设置与词卡 UX](settings-wordcard-ux.md)。

## 哪份资料是当前依据

| 信息 | 当前依据 |
|---|---|
| 应用行为、IPC、路径 | 当前检出的 `src/` 源码 |
| 构建命令与资源 | `package.json`、`scripts/`、`electron-builder.yml` |
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
