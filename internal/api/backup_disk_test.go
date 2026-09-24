package api_test

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

// D10/D11 门禁：备份导出的东西必须**真能用**（tar.gz 里有一份 SQLite 快照 + 清单），
// 上传页拿到的盘必须是"目标媒体库所在的盘"而不是数据目录那块盘。
//
// 这条门禁存在的理由：备份这种东西最容易"看着成功、其实是个空壳"；
// 磁盘显示最容易指错盘（用户 2026-09-24 就是被指到系统盘上去了）。

type uploadSpaceBody struct {
	Inbox struct {
		Path       string `json:"path"`
		FreeBytes  uint64 `json:"free_bytes"`
		TotalBytes uint64 `json:"total_bytes"`
		Label      string `json:"label"`
	} `json:"inbox"`
	Library struct {
		Path  string `json:"path"`
		Label string `json:"label"`
		Free  uint64 `json:"free_bytes"`
	} `json:"library"`
	LibraryID string `json:"library_id"`
	Defaulted bool   `json:"defaulted"`
	SameVol   bool   `json:"same_volume"`
}

func TestUploadSpaceReportsTargetLibraryDisk(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	root2 := filepath.Join(e.Base, "media2")
	lib1 := e.newLibrary("第一个库", e.Root)
	lib2 := e.newLibrary("第二个库", root2) // newLibrary 已经把 RootPath 设成 root2

	res, env, raw := e.do(http.MethodGet, "/api/v1/me/upload-space", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("上传空间接口失败 %d: %s", res.StatusCode, raw)
	}
	var body struct {
		Inbox struct {
			Path       string `json:"path"`
			FreeBytes  uint64 `json:"free_bytes"`
			TotalBytes uint64 `json:"total_bytes"`
			Label      string `json:"label"`
		} `json:"inbox"`
		Library struct {
			Path  string `json:"path"`
			Label string `json:"label"`
			Free  uint64 `json:"free_bytes"`
		} `json:"library"`
		LibraryID string `json:"library_id"`
		Defaulted bool   `json:"defaulted"`
		SameVol   bool   `json:"same_volume"`
	}
	decodeInto(t, env.Data, &body)
	if body.Inbox.FreeBytes == 0 || body.Inbox.TotalBytes == 0 {
		t.Fatalf("收件盘没读到空间：%+v", body.Inbox)
	}
	if body.LibraryID != lib1.ID || body.Library.Path != e.Root || !body.Defaulted {
		t.Fatalf("没指定库时应给第一个可访问的库并标 defaulted：%+v", body)
	}

	// 指定第二个库：存储盘必须跟着换（这正是"用户报障"的那一点）
	res, env, raw = e.do(http.MethodGet, "/api/v1/me/upload-space?library_id="+lib2.ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("上传空间接口失败 %d: %s", res.StatusCode, raw)
	}
	body = uploadSpaceBody{} // 换一个空结构再解：omitempty 的字段不会覆盖旧值
	decodeInto(t, env.Data, &body)
	if body.LibraryID != lib2.ID || body.Library.Path != root2 {
		t.Fatalf("选了第二个库但存储盘还是别的：%+v", body)
	}
	if body.Defaulted {
		t.Fatal("指定了库就不该标 defaulted")
	}
}

func TestExportBackupContainsUsableDatabase(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	lib := e.newLibrary("库", e.Root)
	e.newMedia(lib.ID, filepath.Join(e.Root, "a.mp4"), []byte("aaa"))

	res, err := e.Client.Get(e.TS.URL + "/api/v1/admin/backup")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("备份接口 %d", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); !strings.Contains(ct, "gzip") {
		t.Fatalf("Content-Type 不是 gzip：%s", ct)
	}
	if cd := res.Header.Get("Content-Disposition"); !strings.Contains(cd, "attachment") {
		t.Fatalf("没有 attachment 头：%s", cd)
	}
	gz, err := gzip.NewReader(res.Body)
	if err != nil {
		t.Fatalf("不是合法的 gzip：%v", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	found := map[string][]byte{}
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("tar 读取失败：%v", err)
		}
		body, err := io.ReadAll(tr)
		if err != nil {
			t.Fatalf("读 tar 条目失败：%v", err)
		}
		found[hdr.Name] = body
	}
	db, ok := found["zizvideo.db"]
	if !ok {
		t.Fatalf("备份里没有数据库：%v", keysOf(found))
	}
	if len(db) < 100 || string(db[:16]) != "SQLite format 3\x00" {
		t.Fatalf("备份里的 db 不是 SQLite 文件（%d 字节）", len(db))
	}
	manifest, ok := found["manifest.json"]
	if !ok {
		t.Fatalf("备份里没有清单：%v", keysOf(found))
	}
	var m map[string]any
	if err := json.Unmarshal(manifest, &m); err != nil {
		t.Fatalf("清单不是 JSON：%v", err)
	}
	if m["version"] == nil || m["version"] == "" {
		t.Fatalf("清单里没有版本号：%s", string(manifest))
	}
	if note, _ := m["note"].(string); !strings.Contains(note, "不含视频文件") {
		t.Fatalf("清单要如实说明不含视频文件：%s", string(manifest))
	}

	// 非管理员不许下载备份
	anon := e.anonClient()
	if r2, err := anon.Get(e.TS.URL + "/api/v1/admin/backup"); err == nil {
		defer r2.Body.Close()
		if r2.StatusCode == http.StatusOK {
			t.Fatal("匿名用户拿到了备份")
		}
	}
}

func keysOf(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
