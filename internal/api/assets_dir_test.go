package api_test

import (
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zizdog/zizvideo/internal/config"
)

// 调试开关门禁（ZV_ASSETS_DIR）：设了就从磁盘读前端、且**不缓存**（改 CSS 刷新即生效）；
// 没设/目录不可用一律走内嵌 —— 一个调试开关绝不能把界面弄成 404。
func TestAssetsDirServesDiskFrontendInDevMode(t *testing.T) {
	cases := []struct {
		name      string
		assetDir  func(t *testing.T) string
		wantBody  string
		wantCache string
		wantETag  bool
	}{
		{
			name:      "默认：内嵌前端 + 版本 ETag + no-cache",
			assetDir:  func(t *testing.T) string { return "" },
			wantBody:  "抖音式：左返回",
			wantCache: "no-cache",
			wantETag:  true,
		},
		{
			name: "ZV_ASSETS_DIR：读磁盘 + no-store（本地改完刷新就生效）",
			assetDir: func(t *testing.T) string {
				dir := t.TempDir()
				if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<!doctype html><title>dev</title>"), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(dir, "app.css"), []byte("/* dev-css-marker */"), 0o600); err != nil {
					t.Fatal(err)
				}
				return dir
			},
			wantBody:  "dev-css-marker",
			wantCache: "no-store",
			wantETag:  false,
		},
		{
			name:      "目录不可用：退回内嵌（绝不 404）",
			assetDir:  func(t *testing.T) string { return filepath.Join(t.TempDir(), "并不存在") },
			wantBody:  "抖音式：左返回",
			wantCache: "no-cache",
			wantETag:  true,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := c.assetDir(t)
			e := newEnv(t, func(cfg *config.Config) { cfg.AssetsDir = dir })
			res, raw := e.callRaw(http.MethodGet, "/app.css", "", nil, nil)
			if res.StatusCode != http.StatusOK {
				t.Fatalf("GET /app.css = %d", res.StatusCode)
			}
			if body := string(raw); !strings.Contains(body, c.wantBody) {
				t.Fatalf("app.css 内容不对，期望含 %q，实际前 80 字节：%q", c.wantBody, body[:min(80, len(body))])
			}
			if got := res.Header.Get("Cache-Control"); !strings.Contains(got, c.wantCache) {
				t.Fatalf("Cache-Control = %q，期望含 %q", got, c.wantCache)
			}
			hasETag := res.Header.Get("ETag") != ""
			if hasETag != c.wantETag {
				t.Fatalf("ETag 存在性 = %v，期望 %v", hasETag, c.wantETag)
			}
		})
	}
}

// 静态层门禁：内嵌清单 + 目录请求。三件事一起盯：
// 点文件（.DS_Store 之流）不许进二进制、更不许对外 200（embed 用明确清单，不是 all:）；
// 没有 index.html 的目录请求直接 404（http.FileServer 默认回目录列表，等于把内部文件名摆出去）；
// 清单式的 embed 不能漏东西 —— 源码树里每个非隐藏资产都必须真的能从二进制里取到。
//
// 这条门禁存在的理由：①泄露用户机器上的垃圾文件，②暴露目录结构，③漏一个 JS 就是整页白屏。
func TestStaticLayerServesAssetsOnly(t *testing.T) {
	e := newEnv(t)

	res, _ := e.callRaw(http.MethodGet, "/.DS_Store", "", nil, nil)
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("GET /.DS_Store = %d，期望 404（点文件不该嵌进二进制）", res.StatusCode)
	}
	res, raw := e.callRaw(http.MethodGet, "/js/", "", nil, nil)
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("GET /js/ = %d，期望 404（不许回目录列表）：%s", res.StatusCode, raw[:min(120, len(raw))])
	}
	res, raw = e.callRaw(http.MethodGet, "/", "", nil, nil)
	if res.StatusCode != http.StatusOK || !strings.Contains(string(raw), "<html") {
		t.Fatalf("GET / = %d，首页必须还在：%s", res.StatusCode, raw[:min(120, len(raw))])
	}

	err := filepath.WalkDir(assetsDir(), func(p string, d fs.DirEntry, werr error) error {
		if werr != nil {
			return werr
		}
		name := d.Name()
		if name != "." && strings.HasPrefix(name, ".") {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		rel, rerr := filepath.Rel(assetsDir(), p)
		if rerr != nil {
			return rerr
		}
		res, _ := e.callRaw(http.MethodGet, "/"+filepath.ToSlash(rel), "", nil, nil)
		if res.StatusCode != http.StatusOK {
			t.Errorf("资产 %s 取不到（HTTP %d）—— 内嵌清单漏了它", rel, res.StatusCode)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
