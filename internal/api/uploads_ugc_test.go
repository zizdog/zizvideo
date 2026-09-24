package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/zizdog/zizvideo/internal/domain"
)

// 用户上传（UGC）第一段门禁：白名单闸门、断点续传、定稿待审、审核通过才进库、驳回删文件。
//
// 判据都在"别人看不到/没通过就进不了库"上：待审内容根本不在 media 表里，
// 所以这里直接查 media 表条数，而不是查列表接口（列表过滤坏了也拦不住这种泄漏）。

type ugcStartBody struct {
	Item struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Size     int64  `json:"size"`
		State    string `json:"state"`
		Received int64  `json:"received_bytes"`
	} `json:"item"`
	Quota struct {
		Items    int   `json:"items"`
		MaxItems int   `json:"max_items"`
		MaxBytes int64 `json:"max_bytes"`
	} `json:"quota"`
}

type ugcItemBody struct {
	Item struct {
		ID         string `json:"id"`
		Name       string `json:"name"`
		State      string `json:"state"`
		Received   int64  `json:"received_bytes"`
		ReviewNote string `json:"review_note"`
		MediaID    string `json:"media_id"`
		LibraryID  string `json:"library_id"`
	} `json:"item"`
}

type ugcListBody struct {
	List []struct {
		ID         string `json:"id"`
		State      string `json:"state"`
		ReviewNote string `json:"review_note"`
	} `json:"list"`
}

// ugcUser 建一个普通用户并返回它的独立客户端与 id。
func (e *env) ugcUser(t *testing.T, username string) (*http.Client, string) {
	t.Helper()
	res, env, raw := e.write(http.MethodPost, "/api/v1/users", map[string]any{
		"username": username, "password": "userpass123", "display_name": username, "role": "user"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("建用户失败 %d: %s", res.StatusCode, raw)
	}
	var created struct {
		ID string `json:"id"`
	}
	decodeInto(t, env.Data, &created)
	c := e.anonClient()
	if r, body := e.loginAs(c, username, "userpass123"); r.StatusCode != http.StatusOK {
		t.Fatalf("登录失败 %d: %s", r.StatusCode, body)
	}
	return c, created.ID
}

func (e *env) ugcStart(t *testing.T, c *http.Client, name string, size int) (*http.Response, ugcStartBody, []byte) {
	t.Helper()
	res, env, raw := e.writeAs(c, http.MethodPost, "/api/v1/uploads",
		map[string]any{"name": name, "size": size})
	var out ugcStartBody
	if env.Data != nil {
		_ = json.Unmarshal(env.Data, &out)
	}
	return res, out, raw
}

// uploadRaw 是带指定客户端的原始体请求（UGC 的 PUT 走客户端自己的会话与 CSRF）。
func (e *env) uploadRaw(t *testing.T, c *http.Client, method, path string, body []byte,
	header map[string]string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), method, e.TS.URL+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-CSRF-Token", csrfOf(t, c, e.TS.URL))
	for k, v := range header {
		req.Header.Set(k, v)
	}
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	return res, readAll(t, res.Body)
}

func mustData(t *testing.T, raw []byte) json.RawMessage {
	t.Helper()
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("解析响应失败: %v (%s)", err, raw)
	}
	return env.Data
}

func mustErrorCode(t *testing.T, raw []byte) string {
	t.Helper()
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("解析响应失败: %v (%s)", err, raw)
	}
	if env.Error == nil {
		t.Fatalf("期望错误响应: %s", raw)
	}
	return env.Error.Code
}

func TestUGCWhitelistAndReviewFlow(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	libRoot := filepath.Join(e.Root, "ugc-lib")
	if err := os.MkdirAll(libRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	lib := e.newLibrary("上传落库", libRoot)

	client, userID := e.ugcUser(t, "uploader")

	// 1) 没白名单：403，且不能开会话。
	res, _, raw := e.ugcStart(t, client, "clip.mp4", 5)
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("未授权用户开会话应为 403，实际 %d: %s", res.StatusCode, raw)
	}
	if code := mustErrorCode(t, raw); code != "UPLOAD_NOT_ALLOWED" {
		t.Fatalf("错误码 = %s，期望 UPLOAD_NOT_ALLOWED", code)
	}

	// 2) 管理员开白名单（PATCH 立刻生效，不用重新登录）。
	res, env, raw := e.write(http.MethodPatch, "/api/v1/users/"+userID,
		map[string]any{"can_upload": true})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("开白名单失败 %d: %s", res.StatusCode, raw)
	}
	var patched struct {
		CanUpload bool `json:"can_upload"`
	}
	decodeInto(t, env.Data, &patched)
	if !patched.CanUpload {
		t.Fatalf("PATCH 后 can_upload 仍为 false: %s", raw)
	}

	// 3) 开会话 → 分片续传（第一片后回读断点）→ 定稿。
	res, start, raw := e.ugcStart(t, client, "clip.mp4", 6)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("授权后开会话失败 %d: %s", res.StatusCode, raw)
	}
	id := start.Item.ID
	if start.Item.State != domain.UploadUploading || id == "" {
		t.Fatalf("开会话响应不合法: %s", raw)
	}
	part := "abc"
	put, body := e.uploadRaw(t, client, http.MethodPut, "/api/v1/uploads/"+id, []byte(part),
		map[string]string{"Content-Range": "bytes 0-2/6"})
	if put.StatusCode != http.StatusOK {
		t.Fatalf("第一片失败 %d: %s", put.StatusCode, body)
	}
	var progress struct {
		Received      bool  `json:"received"`
		ReceivedBytes int64 `json:"received_bytes"`
	}
	if err := json.Unmarshal(mustData(t, body), &progress); err != nil {
		t.Fatal(err)
	}
	if progress.Received || progress.ReceivedBytes != 3 {
		t.Fatalf("第一片后进度不对: %s", body)
	}
	// 断点位置不符必须拒绝（否则会静默写坏文件）。
	bad, badBody := e.uploadRaw(t, client, http.MethodPut, "/api/v1/uploads/"+id, []byte("xyz"),
		map[string]string{"Content-Range": "bytes 9-11/6"})
	if bad.StatusCode != http.StatusConflict {
		t.Fatalf("断点不符应 409，实际 %d: %s", bad.StatusCode, badBody)
	}
	put, body = e.uploadRaw(t, client, http.MethodPut, "/api/v1/uploads/"+id, []byte("def"),
		map[string]string{"Content-Range": "bytes 3-5/6"})
	if put.StatusCode != http.StatusOK {
		t.Fatalf("续传失败 %d: %s", put.StatusCode, body)
	}
	if err := json.Unmarshal(mustData(t, body), &progress); err != nil {
		t.Fatal(err)
	}
	if !progress.Received {
		t.Fatalf("续传完成后 received 应为 true: %s", body)
	}
	res, env, raw = e.writeAs(client, http.MethodPost, "/api/v1/uploads/"+id+"/finish", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("定稿失败 %d: %s", res.StatusCode, raw)
	}
	var finished ugcItemBody
	decodeInto(t, env.Data, &finished)
	if finished.Item.State != domain.UploadPending {
		t.Fatalf("定稿后状态 = %s，期望 pending", finished.Item.State)
	}

	// 4) 待审内容不进媒体库：media 表 0 条，文件还在 inbox。
	if n := mediaTotal(t, e); n != 0 {
		t.Fatalf("待审内容不该进 media 表，实际 %d 条", n)
	}
	inbox := filepath.Join(e.Cfg.DataDir, "inbox")
	if _, err := os.Stat(filepath.Join(inbox, userID)); err != nil {
		t.Fatalf("文件没落进 inbox: %v", err)
	}

	// 5) 后台待审列表能看到它，通过后进库且立刻可用。
	res, env, raw = e.do(http.MethodGet, "/api/v1/admin/uploads/pending", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("待审列表失败 %d: %s", res.StatusCode, raw)
	}
	var pending ugcListBody
	decodeInto(t, env.Data, &pending)
	if len(pending.List) != 1 || pending.List[0].ID != id {
		t.Fatalf("待审列表 = %+v", pending.List)
	}
	res, env, raw = e.write(http.MethodPost, "/api/v1/admin/uploads/"+id+"/approve",
		map[string]any{"library_id": lib.ID})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("通过失败 %d: %s", res.StatusCode, raw)
	}
	var approved struct {
		MediaID string `json:"media_id"`
		Path    string `json:"path"`
	}
	decodeInto(t, env.Data, &approved)
	if approved.MediaID == "" {
		t.Fatalf("通过后没有 media_id: %s", raw)
	}
	m, err := e.DB.MediaByPath(lib.ID, approved.Path)
	if err != nil || m == nil {
		t.Fatalf("通过后媒体库里没有这条: %v %s", err, raw)
	}
	if m.Status != domain.MediaReady || m.DurationMS == 0 {
		t.Fatalf("通过后应探测成 ready: %+v", m)
	}
	if _, err := os.Stat(approved.Path); err != nil {
		t.Fatalf("通过后文件不在库里: %v", err)
	}
	// 上传者能在「我的上传」里看到它已通过。
	_, env, raw = e.doAs(client, http.MethodGet, "/api/v1/me/uploads")
	var mine ugcListBody
	decodeInto(t, env.Data, &mine)
	if len(mine.List) != 1 || mine.List[0].State != domain.UploadApproved {
		t.Fatalf("我的上传状态不对: %s", raw)
	}

	// 6) 驳回：文件删掉、状态 rejected、原因回给上传者。
	res, start, raw = e.ugcStart(t, client, "bad.mp4", 4)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("第二次开会话失败 %d: %s", res.StatusCode, raw)
	}
	second := start.Item.ID
	if p, b := e.uploadRaw(t, client, http.MethodPut, "/api/v1/uploads/"+second, []byte("wxyz"), nil); p.StatusCode != http.StatusOK {
		t.Fatalf("第二次上传失败 %d: %s", p.StatusCode, b)
	}
	if r, _, b := e.writeAs(client, http.MethodPost, "/api/v1/uploads/"+second+"/finish", nil); r.StatusCode != http.StatusOK {
		t.Fatalf("第二次定稿失败 %d: %s", r.StatusCode, b)
	}
	res, _, raw = e.write(http.MethodPost, "/api/v1/admin/uploads/"+second+"/reject", nil)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("驳回没填原因应 400，实际 %d: %s", res.StatusCode, raw)
	}
	res, _, raw = e.write(http.MethodPost, "/api/v1/admin/uploads/"+second+"/reject",
		map[string]any{"note": "画面全是黑屏"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("驳回失败 %d: %s", res.StatusCode, raw)
	}
	item, err := e.DB.GetUploadItem(second)
	if err != nil {
		t.Fatal(err)
	}
	if item.State != domain.UploadRejected || item.ReviewNote != "画面全是黑屏" {
		t.Fatalf("驳回状态不对: %+v", item)
	}
	if _, err := os.Stat(item.Path); !os.IsNotExist(err) {
		t.Fatalf("驳回后文件应该被删掉: %v", err)
	}
}

// P1「剧场草稿」门禁：审核通过时可以顺手归入剧场 —— 已有剧场 id，或按标题找/建草稿；
// 集号用**文件名识别**，并且批量乱序通过后要按 (season, episode) 重排（否则播放顺序是审核顺序）。
func TestUGCApproveIntoSeriesDraft(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	libRoot := filepath.Join(e.Root, "draft-lib")
	if err := os.MkdirAll(libRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	lib := e.newLibrary("草稿库", libRoot)
	client, userID := e.ugcUser(t, "uploader")
	// 这个测试只关心"归入剧场"，先把上传白名单开了（别的门禁在另一个测试里）
	if res, _, raw := e.write(http.MethodPatch, "/api/v1/users/"+userID,
		map[string]any{"can_upload": true}); res.StatusCode != http.StatusOK {
		t.Fatalf("开白名单失败 %d: %s", res.StatusCode, raw)
	}

	send := func(name string) string {
		t.Helper()
		// 内容按文件名派生：既满足"声明大小 = 实发字节"，又让每个文件内容不同（避开内容去重）
		body := []byte("zv-" + name)
		res, start, raw := e.ugcStart(t, client, name, len(body))
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("开会话失败 %d: %s", res.StatusCode, raw)
		}
		id := start.Item.ID
		if p, b := e.uploadRaw(t, client, http.MethodPut, "/api/v1/uploads/"+id, body, nil); p.StatusCode != http.StatusOK {
			t.Fatalf("上传失败 %d: %s", p.StatusCode, b)
		}
		if r, _, b := e.writeAs(client, http.MethodPost, "/api/v1/uploads/"+id+"/finish", nil); r.StatusCode != http.StatusOK {
			t.Fatalf("定稿失败 %d: %s", r.StatusCode, b)
		}
		return id
	}
	approve := func(id string, body map[string]any) map[string]any {
		t.Helper()
		res, env, raw := e.write(http.MethodPost, "/api/v1/admin/uploads/"+id+"/approve", body)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("通过失败 %d: %s", res.StatusCode, raw)
		}
		var out map[string]any
		decodeInto(t, env.Data, &out)
		return out
	}

	// 先通过"第 2 集"，再通过"第 1 集"：都归入同一个新建草稿 ⇒ 顺序必须被改成 1、2。
	second := send("我的短剧 第2集.mp4")
	got := approve(second, map[string]any{"library_id": lib.ID, "series_title": "我的短剧"})
	seriesID, _ := got["series_id"].(string)
	if seriesID == "" {
		t.Fatalf("通过时没建出剧场草稿: %+v", got)
	}
	first := send("我的短剧 第1集.mp4")
	got2 := approve(first, map[string]any{"library_id": lib.ID, "series_title": "我的短剧"})
	if got2["series_id"] != seriesID {
		t.Fatalf("同名剧场应复用，实际 %v ≠ %s", got2["series_id"], seriesID)
	}

	eps, _, err := e.DB.ListSeriesEpisodes(domain.LibraryScope{All: true}, seriesID)
	if err != nil {
		t.Fatal(err)
	}
	if len(eps) != 2 {
		t.Fatalf("剧场里应有 2 集，实际 %d", len(eps))
	}
	// 顺序 = 第1集、第2集（按识别出的集号重排过），而不是审核顺序（2 在前）
	if eps[0].Episode == nil || *eps[0].Episode != 1 || eps[1].Episode == nil || *eps[1].Episode != 2 {
		t.Fatalf("集号识别不对：%+v / %+v", eps[0].Episode, eps[1].Episode)
	}
	items, err := e.DB.GetSeries(seriesID)
	if err != nil {
		t.Fatal(err)
	}
	if items.EpisodeCount != 2 || items.LibraryID != lib.ID {
		t.Fatalf("剧场草稿状态不对: %+v", items)
	}
	episodes, _, err := e.DB.ListSeriesEpisodes(domain.LibraryScope{All: true}, seriesID)
	if err != nil {
		t.Fatal(err)
	}
	if episodes[0].MediaID == episodes[1].MediaID {
		t.Fatal("两集不该是同一条 media")
	}
	// 明确给了 series_id 时也要能挂进去
	third := send("我的短剧 第3集.mp4")
	got3 := approve(third, map[string]any{"library_id": lib.ID, "series_id": seriesID})
	if got3["series_id"] != seriesID {
		t.Fatalf("显式 series_id 应挂同一个剧场: %+v", got3)
	}
	eps3, _, err := e.DB.ListSeriesEpisodes(domain.LibraryScope{All: true}, seriesID)
	if err != nil {
		t.Fatal(err)
	}
	if len(eps3) != 3 || eps3[2].Episode == nil || *eps3[2].Episode != 3 {
		t.Fatalf("第三集应排到最后：%+v", eps3[2])
	}
}

// A1 批量审核门禁：批量通过（同一份单条逻辑）→ 逐条结果如实；批量驳回 → 文件真的没了。
// 关键点：**部分失败不许整批失败**（一个坏 id 不能拖着其它条一起不通过）。
func TestUGCBatchApproveAndReject(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	libRoot := filepath.Join(e.Root, "batch-lib")
	if err := os.MkdirAll(libRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	lib := e.newLibrary("批量库", libRoot)
	client, userID := e.ugcUser(t, "batchuser")
	if res, _, raw := e.write(http.MethodPatch, "/api/v1/users/"+userID,
		map[string]any{"can_upload": true}); res.StatusCode != http.StatusOK {
		t.Fatalf("开白名单失败 %d: %s", res.StatusCode, raw)
	}
	send := func(name string) string {
		t.Helper()
		body := []byte("zv-batch-" + name)
		res, start, raw := e.ugcStart(t, client, name, len(body))
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("开会话失败 %d: %s", res.StatusCode, raw)
		}
		id := start.Item.ID
		if p, b := e.uploadRaw(t, client, http.MethodPut, "/api/v1/uploads/"+id, body, nil); p.StatusCode != http.StatusOK {
			t.Fatalf("上传失败 %d: %s", p.StatusCode, b)
		}
		if r, _, b := e.writeAs(client, http.MethodPost, "/api/v1/uploads/"+id+"/finish", nil); r.StatusCode != http.StatusOK {
			t.Fatalf("定稿失败 %d: %s", r.StatusCode, b)
		}
		return id
	}

	ids := []string{send("批量剧 第2集.mp4"), send("批量剧 第1集.mp4")}
	keep := send("留着驳回.mp4")
	// 故意混一个不存在的 id：它必须单独失败，另外两条照样通过
	batchIDs := append(append([]string{}, ids...), "upl_does_not_exist")
	res, env, raw := e.write(http.MethodPost, "/api/v1/admin/uploads/approve-batch",
		map[string]any{"ids": batchIDs, "library_id": lib.ID, "series_title": "批量剧"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("批量通过 HTTP = %d: %s", res.StatusCode, raw)
	}
	var out struct {
		Approved int `json:"approved"`
		Failed   int `json:"failed"`
		Total    int `json:"total"`
		Results  []struct {
			ID    string `json:"id"`
			OK    bool   `json:"ok"`
			Error string `json:"error"`
			Item  struct {
				SeriesID string `json:"series_id"`
			} `json:"item"`
		} `json:"results"`
	}
	decodeInto(t, env.Data, &out)
	if out.Total != 3 || out.Approved != 2 || out.Failed != 1 {
		t.Fatalf("批量结果计数不对: %+v", out)
	}
	seriesID := ""
	for _, r := range out.Results {
		if r.ID == "upl_does_not_exist" {
			if r.OK || r.Error == "" {
				t.Fatalf("坏 id 必须单独失败并给原因: %+v", r)
			}
			continue
		}
		if !r.OK || r.Item.SeriesID == "" {
			t.Fatalf("这两条应当通过并归入剧场草稿: %+v", r)
		}
		seriesID = r.Item.SeriesID
	}
	eps, _, err := e.DB.ListSeriesEpisodes(domain.LibraryScope{All: true}, seriesID)
	if err != nil {
		t.Fatal(err)
	}
	if len(eps) != 2 || eps[0].Episode == nil || *eps[0].Episode != 1 {
		t.Fatalf("批量通过后剧场应识别集号并重排: %+v", eps)
	}

	// 批量驳回：文件必须真的删掉、状态 rejected
	res, env, raw = e.write(http.MethodPost, "/api/v1/admin/uploads/reject-batch",
		map[string]any{"ids": []string{keep}, "note": "不符合要求"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("批量驳回 HTTP = %d: %s", res.StatusCode, raw)
	}
	var rj struct {
		Rejected int `json:"rejected"`
		Failed   int `json:"failed"`
	}
	decodeInto(t, env.Data, &rj)
	if rj.Rejected != 1 || rj.Failed != 0 {
		t.Fatalf("批量驳回计数不对: %+v", rj)
	}
	item, err := e.DB.GetUploadItem(keep)
	if err != nil {
		t.Fatal(err)
	}
	if item.State != domain.UploadRejected {
		t.Fatalf("驳回后状态 = %q", item.State)
	}
	if _, err := os.Stat(item.Path); !os.IsNotExist(err) {
		t.Fatalf("驳回后文件应被删掉: %v", err)
	}
	// 原因必填
	res, _, _ = e.write(http.MethodPost, "/api/v1/admin/uploads/reject-batch",
		map[string]any{"ids": []string{keep}})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("批量驳回不填原因应 400，实际 %d", res.StatusCode)
	}
	// 空 ids / 超限
	res, _, _ = e.write(http.MethodPost, "/api/v1/admin/uploads/approve-batch",
		map[string]any{"ids": []string{}, "library_id": lib.ID})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("空 ids 应 400，实际 %d", res.StatusCode)
	}
}
