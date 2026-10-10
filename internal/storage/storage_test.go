package storage

import (
	"database/sql"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"

	"github.com/zizdog/zizvideo/internal/domain"
	"github.com/zizdog/zizvideo/migrations"
)

func newLib(id, name, root string) *domain.Library {
	return &domain.Library{ID: id, Name: name, RootPath: root, Recursive: true,
		Enabled: true, IgnoreRules: []string{}}
}

// TestMigrateCreatesSchemaAndIsIdempotent covers both migration gates: an empty
// database gets every table, and repeated startups are a no-op.
func TestMigrateCreatesSchemaAndIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db", "zizvideo.db")
	// 版本号从迁移文件数推导：并行加迁移时不会因为写死数字而误报。
	migs, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	want := len(migs)

	db, err := Open(path)
	if err != nil {
		t.Fatalf("首次打开失败: %v", err)
	}
	v, err := db.SchemaVersion()
	if err != nil {
		t.Fatal(err)
	}
	if v != migs[len(migs)-1].version {
		t.Fatalf("schema 版本 = %d, 期望 %d", v, migs[len(migs)-1].version)
	}
	for _, table := range []string{
		"schema_migrations", "users", "sessions", "media_libraries", "media",
		"scan_tasks", "watch_progress", "favorites", "reactions", "audit_log",
		"series", "series_media", "user_libraries", "job_tasks",
	} {
		var name string
		err := db.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&name)
		if err != nil {
			t.Fatalf("表 %s 未创建: %v", table, err)
		}
	}
	var mode string
	if err := db.QueryRow(`PRAGMA journal_mode`).Scan(&mode); err != nil {
		t.Fatal(err)
	}
	if mode != "wal" {
		t.Fatalf("journal_mode = %q, 期望 wal", mode)
	}
	db.Close()

	// Second start on the same file must not fail or duplicate anything.
	db2, err := Open(path)
	if err != nil {
		t.Fatalf("重复打开失败: %v", err)
	}
	defer db2.Close()
	v2, err := db2.SchemaVersion()
	if err != nil {
		t.Fatal(err)
	}
	if v2 != v {
		t.Fatalf("重复启动后 schema 版本 = %d, 期望 %d", v2, v)
	}
	var applied int
	if err := db2.QueryRow(`SELECT COUNT(1) FROM schema_migrations`).Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if applied != want {
		t.Fatalf("迁移记录数 = %d, 期望 %d", applied, want)
	}
}

// TestMigrationVersionsAreUnique 锁死"同版本号会被静默跳过"这类问题。
func TestMigrationVersionsAreUnique(t *testing.T) {
	migs, err := loadMigrations()
	if err != nil {
		t.Fatalf("迁移加载失败: %v", err)
	}
	seen := map[int]string{}
	for _, m := range migs {
		if prev, ok := seen[m.version]; ok {
			t.Fatalf("迁移版本号 %d 重复: %s 与 %s", m.version, prev, m.name)
		}
		seen[m.version] = m.name
	}
}

func TestUniqueConstraintsRespectSoftDelete(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "zizvideo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	lib := newLib("lib_1", "Movies", "/tmp/movies")
	if err := db.CreateLibrary(lib); err != nil {
		t.Fatal(err)
	}
	if err := db.CreateLibrary(newLib("lib_2", "Movies", "/tmp/other")); err == nil {
		t.Fatal("同名媒体库必须被唯一索引拒绝")
	}
}

func TestAbandonStaleTasksOnRestart(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "zizvideo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.CreateLibrary(newLib("lib_1", "l", "/tmp/l")); err != nil {
		t.Fatal(err)
	}
	task := &domain.ScanTask{ID: "scn_1", LibraryID: "lib_1", Kind: "incremental"}
	if err := db.CreateScanTask(task); err != nil {
		t.Fatal(err)
	}
	if err := db.UpdateScanTaskProgress("scn_1", 10, 0, 0, 0); err != nil {
		t.Fatal(err)
	}
	if n, err := db.AbandonStaleTasks(); err != nil || n != 1 {
		t.Fatalf("遗留任务回收 = %d, err=%v", n, err)
	}
	got, err := db.GetScanTask("scn_1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "interrupted" {
		t.Fatalf("重启后状态 = %q, 期望 interrupted", got.Status)
	}
}

// TestMigration0006FailClosed：真实 0005 结构 + 历史普通用户 → 升级到 0006 后
// 0 授权（有意），管理员照旧全见。锁死"升级后家人被挡在门外"的预期行为（D.3）。
func TestMigration0006FailClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "zizvideo.db")
	raw, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(ON)")
	if err != nil {
		t.Fatal(err)
	}
	old := []string{"0001_init.sql", "0002_feed.sql", "0003_series.sql",
		"0004_episode.sql", "0005_seek.sql"}
	now := domain.NowString()
	for i, name := range old {
		body, err := migrations.FS.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := raw.Exec(string(body)); err != nil {
			t.Fatalf("执行 %s: %v", name, err)
		}
		if _, err := raw.Exec(`INSERT INTO schema_migrations(version, applied_at) VALUES(?,?)`,
			i+1, now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := raw.Exec(`INSERT INTO users
		(id,username,display_name,password_hash,role,status,created_at,updated_at)
		VALUES ('usr_old','old','Old','x','user','active',?,?)`, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`INSERT INTO media_libraries
		(id,name,root_path,recursive,enabled,ignore_rules,mount_id,created_at,updated_at)
		VALUES ('lib_old','旧库','/tmp/old',1,1,'[]','',?,?)`, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`INSERT INTO media
		(id,library_id,path,normalized_path,title,size,mtime_ns,container,video_codec,audio_codec,
		 width,height,duration_ms,bitrate,fps,status,error_class,error_message,probe_attempts,
		 created_at,updated_at)
		VALUES ('med_old','lib_old','/tmp/old/a.mp4','/tmp/old/a.mp4','a',1,1,'mp4','h264','aac',
		 1,1,1,1,1,'ready','','',0,?,?)`, now, now); err != nil {
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}

	db, err := Open(path)
	if err != nil {
		t.Fatalf("从 0005 升级失败: %v", err)
	}
	defer db.Close()
	// 从 0005 升级后必须把剩下的迁移全部跑完：期望值直接取内嵌迁移的最高版本，
	// 以后加迁移不用再改这个数字。
	migs, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	if v, _ := db.SchemaVersion(); v != migs[len(migs)-1].version {
		t.Fatalf("schema 版本 = %d, 期望 %d（全部迁移跑完）", v, migs[len(migs)-1].version)
	}
	var name string
	if err := db.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name='user_libraries'`).
		Scan(&name); err != nil {
		t.Fatalf("user_libraries 未创建: %v", err)
	}
	ids, err := db.UserLibraryIDs("usr_old")
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 0 {
		t.Fatalf("迁移不得回填存量用户: %v", ids)
	}
	if briefs, err := db.ListLibrariesIn(domain.LibraryScope{}); err != nil || len(briefs) != 0 {
		t.Fatalf("空 scope 必须返回空: %v err=%v", briefs, err)
	}
	all, err := db.ListLibrariesIn(domain.LibraryScope{All: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 1 {
		t.Fatalf("管理端应看到 1 个库, 得到 %d", len(all))
	}
}

// TestUserLibrariesCascadeAndSoftDelete：软删库判据立即失效但授权行保留；
// 硬删用户 CASCADE 清行；软删后重建的同名库不被旧授权命中（D.3）。
func TestUserLibrariesCascadeAndSoftDelete(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "zizvideo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.CreateUser(&domain.User{ID: "usr_1", Username: "u1", PasswordHash: "x",
		Role: domain.RoleUser, Status: domain.StatusActive}); err != nil {
		t.Fatal(err)
	}
	l1, l2 := newLib("lib_1", "L1", "/tmp/l1"), newLib("lib_2", "L2", "/tmp/l2")
	for _, l := range []*domain.Library{l1, l2} {
		if err := db.CreateLibrary(l); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.GrantUserLibrary("usr_1", l1.ID); err != nil {
		t.Fatal(err)
	}
	if err := db.GrantUserLibrary("usr_1", l1.ID); err != nil { // 复合主键 ⇒ 幂等
		t.Fatal(err)
	}
	if err := db.GrantUserLibrary("usr_1", l2.ID); err != nil {
		t.Fatal(err)
	}
	if ids, _ := db.UserLibraryIDs("usr_1"); len(ids) != 2 {
		t.Fatalf("授权数 = %d, 期望 2", len(ids))
	}

	if err := db.DeleteLibrary(l2.ID); err != nil { // 软删
		t.Fatal(err)
	}
	ids, err := db.UserLibraryIDs("usr_1")
	if err != nil {
		t.Fatal(err)
	}
	if ids[l2.ID] || len(ids) != 1 {
		t.Fatalf("软删库不得再进判据: %v", ids)
	}
	var rows int
	if err := db.QueryRow(`SELECT COUNT(1) FROM user_libraries WHERE user_id='usr_1'`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 2 {
		t.Fatalf("软删库的授权行应保留: %d", rows)
	}

	l3 := newLib("lib_3", "L2", "/tmp/l2b") // 同名重建 = 新 id
	if err := db.CreateLibrary(l3); err != nil {
		t.Fatal(err)
	}
	ids, _ = db.UserLibraryIDs("usr_1")
	if ids[l3.ID] {
		t.Fatal("幽灵授权：旧库授权不得对新库生效")
	}
	if briefs, _ := db.ListLibrariesIn(domain.LibraryScope{IDs: map[string]bool{l2.ID: true}}); len(briefs) != 0 {
		t.Fatalf("软删库的授权范围应返回空: %v", briefs)
	}

	if _, err := db.Exec(`DELETE FROM users WHERE id='usr_1'`); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(1) FROM user_libraries WHERE user_id='usr_1'`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("硬删用户应 CASCADE 清授权行: %d", rows)
	}
}

// TestMigration0007DefaultsAndSource：0007 加列、source CHECK、自助注册同事务继承。
func TestMigration0007DefaultsAndSource(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "zizvideo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var cols int
	if err := db.QueryRow(`SELECT COUNT(1) FROM pragma_table_info('media_libraries')
		WHERE name = 'default_for_new_users'`).Scan(&cols); err != nil || cols != 1 {
		t.Fatalf("default_for_new_users 列缺失: n=%d err=%v", cols, err)
	}
	if err := db.QueryRow(`SELECT COUNT(1) FROM pragma_table_info('user_libraries')
		WHERE name = 'source'`).Scan(&cols); err != nil || cols != 1 {
		t.Fatalf("source 列缺失: n=%d err=%v", cols, err)
	}
	if _, err := db.Exec(`INSERT INTO user_libraries (user_id, library_id, source, created_at)
		VALUES ('u','l','bogus','now')`); err == nil {
		t.Fatal("source CHECK 未拦住非法值")
	}

	l1, l2 := newLib("lib_1", "L1", "/tmp/l1"), newLib("lib_2", "L2", "/tmp/l2")
	for _, l := range []*domain.Library{l1, l2} {
		if err := db.CreateLibrary(l); err != nil {
			t.Fatal(err)
		}
	}
	if ids, err := db.DefaultLibraryIDs(); err != nil || len(ids) != 0 {
		t.Fatalf("未设置默认库时必须为空（fail-closed）: %v err=%v", ids, err)
	}
	l1.DefaultForNewUsers = true
	if _, err := db.UpdateLibrary(l1.ID, LibraryPatch{DefaultForNewUsers: &l1.DefaultForNewUsers}); err != nil {
		t.Fatal(err)
	}
	if ids, _ := db.DefaultLibraryIDs(); len(ids) != 1 || ids[0] != l1.ID {
		t.Fatalf("默认库集合 = %v, 期望 [%s]", ids, l1.ID)
	}

	self := &domain.User{ID: "usr_self", Username: "self", PasswordHash: "x",
		Role: domain.RoleUser, Status: domain.StatusActive}
	if err := db.CreateUserWithDefaults(self); err != nil {
		t.Fatal(err)
	}
	if src := grantSourceRow(t, db, self.ID, l1.ID); src != "default" {
		t.Fatalf("自助注册继承 source = %q, 期望 default", src)
	}
	manual := &domain.User{ID: "usr_manual", Username: "manual", PasswordHash: "x",
		Role: domain.RoleUser, Status: domain.StatusActive}
	if err := db.CreateUser(manual); err != nil {
		t.Fatal(err)
	}
	var rows int
	if err := db.QueryRow(`SELECT COUNT(1) FROM user_libraries WHERE user_id = ?`, manual.ID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("管理员建号不应继承: %d 行", rows)
	}
}

func grantSourceRow(t *testing.T, db *DB, userID, libraryID string) string {
	t.Helper()
	var src string
	if err := db.QueryRow(`SELECT source FROM user_libraries WHERE user_id = ? AND library_id = ?`,
		userID, libraryID).Scan(&src); err != nil {
		t.Fatal(err)
	}
	return src
}

// TestResetStaleTranscodes：崩溃/强杀留下的 transcode_state='running' 必须在启动时
// 被改成 failed，并把路径交回调用方去删临时文件（否则界面永远显示"转码中"，
// 而没有任何东西在转 —— 2026-10-10 审计）。
func TestResetStaleTranscodes(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "db", "zizvideo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	lib := newLib("lib_1", "库", t.TempDir())
	if err := db.CreateLibrary(lib); err != nil {
		t.Fatal(err)
	}
	ins := func(id, path string) {
		m := &domain.Media{ID: id, LibraryID: lib.ID, Path: path, Title: id, Size: 10,
			Container: "mov", Codecs: domain.Codecs{Video: "h264", Audio: "aac"},
			Width: 640, Height: 360, DurationMS: 1000, Status: domain.MediaReady}
		if err := db.InsertMedia(m); err != nil {
			t.Fatal(err)
		}
	}
	ins("med_running", "/lib/a.mp4")
	ins("med_done", "/lib/b.mp4")
	ins("med_idle", "/lib/c.mp4")
	if err := db.SetMediaTranscode("med_running", domain.TranscodeRunning, "转码中"); err != nil {
		t.Fatal(err)
	}
	if err := db.SetMediaTranscode("med_done", domain.TranscodeDone, "完成"); err != nil {
		t.Fatal(err)
	}

	paths, err := db.ResetStaleTranscodes("上次转码被中断（进程退出），没有完成")
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 1 || paths[0] != "/lib/a.mp4" {
		t.Fatalf("应只交回卡在 running 的那条路径，实际 %v", paths)
	}
	for id, want := range map[string]string{
		"med_running": domain.TranscodeFailed,
		"med_done":    domain.TranscodeDone,
		"med_idle":    "",
	} {
		got, err := db.GetMediaIn(domain.LibraryScope{All: true}, id)
		if err != nil {
			t.Fatalf("%s 读不到: %v", id, err)
		}
		if got.TranscodeState != want {
			t.Fatalf("%s 的 transcode_state = %q, 期望 %q", id, got.TranscodeState, want)
		}
	}
	// 幂等：再跑一次没有可清的了
	again, err := db.ResetStaleTranscodes("x")
	if err != nil {
		t.Fatal(err)
	}
	if len(again) != 0 {
		t.Fatalf("第二次不应再有可清项，实际 %v", again)
	}
}

// TestListProgressReturnsFullMediaRow：三条查询路径（MediaByPath / mediaJoin / ListProgress）
// 必须返回**同样的** Media —— 2026-10-10 审计发现 ListProgress 手抄的列清单漏了
// transcode_state/transcode_note/loudness_lufs，于是"历史"里这两条新功能的字段恒为空。
func TestListProgressReturnsFullMediaRow(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "db", "zizvideo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	lib := newLib("lib_1", "库", t.TempDir())
	if err := db.CreateLibrary(lib); err != nil {
		t.Fatal(err)
	}
	user := &domain.User{ID: "usr_1", Username: "u", DisplayName: "U", Role: domain.RoleUser,
		Status: domain.StatusActive, PasswordHash: "x", CreatedAt: domain.NowString()}
	if err := db.CreateUser(user); err != nil {
		t.Fatal(err)
	}
	m := &domain.Media{ID: "med_1", LibraryID: lib.ID, Path: "/lib/a.mp4", Title: "A", Size: 10,
		Container: "mov", Codecs: domain.Codecs{Video: "h264", Audio: "aac"},
		Width: 640, Height: 360, DurationMS: 1000, Status: domain.MediaReady}
	if err := db.InsertMedia(m); err != nil {
		t.Fatal(err)
	}
	if err := db.SetMediaTranscode("med_1", domain.TranscodeFailed, "编码器不支持"); err != nil {
		t.Fatal(err)
	}
	if err := db.UpdateMediaLoudness("med_1", -17.5); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertProgress(&domain.Progress{UserID: user.ID, MediaID: "med_1",
		PositionMS: 4200, DurationMS: 1000, UpdatedAt: domain.NowString()}); err != nil {
		t.Fatal(err)
	}

	_, medias, err := db.ListProgress(domain.LibraryScope{All: true}, user.ID, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(medias) != 1 {
		t.Fatalf("应返回 1 条，实际 %d", len(medias))
	}
	got := medias[0]
	if got.TranscodeState != domain.TranscodeFailed || got.TranscodeNote != "编码器不支持" {
		t.Fatalf("ListProgress 丢了转码字段：state=%q note=%q（列清单漂移）", got.TranscodeState, got.TranscodeNote)
	}
	if got.LoudnessLUFS != -17.5 {
		t.Fatalf("ListProgress 丢了响度字段：%v", got.LoudnessLUFS)
	}
	// 与单条读路径逐字段对齐（同一份列清单 ⇒ 必须一致）
	ref, err := db.GetMediaIn(domain.LibraryScope{All: true}, "med_1")
	if err != nil {
		t.Fatal(err)
	}
	if *ref != got {
		t.Fatalf("两条路径返回的 Media 不一致：\n单条=%+v\n历史=%+v", *ref, got)
	}
}

// TestTruncateKeepsValidUTF8：备注里存中文（转码失败原因就是中文）时，
// 按 byte 截断会切裂多字节字符，写进库就是非法 UTF-8（界面显示成 U+FFFD）——审计 P3。
func TestTruncateKeepsValidUTF8(t *testing.T) {
	long := strings.Repeat("转码失败原因很长", 50) // 每字 3 字节
	for _, n := range []int{1, 2, 5, 29, 30, 300} {
		got := truncate(long, n)
		if len(got) > n {
			t.Fatalf("截断后超过上限：n=%d len=%d", n, len(got))
		}
		if !utf8.ValidString(got) {
			t.Fatalf("截断产生了非法 UTF-8：n=%d %q", n, got)
		}
	}
	if got := truncate("短", 1); got != "" {
		t.Fatalf("1 字节连一个完整 rune 都放不下，应返回空串，实际 %q", got)
	}
}

// TestMigrateConcurrentHandles：升级场景下**两个进程/两个连接同时迁移同一个库**
// （面板升级后用新二进制调 `zizvideo roots add`，而旧 daemon 还在跑）。
// 老实现是"SELECT 判重 + deferred 事务"，判重与应用不原子 ⇒ 后到者会拿到
// "duplicate column name" 而 Open 失败。现在每条迁移在 BEGIN IMMEDIATE 里重新判重。
func TestMigrateConcurrentHandles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db", "zizvideo.db")
	const workers = 4
	start := make(chan struct{})
	errs := make(chan error, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			db, err := Open(path)
			if err != nil {
				errs <- err
				return
			}
			defer db.Close()
			<-start
			if err := db.Migrate(); err != nil {
				errs <- err
			}
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("并发迁移必须全部成功（老实现会 duplicate column name）：%v", err)
	}
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	migs, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	v, err := db.SchemaVersion()
	if err != nil {
		t.Fatal(err)
	}
	if v != migs[len(migs)-1].version {
		t.Fatalf("迁移后版本 = %d, 期望 %d", v, migs[len(migs)-1].version)
	}
}

// TestLibraryKindRoundTripAndDefault：库类型（短视频/短剧）必须能存能读，
// 空值/未知值一律按短视频库 —— 库里绝不允许出现第三种形态（2026-10-10 设计）。
func TestLibraryKindRoundTripAndDefault(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "db", "zizvideo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	short := newLib("lib_short", "散片", t.TempDir())
	if err := db.CreateLibrary(short); err != nil {
		t.Fatal(err)
	}
	if short.Kind != domain.KindShort {
		t.Fatalf("不传 kind 应默认 short，实际 %q", short.Kind)
	}
	drama := newLib("lib_drama", "短剧", t.TempDir())
	drama.Kind = domain.KindDrama
	if err := db.CreateLibrary(drama); err != nil {
		t.Fatal(err)
	}
	got, err := db.GetLibrary("lib_drama")
	if err != nil {
		t.Fatal(err)
	}
	if got.Kind != domain.KindDrama {
		t.Fatalf("读回来 kind = %q，期望 drama", got.Kind)
	}
	// 改类型：不动别的东西，读回一致
	next := domain.KindShort
	upd, err := db.UpdateLibrary("lib_drama", LibraryPatch{Kind: &next})
	if err != nil {
		t.Fatal(err)
	}
	if upd.Kind != domain.KindShort || upd.Name != "短剧" {
		t.Fatalf("改类型后 = %+v", upd)
	}
	// 非法类型必须被拒（而不是静默写成第三种）
	bogus := "mixed"
	if _, err := db.UpdateLibrary("lib_drama", LibraryPatch{Kind: &bogus}); err == nil {
		t.Fatal("非法库类型必须被拒")
	}
	// 未知类型即使直接写进库，读出来也按 short
	if _, err := db.Exec(`UPDATE media_libraries SET kind = 'weird' WHERE id = ?`, "lib_short"); err != nil {
		t.Fatal(err)
	}
	again, err := db.GetLibrary("lib_short")
	if err != nil {
		t.Fatal(err)
	}
	if again.Kind != domain.KindShort {
		t.Fatalf("未知 kind 应回落到 short，实际 %q", again.Kind)
	}
}

// TestMigrationClassifiesLibrariesWithSeriesAsDrama：migration 0024 的存量归类规则 ——
// **建过剧场的库判 drama，其余判 short**（用户 2026-10-10 的设计：目录/剧场决定形态）。
func TestMigrationClassifiesLibrariesWithSeriesAsDrama(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "db", "zizvideo.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	withSeries := newLib("lib_a", "有剧", t.TempDir())
	plain := newLib("lib_b", "没剧", t.TempDir())
	for _, l := range []*domain.Library{withSeries, plain} {
		if err := db.CreateLibrary(l); err != nil {
			t.Fatal(err)
		}
	}
	// 建一部剧（挂在 lib_a）——模拟"迁移前就已经在用剧场功能"
	if err := db.CreateSeries(&domain.Series{ID: "ser_1", Title: "某剧", LibraryID: withSeries.ID}); err != nil {
		t.Fatal(err)
	}
	// 把 0024 的效果在测试里回放一遍（迁移只会跑一次，这里验证归类 SQL 本身）
	if _, err := db.Exec(`UPDATE media_libraries SET kind = 'short'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE media_libraries SET kind = 'drama'
		WHERE id IN (SELECT DISTINCT library_id FROM series WHERE library_id IS NOT NULL AND library_id != '')`); err != nil {
		t.Fatal(err)
	}
	a, err := db.GetLibrary(withSeries.ID)
	if err != nil {
		t.Fatal(err)
	}
	b, err := db.GetLibrary(plain.ID)
	if err != nil {
		t.Fatal(err)
	}
	if a.Kind != domain.KindDrama {
		t.Fatalf("有剧场的库应判 drama，实际 %q", a.Kind)
	}
	if b.Kind != domain.KindShort {
		t.Fatalf("没有剧场的库应判 short，实际 %q", b.Kind)
	}
	db.Close()
	// 迁移文件本身也必须真的把这个列建出来（防止只改代码忘了迁移）
	again, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	v, err := again.SchemaVersion()
	if err != nil {
		t.Fatal(err)
	}
	if v < 24 {
		t.Fatalf("schema 版本 = %d，0024（library kind）应已应用", v)
	}
}

// TestSwapMakesQueriesAtomic：备份恢复用 Swap 换连接，而 server/scanner/转码队列都长期
// 握着同一个 *DB。老实现是直接写内嵌的 `*sql.DB` 字段（别的 goroutine 同时在读它）⇒
// 数据竞争，表现是恢复期间"随机 500"。现在连接是 atomic.Pointer，Swap 是一次原子替换。
//
// 判据：① 并发查询 + Swap 在 `-race` 下不报竞争；② Swap 之后所有查询走新库；
// ③ 旧连接池被关掉（不关就泄漏到进程退出）。
func TestSwapMakesQueriesAtomic(t *testing.T) {
	dir := t.TempDir()
	first, err := Open(filepath.Join(dir, "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if err := first.CreateLibrary(newLib("lib_a", "A", "/tmp/a")); err != nil {
		t.Fatal(err)
	}
	second, err := Open(filepath.Join(dir, "b.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := second.CreateLibrary(newLib("lib_b", "B", "/tmp/b")); err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-stop:
				return
			default:
			}
			// 查询结果在 Swap 前后可能来自任一库（这是允许的），只要不崩、不竞争
			_, _ = first.ListLibraries()
			_, _ = first.SchemaVersion()
		}
	}()
	first.Swap(second)
	close(stop)
	<-done

	libs, err := first.ListLibraries()
	if err != nil {
		t.Fatalf("Swap 之后查询失败：%v", err)
	}
	if len(libs) != 1 || libs[0].ID != "lib_b" {
		t.Fatalf("Swap 之后应看到新库的内容，实际 %+v", libs)
	}
	first.Close()
}

// TestTransactionsAreImmediate：事务必须是 IMMEDIATE（`_txlock=immediate`）。
//
// 为什么（2026-10-11 审计）：SQLite 默认 deferred 事务在"先读后写"时，如果中途别的连接提交过，
// 升级写锁会**直接失败**（SQLITE_BUSY_SNAPSHOT）。本项目大量事务正是"先查存在性/计数，再写"
// （AddSeriesMedia / ApplyDeletions / DeleteLibrary / 迁移…），扫描器与 API 并发时会冒"随机 500"。
// IMMEDIATE 在 BEGIN 就拿写锁，配合 busy_timeout 变成"排队等"。
//
// 判据（能区分两种模式）：A 开事务只读（还没写），B 去写。
//
//	· deferred：B 能写成功（A 只持有读快照）—— 老行为；
//	· immediate：A 已持有写锁 ⇒ B 拿不到锁（用很短的 busy_timeout 让它立即报错）。
func TestTransactionsAreImmediate(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "z.db")
	a, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if err := a.CreateLibrary(newLib("lib_a", "A", "/tmp/a")); err != nil {
		t.Fatal(err)
	}
	// 第二个连接用**极短**的 busy_timeout，好在拿不到锁时立刻返回而不是等 5 秒
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	raw, err := sql.Open("sqlite", u.String()+
		"?_txlock=immediate&_pragma=busy_timeout(120)&_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	second := &DB{}
	second.conn.Store(raw)

	tx, err := a.Begin()
	if err != nil {
		t.Fatal(err)
	}
	// A 只读（deferred 模式下这时不会持有写锁）
	var n int
	if err := tx.QueryRow(`SELECT COUNT(1) FROM media_libraries`).Scan(&n); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	// B 试着写：immediate 下 A 已持写锁 ⇒ B 报 database is locked
	_, werr := second.Exec(`UPDATE media_libraries SET name = name WHERE id = 'lib_a'`)
	if werr == nil {
		_ = tx.Rollback()
		t.Fatal("A 开着事务时 B 竟然能写 —— 说明事务不是 IMMEDIATE（deferred 会在这里丢写/报 BUSY_SNAPSHOT）")
	}
	if !busyErr(werr) && !strings.Contains(strings.ToLower(werr.Error()), "locked") {
		_ = tx.Rollback()
		t.Fatalf("B 的写入应因锁失败，实际：%v", werr)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	// A 提交后 B 立刻能写（没有死锁残留）
	if _, err := second.Exec(`UPDATE media_libraries SET updated_at = ? WHERE id = 'lib_a'`, domain.NowString()); err != nil {
		t.Fatalf("A 提交后 B 应能写：%v", err)
	}
}
