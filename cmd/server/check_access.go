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
}

// runCheckAccess handles `zizvideo check-access <绝对路径> [--config <file>]`:
// 面板「权限」页的自检口 —— 让**面板的弹窗由 zizvideo 自己的签名身份触发**，
// 回答"以当前用户身份到底读不读得到这个目录"（TCC 保护目录只有真去读才知道）。
//
// 不需要配置文件：面板调用时只传 `check-access <路径>`（`--config` 只是为了和 roots
// 子命令同一副样子；给了也不读盘）。
func runCheckAccess(args []string) error {
	fs := flag.NewFlagSet("check-access", flag.ContinueOnError)
	configPath := fs.String("config", "", "配置文件路径 (JSON，可选)")
	if err := fs.Parse(stripFlag(args, "--config", configPath)); err != nil {
		return printAccess(accessOut{Reason: "参数不对：" + err.Error()})
	}
	rest := fs.Args()
	if len(rest) != 1 {
		return printAccess(accessOut{Reason: "用法: zizvideo check-access <绝对路径>"})
	}
	target := config.ResolvePath(rest[0])
	if target == "" || !filepath.IsAbs(target) {
		return printAccess(accessOut{Path: rest[0], Reason: "必须是绝对路径"})
	}
	readable, reason := probeReadable(target)
	return printAccess(accessOut{Path: target, Readable: readable, Reason: reason})
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
