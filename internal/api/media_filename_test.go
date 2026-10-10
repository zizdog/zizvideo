package api_test

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zizdog/zizvideo/internal/domain"
	"github.com/zizdog/zizvideo/internal/storage"
)

// 原生播放页那行「正在播放：…」要显示**文件名**（用户 2026-10-01："是文件名，不是标题"）：
// file_name 给所有能看到这条的人；**宿主机绝对路径仍然只给管理员**（别为了显示文件名把目录也漏出去）。
func TestMediaFileNameForEveryoneHostPathOnlyForAdmin(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	lib := e.newLibrary("l", e.Root)
	name := "第13集 李逵正式下线.mp4"
	m := e.newMedia(lib.ID, filepath.Join(e.Root, name), body(64))

	item := func(raw []byte) map[string]any {
		t.Helper()
		var out struct {
			Data map[string]any `json:"data"`
		}
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatalf("解析失败: %v (%s)", err, raw)
		}
		return out.Data
	}

	// 管理员：文件名 + 路径都给（路径是管理端在用的）
	res, _, raw := e.do(http.MethodGet, "/api/v1/media/"+m.ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("管理员读单条 = %d (%s)", res.StatusCode, raw)
	}
	got := item(raw)
	if got["file_name"] != name {
		t.Fatalf("管理员 file_name = %v, 想要 %q", got["file_name"], name)
	}
	if got["path"] != filepath.Join(e.Root, name) {
		t.Fatalf("管理员 path = %v", got["path"])
	}

	// 普通用户：文件名在，路径不在
	res, env, raw := e.write(http.MethodPost, "/api/v1/users", map[string]any{
		"username": "bob", "password": "bobpass12345", "role": "user"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("创建普通用户失败 %d: %s", res.StatusCode, raw)
	}
	var bobUser domain.User
	decodeInto(t, env.Data, &bobUser)
	// 普通用户默认 0 个库（fail-closed）：显式授权这个库，否则单条读出来是 404
	if res, _, raw := e.write(http.MethodPut, "/api/v1/admin/users/"+bobUser.ID+"/libraries",
		map[string]any{"library_ids": []string{lib.ID}}); res.StatusCode != http.StatusOK {
		t.Fatalf("授权库失败 %d: %s", res.StatusCode, raw)
	}
	bob := e.anonClient()
	if res, raw := e.loginAs(bob, "bob", "bobpass12345"); res.StatusCode != http.StatusOK {
		t.Fatalf("bob 登录失败 %d: %s", res.StatusCode, raw)
	}
	res, _, raw = e.doAs(bob, http.MethodGet, "/api/v1/media/"+m.ID)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("普通用户读单条 = %d (%s)", res.StatusCode, raw)
	}
	got = item(raw)
	if got["file_name"] != name {
		t.Fatalf("普通用户 file_name = %v, 想要 %q（文件名要给，不然原生页显示不出文件名）", got["file_name"], name)
	}
	if _, ok := got["path"]; ok {
		t.Fatalf("普通用户不该看到宿主机路径: %v", got["path"])
	}
}

// 库类型（短视频库 / 短剧库）是用户 2026-10-10 拍板的 Jellyfin 式模型的第一层：
// 创建/修改都要能指定，非法值必须 400（不许静默落成第三种形态）。
func TestLibraryKindValidatedAndExposed(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	root := filepath.Join(e.Root, "drama-lib")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	// ① 建短剧库：响应里带 kind
	res, env, raw := e.write(http.MethodPost, "/api/v1/libraries", map[string]any{
		"name": "短剧库", "root_path": root, "kind": "drama"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("建库失败 %d: %s", res.StatusCode, raw)
	}
	var created domain.Library
	decodeInto(t, env.Data, &created)
	if created.Kind != domain.KindDrama {
		t.Fatalf("kind = %q，期望 drama", created.Kind)
	}
	// ② 改回短视频库
	res, env, raw = e.write(http.MethodPatch, "/api/v1/libraries/"+created.ID, map[string]any{"kind": "short"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("改类型失败 %d: %s", res.StatusCode, raw)
	}
	var patched domain.Library
	decodeInto(t, env.Data, &patched)
	if patched.Kind != domain.KindShort {
		t.Fatalf("改类型后 kind = %q，期望 short", patched.Kind)
	}
	// ③ 非法类型：400，且库里不能留下第三种形态
	res, _, raw = e.write(http.MethodPatch, "/api/v1/libraries/"+created.ID, map[string]any{"kind": "mixed"})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("非法类型应 400，得到 %d (%s)", res.StatusCode, raw)
	}
	root2 := filepath.Join(e.Root, "bogus-lib")
	if err := os.MkdirAll(root2, 0o755); err != nil {
		t.Fatal(err)
	}
	res, _, raw = e.write(http.MethodPost, "/api/v1/libraries", map[string]any{
		"name": "非法库", "root_path": root2, "kind": "movies"})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("非法类型创建应 400，得到 %d (%s)", res.StatusCode, raw)
	}
	lib, err := e.DB.GetLibrary(created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if lib.Kind != domain.KindShort {
		t.Fatalf("库类型被非法请求改写成了 %q", lib.Kind)
	}
}

// 后台两块「各管各的」的硬判据（用户 2026-10-10："后台各管各的"）：
// GET /api/v1/media?kind=short|drama 必须按**库类型**过滤 —— 短视频管理里不出现剧集，
// 短剧管理里不出现散片。靠接口约束 + 测试钉住，而不是前端自己过滤。
func TestMediaListFiltersByLibraryKind(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	mkLib := func(name, kind string) *domain.Library {
		root := filepath.Join(e.Root, name)
		if err := os.MkdirAll(root, 0o755); err != nil {
			t.Fatal(err)
		}
		res, env, raw := e.write(http.MethodPost, "/api/v1/libraries", map[string]any{
			"name": name, "root_path": root, "kind": kind})
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("建库 %s 失败 %d: %s", name, res.StatusCode, raw)
		}
		var lib domain.Library
		decodeInto(t, env.Data, &lib)
		return &lib
	}
	shortLib := mkLib("散片库", domain.KindShort)
	dramaLib := mkLib("短剧库", domain.KindDrama)
	e.newMedia(shortLib.ID, filepath.Join(e.Root, "散片库", "a.mp4"), body(8))
	e.newMedia(shortLib.ID, filepath.Join(e.Root, "散片库", "b.mp4"), body(8))
	e.newMedia(dramaLib.ID, filepath.Join(e.Root, "短剧库", "S01E01.mp4"), body(8))

	listIDs := func(kind string) []string {
		t.Helper()
		res, env, raw := e.do(http.MethodGet, "/api/v1/media?per_page=50&kind="+kind, nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("kind=%s 列表失败 %d: %s", kind, res.StatusCode, raw)
		}
		var page struct {
			List []struct {
				ID          string `json:"id"`
				LibraryID   string `json:"library_id"`
				LibraryName string `json:"library_name"`
			} `json:"list"`
		}
		decodeInto(t, env.Data, &page)
		out := []string{}
		for _, it := range page.List {
			out = append(out, it.LibraryID)
		}
		return out
	}
	shortIDs := listIDs(domain.KindShort)
	if len(shortIDs) != 2 {
		t.Fatalf("短视频库应 2 条，实际 %d（%v）", len(shortIDs), shortIDs)
	}
	for _, id := range shortIDs {
		if id != shortLib.ID {
			t.Fatalf("kind=short 列表里出现了别的库：%s", id)
		}
	}
	dramaIDs := listIDs(domain.KindDrama)
	if len(dramaIDs) != 1 || dramaIDs[0] != dramaLib.ID {
		t.Fatalf("短剧库应 1 条且只属于剧库，实际 %v", dramaIDs)
	}
	// 不带 kind = 不过滤（管理面其它页签仍要看全部）
	if res, _, _ := e.do(http.MethodGet, "/api/v1/media?per_page=50", nil); res.StatusCode != http.StatusOK {
		t.Fatalf("不带 kind 应 200，实际 %d", res.StatusCode)
	}
}

// 「未归组」入口（2026-10-11 分离第 5 步收尾）：短剧库扫描会把**库根散片**留成未归组
// （不建剧、不塞进任何剧），后台得能只列这些、再把它们归进某部剧。
// 判据：`?kind=drama&ungrouped=1` 只出没进过剧的；进了剧立刻从这一列消失。
func TestMediaListUngroupedOnly(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	root := filepath.Join(e.Root, "drama")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	res, env, raw := e.write(http.MethodPost, "/api/v1/libraries", map[string]any{
		"name": "短剧库", "root_path": root, "kind": domain.KindDrama})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("建短剧库失败 %d: %s", res.StatusCode, raw)
	}
	var lib domain.Library
	decodeInto(t, env.Data, &lib)

	loose := e.newMedia(lib.ID, filepath.Join(root, "随手拍的.mp4"), body(8))
	grouped := e.newMedia(lib.ID, filepath.Join(root, "某剧", "01.mp4"), body(8))
	ser := &domain.Series{ID: domain.NewID("ser"), Title: "某剧", LibraryID: lib.ID,
		DirPath: filepath.Join(root, "某剧")}
	if err := e.DB.CreateSeries(ser); err != nil {
		t.Fatal(err)
	}
	if _, err := e.DB.AddSeriesMedia(ser.ID, []storage.SeriesMediaInput{{MediaID: grouped.ID}}); err != nil {
		t.Fatal(err)
	}

	listIDs := func(q string) []string {
		t.Helper()
		res, env, raw := e.do(http.MethodGet, "/api/v1/media?per_page=50&"+q, nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("列表失败 %d: %s", res.StatusCode, raw)
		}
		var page struct {
			List []struct {
				ID string `json:"id"`
			} `json:"list"`
		}
		decodeInto(t, env.Data, &page)
		out := []string{}
		for _, it := range page.List {
			out = append(out, it.ID)
		}
		return out
	}
	got := listIDs("kind=drama&ungrouped=1")
	if len(got) != 1 || got[0] != loose.ID {
		t.Fatalf("未归组应只有那条散片，实际 %v", got)
	}
	if all := listIDs("kind=drama"); len(all) != 2 {
		t.Fatalf("不带 ungrouped 应回两条，实际 %v", all)
	}
	// 归入剧之后立刻从"未归组"消失
	if _, err := e.DB.AddSeriesMedia(ser.ID, []storage.SeriesMediaInput{{MediaID: loose.ID}}); err != nil {
		t.Fatal(err)
	}
	if got := listIDs("kind=drama&ungrouped=1"); len(got) != 0 {
		t.Fatalf("归入剧后不该再出现在未归组里，实际 %v", got)
	}
}

// 建库重名必须是 409 + 人话，不能冒成 500「服务内部错误」。
// 2026-10-11 浏览器验收时抓到：老实现直接 INSERT，撞 `UNIQUE constraint failed:
// media_libraries.name` 之后 handler 把 SQL 错误当内部错误回给用户 —— 用户只看到
// "服务内部错误"，根本不知道是名字重复。
func TestCreateLibraryDuplicateNameIsConflict(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	root := filepath.Join(e.Root, "dup-lib")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	body := map[string]any{"name": "散片库", "root_path": root, "kind": "short"}
	res, _, raw := e.write(http.MethodPost, "/api/v1/libraries", body)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("第一次建库失败 %d: %s", res.StatusCode, raw)
	}
	res, _, raw = e.write(http.MethodPost, "/api/v1/libraries", body)
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("重名建库应 409，实际 %d: %s", res.StatusCode, raw)
	}
	if !strings.Contains(string(raw), "散片库") {
		t.Fatalf("错误里要写清是哪个名字重复了：%s", raw)
	}
	// 名字释放后可以再用（软删的库不占名字）
	libs, err := e.DB.ListLibraries()
	if err != nil || len(libs) != 1 {
		t.Fatalf("应有 1 个库：%v %v", libs, err)
	}
	if err := e.DB.DeleteLibrary(libs[0].ID); err != nil {
		t.Fatal(err)
	}
	res, _, raw = e.write(http.MethodPost, "/api/v1/libraries", body)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("删掉旧库后重名应可再用，实际 %d: %s", res.StatusCode, raw)
	}
}
