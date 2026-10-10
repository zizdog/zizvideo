# 给面板 AI：zizvideo 的 `check-access` 自检口（对接说明）

> 写这份的原因：面板正在做"应用的能用泛化改造"，zizvideo 侧配合加了自检动词。
> **本文所有判据都是从两边代码读出来的**（zizvideo 侧本仓库，面板侧 `../zizpanel/…`），
> 面板 AI 照这个实现不会有闪失；哪条与代码不符就以代码为准并回我。
> 本仓库这次改动：`cmd/server/check_access.go`（新）、`cmd/server/main.go`（挂动词）。
> 生效版本：**zizvideo ≥ 0.6.2-mvp**（0.6.1-mvp 及更早没有这个动词）。

## 1. 面板怎么调（现状，不用改调用面）

`../zizpanel/internal/permissions/externalapp.go:256-275` 的 `CheckAppAccess`：

```
sudo -n -u <真实用户> <execPath> check-access <路径>
```

- `<execPath>`：面板托管是 `/opt/zizvideo/bin/zizvideo`（`ZizvideoInstallPath`）；独立部署是 `~/.local/bin/zizvideo`。
- **必须是真实用户身份**（`sudo -n -u <owner>`）——root 会绕过 TCC，我们会如实报 `readable:true`，
  那就成了谎报。zizvideo 侧不做任何身份检查（信任调用方），这条靠面板保证。
- **不带 `--config`**：这个动词不读配置、不启服务、不写盘、不联网（纯读一次路径，可反复调）。

## 2. 输出契约（面板解析的就是它）

**stdout 只有一行，紧凑 JSON**（`/Users/zizdog` 是示例）：

```json
{"path":"/Users/zizdog/Movies/短剧","readable":true}
{"path":"/Users/zizdog/Documents","readable":false,"reason":"没有读取权限（可能缺完全磁盘访问授权）"}
{"path":"/Users/zizdog/nope","readable":false,"reason":"路径不存在"}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `path` | string | 解析后的**绝对路径**（`config.ResolvePath`：Clean + 解符号链接，`/tmp` 会变 `/private/tmp`）。面板解析器不读它，仅供日志 |
| `readable` | **bool（必在）** | 以当前用户身份**真去读**的结果；面板 `parseAccessJSON` 要求它非 null，缺了就当"不支持自检" |
| `reason` | string（可缺） | `readable:true` 时不输出；`false` 时必给一句人话（≤40 字，面板原样显示给用户） |

- `reason` 目前只有这几种：`路径不存在` / `没有读取权限（可能缺完全磁盘访问授权）` /
  `打不开：<err>` / `必须是绝对路径` / `用法: zizvideo check-access <绝对路径>`。
- JSON 里的 `<` `>` 不做 HTML 转义（`SetEscapeHTML(false)`），别按 `\u003c` 兼容。
- 除这一行外 **stdout 不许有别的东西**（这个动词不打日志）；面板解析器会跳过不以 `{` 开头的行，
  但**多行格式化 JSON 会被判为不合法**（首行只有一个 `{`）——所以是一行，不是 pretty-print。

## 3. 退出码：**永远 0**（这条最容易踩）

| 情况 | 退出码 | 面板看到 |
|---|---|---|
| 读得到 | 0 | `readable:true` |
| 读不到（TCC / 权限 / 不存在） | **0** | `readable:false` + `reason` |
| 参数不对（少参数、相对路径） | **0** | `readable:false` + `reason` |

面板 `CheckAppAccess` 把**非零退出**当"跑不起来"报错（`无法运行 <execPath>：…`），
所以"读不了"绝不能靠退出码表达 —— zizvideo 一律 exit 0，只有 `printAccess` 本身都不可能失败。

## 4. `readable` 的判据 = 真读一次（不是 stat）

`cmd/server/check_access.go` 的 `probeReadable`：

- 文件：`os.Open` 成功即 `true`。
- 目录：`os.Open` + `Readdirnames(1)` 成功即 `true`（空目录返回 `io.EOF`，算成功）。
- **为什么不用 `os.Stat`**：TCC（完全磁盘访问）拦的是"读"，`stat` 能过、`open` 被拒是常态
  （外接卷、`~/Desktop`、`~/Documents`、`~/Downloads`）。只有真读一次才知道用户授权有没有生效。

## 5. 【建议】面板侧一处防御（不改也能跑，改了更稳）

老版本 zizvideo（≤0.6.1-mvp）没有这个动词：Go 的 flag 解析在**第一个位置参数**处停止，
`check-access <路径>` 会被当成多余参数忽略掉、**然后去启服务**；面板的调用形状又不带配置
⇒ 它会用**默认配置**（绑 `127.0.0.1:7766`、用真实数据目录）启动。此时真服务通常已占 7766
⇒ 监听失败 ⇒ **exit 1**。于是面板显示的是"无法运行 …"（与事实无关），而不是"该应用版本不支持自检"。

> 实测（2026-10-10，0.6.1-mvp 的发布件）：`<bin> check-access /tmp --config /tmp/x.json`
> —— 连 `--config` 都没读（它在位置参数后面），直接按默认配置在 7766 起了服务、跑了一轮
> startup 自动扫描，直到被信号停掉。**结论：老版本上这个动词会"真的把服务起起来"，
> 面板不能假设它只是"不答 JSON"。**

建议：`CheckAppAccess` 里把**"没有可解析的 JSON 行"一律归为 `Supported:false`（"该应用版本不支持自检，请升级"）**，
只有在**进程根本没跑起来**（exec 失败）时才报"无法运行"。这样新旧版本都能给出人话。
（新版 zizvideo ≥0.6.2-mvp 不会再有这个问题：动词在 `run()` 之前被 `indexVerb` 截走，
参数顺序也随意 —— `--config` 放前放后都认。）

## 6. 相关面（没变，别改）

- `roots` 动词不变：`zizvideo roots list|add <绝对路径>|remove <绝对路径> [--config <file>]`，
  一行 JSON；面板的 `RootsArgs`（`registry.go:138`）照传即可。
- `--version` 仍是 `zizvideo <版本>`；`/healthz` 返回 `ok`；`/readyz` 返回真就绪 JSON
  （面板建议把 `/readyz` 当 `verify`、`/healthz` 只作 `health`）。
- 注册表里 zizvideo 条目那两个**与事实不符**的常量（不属本次改动，但会影响泛化改造）：
  `ZizvideoLabel` / `ZizvideoSigningID` 现在写的是 `cn.zizvideo.serve`，
  而独立部署的 launchd label 与签名 identifier 都是 **`com.zizvideo.server`**、
  面板托管 label 是 **`cn.zizpanel.zizvideo`**。条目 `Enabled=false`，无运行时影响。

## 7. 手工验证（照抄即可，两边都能跑）

```
# 1) 可读 / 不可读 / 不存在 —— 三行都必须是 exit 0 + 一行 JSON
/opt/zizvideo/bin/zizvideo check-access "$HOME/Movies"
/opt/zizvideo/bin/zizvideo check-access "$HOME/Library/Mail"     # 没授权时 readable:false
/opt/zizvideo/bin/zizvideo check-access /nope-xyz

# 2) 逐字模拟面板（换成真实用户名）
sudo -n -u "$(id -un)" /opt/zizvideo/bin/zizvideo check-access "$HOME/Movies"

# 3) 参数顺序（新版两种都认；老版本只认 --config 在**前面**，别踩那个坑）
/opt/zizvideo/bin/zizvideo check-access "$HOME/Movies" --config "$HOME/Library/Application Support/zizvideo/config.json"

# 4) 面板侧解析自测（stub 输出上面那行 JSON，断言 readable 被读到）
```

zizvideo 侧的门禁：`go test ./cmd/server/ -run TestCheckAccess -count=1`
（复刻了面板的 `parseAccessJSON`：输出形状一变就红 —— 包括"必须只有一行"）。
