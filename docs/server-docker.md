# Linux OCR 与 NAS Docker 部署

2026-10-20。Docker 镜像包含 Node 服务端、Linux Rust 解包器、CPython 3.12、CPU ONNX Runtime、OCR 源码与五份锁定模型。桌面端继续使用「服务器 URL」连接；不需要在 NAS 安装桌面程序、系统 Python、Rust 或独立数据库。

## 快速部署

在主仓库根目录执行，确保 `engines/` submodule 已检出。若是新 clone，先运行 `git submodule update --init --recursive`；构建需要引擎源码及模型清单，模型文件本身不进 Git。

```bash
mkdir -p server-library
cp server/.env.example server/.env
# 修改 server/.env：ARALE_LIBRARY_DIR 指向漫画原始目录
# x86_64 NAS 使用 linux/amd64，ARM64 NAS 使用 linux/arm64

docker compose -f server/compose.yaml up -d --build
docker compose -f server/compose.yaml ps
docker compose -f server/compose.yaml logs --tail=30 arale
```

默认发布 `3737` 端口。健康状态变为 `healthy` 后，桌面设置中添加 `http://NAS地址:3737`。读取首次自动生成的令牌：

```bash
docker compose -f server/compose.yaml exec -T arale cat /data/access-token
```

Arale 的书库目录由使用者指定，与 NAS 上其他阅读服务独立。首次部署可新建专用 `library/` 和 `data/`，先放入验收样本；不要按其他服务的名称或挂载推断它们也是 Arale 的书源。

客户端填写 URL 和令牌后，点击「验证并保存」，再选择服务器书源。本地书库保持原位，书籍、学习资料及进度的归属见[服务端与远程书库](server.md)。

默认镜像名为 `arale-server:local`，使用本机源码构建，尚未向 Docker Hub／GHCR 推送。首次构建需要拉取官方基础镜像、npm／PyPI／Cargo 依赖；有缓存后只重建变化的层。构建上下文由 `.dockerignore` 白名单限制，不包含个人书库、桌面数据、凭据、macOS／Windows Python 或仓库 Rust 工具链。

构建优先复用 `engines/arale_onnx_v1/models/` 中五个已锁定文件；本地文件存在但哈希错误时直接失败。缺失时从已发布的固定 SHA-256 桌面引擎归档取得平台无关模型，先校验整个归档的字节数／哈希，再只提取并校验五份模型；桌面 Python 运行时不会进入 Linux 镜像。最终镜像包含模型，运行期间无需下载。

## Compose 配置

`server/.env.example` 中的相对路径按 `server/compose.yaml` 所在目录解析，NAS 建议填写绝对路径。

| 配置 | 默认值 | 含义 |
|---|---|---|
| `ARALE_PLATFORM` | `linux/amd64` | x86_64 NAS；ARM64 改为 `linux/arm64` |
| `ARALE_LIBRARY_DIR` | `../server-library` | 原始漫画目录，只读挂载到 `/library`；目录须预先存在 |
| `ARALE_PORT` | `3737` | NAS 对外端口 |
| `ARALE_BIND_ADDRESS` | `0.0.0.0` | 局域网可访问；仅反代访问可设为 `127.0.0.1` |
| `ARALE_SERVER_NAME` | `Arale Server` | 服务端显示名称 |
| `ARALE_OCR_THREADS` | `4` | ORT 单个会话的 CPU 线程数，OCR 任务仍串行 |
| `ARALE_UID`／`ARALE_GID` | `1000`／`1000` | 容器运行身份；必须能读取漫画和写入服务端数据 |
| `ARALE_IMAGE` | `arale-server:local` | 本地构建或已自行导入的镜像名 |

默认数据存放在项目名下的 Docker named volume `arale-data`，容器内路径 `/data`。SQLite WAL、服务器身份、访问令牌、页图、文字层和检查点都在其中；重建／升级容器不会更改这些数据。首次卷目录为 UID/GID 1000；使用自定义 UID/GID 时，先配置卷权限，或使用下面的 NAS 目录挂载。

将数据放到 NAS 的固定目录：

```bash
# 先创建该目录，并授予所选 UID/GID 读写权限
# 在 server/.env 增加：ARALE_DATA_DIR=/volume1/docker/arale/data
docker compose -f server/compose.yaml -f server/compose.bind.yaml up -d --build
```

`/data` 与 `/library` 必须分开，不能互相包含。Compose 不自动创建填写错误或未挂载的漫画／数据目录；目录缺失会明确失败。自定义 UID/GID 在初次创建时确定，之后改变身份需要同时调整已有数据目录权限。服务端数据应位于 NAS 本地文件系统；不把 SQLite 放到 SMB/NFS 共享上供多个服务进程同时写入。

容器以普通用户运行，根文件系统只读，临时目录放在 `/tmp`，漫画只读，数据卷可写。无需 privileged、host network、Docker socket 或显卡。镜像仅提供 CPU 引擎。

### 已有令牌／Compose secret

默认自动生成的令牌会持久保存在 `/data/access-token`。如果需要由部署配置提供固定令牌，使用独立文件（至少 16 字符），在 `server/.env` 增加 `ARALE_TOKEN_FILE=/path/to/access-token`，然后：

```bash
docker compose -f server/compose.yaml -f server/compose.secret.yaml up -d
```

也可同时添加 `compose.bind.yaml`。外部文件需对容器 UID 可读，Compose 会把文件只读挂载为 `/run/secrets/arale_access_token`；服务端通过 `ARALE_SERVER_TOKEN_FILE` 读取，不把令牌值写进镜像或容器环境。启用后客户端使用外部文件的内容，旧自动生成令牌不再生效。源码启动仍兼容 `ARALE_SERVER_TOKEN`，两种显式配置不能同时使用。

## 更新、停止与备份

```bash
# 拉取代码后重新构建，保留同一个 Compose 项目名、数据卷和目录配置
docker compose -f server/compose.yaml up -d --build

# 正常停止，让服务端中止当前进程并保留已完成页
docker compose -f server/compose.yaml stop

# 移除容器但保留 named volume
docker compose -f server/compose.yaml down
```

部署时用了额外 override 文件，后续命令也应带上相同文件。`down --volumes` 会删除 named volume，只用于隔离测试环境；不要在实际书库上使用。目录挂载备份时先停止服务，保存整个数据目录及原始漫画目录。named volume 可在停止后使用 Docker 卷备份工具导出，恢复时保持目录内容完整；不要只复制 `arale.sqlite` 而漏掉 WAL 和页图。

OCR 工作属于服务端，客户端退出不会停止。正常停止可立即再次启动；强杀／断电后，文件租约最多等待约 15 秒过期，再从成功页的 SQLite 检查点继续。容器重建后主机名／PID 不同也能恢复。升级前停止旧服务，不能同时运行两个写同一数据卷的实例；活动租约会拒绝第二个写入者。旧版 PID 锁仅在确认本机原进程已退出时迁移，不能确认时保留原锁并报错。

启动先校验模型并实际加载 OCR CPU 会话，再启动 HTTP。`HEALTHCHECK` 只检查 `/health`，不会反复加载神经网络。启动宽限 120 秒；库扫描可在 HTTP 就绪后继续，状态与错误可在桌面服务器设置查看。

## 构建输入与维护

- `server/Dockerfile`：多阶段构建，官方 Node／Python／Rust 多架构镜像固定到索引摘要。
- `server/docker/requirements-linux.lock`：与当前 OCR 源码匹配的固定版本及 wheel 哈希，覆盖 CPython 3.12 的 Linux amd64／arm64；只接受二进制 wheel，不临时构建 Python 原生依赖。
- `server/docker/lock-ocr-deps.py`：人工升级依赖时，从 PyPI 官方元数据重建锁文件；升级后必须重新验证两架构识别。
- `engines/arale_onnx_v1/model-manifest.json`：沿用现有模型内容和 SHA，没有重新导出模型。
- `server/docker/extension-linux.json`：Linux runner 清单；不改变桌面现有引擎包或 JSONL。
- `server/docker/verify-runtime.py`：启动模型完整性、CPU provider 和依赖版本验证。
- `server/src/lock.ts`：心跳租约；`server/src/ocr.ts` 把 Linux 依赖锁也计入 OCR 检查点指纹，防止升级运行时后混用旧结果。

Linux wheel 兼容范围参照 [ONNX Runtime Python 文档](https://onnxruntime.ai/docs/get-started/with-python)；Compose 文件挂载机制参照 [Docker Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/)。模型／OCR 第三方许可与源码说明保留在镜像 `/opt/arale/licenses/`，Python wheel 自带许可元数据也保留。

## 本机验证

测试使用单独的 Compose project、临时漫画目录与 named volume，不读取或改写正式书库，也不操作机器上的其他容器。运行：

```bash
# Apple Silicon 本机原生 Linux ARM64
docker build --platform linux/arm64 -t arale-server:linux-arm64 -f server/Dockerfile .
npm run server:docker:test -- --platform linux/arm64 --native

# 同机模拟 NAS 常用的 Linux x86_64
docker build --platform linux/amd64 -t arale-server:linux-amd64 -f server/Dockerfile .
npm run server:docker:test -- --platform linux/amd64 --native
```

`--native` 额外运行现有 Rust 桌面客户端集成，需要本机桌面开发工具链。省略它只要求 Node 和 Docker，仍执行真实容器 HTTP、进度、OCR 和重建恢复。也可加 `--build` 让测试先构建对应镜像。报告写到 `.tmp/docker-validation/report-<arch>.json`，不含令牌；隔离容器、卷和测试漫画在结束后清理，构建镜像保留。

验收覆盖真实 Linux runtime 自检、容器 Rust 解包、认证原图、两设备进度比较／幂等、提交后退出的独立客户端、OCR 成功页后强杀并重建容器、重启续跑与文字层读取、服务器身份／令牌／进度持久化、只读原文件不变，以及可选的两个 Rust 客户端兼容验证。

### 已完成的验收

实际测试日期为 2026-10-19，2026-10-20 完成收尾核对。宿主为 macOS arm64，Docker Engine 29.7.2、Compose 5.4.0；容器内为 Linux、CPython 3.12.15、ONNX Runtime 1.30.0，使用 CPUExecutionProvider。以下两套是本机 Linux VM 结果；实体 NAS 结果另见下一节。

| 运行平台 | 完整流程 | 崩溃恢复 | 实际结果报告 |
|---|---|---|---|
| Linux ARM64（本机 Linux VM） | 15/15 通过 | 第 1 页后 SIGKILL，退出码 137，残留租约确认存在；重建后第 2 次尝试完成 4 页／28 块 | [ARM64 报告](validation/server-docker-2026-10-19/arm64.json) |
| Linux amd64（同机模拟运行） | 15/15 通过 | 相同强杀、租约恢复、逐页检查点和完整文字层验收通过 | [amd64 报告](validation/server-docker-2026-10-19/amd64.json) |

每套均实际运行两个 Rust 客户端，验证远程图片／文字层读取、进度冲突与重新定位、离线待同步重试、本机数据原位保留。外部 Compose secret 通过容器实际验证，令牌不进入镜像或容器环境；NAS bind override 已通过 Compose 配置校验，实体 NAS 的目录权限仍需部署时验证。

其他回归：`npm run typecheck` 通过，`npm test` 为 445 通过／1 跳过；`npm run server:test` 为 18/18；`npm run server:lock:test` 的 5 组排他、恢复和兼容检查通过；`python3 server/docker/test-models.py` 的 3 项本地／归档来源校验、篡改拒绝与路径约束测试通过。首次原文件比对曾因 Buffer／Uint8Array 类型不同误报，已改为同类型字节比较并完整重跑两架构，最终报告均通过。

ARM64／amd64 镜像分别保留为本机 `arale-server:linux-arm64`、`arale-server:linux-amd64`，未推送到镜像仓库。测试容器、测试 named volume 和样本目录均已清理。模型仅在构建时从现有锁定文件复制并校验，本轮没有实际执行远端大归档下载；下载／归档校验路径用隔离归档夹具验证。

上述 amd64 属于模拟运行，通过范围不等同实体 NAS 验收。原生桌面 GUI、Windows、NAS ACL／SMB/NFS、反向代理 HTTPS、长期压力、其他归档格式的 Linux 运行和所有 CPU 型号仍未验收。

## 实体 NAS 验收（2026-10-20）

Ubuntu x86_64 实体 NAS，Docker 29.1.3、Compose 5.1.4。独立项目 `arale-nas`，镜像 `arale-server:nas-20261020`；专用 `library/` 只读挂载、`data/` 可写，端口 3737，UID/GID 1000，根文件系统只读，限制 2 核／3 GiB。实际配置见 [NAS Compose](validation/server-nas-2026-10-20/compose.yaml)，其中相对路径基于 NAS 的专用部署目录。没有挂载或修改其他阅读服务的目录。本次只放入 `Arale-deployment-check.cbz` 两页日文样本，未迁入个人漫画。

在 NAS 原生构建 amd64 镜像，Rust 构建阶段复用 NAS 已缓存且摘要固定的 `rust:1.98-bookworm`（1.98.1），其余基础镜像仍使用 Dockerfile 的固定摘要。首次通过公开镜像分段下载 722,309,909 字节模型来源归档，在 NAS 验证原始归档 SHA-256 和五个模型 SHA-256 后构建。没有修改 Docker daemon、全局代理、系统 DNS 或既有网络路由。

首次启动发现私密源码归档的文件权限会随 `COPY` 进入镜像，普通用户无法读取 OCR 自检脚本。Dockerfile 现显式设置 `/app`、`/opt/arale` 中公开代码／模型的读取与目录遍历权限；修复后的镜像以普通用户、只读根文件系统实际通过以下验收。ARM64 本机完整流程是上节修复前的记录，本轮未重建 ARM64。

| 验收项 | 实际结果 |
|---|---|
| 认证与原图 | 错误令牌返回 401，真实 NAS 页图与本机原图逐字节一致 |
| 进度同步 | 两设备修订比较、幂等重试、409 冲突保护通过 |
| 后台 OCR | 提交客户端退出后 NAS 继续运行，2/2 页、14 个文字块、无失败；CPython 3.12.15 / ONNX Runtime 1.30.0 CPU |
| 两个 Rust 客户端 | 真实远程图片／文字层、进度冲突处理、离线待同步重试及本地数据原位保留通过 |
| Arale 单服务重启 | 身份、令牌、书籍内容版本、阅读进度及完整 OCR 文字层全部保持一致 |
| 既有服务 | 部署前的 17 个容器 ID、运行状态、启动时间、端口和挂载均一致；原有两个阅读服务 HTTP 状态一致 |
| 构建来源与目录隔离 | 127 份源码哈希核对通过；Arale 只挂载自有书库／数据目录 |

主要执行命令如下；公开记录中的部署路径统一写为示例 `/srv/arale`，执行时替换为自己的目录。构建在 NAS 的源码目录内运行，认证信息不放进命令行：

```bash
docker build --platform linux/amd64 \
  --build-arg RUST_IMAGE=rust:1.98-bookworm@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e \
  -t arale-server:nas-20261020 -f server/Dockerfile .
docker compose -f /srv/arale/compose.yaml up -d --no-build --wait --wait-timeout 180
docker compose -f /srv/arale/compose.yaml restart arale

# Mac 通过 EasyTier 转发访问实体 NAS，令牌仅由本机进程读取
python3 .tmp/nas-deploy/verify-nas.py
python3 .tmp/nas-deploy/verify-native-only.py
python3 .tmp/nas-deploy/verify-restart.py
python3 .tmp/network-session/nas_remote.py --script .tmp/nas-deploy/audit-services.py --timeout 90
```

这些 `.tmp` 文件是本次部署的本机验收工具，不随源码分发。原生步骤实际调用 `cargo test --manifest-path src-tauri/Cargo.toml --locked remote_round_trip -- --ignored --nocapture`，使用隔离客户端目录。首次验收工具将 Cargo 符号链接解析成 rustup 导致原生步骤未执行，修正调用后单独重跑通过，前六项 HTTP／OCR 结果保留。模型校验回归 3/3、`git diff --check` 通过。脱敏结果见 [NAS 报告](validation/server-nas-2026-10-20/nas.json)，配置备份及运维说明保存在 NAS 的 Arale 专用部署目录。

本次未验收原生桌面 GUI 连接 NAS、个人完整漫画库、长期负载、HTTPS 反向代理、NAS 整机重启、ACL／SMB/NFS、实体 NAS 上的其他归档格式或其他硬件。Mac 当前使用临时无 TUN EasyTier 转发；连接生命周期与 NAS 自启动服务分开，关闭该 Mac 进程会断开此临时入口。
