# zizvideo 运行接口契约（两个接口都必须在，改动=破坏兼容）

> 2026-09-22：zizvideo 已从 ZizPanel 仓库**移出**成独立项目（本仓库）。面板侧只保留
> 「托管入口的 supervisor + 镜像索引消费 + 市场卡片」；产物/索引/安装器由本仓库产出。
> 发布：`make release && make publish`（索引由 `tools/make-app-index.py` 生成，别手改 JSON）。
>
> **本文件的判据是代码本身，不是文档**：每一条都标了出处（文件:行/.plist/脚本），
> 对不上就以代码为准并回来改这里（2026-09-23 全量核对过一遍）。
> 面板侧的事实（supervisor 参数、plist、日志归属、索引怎么被消费）在
> `../zizpanel/docs/zizvideo-接入契约.md`：**2026-10-10 与那边逐条核对过**，本文件只写 zizvideo 侧。

zizvideo 以两种方式运行，**共用**同一份二进制、config.json、数据目录与端口 7766；
两种方式**互斥**（安装器检测到系统域有面板托管的 `cn.zizpanel.zizvideo` 就拒绝独立安装）。
无论怎么重构，下面这些都不许丢。

## 前置：二进制的真实接口（两种模式共用）
- `cmd/server/main.go` 认的参数/子命令：`--config <config.json>`、`--version`、
  `roots list|add <绝对路径>|remove <绝对路径>`（读写同一份 config.json）、
  `check-access <绝对路径>`（面板「权限」页的自检口，2026-10-10 加）。
  **没有** `--supervise` / `--user` / `--listen`（历史上文档写过，属于错误；`--listen` 是
  安装器的参数、也是面板 supervisor 的参数，都不是 zizvideo 的参数）。
- **监听地址只由 config.json 的 `listen` 字段决定**（env `ZV_LISTEN` 覆盖它，
  见 `internal/config/config.go` 的 `Load`→`applyEnv`），默认 `127.0.0.1:7766`。
  zizvideo 自身**不限制回环**（`cmd/server/main.go:103` 直接把 `cfg.Listen` 交给
  `http.Server.Addr`）⇒ 想要局域网直连就写 `"listen": "0.0.0.0:7766"`。
- `--version` 打印 `zizvideo <版本>`；`GET /healthz` 返回 ok（`internal/web/router.go:23`）。
- `GET /readyz` 是真就绪（200 = 就绪；**任一检查不过就 503**；JSON 在信封的
  `data.status` / `data.checks`：db/ffmpeg/ffprobe/media_roots/disk）—— 面板侧建议把它当
  `verify` 探针、`/healthz` 只作周期 `health`（面板侧文档 §2.5；声明照抄
  `docs/给面板的check-access说明.md` §6.1）。
- `check-access <绝对路径>`（`cmd/server/check_access.go`）：**一行紧凑 JSON**
  `{"path","readable","reason"}`、**永远 exit 0**、不读配置/不启服务/不写盘。面板以
  `sudo -n -u <真实用户> <二进制> check-access <路径>` 调用并逐行解析 stdout（必须是真实用户身份：
  root 会绕过 TCC 答出不实的 true）。判据是**真读一次**（文件 open、目录 open+Readdirnames(1)），
  不是 `os.Stat`。形状/退出码变了就是破坏面板的「权限」页 —— 门禁 `cmd/server/check_access_test.go`。

## ① 面板托管入口（走面板的 TCC 授权）
- launchd 启动的是**面板二进制**（`/opt/zizpanel/bin/zizpanel`）：
  `<面板二进制> zizvideo-supervise --user <u> --zizvideo /opt/zizvideo/bin/zizvideo --config <数据目录>/config.json --home <h> --listen <host:port> --log-dir <h>/Library/Logs`
- supervisor 以 root fork 后 `SysProcAttr.Credential` setuid 到真实用户（**不经 sudo**）；
  plist 由面板写（`/Library/LaunchDaemons/cn.zizpanel.zizvideo.plist`，**不写 UserName**，
  `RunAtLoad`+`KeepAlive`，stdout/stderr → `zizvideo-supervise.{out,err}.log`）。
- 它给 zizvideo 的子进程命令**只有** `zizvideo --config <config.json>`；面板的 `--listen`
  **经环境变量 `ZV_LISTEN` 真传给子进程**（env 优先于 config.json 的 `listen`，`internal/config/config.go:125`），
  所以面板说"暴露了"就是真暴露。面板只放行**回环与通配**（`localhost`/回环 IP/`0.0.0.0`/`::`），
  具体内网·公网地址与主机名一律拒绝（`../zizpanel/cmd/zizpanel/zizvideo.go` 的
  `zizvideoListenAllowed` + `zizvideoChildCmd`，2026-09-23 修）。
  ⚠️ **旧版本面板**才"校验后把 `--listen` 丢弃、非回环直接 exit 1"（那时服务起不来）——
  本文件旧版照抄过这条，**已过时**，2026-10-10 按面板代码改掉（面板侧文档 §8）。
- 面板只在 config.json **不存在**时补一份 `{}`，从不覆盖用户已有配置。

## ② 独立入口（走 zizvideo 自己的 TCC 授权）
- launchd 启动的是 **zizvideo 自己的二进制**：`<root>/bin/zizvideo --config <config.json>`
  （同样没有 `--supervise`/`--user`/`--listen`；重启靠 launchd 的 `KeepAlive`）。
- 自写 plist（label `com.zizvideo.server`）：默认 `--system` → `/Library/LaunchDaemons/`
  （写 `UserName=<u>`、`RunAtLoad`+`KeepAlive`、`HOME`/`PATH`，开机即起、不需登录）；
  `--user` → `~/Library/LaunchAgents/`（gui 域）。
- 安装位 `<root>/bin/zizvideo`，`root` 默认 `$HOME/.local`（即 `~/.local/bin/zizvideo`，
  可用 `ZV_INSTALL_ROOT` 覆盖）；日志 `~/Library/Logs/zizvideo.{out,err}.log`。
- 用自己的固定证书签名（identifier `com.zizvideo.server`，镜像同目录的
  `zizvideo-codesign.crt`）并由安装器导入信任 ⇒ 授权授一次、升级不失效；镜像没有 crt
  时降级为未签名部署（每次升级都要重新授权，脚本会明说）。

## 共用契约
- 端口 **7766**；面板托管的二进制固定在 `/opt/zizvideo/bin/zizvideo`。
- 数据目录 `~/Library/Application Support/zizvideo/`（DB、封面、config.json）；
  升级/卸载**默认保留**，只有 `--purge`（二次确认）才删。
- install 的 `--listen <host:port>`（默认 `127.0.0.1:7766`）就是**写 config.json 的 `listen`**；
  `0.0.0.0:7766` = 局域网直连（首次绑非回环时 macOS 防火墙要放行）。
- **label 是两侧共同的判据**：面板托管的作业叫 `cn.zizpanel.zizvideo`（泛化通用轨会变成
  `com.zizdog.zizvideo`，见面板侧文档 §6.1-2），本仓库独立部署的叫 `com.zizvideo.server`
  （plist label 与签名 identifier 都是它，`install-zizvideo.sh:9-11`）。
  `install-zizvideo.sh` 的 `PANEL_LABELS` 数组**把面板的两个 label 都认**（plist 在、或
  `launchctl print` 起得来都算命中 ⇒ 拒绝独立安装），并且独立安装时还有一道与 label 无关的
  兜底："7766 已被占用就拒绝"。**面板再改 label，往那个数组里加一项**，否则两条作业会抢 7766
  （面板侧文档 §6.1-2/§6.2/§8⑨）。面板侧注册表里另有一组过时常量
  （`internal/permissions/registry.go` 的 `cn.zizvideo.serve`，条目 `Enabled=false`、无运行时影响），
  那是面板侧要收拾的，本仓库不用跟。
- 版本真源在镜像：`apps/zizvideo/manifest.json`
  （`app` / `latest` / `generated_at` / `assets[{name,version,arch,sha256,size}]`）
  + 产物 `zizvideo_<版本>_darwin_arm64`（裸二进制，只发 arm64）。
- 发布件落 `dist/apps/zizvideo/`，`make publish` 走 mini 面板文件接口上传，**顶层索引最后传**，
  传完复验（索引 sha256/大小 + 线上可达 + `--version`）并清理镜像上的旧版本目录。
