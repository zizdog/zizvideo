# zizvideo 运行接口契约（两个接口都必须在，改动=破坏兼容）

> 2026-09-22：zizvideo 已从 ZizPanel 仓库**移出**成独立项目（本仓库）。面板侧只保留
> 「托管入口的 supervisor + 镜像索引消费 + 市场卡片」；产物/索引/安装器由本仓库产出。
> 发布：`make release && make publish`（索引由 `tools/make-app-index.py` 生成，别手改 JSON）。
>
> **本文件的判据是代码本身，不是文档**：每一条都标了出处（文件:行/.plist/脚本），
> 对不上就以代码为准并回来改这里（2026-09-23 全量核对过一遍）。

zizvideo 以两种方式运行，**共用**同一份二进制、config.json、数据目录与端口 7766；
两种方式**互斥**（安装器检测到系统域有面板托管的 `cn.zizpanel.zizvideo` 就拒绝独立安装）。
无论怎么重构，下面这些都不许丢。

## 前置：二进制的真实接口（两种模式共用）
- `cmd/server/main.go` 只认两个参数：`--config <config.json>` 和 `--version`。
  **没有** `--supervise` / `--user` / `--listen`（历史上文档写过，属于错误；`--listen` 是
  安装器的参数、也是面板 supervisor 的参数，都不是 zizvideo 的参数）。
- **监听地址只由 config.json 的 `listen` 字段决定**（env `ZV_LISTEN` 覆盖它，
  见 `internal/config/config.go` 的 `Load`→`applyEnv`），默认 `127.0.0.1:7766`。
  zizvideo 自身**不限制回环**（`cmd/server/main.go:103` 直接把 `cfg.Listen` 交给
  `http.Server.Addr`）⇒ 想要局域网直连就写 `"listen": "0.0.0.0:7766"`。
- `--version` 打印 `zizvideo <版本>`；`GET /healthz` 返回 ok（`internal/web/router.go:23`）。

## ① 面板托管入口（走面板的 TCC 授权）
- launchd 启动的是**面板二进制**（`/opt/zizpanel/bin/zizpanel`）：
  `<面板二进制> zizvideo-supervise --user <u> --zizvideo /opt/zizvideo/bin/zizvideo --config <数据目录>/config.json --home <h> --listen <host:port> --log-dir <h>/Library/Logs`
- supervisor 以 root fork 后 `SysProcAttr.Credential` setuid 到真实用户（**不经 sudo**）；
  plist 由面板写（`/Library/LaunchDaemons/cn.zizpanel.zizvideo.plist`，**不写 UserName**，
  `RunAtLoad`+`KeepAlive`，stdout/stderr → `zizvideo-supervise.{out,err}.log`）。
- 它给 zizvideo 的子进程命令**只有** `zizvideo --config <config.json>` ⇒ 面板侧的
  `--listen` **与 zizvideo 实际监听地址无关**（而且当前面板版本里它被校验后直接丢弃，
  非回环还会让 supervisor exit 1、服务起不来 —— 已知面板侧缺陷，见 `docs/坑清单.md`）。
  面板只在 config.json **不存在**时补一份 `{}`，从不覆盖用户已有配置。

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
- 版本真源在镜像：`apps/zizvideo/manifest.json`
  （`app` / `latest` / `generated_at` / `assets[{name,version,arch,sha256,size}]`）
  + 产物 `zizvideo_<版本>_darwin_arm64`（裸二进制，只发 arm64）。
- 发布件落 `dist/apps/zizvideo/`，`make publish` 走 mini 面板文件接口上传，**顶层索引最后传**，
  传完复验（索引 sha256/大小 + 线上可达 + `--version`）并清理镜像上的旧版本目录。
