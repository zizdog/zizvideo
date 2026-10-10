package api_test

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/zizdog/zizvideo/internal/domain"
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
