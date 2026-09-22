package api_test

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/zizdog/zizvideo/internal/domain"
)

// 门禁（用户 2026-09-22 报障）：改名/移动后旧记录的文件已不在，扫描只打 missing_since、
// status 仍是 ready。这种行必须做到：
//
//	① 不再进 feed（否则首页推荐一条播到就 404 的记录，前端只能显示"放不了（状态：ready）"）；
//	② 能在媒体列表按 missing 查到（这个筛选以前是死的：status 列里根本没有 missing 值）；
//	③ API 如实透出 missing=true；
//	④ 能一键清理，且只删记录、绝不动文件。
func TestMissingMediaIsHonestAndPurgeable(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	lib := e.newLibrary("缺失库", e.Root)
	keepPath := filepath.Join(e.Root, "keep.mp4")
	gonePath := filepath.Join(e.Root, "gone.mp4")
	keep := e.newMedia(lib.ID, keepPath, body(16))
	gone := e.newMedia(lib.ID, gonePath, body(16))
	if err := e.DB.MarkMissing(gone.ID, domain.NowString()); err != nil {
		t.Fatal(err)
	}

	type item struct {
		ID      string `json:"id"`
		Status  string `json:"status"`
		Missing bool   `json:"missing"`
	}
	type listBody struct {
		List []item `json:"list"`
	}
	has := func(b listBody, id string) bool {
		for _, it := range b.List {
			if it.ID == id {
				return true
			}
		}
		return false
	}

	// ① feed 不许含它
	res, env, raw := e.do(http.MethodGet, "/api/v1/feed/next?limit=50", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("feed = %d (%s)", res.StatusCode, raw)
	}
	var feed listBody
	decodeInto(t, env.Data, &feed)
	if has(feed, gone.ID) {
		t.Fatalf("缺失记录仍进了 feed: %s", raw)
	}
	if !has(feed, keep.ID) {
		t.Fatalf("正常记录应仍在 feed: %s", raw)
	}

	// ③ 单条详情如实透出 missing（status 列仍是 ready，所以 missing 必须是独立判据）
	res, env, raw = e.do(http.MethodGet, "/api/v1/media/"+gone.ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("详情 = %d (%s)", res.StatusCode, raw)
	}
	var one item
	decodeInto(t, env.Data, &one)
	if !one.Missing {
		t.Fatalf("缺失记录必须透出 missing=true: %s", raw)
	}

	// ② missing 筛选能查到；status=ready 不含它
	res, env, _ = e.do(http.MethodGet, "/api/v1/media?status=missing&per_page=50", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("missing 筛选 = %d", res.StatusCode)
	}
	var missingList listBody
	decodeInto(t, env.Data, &missingList)
	if !has(missingList, gone.ID) || has(missingList, keep.ID) {
		t.Fatalf("status=missing 结果不对: %+v", missingList.List)
	}
	_, env, _ = e.do(http.MethodGet, "/api/v1/media?status=ready&per_page=50", nil)
	var readyList listBody
	decodeInto(t, env.Data, &readyList)
	if has(readyList, gone.ID) {
		t.Fatalf("status=ready 不该包含文件已不在的记录")
	}

	// ④ 清理：必须带 confirm
	res, _, raw = e.write(http.MethodPost, "/api/v1/libraries/"+lib.ID+"/purge-missing", map[string]any{})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("缺 confirm 应 400，实际 %d (%s)", res.StatusCode, raw)
	}
	res, env, raw = e.write(http.MethodPost, "/api/v1/libraries/"+lib.ID+"/purge-missing",
		map[string]any{"confirm": true})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("清理 = %d (%s)", res.StatusCode, raw)
	}
	var purged struct {
		Deleted int `json:"deleted"`
	}
	decodeInto(t, env.Data, &purged)
	if purged.Deleted != 1 {
		t.Fatalf("清理条数 = %d，期望 1", purged.Deleted)
	}
	if _, err := os.Stat(gonePath); err != nil {
		t.Fatalf("清理只删记录，不许动文件: %v", err)
	}
	if res, _, _ := e.do(http.MethodGet, "/api/v1/media/"+gone.ID, nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("清理后单条应 404，实际 %d", res.StatusCode)
	}
	if res, _, _ := e.do(http.MethodGet, "/api/v1/media/"+keep.ID, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("清理不许误伤正常记录，实际 %d", res.StatusCode)
	}

	// 非管理员：403（清理是管理动作）
	e.write(http.MethodPatch, "/api/v1/admin/settings", map[string]any{"allow_register": true})
	anon := e.anonClient()
	registerAnon(t, e, anon, "purger")
	if res, raw := e.loginAs(anon, "purger", "newbiepass123"); res.StatusCode != http.StatusOK {
		t.Fatalf("普通用户登录失败 %d: %s", res.StatusCode, raw)
	}
	if res, _, _ := e.writeAs(anon, http.MethodPost, "/api/v1/libraries/"+lib.ID+"/purge-missing",
		map[string]any{"confirm": true}); res.StatusCode != http.StatusForbidden {
		t.Fatalf("普通用户清理应 403，实际 %d", res.StatusCode)
	}
}

// 门禁：前台（播放页）删除入口只给管理员。
// 默认只删面板记录、磁盘文件不动；连文件一起删必须先过口令 + 路径校验；
// 文件删不掉就绝不删记录（"记录没了、文件还在"= 谎报）。
func TestDeleteMediaFromFrontend(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	lib := e.newLibrary("l", e.Root)

	// 非管理员：入口只给管理员（403）
	e.write(http.MethodPatch, "/api/v1/admin/settings", map[string]any{"allow_register": true})
	anon := e.anonClient()
	registerAnon(t, e, anon, "newbie")
	if res, raw := e.loginAs(anon, "newbie", "newbiepass123"); res.StatusCode != http.StatusOK {
		t.Fatalf("普通用户登录失败 %d: %s", res.StatusCode, raw)
	}
	viewerMedia := e.newMedia(lib.ID, filepath.Join(e.Root, "viewer.mp4"), body(8))
	res, _, _ := e.writeAs(anon, http.MethodDelete, "/api/v1/admin/media/"+viewerMedia.ID, map[string]any{})
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("普通用户删除应 403，实际 %d", res.StatusCode)
	}

	// 只删记录：文件必须留在磁盘上
	recordOnly := filepath.Join(e.Root, "record-only.mp4")
	m1 := e.newMedia(lib.ID, recordOnly, body(64))
	res, env, raw := e.write(http.MethodDelete, "/api/v1/admin/media/"+m1.ID, map[string]any{})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("只删记录应 200，实际 %d: %s", res.StatusCode, raw)
	}
	var out struct {
		Deleted     int  `json:"deleted"`
		FileDeleted bool `json:"file_deleted"`
	}
	decodeInto(t, env.Data, &out)
	if out.Deleted != 1 || out.FileDeleted {
		t.Fatalf("只删记录的响应不符: %+v", out)
	}
	if _, err := os.Stat(recordOnly); err != nil {
		t.Fatalf("只删记录不许动文件: %v", err)
	}
	if res, _, _ := e.do(http.MethodGet, "/api/v1/media/"+m1.ID, nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("删除后单条应 404，实际 %d", res.StatusCode)
	}

	// 删文件：缺口令时拒绝，且文件与记录都还在
	withFile := filepath.Join(e.Root, "with-file.mp4")
	m2 := e.newMedia(lib.ID, withFile, body(32))
	res, env, raw = e.write(http.MethodDelete, "/api/v1/admin/media/"+m2.ID,
		map[string]any{"delete_file": true})
	if res.StatusCode != http.StatusBadRequest || env.Error == nil || env.Error.Code != "MEDIA_CONFIRM_REQUIRED" {
		t.Fatalf("缺口令应 400/MEDIA_CONFIRM_REQUIRED，实际 %d: %s", res.StatusCode, raw)
	}
	if _, err := os.Stat(withFile); err != nil {
		t.Fatalf("被拒的删文件请求不许动文件: %v", err)
	}
	if res, _, _ := e.do(http.MethodGet, "/api/v1/media/"+m2.ID, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("被拒后记录必须还在，实际 %d", res.StatusCode)
	}

	// 带口令：文件真没了 + 记录也删掉
	res, env, raw = e.write(http.MethodDelete, "/api/v1/admin/media/"+m2.ID,
		map[string]any{"delete_file": true, "confirm": "删除文件"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("带口令删文件应 200，实际 %d: %s", res.StatusCode, raw)
	}
	decodeInto(t, env.Data, &out)
	if !out.FileDeleted {
		t.Fatalf("响应必须如实说文件已删: %+v", out)
	}
	if _, err := os.Stat(withFile); !os.IsNotExist(err) {
		t.Fatalf("文件应已删除，err=%v", err)
	}

	// 路径不在允许根内：拒绝且不动文件（否则网页端能删掉任意路径）
	outside := filepath.Join(t.TempDir(), "outside.mp4")
	m3 := e.newMedia(lib.ID, outside, body(8))
	res, env, raw = e.write(http.MethodDelete, "/api/v1/admin/media/"+m3.ID,
		map[string]any{"delete_file": true, "confirm": "删除文件"})
	if res.StatusCode != http.StatusBadRequest || env.Error == nil || env.Error.Code != "MEDIA_PATH_REFUSED" {
		t.Fatalf("越界路径应 400/MEDIA_PATH_REFUSED，实际 %d: %s", res.StatusCode, raw)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatalf("越界路径的文件不许被删: %v", err)
	}
	if res, _, _ := e.do(http.MethodGet, "/api/v1/media/"+m3.ID, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("越界被拒后记录必须还在，实际 %d", res.StatusCode)
	}
}
