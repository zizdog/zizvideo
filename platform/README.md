# platform/ —— 平台特有代码（各自隔离）

**核心与平台分开**：`cmd/`、`internal/`、`migrations/`、内嵌前端、`tools/` 是**与平台无关的共用部分**；
本目录只放"某个平台/部署方式特有"的东西，一个平台一个目录，互不干扰。

| 目录 | 是什么 | 关键文件 |
|---|---|---|
| `macos/` | 独立部署（macOS）：系统/用户 LaunchDaemon、证书指纹固定、FDA 引导 | `platform/macos/install-zizvideo.sh`（含 `--verify`） |
| `linux/` | 独立部署（Linux/systemd）：系统用户、systemd 单元、`/readyz` 验收 + 回滚 | `platform/linux/install-zizvideo-linux.sh`（含 `--verify`） |
| `fnos/` | 飞牛 fnOS 应用包源（`fnpack` 打的 `.fpk`） | `platform/fnos/zizvideo/{manifest,config,cmd,wizard,app}`，设备侧自检 `platform/fnos/zizvideo/cmd/verify` |
| `docker/` | 容器（镜像/编排/入口脚本） | `platform/docker/{Dockerfile,docker-compose.yml,entrypoint.sh}` |
| `panel/` | 被 ZizPanel 托管时的对接说明（**契约本身仍在仓库根 `CONTRACT.md`**） | `README.md` |

**客户端**：`android/` 是独立的 Gradle 工程（另一类"平台"，有自己的版本号节奏），暂留仓库根部。

## 三条约定

1. **平台目录只放该平台特有的东西**；一旦发现两处要用同一段逻辑，就抽到 `tools/`（脚本）或
   `internal/`（Go）里共用 —— 平台目录里的重复逻辑是维护负担的源头。
2. **对外名字与仓库内路径解耦**：镜像上的**文件名**（安装器、各平台索引、`fnos/` 与 `docker/` 下的包）
   才是**对外契约**，发布脚本一律按 **basename** 上传。所以本目录怎么搬都不会影响使用者，
   但**任何"拼 URL/路径"的地方都必须区分"仓库内路径"与"镜像上的名字"**（坑 159/160 就是这类）。
3. **新增一个平台**：建 `platform/<平台>/`，在 `Makefile` 加目标，在 `tools/check-*.py` 里加该平台的静态校验，
   并在 `docs/验收清单.md` 的验证矩阵里补一行"这台设备上怎么一句话自检"。

## 每个平台的"一句话自检"

| 平台 | 命令（设备上不需要仓库） | 退出码 |
|---|---|---|
| macOS | `sudo bash platform/macos/install-zizvideo.sh --verify` | 0 全过 / 3 在跑但没就绪 / 1 有错 / 2 参数环境 |
| Linux | `sudo bash platform/linux/install-zizvideo-linux.sh --verify` | 同上 |
| 飞牛 | `sh /var/apps/zizvideo/cmd/verify`（随 `.fpk` 安装） | 同上 |
| 容器 | `bash tools/verify-deploy.sh --no-service`（在宿主上） | 同上 |
