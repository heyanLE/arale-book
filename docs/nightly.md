# 每夜构建与版本

当前实现：2026-10-06。只提供 Windows x64 NSIS `.exe` 和 macOS Apple Silicon（arm64）`.dmg`。正式版发布流程暂未实现。

## 版本与渠道

- Nightly 使用北京时间的日期版本 `YYYY.M.D`，例如 `2026.10.5`，不包含基础版本、前导零或提交号。
- GitHub 标签 `nightly-2026.10.5`，名称 `Nightly 2026-10-05`；始终为 prerelease，不占用正式版 Latest。
- `dev` / `nightly` / `release` 是独立构建元数据，不通过日期大小猜测渠道。源码内的 `0.1.0` 保持为开发基础版本，CI 在构建时覆盖 Tauri 配置，不每日提交版本变更。
- 设置的“版本与更新”读取原生应用实际版本，展示渠道、CPU、提交 SHA 和构建批次时间；开发版与尚未实现的正式版不请求更新。
- 保持现有应用 identifier 和书库目录，安装包渠道不会创建第二份书库。

## 每日发布

入口：[nightly.yml](../.github/workflows/nightly.yml)。每天北京时间 03:17（UTC 19:17）运行，也可在 Actions 手动运行；GitHub 的调度可能延迟。仅运行 `main`。

1. 获取当前 `main` 的 SHA，与最近一次完整、已发布的 Nightly 来源比较。相同则跳过；不以“过去 24 小时有没有提交”判断。
2. 当天已经有公开 Nightly 就跳过，次日再包含后续提交。当天存在上传中断留下的草稿则恢复该草稿的 SHA 和批次时间，不移动标签。
3. 两个平台检出相同 SHA 及该提交固定的 submodule；使用 Node 22.19.0、Rust 1.96.0、Tauri CLI 2.12.1 和 npm/Cargo 锁文件。只带小型 OCR 仓库索引，模型和 Python/ORT 引擎继续独立下载。
4. 分别执行类型检查、Node 测试、Rust 测试和正式打包；Tauri 入口的所有模式（含 `check` / `test`）都先构建前端，满足 `generate_context!` 对 `frontendDist` 的编译依赖，不依赖本机残留的 `dist/`。macOS runner 另编译 Swift Vision OCR 工具，放进应用 Resources/tools，最低系统为 macOS 14。前端目标包含 Safari 17。
5. 收集并校验两个安装包的源码 SHA、引擎 SHA、版本、批次时间和文件 SHA256。CI 构建中若已跟踪源码被修改，则拒绝发布。
6. 两个平台都成功后由唯一发布任务创建草稿，上传两个安装包、`build-info.json`、`SHA256SUMS.txt`。确认四项资产上传完整后再公开。失败保留草稿，已公开标签和版本不覆盖。

准备任务需要 `contents: write` 才能看到 GitHub 的草稿以恢复中断发布，但只执行读取；构建任务只读，发布任务可写。不需要额外仓库 Token：应用与引擎仓库已确认公开，checkout 会把无 SSH Key 的 GitHub submodule SSH 地址转成 HTTPS。

产物命名：

```text
ARaLeBook_2026.10.5_windows-x64-setup.exe
ARaLeBook_2026.10.5_macos-arm64.dmg
build-info.json
SHA256SUMS.txt
```

Windows 当前未使用商业签名证书；macOS 使用 ad-hoc 签名，未进行 Developer ID 公证。这些包不是商店版本。

## 更新检查

设置中点击“检查更新”，通过 Rust 请求公开 GitHub Releases 列表，无需账号或密钥。只接受日期标签合法、已公开的 Nightly prerelease，且必须同时具有两个非空安装包。按日期数字比较，不进行字符串比较或跨渠道更新。

区分有更新、当前最新、尚未发布、平台不支持，以及网络/限流错误；失败不会显示“最新”。请求有超时及响应大小限制，最多检查最近 300 条发布，无法完整确认时引导查看发布页面。

“下载新版本”打开对应 GitHub Release，让用户下载、手动安装；这一阶段不引入自动下载替换、Updater 签名密钥或正式版更新。

## 本地入口与验证

常规开发仍用 `node scripts/tauri.mjs dev`，普通打包用 `node scripts/tauri.mjs pack`。官方 CLI 已固定在 npm 开发依赖中，不要求全局安装。日期版本构建需提供 `ARALE_BUILD_VERSION`、`ARALE_BUILD_CHANNEL=nightly`、`ARALE_BUILD_COMMIT`、`ARALE_BUILD_TIME`；CI 还设置 `ARALE_BUILD_TARGET`。

推送完整应用改动与锁文件至 `main` 后，Actions 工作流才会生效。不要只提交 workflow 而漏掉尚未跟踪的 `src-tauri/` 或共享业务文件；若引擎目录另有待提交修改，需先提交/推送引擎并更新父仓库指针。

Windows 11 x64 / 2026-10-05 已验证：renderer/test 类型检查、`node scripts/test.mjs`（413 通过、1 跳过，包含 8 项发布事务测试）、`cargo test --manifest-path src-tauri/Cargo.toml --locked`（37/37）、Vite（Chrome 110/Safari 17 构建目标）和真实 WebView2 `node scripts/smoke-tauri.mjs`（195/195）。受限桌面运行未及时收到报告，改在正常桌面权限下使用隔离书库完成验证。

开发版和设置了日期版本/渠道/提交/批次时间的 Nightly debug 各通过真实 WebView2 195/195，包含原生版本透传与更新按钮状态。`node scripts/tauri.mjs pack` 在 Nightly 环境下生成日期 NSIS，EXE 的 FileVersion/ProductVersion 均为 `2026.10.5`，归档检查与 Windows 安装包收集/SHA 校验通过；这只是含未提交工作区修改的本地验证包，未发布或安装。`actionlint` v1.7.12 静态检查 `.github/workflows/nightly.yml` 通过。

本地验证包为 21,455,121 字节（20.46 MiB）。包内 EXE 与编译输出只有官方 bundler 的安装类型标记 `UNK → NSS` 三字节差异，按该标记归一化后逐字节一致；不能用未归一化的裸 EXE SHA 判断包内代码是否一致。Windows 浏览器打开沿用 ShellExecute 与平衡的 COM 初始化，最后新增该初始化后定向 Rust 更新测试 3/3、发布事务测试 8/8、debug 构建通过；未因此重打 NSIS。

### 首次 CI 失败与修复（2026-10-06）

[首次定时运行](https://github.com/heyanLE/arale-book/actions/runs/37395940195)于香港时间 08:48 触发（调度延迟）。公开任务记录显示 Windows x64/macOS arm64 都通过类型检查与 Node 测试，在 `npm run tauri:test` 失败；打包与发布均未执行。完整日志下载需要 GitHub 登录，本轮未取得该日志。

Windows 11 x64 / Node 24.19.0 / Rust 1.96.0：移走本地 `dist/` 后，以同一 Nightly 配置执行 `node scripts/tauri.mjs test`，复现 `generate_context!` 报 `frontendDist` 指向的 `../dist/renderer` 不存在。原入口只在 `dev` / `build` / `pack` 前构建前端，本机旧产物掩盖了测试入口缺少前置构建的问题。已改为每个入口模式都先构建 Vite；再次从没有 `dist/` 的状态运行同一命令，前端构建及 Rust 37/37 通过。

修复后的 GitHub 两平台构建尚未验收；macOS 编译/运行/DMG、公开 Release 发布与下载后安装仍待验证。本地复现与 Windows 测试通过不代表 macOS 或发布步骤已通过。
