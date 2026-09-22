package api_test

import (
	"net/http"
	"path/filepath"
	"testing"

	"github.com/zizdog/zizvideo/internal/domain"
)

// 媒体库分组（用户 2026-09-22）：可见性判据是"直授 ∪ 组授"，
// 组本身**不写 user_libraries** —— 否则把库移出组之后授权就清不掉了。

func (e *env) createGroup(t *testing.T, name string) domain.LibraryGroup {
	t.Helper()
	res, env, raw := e.write(http.MethodPost, "/api/v1/admin/library-groups", map[string]any{"name": name})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("建组 %s 失败 %d: %s", name, res.StatusCode, raw)
	}
	var g domain.LibraryGroup
	decodeInto(t, env.Data, &g)
	return g
}

func (e *env) setLibraryGroup(t *testing.T, libraryID, groupID string) {
	t.Helper()
	res, _, raw := e.write(http.MethodPut, "/api/v1/libraries/"+libraryID+"/group",
		map[string]any{"group_id": groupID})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("归组失败 %d: %s", res.StatusCode, raw)
	}
}

func (e *env) setUserGroups(t *testing.T, userID string, groupIDs []string) {
	t.Helper()
	res, _, raw := e.write(http.MethodPut, "/api/v1/admin/users/"+userID+"/library-groups",
		map[string]any{"group_ids": groupIDs})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("设置组授权失败 %d: %s", res.StatusCode, raw)
	}
}

func (e *env) newPlainUser(t *testing.T, name string) (*http.Client, domain.User) {
	t.Helper()
	pass := name + "pass12345"
	res, env, raw := e.write(http.MethodPost, "/api/v1/users",
		map[string]any{"username": name, "password": pass, "role": "user"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("建用户 %s 失败 %d: %s", name, res.StatusCode, raw)
	}
	var u domain.User
	decodeInto(t, env.Data, &u)
	c := e.anonClient()
	if res, raw := e.loginAs(c, name, pass); res.StatusCode != http.StatusOK {
		t.Fatalf("%s 登录失败 %d: %s", name, res.StatusCode, raw)
	}
	return c, u
}

func (e *env) myLibraryIDs(t *testing.T, c *http.Client) map[string]bool {
	t.Helper()
	res, env, raw := e.doAs(c, http.MethodGet, "/api/v1/me/libraries")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("/me/libraries = %d (%s)", res.StatusCode, raw)
	}
	var list []domain.LibraryBrief
	decodeInto(t, env.Data, &list)
	out := map[string]bool{}
	for _, b := range list {
		out[b.ID] = true
	}
	return out
}

func TestLibraryGroupAccessIsUnion(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	l1 := e.newLibrary("组L1", filepath.Join(e.Root, "g1"))
	l2 := e.newLibrary("组L2", filepath.Join(e.Root, "g2"))
	l3 := e.newLibrary("组L3", filepath.Join(e.Root, "g3"))
	m1 := e.newMedia(l1.ID, filepath.Join(e.Root, "g1", "a.mp4"), []byte("1"))
	m3 := e.newMedia(l3.ID, filepath.Join(e.Root, "g3", "c.mp4"), []byte("3"))

	g := e.createGroup(t, "古装")
	e.setLibraryGroup(t, l1.ID, g.ID)
	e.setLibraryGroup(t, l2.ID, g.ID)

	// dave：只有组授权
	c, dave := e.newPlainUser(t, "dave")
	e.setUserGroups(t, dave.ID, []string{g.ID})
	got := e.myLibraryIDs(t, c)
	if !got[l1.ID] || !got[l2.ID] || got[l3.ID] {
		t.Fatalf("组授权可见集 = %v，期望 L1+L2（不含 L3）", got)
	}
	// 媒体层面同样生效：不是"列表好看、内容仍可见"。
	if res, _, raw := e.doAs(c, http.MethodGet, "/api/v1/media/"+m1.ID); res.StatusCode != http.StatusOK {
		t.Fatalf("组授权读组内媒体 = %d (%s)，期望 200", res.StatusCode, raw)
	}
	if res, _, _ := e.doAs(c, http.MethodGet, "/api/v1/media/"+m3.ID); res.StatusCode != http.StatusNotFound {
		t.Fatalf("组外媒体 = %d，期望 404", res.StatusCode)
	}
	// /me/libraries 要带组名，观看端才能按组显示。
	res, env, _ := e.doAs(c, http.MethodGet, "/api/v1/me/libraries")
	var briefs []domain.LibraryBrief
	decodeInto(t, env.Data, &briefs)
	foundGroupName := false
	for _, b := range briefs {
		if b.ID == l1.ID && b.GroupID == g.ID && b.GroupName == "古装" {
			foundGroupName = true
		}
	}
	if !foundGroupName {
		t.Fatalf("/me/libraries 未带组信息: %+v", briefs)
	}
	_ = res

	// erin：直授 L3 + 组授权 ⇒ 并集
	c2, erin := e.newPlainUser(t, "erin")
	if err := e.DB.GrantUserLibrary(erin.ID, l3.ID); err != nil {
		t.Fatal(err)
	}
	e.setUserGroups(t, erin.ID, []string{g.ID})
	got2 := e.myLibraryIDs(t, c2)
	if !got2[l1.ID] || !got2[l2.ID] || !got2[l3.ID] {
		t.Fatalf("并集可见集 = %v，期望 L1+L2+L3", got2)
	}

	// 组授权绝不能写进 user_libraries（判据并集，不是回填）
	var n int
	if err := e.DB.QueryRow(`SELECT COUNT(1) FROM user_libraries WHERE user_id = ?`, dave.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("组授权不该写直授行，dave 却有 %d 行", n)
	}
}

func TestLibraryGroupDeleteUnbindsOnly(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	lib := e.newLibrary("待解绑", filepath.Join(e.Root, "u"))
	media := e.newMedia(lib.ID, filepath.Join(e.Root, "u", "a.mp4"), []byte("x"))
	g := e.createGroup(t, "临时组")
	e.setLibraryGroup(t, lib.ID, g.ID)

	c, u := e.newPlainUser(t, "frank")
	e.setUserGroups(t, u.ID, []string{g.ID})
	if got := e.myLibraryIDs(t, c); !got[lib.ID] {
		t.Fatalf("组授权应先可见: %v", got)
	}

	var out struct {
		Unbound int64 `json:"unbound_libraries"`
	}
	res, env, raw := e.write(http.MethodDelete, "/api/v1/admin/library-groups/"+g.ID, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("删组 = %d (%s)", res.StatusCode, raw)
	}
	decodeInto(t, env.Data, &out)
	if out.Unbound != 1 {
		t.Fatalf("解绑库数 = %d，期望 1", out.Unbound)
	}

	// 库还在、媒体还在，只是回到"未分组"
	l, err := e.DB.GetLibrary(lib.ID)
	if err != nil || l == nil {
		t.Fatalf("删组不许删库: %v", err)
	}
	if l.GroupID != "" {
		t.Fatalf("删组后 group_id 应为空，实际 %q", l.GroupID)
	}
	if res, _, _ := e.do(http.MethodGet, "/api/v1/media/"+media.ID, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("删组后管理员仍应看到媒体，实际 %d", res.StatusCode)
	}
	// 组授权是唯一来源 ⇒ 用户必须失去访问（不许留幽灵授权）
	if got := e.myLibraryIDs(t, c); len(got) != 0 {
		t.Fatalf("删组后用户不该还看得到库: %v", got)
	}
}

func TestLibraryGroupsRequireAdmin(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	c, u := e.newPlainUser(t, "grace")
	cases := []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, "/api/v1/admin/library-groups", nil},
		{http.MethodPost, "/api/v1/admin/library-groups", map[string]any{"name": "x"}},
		{http.MethodDelete, "/api/v1/admin/library-groups/grp_nope", nil},
		{http.MethodPost, "/api/v1/admin/library-groups/grp_nope/action", map[string]any{"action": "disable"}},
		{http.MethodPut, "/api/v1/admin/users/" + u.ID + "/library-groups", map[string]any{"group_ids": []string{}}},
	}
	for _, tc := range cases {
		res, _, raw := e.writeAs(c, tc.method, tc.path, tc.body)
		if res.StatusCode != http.StatusForbidden {
			t.Fatalf("%s %s = %d，期望 403 (%s)", tc.method, tc.path, res.StatusCode, raw)
		}
	}
}

func TestLibraryGroupDuplicateNameAndValidation(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	e.createGroup(t, "重名组")
	res, env, raw := e.write(http.MethodPost, "/api/v1/admin/library-groups", map[string]any{"name": "重名组"})
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("重名建组 = %d，期望 409 (%s)", res.StatusCode, raw)
	}
	if env.Error == nil || env.Error.Code != "VALIDATION_GROUP_EXISTS" {
		t.Fatalf("重名错误码 = %+v", env.Error)
	}
	if res, _, _ := e.write(http.MethodPost, "/api/v1/admin/library-groups", map[string]any{"name": "  "}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("空组名 = %d，期望 400", res.StatusCode)
	}
	// 归到不存在的组必须失败，不能写幽灵 group_id
	lib := e.newLibrary("幽灵", filepath.Join(e.Root, "ghost"))
	res, _, raw = e.write(http.MethodPut, "/api/v1/libraries/"+lib.ID+"/group", map[string]any{"group_id": "grp_nope"})
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("归到不存在的组 = %d，期望 404 (%s)", res.StatusCode, raw)
	}
	l, err := e.DB.GetLibrary(lib.ID)
	if err != nil || l.GroupID != "" {
		t.Fatalf("失败归组不该改库: %+v err=%v", l, err)
	}
}

func TestLibraryGroupBatchAssignAndAction(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	l1 := e.newLibrary("批1", filepath.Join(e.Root, "b1"))
	l2 := e.newLibrary("批2", filepath.Join(e.Root, "b2"))
	g := e.createGroup(t, "批量组")

	// 批量归组
	var bulk struct {
		Moved     int64 `json:"moved"`
		Requested int   `json:"requested"`
	}
	res, env, raw := e.write(http.MethodPut, "/api/v1/admin/library-groups/"+g.ID+"/libraries",
		map[string]any{"library_ids": []string{l1.ID, l2.ID, "lib_nope"}})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("批量归组 = %d (%s)", res.StatusCode, raw)
	}
	decodeInto(t, env.Data, &bulk)
	if bulk.Moved != 2 || bulk.Requested != 3 {
		t.Fatalf("批量归组计数 = %+v，期望 moved=2 / requested=3", bulk)
	}
	// 组列表带成员库数
	var groups struct {
		List []domain.LibraryGroup `json:"list"`
	}
	_, env, _ = e.do(http.MethodGet, "/api/v1/admin/library-groups", nil)
	decodeInto(t, env.Data, &groups)
	if len(groups.List) != 1 || groups.List[0].LibraryCount != 2 {
		t.Fatalf("组库数 = %+v，期望 1 组 2 库", groups.List)
	}

	// 整组停用 → 计数如实
	var act struct {
		Changed int64 `json:"changed"`
	}
	res, env, raw = e.write(http.MethodPost, "/api/v1/admin/library-groups/"+g.ID+"/action",
		map[string]any{"action": "disable"})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("整组停用 = %d (%s)", res.StatusCode, raw)
	}
	decodeInto(t, env.Data, &act)
	if act.Changed != 2 {
		t.Fatalf("停用行数 = %d，期望 2", act.Changed)
	}
	for _, id := range []string{l1.ID, l2.ID} {
		l, err := e.DB.GetLibrary(id)
		if err != nil || l.Enabled {
			t.Fatalf("库 %s 应已停用: %+v err=%v", id, l, err)
		}
	}

	// 停用的库整组扫描：如实回报"一个都没启动"，不许谎报
	var scan struct {
		Total   int                 `json:"total"`
		Started int                 `json:"started"`
		Failed  []map[string]string `json:"failed"`
	}
	res, env, raw = e.write(http.MethodPost, "/api/v1/admin/library-groups/"+g.ID+"/action",
		map[string]any{"action": "scan"})
	if res.StatusCode != http.StatusAccepted {
		t.Fatalf("整组扫描 = %d (%s)", res.StatusCode, raw)
	}
	decodeInto(t, env.Data, &scan)
	if scan.Total != 2 || scan.Started != 0 || len(scan.Failed) != 2 {
		t.Fatalf("停用库扫描应回报 0 启动 / 2 失败: %+v", scan)
	}

	// 启用后扫描真的起来
	if res, _, _ := e.write(http.MethodPost, "/api/v1/admin/library-groups/"+g.ID+"/action",
		map[string]any{"action": "enable"}); res.StatusCode != http.StatusOK {
		t.Fatalf("整组启用 = %d", res.StatusCode)
	}
	res, env, raw = e.write(http.MethodPost, "/api/v1/admin/library-groups/"+g.ID+"/action",
		map[string]any{"action": "scan"})
	if res.StatusCode != http.StatusAccepted {
		t.Fatalf("整组扫描 = %d (%s)", res.StatusCode, raw)
	}
	decodeInto(t, env.Data, &scan)
	if scan.Started != 2 {
		t.Fatalf("启用后应启动 2 个扫描: %+v", scan)
	}
	// 未知动作必须 400，不能静默当成功
	if res, _, _ := e.write(http.MethodPost, "/api/v1/admin/library-groups/"+g.ID+"/action",
		map[string]any{"action": "reboot"}); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("未知动作 = %d，期望 400", res.StatusCode)
	}
}

// 组授权算"有权限"：该用户不该再被算进"未授权用户"，补发也不该给他塞默认库。
func TestGroupGrantCountsAsAccessForDefaults(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	lib := e.newLibrary("默认库", filepath.Join(e.Root, "d"))
	e.write(http.MethodPatch, "/api/v1/libraries/"+lib.ID, map[string]any{"default_for_new_users": true})

	_, u := e.newPlainUser(t, "henry")
	g := e.createGroup(t, "亨利组")
	e.setUserGroups(t, u.ID, []string{g.ID})

	var view struct {
		UsersWithoutLibraries int `json:"users_without_libraries"`
	}
	_, env, _ := e.do(http.MethodGet, "/api/v1/admin/libraries/defaults", nil)
	decodeInto(t, env.Data, &view)
	if view.UsersWithoutLibraries != 0 {
		t.Fatalf("有组授权的用户被算成未授权: %d", view.UsersWithoutLibraries)
	}

	var res struct {
		UsersGranted int `json:"users_granted"`
		UsersSkipped int `json:"users_skipped"`
	}
	_, env, _ = e.write(http.MethodPost, "/api/v1/admin/libraries/defaults/backfill", map[string]any{"confirm": true})
	decodeInto(t, env.Data, &res)
	if res.UsersGranted != 0 || res.UsersSkipped != 1 {
		t.Fatalf("有组授权的用户不该被补发默认库: %+v", res)
	}
	var n int
	if err := e.DB.QueryRow(`SELECT COUNT(1) FROM user_libraries WHERE user_id = ?`, u.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("补发不该给有组授权的用户写直授行，实际 %d 行", n)
	}
}
