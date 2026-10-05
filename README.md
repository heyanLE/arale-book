<a href="https://github.com/heyanLE/arale-book">
    <img src="./assets/arale-icons-v2/app/256.png" alt="ARaLeBook logo" title="あられブック · ARaLeBook" width="80"/>
</a>

# あられブック [App](#)


### 漫画与小说的日语阅读器
把漫画和小说管起来，读得舒服 —— 点一下就能查词，啃生肉不再卡壳。

[![License: GPL-3.0](https://img.shields.io/github/license/heyanLE/arale-book?labelColor=27303D&color=0877d2)](/LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20arm64%20%7C%20Windows%20x64-27303D)](https://github.com/heyanLE/arale-book/releases)

[![Tauri](https://img.shields.io/badge/Tauri-2-24C8D8?logo=tauri&logoColor=FFFFFF)](https://tauri.app/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=FFFFFF)](https://www.typescriptlang.org/)
[![OCR engine: arale-book-ocr-manga](https://img.shields.io/badge/OCR%20engine-arale--book--ocr--manga-27303D?logo=github&logoColor=FFFFFF)](https://github.com/heyanLE/arale-book-ocr-manga)

## 下载

发布包会放到 [Releases](https://github.com/heyanLE/arale-book/releases)。目前还没有正式版本，请从源码构建：

```bash
git clone --recurse-submodules git@github.com:heyanLE/arale-book.git
cd arale-book
npm ci
npm run build:vision-ocr      # 可选：macOS 系统 OCR 小工具
npm start                   # 构建并启动 Tauri
```

需要 Node.js 和 Rust 工具链；Windows 构建解包器还需 MSVC 构建工具。submodule 使用 SSH，需配置两个仓库的访问权限；HTTPS 克隆方式见[开发文档](docs/development.md)。Windows 不需要运行 `build:vision-ocr`，系统 OCR 使用随源码提供的 Windows.Media.Ocr PowerShell 脚本。

<div align="left">

| 平台 | 支持 | 已实测 | 说明 |
|---|:---:|:---:|---|
| macOS Apple Silicon（arm64） | ⚠️ | ❌ | Tauri 支持；当前版本尚未在 macOS 运行验收，ONNX 扩展需 macOS 14 |
| macOS Intel（x64） | ⚠️ | ❌ | Tauri 支持；当前未配置或验收安装包 |
| Windows（x64） | ✅ | ✅ | Windows 11 已验证 Tauri/WebView2 阅读、查词、制卡、OCR 与扩展；NSIS 构建通过，干净机器安装/卸载待测 |
| Linux（x64） | ⚠️ | ❌ | Tauri 支持；当前未配置或验收安装包 |


*✅ 表示已有目标机运行记录，具体覆盖范围见[当前状态](docs/current-state.md)；⚠️ 表示该组合未运行验收；❌ 表示没有构建目标。核对日期：2026-10-05。*

</div>


## 功能

<div align="left">

* 本地书库：漫画（`.cbz` `.zip` `.cbr` `.rar` `.7z` `.cb7` `.cbt`、图片文件夹、`.mokuro`）与小说（`.epub`），包括整本都是插画扫页的「图片型小说」。
* 可配置的阅读器：单页与双页跨页（配对偏移 0–4）、阅读方向左到右 / 右到左、缩放平移、沉浸模式；沉浸右上角可打开词卡侧栏并使用漫画批注工具。
* 漫画/图片批注：底部快捷画笔建层、当前画笔层橡皮与文字点击放置，右键也可新建；按书管理、按页保存，支持显示、锁定、排序、撤销与缩放同步；位于 OCR 文字层下方，阅读时仍可查词。详见[批注图层](docs/reader-annotations.md)。
* 小说阅读：目录树与章节导航、阅读位置记忆、字号 / 字体 / 行高 / 边距，支持竖排（縦書き）。
* 点词或划词查词典，支持 Yomitan 格式词典；词典由用户手动导入。
* 设置可管理 LLM、翻译配置及词卡弹窗的默认选择；内置免 Key 的 Bing 翻译，漫画识别时可按书选择 OCR 引擎。
* 词卡：可固定多张、可改标题、可存进这本书的词卡夹，含上下文里的子句分析；新词卡记住来源页/章，可跳转并返回。
* 文字识别（OCR）：系统 OCR（零下载）或漫画专用的 ONNX 扩展，把漫画页变成可点查的文字层。
* 整本书分词并生成词表；漫画可按 JLPT 参考等级筛选候选词、补录短语，生成 Anki 文本或带截图的 `.apkg`。A0–A4 提供本地词典、翻译辅助和不同 AI 消耗档位，支持预算、自动校验/修复、待审原因与已通过卡先导出。
* LLM 词义分析：任意 OpenAI 兼容接口，本地服务（Ollama 等）也可以。
* 深浅色主题，跟随系统。
* 以及更多…

</div>

## 贡献

这是一个个人项目，[Issue](https://github.com/heyanLE/arale-book/issues) 与 PR 都欢迎；改动较大的话，请先开个 Issue 聊一下。

提交问题前，可以先看看下面的「已知限制」和已有的 Issue。新上下文接续开发从[当前文档入口](docs/README.md)开始，Windows 换机见[迁移交接](docs/windows-handoff.md)。

### 相关仓库

[![heyanLE/arale-book-ocr-manga - GitHub](https://github-stats-extended.vercel.app/api/pin/?username=heyanLE&repo=arale-book-ocr-manga&bg_color=161B22&text_color=c9d1d9&title_color=0877d2&icon_color=0877d2&border_radius=8&hide_border=true&description_lines_count=2)](https://github.com/heyanLE/arale-book-ocr-manga/)


### 致谢

* 流程设计参考 [Fushi](https://github.com/hajisensai/Fushi)（GPL-3.0），早期阅读笔记已收入[历史文档归档](docs/archive/2026-09-26/README.md)。
* 日语去屈折数据来自 [Yomitan](https://github.com/yomitan/yomitan)（BSD-3-Clause）。
* 异体字表由 [kanji-processor](https://github.com/yomidevs/kanji-processor)（MIT）生成。
* 测试使用的词典来自 [MarvNC/yomitan-dictionaries](https://github.com/MarvNC/yomitan-dictionaries)。
* 漫画制卡使用的社区 JLPT 参考数据来自 [stephenmk/yomitan-jlpt-vocab](https://github.com/stephenmk/yomitan-jlpt-vocab)，来源和许可见 [数据署名](data/JLPT-ATTRIBUTION.md)。

### 免责声明

「あられ」取自《BanG Dream!》企划乐队 **夢限大みゅーたいぷ** 的主唱[仲町あられ](https://bang-dream.com/artist/yumemita/nakamachi-arale/)，图标用的就是她的形象（金色双马尾 + 猫耳耳机）。

本应用**不附带任何书籍内容**，也与任何内容提供方不存在关联 —— 书由你自己导入，全部存在你自己的磁盘上。这是个人非商业项目，与 Bushiroad / BanG Dream! 官方无任何关联；图标使用的角色形象权利属于其原始权利方，若日后转为商业分发请自行处理授权。

### 许可

<pre>
Copyright © 2026 heyanLE

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see &lt;https://www.gnu.org/licenses/&gt;.
</pre>
