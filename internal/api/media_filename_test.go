package api_test

import (
	"encoding/json"
	"net/http"
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
