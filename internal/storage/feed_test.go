package storage

import (
	"fmt"
	"path/filepath"
	"testing"

	"github.com/zizdog/zizvideo/internal/domain"
)

func openFeedDB(t *testing.T) *DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "zizvideo.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

// seedFeedMedia registers n ready rows in one library.
func seedFeedMedia(t *testing.T, db *DB, libID string, n int) map[string]bool {
	t.Helper()
	want := map[string]bool{}
	for i := 0; i < n; i++ {
		m := &domain.Media{
			ID: domain.NewID("med"), LibraryID: libID,
			Path:  fmt.Sprintf("/tmp/feed/%s/%d.mp4", libID, i),
			Title: "clip", Size: 10, Status: domain.MediaReady, DurationMS: 1000,
		}
		if err := db.InsertMedia(m); err != nil {
			t.Fatal(err)
		}
		want[m.ID] = true
	}
	return want
}

// collectFeed walks one cycle and returns the ids in visit order.
func collectFeed(t *testing.T, db *DB, scope domain.LibraryScope, seed string, limit int) []string {
	t.Helper()
	out := []string{}
	var hash int64
	id := ""
	for guard := 0; guard < 200; guard++ {
		rows, err := db.FeedPage(scope, seed, hash, id, limit)
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) == 0 {
			return out
		}
		for _, m := range rows {
			out = append(out, m.ID)
			hash, id = FeedOrderKey(m.ID, seed), m.ID
		}
	}
	t.Fatalf("游标走了 200 页还没有终点")
	return out
}

// 门禁：同一 (id, seed) 必须得到同一个键；seed 变了键就该变。
func TestFeedOrderKeyDeterministicAndSeedDependent(t *testing.T) {
	id := domain.NewID("med")
	if FeedOrderKey(id, "seed-a") != FeedOrderKey(id, "seed-a") {
		t.Fatal("同一个 (id, seed) 必须得到同一个排序键")
	}
	if FeedOrderKey(id, "seed-a") == FeedOrderKey(id, "seed-b") {
		t.Fatal("seed 不同时排序键不应相同")
	}
	if FeedOrderKey(id, "seed-a") < 0 {
		t.Fatal("排序键必须是非负的 63 位整数")
	}
}

// 门禁：同一 seed 的一轮里每条只出现一次，走完就停。
func TestFeedPageVisitsEachItemOncePerCycle(t *testing.T) {
	db := openFeedDB(t)
	lib := newLib("lib_1", "A", "/tmp/a")
	if err := db.CreateLibrary(lib); err != nil {
		t.Fatal(err)
	}
	want := seedFeedMedia(t, db, lib.ID, 7)

	got := collectFeed(t, db, domain.LibraryScope{All: true}, "seed-1", 3)
	if len(got) != len(want) {
		t.Fatalf("一轮覆盖 %d 条, 期望 %d", len(got), len(want))
	}
	seen := map[string]int{}
	for _, id := range got {
		seen[id]++
		if !want[id] {
			t.Fatalf("返回了无关媒体 %s", id)
		}
	}
	for id, n := range seen {
		if n != 1 {
			t.Fatalf("同一 seed 内 %s 出现 %d 次", id, n)
		}
	}
	// 换 seed 重开一轮，仍然覆盖全部（只是顺序不同）
	if again := collectFeed(t, db, domain.LibraryScope{All: true}, "seed-2", 3); len(again) != len(want) {
		t.Fatalf("新 seed 一轮覆盖 %d 条, 期望 %d", len(again), len(want))
	}
}

// 门禁（用户 2026-09-22 报障）：文件已不在磁盘上的行**不许进 feed**。
// 扫描只打 missing_since、status 仍是 ready，所以必须靠 missing_since 过滤，
// 否则首页会推荐一条播到就 404 的记录，前端只能显示"这个视频放不了（状态：ready）"。
func TestFeedExcludesMissingRows(t *testing.T) {
	db := openFeedDB(t)
	lib := newLib("lib_m", "M", "/tmp/m")
	if err := db.CreateLibrary(lib); err != nil {
		t.Fatal(err)
	}
	want := seedFeedMedia(t, db, lib.ID, 3)

	// 把其中一条标记为"文件已不在"（不改 status，模拟真实扫描行为）
	var gone string
	for id := range want {
		gone = id
		break
	}
	if err := db.MarkMissing(gone, domain.NowString()); err != nil {
		t.Fatal(err)
	}

	got := collectFeed(t, db, domain.LibraryScope{All: true}, "s", 2)
	if len(got) != 2 {
		t.Fatalf("feed = %d 条, 期望 2（缺失那条必须被排除），得到 %v", len(got), got)
	}
	for _, id := range got {
		if id == gone {
			t.Fatalf("缺失记录 %s 仍然进了 feed", gone)
		}
	}
	n, err := db.CountPlayable(domain.LibraryScope{All: true})
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("CountPlayable = %d, 期望 2", n)
	}
	// 记录本身还在（两阶段删除设计：先标记，不急着删）——只是不再被推荐。
	if _, err := db.getMedia(gone); err != nil {
		t.Fatalf("缺失记录不该被删掉: %v", err)
	}

	// 文件回来了（ClearMissing）就该重新进 feed
	if err := db.ClearMissing(gone); err != nil {
		t.Fatal(err)
	}
	if n, _ := db.CountPlayable(domain.LibraryScope{All: true}); n != 3 {
		t.Fatalf("文件回来后 CountPlayable = %d, 期望 3", n)
	}
}

// 门禁：后台「媒体」页的 missing 筛选必须按 missing_since 判定（status 列里没有 missing 这个值）。
func TestListMediaMissingFilterUsesMissingSince(t *testing.T) {
	db := openFeedDB(t)
	lib := newLib("lib_l", "L", "/tmp/l")
	if err := db.CreateLibrary(lib); err != nil {
		t.Fatal(err)
	}
	seedFeedMedia(t, db, lib.ID, 2)
	var gone string
	for id := range mustIDs(t, db, lib.ID) {
		gone = id
		break
	}
	if err := db.MarkMissing(gone, domain.NowString()); err != nil {
		t.Fatal(err)
	}

	rows, total, err := db.ListMedia(domain.LibraryScope{All: true}, MediaFilter{Status: domain.MediaMissing, PerPage: 20, Page: 1})
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || len(rows) != 1 || rows[0].ID != gone {
		t.Fatalf("missing 筛选 = %d 条(total=%d)，期望只有 %s", len(rows), total, gone)
	}
	// 其它状态筛选不受影响
	ready, _, err := db.ListMedia(domain.LibraryScope{All: true}, MediaFilter{Status: domain.MediaReady, PerPage: 20, Page: 1})
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range ready {
		if m.ID == gone {
			t.Fatalf("status=ready 不该包含缺失记录")
		}
	}
}

// 门禁：清理缺失记录只删该库的这些行，绝不碰文件、不碰别的库。
func TestPurgeMissingMediaOnlyTouchesThatLibrary(t *testing.T) {
	db := openFeedDB(t)
	libA := newLib("lib_pa", "PA", "/tmp/pa")
	libB := newLib("lib_pb", "PB", "/tmp/pb")
	for _, lib := range []*domain.Library{libA, libB} {
		if err := db.CreateLibrary(lib); err != nil {
			t.Fatal(err)
		}
	}
	seedFeedMedia(t, db, libA.ID, 2)
	seedFeedMedia(t, db, libB.ID, 2)
	goneA := firstID(t, db, libA.ID)
	goneB := firstID(t, db, libB.ID)
	if err := db.MarkMissing(goneA, domain.NowString()); err != nil {
		t.Fatal(err)
	}
	if err := db.MarkMissing(goneB, domain.NowString()); err != nil {
		t.Fatal(err)
	}

	n, err := db.PurgeMissingMedia(libA.ID)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("清理条数 = %d, 期望 1", n)
	}
	// A 库那条已软删（查不到），B 库那条还在
	if _, err := db.getMedia(goneA); err == nil {
		t.Fatalf("A 库缺失记录应已被软删")
	}
	if _, err := db.getMedia(goneB); err != nil {
		t.Fatalf("B 库缺失记录不该被动: %v", err)
	}
	// 再清一次必须报 0，不许谎报
	if n, _ := db.PurgeMissingMedia(libA.ID); n != 0 {
		t.Fatalf("重复清理 = %d, 期望 0", n)
	}
	// 不存在的库直接报错
	if _, err := db.PurgeMissingMedia("lib_nope"); err == nil {
		t.Fatal("不存在的媒体库必须报错")
	}
}

func mustIDs(t *testing.T, db *DB, libID string) map[string]bool {
	t.Helper()
	rows, _, err := db.ListMedia(domain.LibraryScope{All: true}, MediaFilter{LibraryID: libID, PerPage: 50, Page: 1})
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]bool{}
	for _, m := range rows {
		out[m.ID] = true
	}
	return out
}

func firstID(t *testing.T, db *DB, libID string) string {
	t.Helper()
	for id := range mustIDs(t, db, libID) {
		return id
	}
	t.Fatalf("库 %s 没有媒体", libID)
	return ""
}

// 门禁：library_id 范围只返回该库，全部库范围返回全部。
func TestFeedPageScopeFiltersLibrary(t *testing.T) {
	db := openFeedDB(t)
	libA := newLib("lib_a", "A", "/tmp/a")
	libB := newLib("lib_b", "B", "/tmp/b")
	for _, lib := range []*domain.Library{libA, libB} {
		if err := db.CreateLibrary(lib); err != nil {
			t.Fatal(err)
		}
	}
	seedFeedMedia(t, db, libA.ID, 3)
	seedFeedMedia(t, db, libB.ID, 2)

	if got := collectFeed(t, db, domain.LibraryScope{All: true}, "s", 4); len(got) != 5 {
		t.Fatalf("全部库 = %d 条, 期望 5", len(got))
	}
	scoped := collectFeed(t, db, domain.LibraryScope{IDs: map[string]bool{libA.ID: true}}, "s", 4)
	if len(scoped) != 3 {
		t.Fatalf("库 A = %d 条, 期望 3", len(scoped))
	}
	for _, id := range scoped {
		m, err := db.getMedia(id)
		if err != nil {
			t.Fatal(err)
		}
		if m.LibraryID != libA.ID {
			t.Fatalf("库 A 范围出现了 %s 的媒体", m.LibraryID)
		}
	}
}

// 门禁（用户 2026-09-22 明确）：普通视频 feed 的范围与顺序不受剧场影响 ——
// 加入剧场的某一集仍在本轮里，且 (scope, seed) 的顺序一字不变。
func TestFeedOrderIgnoresSeriesMembership(t *testing.T) {
	db := openFeedDB(t)
	lib := newLib("lib_f", "F", "/tmp/f")
	if err := db.CreateLibrary(lib); err != nil {
		t.Fatal(err)
	}
	want := seedFeedMedia(t, db, lib.ID, 5)

	before := collectFeed(t, db, domain.LibraryScope{All: true}, "seed-fixed", 2)
	if len(before) != len(want) {
		t.Fatalf("加入剧场前一轮覆盖 %d 条, 期望 %d", len(before), len(want))
	}

	series := &domain.Series{ID: domain.NewID("ser"), Title: "剧场"}
	if err := db.CreateSeries(series); err != nil {
		t.Fatal(err)
	}
	inSeries := before[0]
	if _, err := db.AddSeriesMedia(series.ID, []SeriesMediaInput{{MediaID: inSeries}}); err != nil {
		t.Fatal(err)
	}

	after := collectFeed(t, db, domain.LibraryScope{All: true}, "seed-fixed", 2)
	if len(after) != len(want) {
		t.Fatalf("加入剧场后一轮覆盖 %d 条, 期望 %d（剧集不许被 feed 排除）", len(after), len(want))
	}
	seen := map[string]bool{}
	for i, id := range after {
		seen[id] = true
		if id != before[i] {
			t.Fatalf("剧场成员改变了 feed 的种子随机顺序: before=%v after=%v", before, after)
		}
	}
	if !seen[inSeries] {
		t.Fatalf("已加入剧场的那一集 %s 必须仍在 feed 的 id 集合里", inSeries)
	}
}

// 门禁：seed / 游标 / 已播计数 / 播放设置按用户持久化，scope 各一轮。
func TestFeedStateAndPrefsPersist(t *testing.T) {
	db := openFeedDB(t)
	if err := db.CreateUser(&domain.User{ID: "usr_1", Username: "u1", PasswordHash: "x",
		Role: domain.RoleUser, Status: domain.StatusActive}); err != nil {
		t.Fatal(err)
	}
	st, err := db.GetFeedState("usr_1", FeedScopeAll)
	if err != nil {
		t.Fatal(err)
	}
	if st.Seed == "" {
		t.Fatal("首次取状态应生成 seed")
	}
	st.Seed, st.CursorHash, st.CursorID, st.Played = "seed-x", 42, "med_9", 3
	if err := db.SaveFeedState(st); err != nil {
		t.Fatal(err)
	}
	got, err := db.GetFeedState("usr_1", FeedScopeAll)
	if err != nil {
		t.Fatal(err)
	}
	if got.Seed != "seed-x" || got.CursorHash != 42 || got.CursorID != "med_9" || got.Played != 3 {
		t.Fatalf("状态没有持久化: %+v", got)
	}
	other, err := db.GetFeedState("usr_1", "lib_a")
	if err != nil {
		t.Fatal(err)
	}
	if other.Seed == "seed-x" || other.Played != 0 {
		t.Fatalf("不同 scope 必须是独立的一轮: %+v", other)
	}

	prefs, err := db.GetUserPrefs("usr_1")
	if err != nil {
		t.Fatal(err)
	}
	if prefs.LoopPlay || !prefs.AutoplayNext {
		t.Fatalf("默认应是 循环关 / 连播开: %+v", prefs)
	}
	if prefs.SeekSeconds != DefaultSeekSeconds {
		t.Fatalf("默认跳转秒数 = %d, 期望 %d", prefs.SeekSeconds, DefaultSeekSeconds)
	}
	if err := db.SaveUserPrefs("usr_1", &UserPrefs{LoopPlay: true, AutoplayNext: false, SeekSeconds: 25}); err != nil {
		t.Fatal(err)
	}
	prefs, err = db.GetUserPrefs("usr_1")
	if err != nil {
		t.Fatal(err)
	}
	if !prefs.LoopPlay || prefs.AutoplayNext || prefs.SeekSeconds != 25 {
		t.Fatalf("设置没有持久化: %+v", prefs)
	}
	// 存量非法值（<=0）必须回落默认，而不是让前端拿到 0 秒跳转。
	if _, err := db.Exec(`UPDATE user_prefs SET seek_seconds = 0 WHERE user_id = ?`, "usr_1"); err != nil {
		t.Fatal(err)
	}
	prefs, err = db.GetUserPrefs("usr_1")
	if err != nil {
		t.Fatal(err)
	}
	if prefs.SeekSeconds != DefaultSeekSeconds {
		t.Fatalf("非法存量值回落 = %d, 期望 %d", prefs.SeekSeconds, DefaultSeekSeconds)
	}
}
