package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// panelAccess 是**面板侧解析器**的复刻（`../zizpanel/internal/permissions/externalapp.go`
// 的 parseAccessJSON）：逐行扫 stdout，取第一条以 `{` 开头、JSON 合法且带 `readable` 的行。
// 这个测试的意义就是"面板真能读懂我们的输出" —— 形状一变它就红。
func panelAccess(t *testing.T, out string) (bool, string) {
	t.Helper()
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "{") {
			continue
		}
		var a struct {
			Path     string `json:"path"`
			Readable *bool  `json:"readable"`
			Reason   string `json:"reason"`
		}
		if err := json.Unmarshal([]byte(line), &a); err != nil || a.Readable == nil {
			continue
		}
		return *a.Readable, a.Reason
	}
	t.Fatalf("面板解析不了这份输出（期待一行带 readable 的 JSON）：%q", out)
	return false, ""
}

// TestCheckAccessCLI 钉住面板「权限」页自检口的契约（用户 2026-10-10：配合面板的
// 应用泛化改造）。面板调用形状：`sudo -n -u <用户> <二进制> check-access <路径>` ——
// **没有 --config**，所以这条也顺带证明"不带配置也能跑"。
func TestCheckAccessCLI(t *testing.T) {
	bin := buildBinary(t)
	base := t.TempDir()
	if real, err := filepath.EvalSymlinks(base); err == nil {
		base = real
	}
	dir := filepath.Join(base, "媒体目录")
	file := filepath.Join(base, "片子.mp4")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	// ① 读得到的目录 / 文件 ⇒ readable:true，exit 0
	for _, target := range []string{dir, file} {
		stdout, stderr, code := runBin(t, bin, nil, "check-access", target)
		if code != 0 {
			t.Fatalf("check-access %s 退出码 = %d（必须 0：面板把非零当「跑不起来」）stderr=%q", target, code, stderr)
		}
		if strings.Count(strings.TrimSpace(stdout), "\n") != 0 {
			t.Fatalf("输出必须是**一行**（面板只认一行）：%q", stdout)
		}
		readable, reason := panelAccess(t, stdout)
		if !readable {
			t.Fatalf("check-access %s 应可读，得到 readable=false（%s）", target, reason)
		}
	}

	// ② 路径不存在：也是 exit 0 + readable:false + 一句人话
	missing := filepath.Join(base, "没有这个")
	stdout, _, code := runBin(t, bin, nil, "check-access", missing)
	if code != 0 {
		t.Fatalf("不存在的路径也必须 exit 0，得到 %d", code)
	}
	if readable, reason := panelAccess(t, stdout); readable || reason == "" {
		t.Fatalf("不存在的路径应 readable=false 且带原因，得到 readable=%v reason=%q", readable, reason)
	}

	// ③ 读不了的目录（0000）：readable:false —— 正是"缺完全磁盘访问授权"那一类
	if os.Geteuid() != 0 {
		locked := filepath.Join(base, "锁住的")
		if err := os.MkdirAll(locked, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(locked, 0o000); err != nil {
			t.Fatal(err)
		}
		defer os.Chmod(locked, 0o755)
		stdout, _, code := runBin(t, bin, nil, "check-access", locked)
		if code != 0 {
			t.Fatalf("读不了的目录也必须 exit 0，得到 %d", code)
		}
		if readable, reason := panelAccess(t, stdout); readable {
			t.Fatalf("0000 的目录不该报可读（reason=%q）", reason)
		} else if reason == "" {
			t.Fatal("读不了必须给原因（面板要显示给用户）")
		}
	}

	// ④ 参数不对：还是 exit 0 + readable:false（不许让面板看到一句无关的报错）
	for _, args := range [][]string{{"check-access"}, {"check-access", "相对路径"}} {
		stdout, _, code := runBin(t, bin, nil, args...)
		if code != 0 {
			t.Fatalf("%v 必须 exit 0，得到 %d", args, code)
		}
		if readable, reason := panelAccess(t, stdout); readable || reason == "" {
			t.Fatalf("%v 应 readable=false 且带原因，得到 readable=%v reason=%q", args, readable, reason)
		}
	}
}
