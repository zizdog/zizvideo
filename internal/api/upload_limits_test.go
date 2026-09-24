package api_test

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// readBody 读完响应体（错误信息都在里面）。
func readBody(t *testing.T, res *http.Response) string {
	t.Helper()
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

// ⑤ 门禁：上传的"体积护栏"要说清楚原因 ——
//   ① 声明 100 字节却只发了 40（典型外因：反向代理把请求体截断了）⇒ 400，
//      且报错里明确提到"反向代理/请求体上限"，别让用户对着"字节数不符"猜；
//   ② 超过单文件上限 ⇒ 413 UPLOAD_FILE_TOO_LARGE。
//
// 为什么值得一条门禁：这两种都是"用户会真的撞上、但报错最容易写成天书"的路径，
// 而且反向代理上限（nginx 默认 1m）是自托管最常见的坑。

func TestUploadBodyLimitsExplainThemselves(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	_ = e.newLibrary("库", e.Root)

	db := filepath.Join(e.Root, "上传")
	if err := os.MkdirAll(db, 0o755); err != nil {
		t.Fatal(err)
	}

	// ① 被截断的**整文件**上传（不带 Content-Range 才是"整文件"语义；
	//    带 Range 的短包是正常的分片续传，服务端会 202 让客户端接着传）
	uploadID, index := e.startAdminUpload(db, "cut.mp4", 100)
	res := e.putWhole(uploadID, index, bytes.Repeat([]byte("x"), 40))
	body := readBody(t, res)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("截断应 400，实际 %d: %s", res.StatusCode, body)
	}
	if !strings.Contains(body, "反向代理") {
		t.Fatalf("截断的报错要提到反向代理这个常见外因：%s", body)
	}
	if _, err := os.Stat(filepath.Join(db, "cut.mp4") + ".zvpart"); err == nil {
		t.Fatal("截断的半截文件要删掉，别留在磁盘上")
	}

	// ② 超过单文件上限：**start 那一步就会拦**（比等到 PUT 再拒更早、更清楚）
	tooBig := int(e.Cfg.UploadMaxBytes()) + 1
	res2, _, raw2 := e.write(http.MethodPost, "/api/v1/admin/uploads/start", map[string]any{
		"dir_path": db, "overwrite": false,
		"files": []map[string]any{{"name": "huge.mp4", "size": tooBig}},
	})
	if res2.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("超限应 413，实际 %d: %s", res2.StatusCode, raw2)
	}
	if !strings.Contains(string(raw2), "UPLOAD_FILE_TOO_LARGE") {
		t.Fatalf("超限的错误码应是 UPLOAD_FILE_TOO_LARGE：%s", raw2)
	}
	if !strings.Contains(string(raw2), "upload_max_file_mb") {
		t.Fatalf("超限要告诉用户改哪里：%s", raw2)
	}
}
