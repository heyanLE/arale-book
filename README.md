<div align="center">

<a href="https://github.com/heyanLE/arale-book">
    <img src="./assets/arale-icons-v2/app/256.png" alt="ARaLeBook logo" title="あられブック · ARaLeBook" width="80"/>
</a>

# あられブック [App](#)

### 漫画与小说的日语阅读器
把漫画和小说管起来，读得舒服 —— 点一下就能查词，啃生肉不再卡壳。

[![License: GPL-3.0](https://img.shields.io/github/license/heyanLE/arale-book?labelColor=27303D&color=0877d2)](/LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%2011%2B%20arm64-27303D)](https://github.com/heyanLE/arale-book/releases)

[![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=FFFFFF)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=FFFFFF)](https://www.typescriptlang.org/)
[![OCR engine: arale-book-ocr-manga](https://img.shields.io/badge/OCR%20engine-arale--book--ocr--manga-27303D?logo=github&logoColor=FFFFFF)](https://github.com/heyanLE/arale-book-ocr-manga)

## 下载

发布包会放到 [Releases](https://github.com/heyanLE/arale-book/releases)。目前还没有正式版本，请从源码构建：

```bash
git clone --recurse-submodules https://github.com/heyanLE/arale-book.git
cd arale-book
npm install
npm run build:native          # Rust 解包器，.rar / .7z 支持靠它
npm run build:vision-ocr      # 可选：macOS 系统 OCR 小工具
npm start
```

*需要 macOS 11 Big Sur 或更高版本。*

<div align="left">

| 平台 | 支持 | 已实测 | 说明 |
|---|:---:|:---:|---|
| macOS Apple Silicon（arm64） | ✅ | ✅ | 开发与发布都在这个平台，唯一完整验证过的组合 |
| macOS Intel（x64） | ⚠️ | ❌ | Electron 本身支持，但打包配置默认只出 arm64 |
| Windows（x64） | ⚠️ | ❌ | 有 NSIS 打包配置；系统 OCR 脚本也没在真机上跑过 |
| Linux（x64） | ⚠️ | ❌ | 有 AppImage 打包配置，运行时依赖未经验证 |
| 其他平台（含 Linux ARM） | ❌ | — | 没有任何构建目标配置 |

*⚠️ = 构建配置已写好，但没有在真机上验证过；❌ 表示目前没有可用的构建目标。*

</div>

自己打包的话，`npm run pack:release` 产出 `.app` 与 `.zip`，`node scripts/make-dmg.mjs` 出 `.dmg`。安装包没有做代码签名，首次打开需要右键 →「打开」。所有数据都存在本机 `~/Library/Application Support/ARaLeBook/`，删掉该目录即等于恢复出厂。

## 功能

<div align="left">

* 本地书库：漫画（`.cbz` `.zip` `.cbr` `.rar` `.7z` `.cb7` `.cbt`、图片文件夹、`.mokuro`）与小说（`.epub`），包括整本都是插画扫页的「图片型小说」。
* 可配置的阅读器：单页与双页跨页（配对偏移 0–4）、阅读方向左到右 / 右到左、缩放平移、沉浸模式。
* 小说阅读：目录树与章节导航、阅读位置记忆、字号 / 字体 / 行高 / 边距，支持竖排（縦書き）。
* 点词或划词查词典，支持 Yomitan 格式词典；随包内嵌三部小词典，开箱即用。
* 词卡：可固定多张、可改标题、可存进这本书的词卡夹，含上下文里的子句分析。
* 文字识别（OCR）：系统 OCR（零下载）或漫画专用的 ONNX 扩展，把漫画页变成可点查的文字层。
* 整本书分词并生成词表，可反复重跑。
* LLM 词义分析：任意 OpenAI 兼容接口，本地服务（Ollama 等）也可以。
* 深浅色主题，跟随系统。
* 以及更多…

</div>

## 贡献

这是一个个人项目，[Issue](https://github.com/heyanLE/arale-book/issues) 与 PR 都欢迎；改动较大的话，请先开个 Issue 聊一下。

提交问题前，可以先看看下面的「已知限制」和已有的 Issue；项目怎么设计的、引擎怎么分发的，记在 [`docs/`](./docs) 里。

### 相关仓库

[![heyanLE/arale-book-ocr-manga - GitHub](https://github-stats-extended.vercel.app/api/pin/?username=heyanLE&repo=arale-book-ocr-manga&bg_color=161B22&text_color=c9d1d9&title_color=0877d2&icon_color=0877d2&border_radius=8&hide_border=true&description_lines_count=2)](https://github.com/heyanLE/arale-book-ocr-manga/)

### 已知限制

* 可下载的 ONNX OCR 扩展需要 macOS 14+；macOS 11–13 仍可使用系统 OCR。
* 词典只支持 Yomitan 格式，MDX / StarDict / DSL 未实现。
* `.zip` / `.cbz` 会整体读进内存，单个超过 2 GB 的包会被拒绝（`.rar` / `.7z` 走流式解包，无此限制）。
* 系统 OCR 为屏幕文字与文档优化；ONNX 扩展使用漫画专用模型，但竖排、拟声词、手写体仍可能误识别。
* 「一键制卡」（导出 Anki 卡组）还没做，词卡目前只存在本地。
* 没有云同步、没有联网元数据刮削、单窗口。

### 致谢

* 流程设计参考 [Fushi](https://github.com/hajisensai/Fushi)（GPL-3.0），逐条对照的阅读笔记在 [`docs/analysis/`](./docs/analysis)。
* 日语去屈折数据来自 [Yomitan](https://github.com/yomitan/yomitan)（BSD-3-Clause）。
* 异体字表由 [kanji-processor](https://github.com/yomidevs/kanji-processor)（MIT）生成。
* 随包内嵌的词典来自 [MarvNC/yomitan-dictionaries](https://github.com/MarvNC/yomitan-dictionaries)。

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

</div>
