package api_test

import (
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
