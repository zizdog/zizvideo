package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/zizdog/zizvideo/internal/config"
)

// accessOut 是 `zizvideo check-access <路径>` 的唯一输出：**一行紧凑 JSON**。
//
// ⚠️ 契约在面板侧（`../zizpanel/internal/permissions/externalapp.go` 的 CheckAppAccess /
// parseAccessJSON）：面板以 `sudo -n -u <真实用户> <二进制> check-access <路径>` 调用，
// **逐行扫描 stdout**，取第一条以 `{` 开头且 JSON 合法、带 `readable`（bool）的行。
// 所以：① 只能打一行、不能格式化多行（首行只有一个 `{` 会被判为非法 JSON）；
// ② 除这行以外 stdout 不许有任何输出（日志走 stderr）；
// ③ **永远 exit 0** —— 面板把非零退出当"跑不起来"报错（"无法运行 …"），
//
//	而"读不了"必须如实走 readable:false + reason，不能让用户看到一句与事实无关的报错。
type accessOut struct {
	Path     string `json:"path"`
	Readable bool   `json:"readable"`
	Reason   string `json:"reason,omitempty"`
	// Mode 只在"探测完全磁盘访问权限"时有值（"fda"）。面板/脚本读的仍是 readable，
	// 多出来的字段对老解析器无害（它只找 readable 那行）。
	Mode string `json:"mode,omitempty"`
}

// fdaCanaries 是"通常只有拿到完全磁盘访问（TCC / Full Disk Access）才读得到"的哨兵路径。
//
// ⚠️ 它只能当**启发式**用，绝不能当成判决（2026-10-11 实测踩到）：本机上
// `~/Library/Application Support/com.apple.TCC/` 干脆不存在，而
// `/Library/Application Support/com.apple.TCC/TCC.db` 在**没有 FDA 的普通进程里也可能读得到** ——
// 于是"我读得到 ⇒ 你有权限"会是**假阳性**（比不探测更糟：安装器会以为万事大吉、跳过引导）。
// 所以：
//
//	① 真正可信的判据是**去读用户关心的那个路径**（媒体根）—— 安装器就是这么用的；
//	② 这个哨兵只用于"还没配任何媒体根"时给个**倾向性**提示，reasson 里明确写"通常说明"，
//	   不写"已授予"。
var fdaCanaries = []string{
	"~/Library/Application Support/com.apple.TCC/TCC.db",
	"~/Library/Safari/History.db",
	"~/Library/Messages/chat.db",
	"~/Library/Mail",
	"/Library/Application Support/com.apple.TCC/TCC.db",
}

// runCheckAccess handles `zizvideo check-access <绝对路径>` 与 `--fda`：
//
//	· 带路径 = 面板「权限」页的自检口（契约见 accessOut 的说明）；
//	· `--fda` = 给**独立部署安装器**用的"你到底有没有完全磁盘访问"探测（启发式，见 fdaCanaries）。
func runCheckAccess(args []string) error {
	fs := flag.NewFlagSet("check-access", flag.ContinueOnError)
	configPath := fs.String("config", "", "配置文件路径 (JSON，可选)")
	fda := fs.Bool("fda", false, "探测是否具备完全磁盘访问权限（TCC），而不是探测某个路径")
	if err := fs.Parse(stripFlag(args, "--config", configPath)); err != nil {
		return printAccess(accessOut{Reason: "参数不对：" + err.Error()})
	}
	if *fda {
		return printAccess(probeFDA(defaultFDACanaries()))
	}
	rest := fs.Args()
	if len(rest) != 1 {
		return printAccess(accessOut{Reason: "用法: zizvideo check-access <绝对路径> 或 --fda"})
	}
	target := config.ResolvePath(rest[0])
	if target == "" || !filepath.IsAbs(target) {
		return printAccess(accessOut{Path: rest[0], Reason: "必须是绝对路径"})
	}
	readable, reason := probeReadable(target)
	return printAccess(accessOut{Path: target, Readable: readable, Reason: reason})
}

// defaultFDACanaries 把哨兵路径展开成绝对路径（~ 走 config.ResolvePath，与项目其它地方一致）。
func defaultFDACanaries() []string {
	out := make([]string, 0, len(fdaCanaries))
	for _, p := range fdaCanaries {
		out = append(out, config.ResolvePath(p))
	}
	return out
}

// probeFDA 挨个真读哨兵路径：**任意一个读得到**就算拿到了完全磁盘访问；
// 全都存在但都读不到 ⇒ 明确说"没授权"；一个都不存在 ⇒ 如实说"无法判定"（不猜）。
// 返回的 path 是这次实际用来判定的那个哨兵（面板/脚本会显示给用户看是哪一个）。
func probeFDA(canaries []string) accessOut {
	var denied string
	for _, p := range canaries {
		st, err := os.Stat(p)
		if err != nil {
			// stat 被拒（EPERM）本身就是"没权限"的证据；ENOENT 才是"用不了这个哨兵"。
			if os.IsPermission(err) {
				denied = p
			}
			continue
		}
		_ = st
		if ok, _ := probeReadable(p); ok {
			return accessOut{Path: p, Readable: true, Mode: "fda",
				Reason: "能读受保护位置（通常说明已授予完全磁盘访问；最可靠的判据是去读你的媒体根目录）"}
		}
		denied = p
	}
	if denied != "" {
		return accessOut{Path: denied, Readable: false, Mode: "fda",
			Reason: "读不到受保护位置（很可能未授予完全磁盘访问）"}
	}
	return accessOut{Path: "", Readable: false, Mode: "fda",
		Reason: "无法判定：可用于探测的受保护位置都不存在 —— 请在系统设置→隐私与安全性→完全磁盘访问里确认"}
}

// probeReadable 真去读一次：目录要列得出来、文件要打得开。
//
// 为什么不用 os.Stat（权限位/存在性）：TCC（完全磁盘访问）拦的就是"读"这个动作，
// stat 能过、open 被拒是常态（外部卷、~/Desktop、~/Documents…）。所以判据必须是 open。
// 返回值：能不能读、读不了的原因（≤40 字，面板会原样显示给用户）。
func probeReadable(path string) (bool, string) {
	st, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return false, "路径不存在"
		}
		if os.IsPermission(err) {
			return false, "没有读取权限（可能缺完全磁盘访问授权）"
		}
		return false, "打不开：" + err.Error()
	}
	if st.IsDir() {
		f, oerr := os.Open(path)
		if oerr != nil {
			return false, openFailReason(oerr)
		}
		defer f.Close()
		// 目录：真的列一下才算"读得到"（空目录会返回 io.EOF，那是成功不是失败）
		if _, rerr := f.Readdirnames(1); rerr != nil && !errors.Is(rerr, io.EOF) {
			return false, openFailReason(rerr)
		}
		return true, ""
	}
	f, oerr := os.Open(path)
	if oerr != nil {
		return false, openFailReason(oerr)
	}
	_ = f.Close()
	return true, ""
}

func openFailReason(err error) string {
	if os.IsPermission(err) {
		return "没有读取权限（可能缺完全磁盘访问授权）"
	}
	if os.IsNotExist(err) {
		return "路径不存在"
	}
	return "打不开：" + err.Error()
}

// printAccess 打那一行 JSON 并**始终返回 nil**（exit 0）：任何"读不了"都由 readable 表达。
func printAccess(out accessOut) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false) // 别把 <路径> 转成 \u003c：面板会原样显示给用户看
	if err := enc.Encode(out); err != nil {
		// 理论上到不了这儿；真到了也要保住"一行 JSON"的形状
		fmt.Printf("{\"path\":%q,\"readable\":false,\"reason\":\"内部错误\"}\n", out.Path)
	}
	return nil
}
