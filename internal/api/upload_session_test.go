package api_test

import (
	"bytes"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// ⑤ 门禁：后台上传的会话**必须跨进程重启**还能接着传（用户 2026-09-24 点名要修）。
//
// 判据是"换一个 Server 实例接着传还能成"：会话若只在内存里，重启后 PUT 会 404
// （"上传会话不存在或已过期"），用户只能从头再传 —— 这正是要修掉的行为。
// 所以这里**真的重建一个 Server**（同一份 DB）再继续传第二块。

func (e *env) startAdminUpload(dir, name string, size int) (string, int) {
	e.t.Helper()
	res, env, raw := e.write(http.MethodPost, "/api/v1/admin/uploads/start", map[string]any{
		"dir_path": dir, "overwrite": false,
		"files": []map[string]any{{"name": name, "size": size}},
	})
	if res.StatusCode != http.StatusCreated {
		e.t.Fatalf("start 失败 %d: %s", res.StatusCode, raw)
	}
	var out struct {
		UploadID string `json:"upload_id"`
		Files    []struct {
			Index int `json:"index"`
		} `json:"files"`
	}
	decodeInto(e.t, env.Data, &out)
	if out.UploadID == "" || len(out.Files) != 1 {
		e.t.Fatalf("start 返回不对：%s", raw)
	}
	return out.UploadID, out.Files[0].Index
}

func (e *env) putChunk(uploadID string, index int, offset int, body []byte, total int) *http.Response {
	e.t.Helper()
	req, err := http.NewRequest(http.MethodPut,
		e.TS.URL+fmt.Sprintf("/api/v1/admin/uploads/%s/%d", uploadID, index), bytes.NewReader(body))
	if err != nil {
		e.t.Fatal(err)
	}
	req.Header.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", offset, offset+len(body)-1, total))
	req.Header.Set("X-CSRF-Token", e.CSFRaw())
	res, err := e.Client.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	return res
}

// putWhole 发一个"整文件"PUT（不带 Content-Range）。
func (e *env) putWhole(uploadID string, index int, body []byte) *http.Response {
	e.t.Helper()
	req, err := http.NewRequest(http.MethodPut,
		e.TS.URL+fmt.Sprintf("/api/v1/admin/uploads/%s/%d", uploadID, index), bytes.NewReader(body))
	if err != nil {
		e.t.Fatal(err)
	}
	req.Header.Set("X-CSRF-Token", e.CSFRaw())
	res, err := e.Client.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	return res
}

func TestUploadSessionSurvivesRestart(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	lib := e.newLibrary("库", e.Root)
	dir := filepath.Join(e.Root, "上传")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}

	const size = 4096
	payload := bytes.Repeat([]byte("zizvideo-"), size/9+1)[:size]
	name := "big.mp4"
	uploadID, index := e.startAdminUpload(dir, name, size)

	// ① 先传前半截
	first := payload[:size/2]
	firstRes := e.putChunk(uploadID, index, 0, first, size)
	if firstRes.StatusCode != http.StatusAccepted {
		t.Fatalf("第一块应 202（还要继续传），实际 %d", firstRes.StatusCode)
	}
	firstRes.Body.Close()
	part := filepath.Join(dir, name) + ".zvpart"
	if st, err := os.Stat(part); err != nil || st.Size() != int64(len(first)) {
		t.Fatalf("半截文件不对：%v size=%d", err, st.Size())
	}

	// ② 模拟进程重启：换一个 Server 实例（内存缓存没了，数据只能来自库）
	e.Restart()

	// ③ 重启后接着传第二块：会话必须还在（要是只存在内存里，这里就是 404）
	second := payload[size/2:]
	res := e.putChunk(uploadID, index, len(first), second, size)
	if res.StatusCode == http.StatusNotFound {
		res.Body.Close()
		t.Fatal("重启后上传会话丢了（404）—— 会话没有落库")
	}
	if res.StatusCode != http.StatusOK {
		body := make([]byte, 400)
		n, _ := res.Body.Read(body)
		res.Body.Close()
		t.Fatalf("重启后补完最后一块应 200，实际 %d: %s", res.StatusCode, body[:n])
	}
	res.Body.Close()

	// ④ 文件内容要与源一致（别"传完了但是坏的"）
	got, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("落盘内容不一致：got %d bytes want %d", len(got), len(payload))
	}
	if _, err := os.Stat(part); err == nil {
		t.Fatal("定稿后 .zvpart 不该还在")
	}
	// ⑤ 扫一次库：刚传上去的文件要能被正常识别入库（证明"传完了"不是只落了字节）
	res2, env2, raw2 := e.write(http.MethodPost, "/api/v1/libraries/"+lib.ID+"/scan", nil)
	if res2.StatusCode != http.StatusAccepted {
		t.Fatalf("触发扫描失败 %d: %s", res2.StatusCode, raw2)
	}
	var scan struct {
		TaskID string `json:"task_id"`
	}
	decodeInto(t, env2.Data, &scan)
	waitTask(t, e, scan.TaskID)
	if n, err := e.DB.CountMedia(lib.ID); err != nil || n != 1 {
		t.Fatalf("扫描后媒体记录数不对：n=%d err=%v", n, err)
	}
}
