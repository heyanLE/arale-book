# ARaLeBook · 阿拉蕾图标 v2

## 项目理解

ARaLeBook（あられブック）是 Electron + React + TypeScript 的本地漫画／小说书库与阅读器。核心功能包括漫画翻页、EPUB 排版、日语分词和点词查义、词卡；OCR 和 LLM 为可选能力。现有界面以深灰／纸色底和朱红强调色为主。

这组图标依据用户提供的仲町阿拉蕾 Q 版正侧面参考图重新生成。保留浅金双马尾、黑黄猫耳耳机、粉色眼睛、青色折线与粉色发夹、粉蓝发尾；以朱红圆角底板衔接现有界面。

## 文件

| 文件 | 用途 |
| --- | --- |
| `app-master.png` | 1254 × 1254 原始透明 PNG，阿拉蕾抱书主图标 |
| `avatar-master.png` | 1254 × 1254 原始透明 PNG，简化头像 |
| `app/{size}.png` | 主图标，16 / 24 / 32 / 48 / 64 / 128 / 256 / 512 / 1024 px |
| `avatar/{size}.png` | 头像版，同上尺寸；适合工具栏和小尺寸品牌标记 |
| `aralebook.icns` | macOS 图标，16 和 32 px 使用简化头像，其余使用抱书版 |
| `aralebook.ico` | Windows 图标，16 / 24 / 32 px 使用简化头像，其余使用抱书版 |
| `aralebook.iconset/` | macOS 标准尺寸源文件 |
| `prompts.json` | 两次生成使用的完整提示词 |
| `export.mjs` | 用 macOS 的 sips / iconutil 重新导出尺寸和格式 |

两张母图由内置 image_gen 生成；导出脚本仅缩放与封装格式，保留 alpha，不重画或抠除背景。提示词请求 1024 px，实际生成结果为 1254 px；标准 1024 px 版本在对应尺寸目录内。

## 项目接入位置

本素材包是**唯一真相源**；应用里那几张都是它拷出去的导出件，由 `npm run icon`
（`scripts/make-icon.mjs`）同步，**不要手改导出件**。

| 应用里的落点 | 来自本包 | 用途 |
| --- | --- | --- |
| `build/icon.icns` | `aralebook.icns` | macOS 打包图标（`electron-builder.yml` 的 `mac.icon`） |
| `build/icon.png` | `app/1024.png` | Windows / Linux 打包图标（`linux.icon`） |
| `build/icon.ico` | `aralebook.ico` | Windows 打包图标（`win.icon`，多尺寸内嵌） |
| `src/renderer/assets/brand-mark.png` | `avatar/64.png` | 工具栏品牌标记（22 CSS px，`Toolbar.tsx`） |

```bash
npm run icon          # 同步到上面四处（任何平台都能跑，纯拷贝 + 校验）
npm run icon:export   # 先从两张母图重导各尺寸/icns/ico（仅 macOS，用 sips/iconutil）
```

开发态 Dock 图标也指向 `build/icon.png`（`src/main/index.ts`，仅未打包时），所以
改完图标重启一次 `npm start` 就能在 Dock 里看到，不必先打包。

其它相关位置：

- 打包路径由 `electron-builder.yml` 显式指定（mac `.icns` / win `.ico` / linux `.png`）。
- 素材包与导出件的一致性由 `tests/icons.test.ts` 守着（逐字节比对 + 魔数 + 像素尺寸）：
  漂移了测试会红，不会出现「图标换了但打包还是旧的」。
- 旧的「代码画图标」路径已停用：`scripts/make-icon-from-art.py` 现在只会打印提示并以 1
  退出；`scripts/render-icon.cjs` 不再被引用。

## 参考

- 主视觉：用户提供的 PNG 参考图。
- 用户提供的萌娘百科页：https://mzh.moegirl.org.cn/仲町阿拉蕾 （本次网页读取返回 JavaScript 提示，未读取到正文）。
- 角色身份核对：https://bang-dream.com/artist/yumemita/nakamachi-arale/ （通过官方页面的搜索结果取得资料）。
- 生成图为基于角色参考制作的衍生素材，不是官方原画；角色相关权利归原权利方。
