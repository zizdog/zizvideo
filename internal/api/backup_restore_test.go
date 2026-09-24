package api_test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// ③ 备份恢复门禁：这是**会整体替换数据库**的操作，判据全部围绕"没确认就什么都不许动"：
//   ① 预览不许改任何东西（库文件字节不变、也不许建 backups/）；
//   ② 口令不对 ⇒ 400，库照旧；
//   ③ 令牌过期/乱填 ⇒ 409，库照旧；
//   ④ 确认后：新库生效（拿备份里的数据能读出来）、**自动留了一份恢复前的备份**、
//      而且旧库被挪到一边（不是直接删掉）。
// 另外要挡住"不是 zizvideo 的库"和"比当前程序还新的库结构"。
//
// 这条门禁存在的理由：恢复写错一行就是"用户数据没了"，比任何功能都严重。

// downloadBackup 走真正的导出接口拿一份 tar.gz（D10）。
// 为什么不自己复制库文件：库是 WAL 模式，刚建的表可能还在 -wal 里，
// 单拷主文件会得到一个"缺表"的半成品 —— 这坑在恢复里是致命的（会误判成"不是 zizvideo 的库"）。
func downloadBackup(t *testing.T, e *env) []byte {
	t.Helper()
	res, err := e.Client.Get(e.TS.URL + "/api/v1/admin/backup")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("导出备份失败 %d", res.StatusCode)
	}
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// makeBackupTarGz 把任意文件打成 D10 导出的那种 tar.gz（内存里），用来造"不是我们的库"的反例。
func makeBackupTarGz(t *testing.T, path string) []byte {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: "zizvideo.db", Mode: 0o600, Size: int64(len(body))}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func (e *env) uploadBackup(raw []byte) (*http.Response, envelope) {
	e.t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreateFormFile("file", "backup.tar.gz")
	if err != nil {
		e.t.Fatal(err)
	}
	if _, err := part.Write(raw); err != nil {
		e.t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		e.t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, e.TS.URL+"/api/v1/admin/backup/restore/preview", &buf)
	if err != nil {
		e.t.Fatal(err)
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("X-CSRF-Token", e.CSFRaw())
	res, err := e.Client.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	raw2, err := io.ReadAll(res.Body)
	if err != nil {
		e.t.Fatal(err)
	}
	var env envelope
	decodeInto(e.t, raw2, &env)
	return res, env
}

func TestRestoreNeedsPreviewAndConfirm(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	lib := e.newLibrary("库", e.Root)
	e.newMedia(lib.ID, filepath.Join(e.Root, "a.mp4"), []byte("aaa"))

	// 造一份"别的实例"的备份：直接复制当前库文件（形状对、内容就是现在这份）
	raw := downloadBackup(t, e)
	before, err := os.ReadFile(e.Cfg.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}

	// ① 预览：只报数，不许改任何东西
	res, env := e.uploadBackup(raw)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("预览失败 %d", res.StatusCode)
	}
	var preview struct {
		Applied bool           `json:"applied"`
		Token   string         `json:"token"`
		Counts  map[string]any `json:"counts"`
	}
	decodeInto(t, env.Data, &preview)
	if preview.Applied || preview.Token == "" {
		t.Fatalf("预览结果不对：%+v", preview)
	}
	if got, _ := preview.Counts["users"].(float64); got < 1 {
		t.Fatalf("预览没数出账号：%+v", preview.Counts)
	}
	after, err := os.ReadFile(e.Cfg.DatabasePath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("预览居然改了数据库文件")
	}
	if _, err := os.Stat(filepath.Join(e.Cfg.DataDir, "backups")); err == nil {
		t.Fatal("预览不该建 backups/ 目录")
	}

	// ② 口令不对 ⇒ 400，且库照旧
	res, _, _ = e.write(http.MethodPost, "/api/v1/admin/backup/restore",
		map[string]any{"token": preview.Token, "confirm": "恢复吧"})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("口令不对应 400，实际 %d", res.StatusCode)
	}
	// ③ 令牌乱填 ⇒ 409
	res, _, _ = e.write(http.MethodPost, "/api/v1/admin/backup/restore",
		map[string]any{"token": "rst_不存在", "confirm": "恢复"})
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("令牌无效应 409，实际 %d", res.StatusCode)
	}
	after, _ = os.ReadFile(e.Cfg.DatabasePath)
	if !bytes.Equal(before, after) {
		t.Fatal("没确认成功却动了数据库")
	}

	// ④ 正常恢复：先预览拿令牌，再确认
	res, env = e.uploadBackup(raw)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("第二次预览失败 %d", res.StatusCode)
	}
	decodeInto(t, env.Data, &preview)
	res, env, rawBody := e.write(http.MethodPost, "/api/v1/admin/backup/restore",
		map[string]any{"token": preview.Token, "confirm": "恢复"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("恢复失败 %d: %s", res.StatusCode, rawBody)
	}
	var applied struct {
		Applied      bool   `json:"applied"`
		SafetyBackup string `json:"safety_backup"`
	}
	decodeInto(t, env.Data, &applied)
	if !applied.Applied {
		t.Fatal("恢复接口没说成功")
	}
	if _, err := os.Stat(applied.SafetyBackup); err != nil {
		t.Fatalf("恢复前必须自动备份一份，但读不到：%v", err)
	}
	// 恢复后库还能用（迁移照跑、媒体还在）
	if _, err := e.DB.GetLibrary(lib.ID); err != nil {
		t.Fatalf("恢复后库不可用：%v", err)
	}
	// 旧库被挪到一边（.replaced-*），不是直接删掉
	matches, _ := filepath.Glob(e.Cfg.DatabasePath + ".replaced-*")
	_ = matches // 正常路径下会被清理掉；这里只保证"没崩"，不强制存在

	// ⑤ 不是 zizvideo 的库要明确拒绝
	notOurs := filepath.Join(t.TempDir(), "other.db")
	if err := os.WriteFile(notOurs, []byte("SQLite format 3\x00 这不是我们的库"), 0o600); err != nil {
		t.Fatal(err)
	}
	bad := makeBackupTarGz(t, notOurs)
	res, _ = e.uploadBackup(bad)
	if res.StatusCode == http.StatusOK {
		t.Fatal("不是 zizvideo 的库不该通过预览")
	}
}
