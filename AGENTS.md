# zizvideo — 工作区规则

> **开工前先读 `ZizVideo-当前状态.md`**（当前版本/部署状态/待办/凭据位置，已 gitignore）。
> 运行接口契约见 `CONTRACT.md`（两个接口都不许丢）。坑见 `docs/坑清单.md`。
> `README.md` 只给使用者看，别往里塞开发过程。

## 项目一句话

自托管的短视频/短剧应用：**一个 Go 二进制 + 内嵌原生 ESM 前端（无构建步骤）+ SQLite**，
既能被 ZizPanel 托管（面板的 TCC 授权），也能独立部署（自己的 LaunchDaemon + 自己的签名）。
本仓库是**独立项目**，与 ZizPanel 仓库（`../zizpanel`，GitHub `zizdog/zizpanel`）通过
`CONTRACT.md` 的两个运行接口 + 镜像索引 `apps/zizvideo/manifest.json` 对接。

- **本机（MacBook Air M4）＝ 唯一开发/测试机**；面板入口 `https://127.0.0.1:8443/`，zizvideo 端口 **7766**。
- 🛑 **生产机（Mac mini M4）不碰**，唯一例外：公网镜像站 `mirror.zizdog.com:8888` 的文档根在它的外置盘上，
  而**只有它的面板进程**能写（TCC，坑 217）⇒ 发布 zizvideo 时可以用它的面板文件接口写 `apps/zizvideo/`，
  做完即止。凭据在 `.panel-credential.local`（gitignored）。
- 版本号以 **`Makefile` 的 `VERSION` + `internal/api/api.go` 的 `Version`** 为准（两处必须一致，`make check` 会核对）。

---

## 一、每轮改动的收尾动作

1. **`make check` 必须真绿**（版本一致 + 前端 JS 真解析 + `go vet` + 单测）。
   写法固定：`make check > /tmp/zv-check.log 2>&1; echo "EXIT=$?"`（别用管道，管道会掩盖退出码）。
2. **本地提交**（`git add -A && git commit`）；推 GitHub 见铁律 4。
3. **发版**（只在用户点名时）：`make release` → `make publish` → 让用户**在面板后台手动更新**测试。
   - 面板不需要跟着发版：它读镜像索引的 `latest`，所以 zizvideo 单方面发版即可生效（市场卡片会显示「可更新」）。
   - **同版本绝不许换字节重传**：产物 sha256 一变，"已装 0.1.2" 与"新装 0.1.2"就不是同一份东西。
     要改就 `bump VERSION`（`0.1.2-mvp → 0.1.3-mvp`），再 `make release publish`。
   - 换机器/换凭据后先 `bash tools/publish-mirror.sh --self-test`（上传探针即删），别拿真版本试。
4. **GitHub**：`origin = git@github.com:zizdog/zizvideo.git`（public）。
   **必须走 SSH**（本机 https 到 github:443 经常连不上）；`gh` 已登录 `zizdog`（有 `repo` scope），
   建仓库/开 PR 用 `gh` 即可。**新会话不需要任何额外授权**。
5. **写回 `ZizVideo-当前状态.md`**（本机验证到的结论 + 待办），不要把历史过程灌进文档（进 git 历史）。

---

## 二、铁律（违反会破坏用户环境或让使用者拿到错东西）

1. **🚨 子代理与测试绝不许动真机的系统状态**：钥匙串信任（`security add-trusted-cert`）、
   `/Library/LaunchDaemons`、`sudo`、`launchctl bootstrap system`、真实证书 —— 一律用假命令验证
   （安装器有 `ZV_FAKE_*` 测试口、PATH 垫片）。真机验证只能由**用户点名**后单独做，做前先列出将要执行的命令；
   报告说"未真跑"而日志显示真跑了 = **谎报**。
2. **用户自己的改动永远不丢**：工作树里出现"我不记得写过的改动"（CSS、字号、图标、提示文案…）时，
   **默认它就是用户写的** —— 不许 `git checkout -- <file>`、不许 `git stash drop`、不许用旧副本盖回去；
   要么原样保留，要么先问。发版遇到脏树也一样：先问。
3. **前端必须过真 ES 解析器**（`make check` 里的 acorn 两项）：`node --check` 放过语法错误 =
   整页白屏且不给行号。**不许把 acorn 检查改成"缺了就跳过"**（那等于没测）。
4. **不许谎报**：做不到就如实说"跳过/失败"，并在汇总里单独列出。能谎报成功的功能比没做更糟。
5. **删文件类操作必须"删后回读"**：网页端删除入口默认只删面板记录（文件保留），
   连文件一起删要口令 + 路径在允许根内 + 删完 `os.Stat` 回读；文件删不掉就**不许**删记录。
6. **改一个 bug 前先问"这是哪一类"**：一次修完同类，补**一条**能失败的门禁就够，别再堆新的。
7. **文案纪律**：用户可见文案一句话（≤40 字），细节收进折叠项；代码注释只写结论 + 坑号。
8. **门禁只减不增**：新增一条必须同时删/合并一条旧的（唯一例外：抓"会伤到使用者"的新问题，
   并写明现有门禁为什么抓不到）。**门禁不许断言用户可改的东西**（提示文案、CSS/字号/图标/布局）。
9. **浏览器测试（Playwright）必须走 `tools/ui-test.sh`，收尾必须清干净**：脚本被超时/中断杀掉时
   harness 只杀 `node`，它拉起的 Chromium 会活下来；页面里若有死循环，renderer 会一直吃
   100%+ CPU —— 2026-09-22 实测把用户机器烧到负载 12、卡死发热（两个 renderer 145% / 65%，11 分钟）。
   → 一律 `bash tools/ui-test.sh <脚本.mjs>`（退出码/信号都会 `pkill -f ms-playwright`）；
   跑完 `pgrep -fl ms-playwright` 必须为空。**禁止**为了省事直接 `node xxx.mjs` 跑浏览器脚本。

---

## 三、环境速查

| | 本机（唯一开发与测试机） | mini（生产） |
|---|---|---|
| 面板 | `https://127.0.0.1:8443/`（凭据 `../zizpanel/.panel-credential.local` 的 `ZP_PASS`） | `https://panel.zizdog.com:8888`（凭据见 `.panel-credential.local`） |
| SSH | — | 只用于发布镜像（`ssh -p 22004 zizdog@zizdog.com`，钥匙 `~/.ssh/zp_mini_ed25519`） |
| 可破坏性操作 | 否（绝不重启） | 禁止（镜像目录写入除外） |

- 构建必须 `export GOPROXY=https://goproxy.cn,direct`（本机 proxy.golang.org 不可达）。
- 本机 zizvideo 默认**由面板托管**（`cn.zizpanel.zizvideo`，launchd 启动的是面板二进制）。
  独立部署模式会与它**互斥**（同一端口 7766，只能有一个在跑）。
- 面板的「注册开关 / 剧场管理 / 市场更新」等入口都在面板后台；zizvideo 的**观看面不放管理操作**。

---

## 四、目录速览

```
cmd/server                入口（--config / --version / --supervise）
internal/api              路由与 handler；Version 常量在这里
internal/web/assets       内嵌前端（原生 ESM，无构建步骤）
internal/{storage,media,dirimport,autoscan,config,auth,task}
migrations                SQLite 迁移
install-zizvideo.sh       独立部署安装器（system LaunchDaemon + 证书导入 + 升级/卸载）
tools/{codesign-release.sh,publish-mirror.sh,make-app-index.py,check-js-*.mjs}
CONTRACT.md               两个运行接口的冻结契约
docs/ITERATION-*.md       历史设计基线；docs/坑清单.md 结论
```
