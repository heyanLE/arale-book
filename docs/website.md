# 官网与部署

核对日期：2026-10-07。已准备 GitHub Pages 自动部署流程，首次公开部署待验证。

## 页面与使用路径

官网源码位于 `site/`，使用独立的 HTML/CSS/JavaScript 和 Vite 配置，不依赖 Tauri 运行环境，不新增 npm 依赖。构建产物为忽略的 `dist-site/`，不会写入桌面应用的 `dist/renderer/`。

按用户指定阅读了 [frontend-design skill](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md)，参考 [EasyBangumi](https://easybangumi.org/) 的简洁导航、产品介绍和功能分区。沿用项目品牌图标，白底、灰色功能区与应用朱红色；提供深浅主题记忆、手机导航、六项功能介绍、查词交互示例、下载渠道和 FAQ。示例日语为官网演示文案，没有读取用户实际书库。

操作路径：打开首页 → 查看功能或点击下载 → 选择每夜/正式构建 → 在 GitHub 对应 Release 查看说明和下载安装包。官网本身不下载或执行安装包。

- 每夜构建：读取公开 GitHub Releases，选择已发布、标签合法且同时具有 Windows x64/macOS arm64 非空安装包的最新 Nightly；排除草稿与不完整发布。
- 正式构建：选择具有两平台安装包的已发布非 prerelease；未发布时明确显示状态，提供发布记录入口，不跳转不存在的 `/releases/latest`。
- 浏览器匿名读取最多 100 项发布记录；未能在完整列表中确认缺少正式版时显示“暂未找到”，引导查看 GitHub。接口失败或超时则使用 `release-snapshot.json` 中有日期的已核对信息，同时提示以 Release 页面为准。
- 回退快照已于 2026-10-07 从公开 API 核对 `nightly-2026.10.7` 的地址、发布时间和两平台资产大小；后续修改页面时同步更新快照。只允许跳转本仓库 GitHub Release 地址。

## 本地运行

```powershell
npm run site:dev       # http://127.0.0.1:5174/
npm run site:build     # 生成 dist-site/
npm run site:preview   # 预览构建产物，同样使用 5174 端口
```

开发预览与产物预览二选一运行，或为产物预览指定另一个端口。只有 Node 可用时，可直接运行 `node node_modules/vite/bin/vite.js --config site/vite.config.mjs`，构建对应 `node node_modules/vite/bin/vite.js build --config site/vite.config.mjs`。配置使用相对资源地址，便于后续挂到 GitHub Pages 的项目路径。

## 验证

Windows 11 x64 / 2026-10-07 / Chrome 154.0.8037.98：官网 Vite 生产构建、`node --check site/main.js`、`git diff --check` 通过。隔离浏览器通过 32 项交互/数据场景检查：图片加载、内部锚点、深浅主题及记忆、按钮文字对比度、查词打开/关闭/焦点恢复与手机浮层完整可见、手机导航及 Escape、FAQ、公开 Nightly 链接、正式版缺失、模拟正式版上线、草稿/缺包过滤、接口失败回退与意外外站链接拒绝。无运行时异常；1440、1024、768、390、320px 无横向溢出。另在 5175 端口实际浏览器检查构建产物的图片、CSS、下载入口，资源路径均可解析到 `/arale-book/` 下；这不代表公开部署通过。已查看实际参考站和官网桌面、手机、深色及查词示例截图，记录在忽略的 `.tmp/site-preview/`。

尚未验证 macOS Safari、实际手机浏览器或公开 GitHub Pages 部署；本轮没有修改桌面功能、安装包发布流程或进行官网公开发布。

## GitHub Pages

GitHub Pages 入口为 `https://heyanle.github.io/arale-book/`。当前账户主页绑定了 `heyanle.com`，GitHub 会把项目入口重定向到该域名的 `/arale-book/`；该域名目前指向外部服务器，公开访问需单独验证，不能以 Actions 部署成功代替可访问验收。仓库 Pages 的构建方式使用 GitHub Actions，入口为 [pages.yml](../.github/workflows/pages.yml)。

`main` 上修改 `site/**`、`package.json`、`package-lock.json` 或官网 workflow 后自动部署，也可在 Actions 手动运行 Website。Ubuntu 24.04 / Node 22.19.0 执行 `npm ci` 与 `npm run site:build`，只上传 `dist-site/`；构建任务只读源码和 Pages 元数据，部署任务通过 `github-pages` 环境取得 Pages 写入与 OIDC 权限。不上传整个工作区，也不触发桌面构建。
