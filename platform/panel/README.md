# 面板托管（ZizPanel）

zizvideo 有**两种运行方式，互斥**（同一个 7766 端口只能有一个在跑）：

| 方式 | 谁持有 macOS 的 TCC（完全磁盘访问）授权 | 作业/label |
|---|---|---|
| **面板托管**（本目录关注的方式） | **面板**持有，zizvideo 作为它的子进程**继承** | `cn.zizpanel.zizvideo`（泛化通用轨会变成 `com.zizdog.zizvideo`） |
| 独立部署 | zizvideo 自己的二进制（见 `platform/macos/`） | `com.zizvideo.server`（plist label 与签名 identifier 都是它） |

**契约在仓库根 `CONTRACT.md`**（放根目录是刻意的：它是**跨仓库**契约，面板仓库也照它实现；
搬进 `platform/` 会让另一侧的引用失效）。本目录只放"面板相关"的操作性说明。

## 对接要点（改面板前先读）

- **版本真源**：镜像 `apps/zizvideo/manifest.json` 的 `latest`；面板读它决定"可更新"。
  ```bash
  curl -s https://mirror.zizdog.com:8888/apps/zizvideo/manifest.json
  ```
- **面板侧唯一要读的索引就是上面那份**（只含 darwin 产物）。`linux.json` / `fnos.json` / `docker.json` /
  `android.json` 是**平台专属清单**，面板不读、也不要当 manifest 的变体，更不要清理
  （它们都在应用级路径，不在版本目录里 ⇒ 面板的"清理旧版本目录"天然不会碰到）。
- **二进制路径**：面板托管的固定在 `/opt/zizvideo/bin/zizvideo`；数据目录
  `~/Library/Application Support/zizvideo/`（升级/卸载默认保留）。
- **发布**：`make publish` 走 mini 面板的文件接口写 `apps/zizvideo/`（凭据 `.panel-credential.local`，
  只有生产机的面板进程能写那块外置盘），**顶层索引最后传**，传完复验线上可达。
- **面板改 label 时**：`platform/macos/install-zizvideo.sh` 的 `PANEL_LABELS` 数组要跟着加一项，
  否则两条作业会抢 7766（`CONTRACT.md` 里写了原因）。
