package storage

import (
	"fmt"
	"testing"

	"github.com/zizdog/zizvideo/internal/domain"
)

// 这一组门禁钉住"短剧库归组"要用的存储能力（设计 §3）：
// 按 dir_path / 标题查剧、活成员、剧目录改名、批量移除成员。

func seedSeries(t *testing.T, db *DB, libID, title string, n int) (*domain.Series, []string) {
	t.Helper()
	ser := &domain.Series{ID: domain.NewID("ser"), Title: title, LibraryID: libID}
	if err := db.CreateSeries(ser); err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, n)
	items := make([]SeriesMediaInput, 0, n)
	for i := 0; i < n; i++ {
		id := domain.NewID("med")
		m := &domain.Media{ID: id, LibraryID: libID, Path: fmt.Sprintf("/tmp/%s/%02d.mp4", title, i+1),
			Title: fmt.Sprintf("%02d", i+1), Size: int64(i + 1), Status: domain.MediaReady}
		if err := db.InsertMedia(m); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
		items = append(items, SeriesMediaInput{MediaID: id, Source: domain.EpisodeSourceFilename})
	}
	if _, err := db.AddSeriesMedia(ser.ID, items); err != nil {
		t.Fatal(err)
	}
	return ser, ids
}

func TestSeriesByDirPathBindsLibraryAndIgnoresTrailingSlash(t *testing.T) {
	db := openFeedDB(t)
	libA := newLib("lib_a", "A", "/tmp/a")
	libB := newLib("lib_b", "B", "/tmp/b")
	for _, l := range []*domain.Library{libA, libB} {
		if err := db.CreateLibrary(l); err != nil {
			t.Fatal(err)
		}
	}
	bound := &domain.Series{ID: "ser_a", Title: "剧A", LibraryID: libA.ID, DirPath: "/tmp/a/剧A"}
	if err := db.CreateSeries(bound); err != nil {
		t.Fatal(err)
	}
	unbound := &domain.Series{ID: "ser_u", Title: "剧U", DirPath: "/tmp/u/剧U"}
	if err := db.CreateSeries(unbound); err != nil {
		t.Fatal(err)
	}

	got, err := db.SeriesByDirPath(libA.ID, "/tmp/a/剧A/")
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || got.ID != bound.ID {
		t.Fatalf("末尾斜杠不该妨碍匹配：%+v", got)
	}
	// 绑定在别的库的剧不能串库复用
	got, err = db.SeriesByDirPath(libB.ID, "/tmp/a/剧A")
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("别的库的剧不该被复用：%+v", got)
	}
	// 还没记库的剧（目录导入/上传落的）可以被认领
	got, err = db.SeriesByDirPath(libB.ID, "/tmp/u/剧U")
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || got.ID != unbound.ID {
		t.Fatalf("未记库的剧应能匹配：%+v", got)
	}
	// 目录不存在就是 nil（扫描器据此走"新建/改名"）
	got, err = db.SeriesByDirPath(libA.ID, "/tmp/a/不存在")
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("不存在的目录应返回 nil，实际 %+v", got)
	}
}

func TestSeriesByTitleInLibrarySeesUnboundSeries(t *testing.T) {
	db := openFeedDB(t)
	libA := newLib("lib_a", "A", "/tmp/a")
	libB := newLib("lib_b", "B", "/tmp/b")
	for _, l := range []*domain.Library{libA, libB} {
		if err := db.CreateLibrary(l); err != nil {
			t.Fatal(err)
		}
	}
	for _, s := range []*domain.Series{
		{ID: "ser_a", Title: "同名", LibraryID: libA.ID},
		{ID: "ser_u", Title: "同名"},
		{ID: "ser_b", Title: "同名", LibraryID: libB.ID},
	} {
		if err := db.CreateSeries(s); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := db.SeriesByTitleInLibrary(libA.ID, "同名")
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, r := range rows {
		ids[r.ID] = true
	}
	if !ids["ser_a"] || !ids["ser_u"] {
		t.Fatalf("本库 + 未记库的同名剧都该返回，实际 %+v", ids)
	}
	if ids["ser_b"] {
		t.Fatalf("别的库的同名剧不该返回：%+v", ids)
	}
}

func TestLiveSeriesMemberIDsSkipsSoftDeleted(t *testing.T) {
	db := openFeedDB(t)
	lib := newLib("lib_a", "A", "/tmp/a")
	if err := db.CreateLibrary(lib); err != nil {
		t.Fatal(err)
	}
	ser, ids := seedSeries(t, db, lib.ID, "剧A", 2)
	if _, err := db.SoftDeleteMedia([]string{ids[0]}); err != nil {
		t.Fatal(err)
	}
	live, err := db.LiveSeriesMemberIDs(ser.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(live) != 1 || live[0] != ids[1] {
		t.Fatalf("只应剩一条活成员 %s，实际 %+v", ids[1], live)
	}
}

func TestRenameSeriesDirKeepsIdentityAndMembers(t *testing.T) {
	db := openFeedDB(t)
	lib := newLib("lib_a", "A", "/tmp/a")
	if err := db.CreateLibrary(lib); err != nil {
		t.Fatal(err)
	}
	ser, ids := seedSeries(t, db, lib.ID, "老剧名", 2)
	if err := db.SetSeriesDir(ser.ID, "/tmp/a/老剧名"); err != nil {
		t.Fatal(err)
	}
	if err := db.RenameSeriesDir(ser.ID, "/tmp/a/新剧名", "新剧名"); err != nil {
		t.Fatal(err)
	}
	fresh, err := db.GetSeries(ser.ID)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.DirPath != "/tmp/a/新剧名" || fresh.Title != "新剧名" {
		t.Fatalf("改名没落库：dir=%q title=%q", fresh.DirPath, fresh.Title)
	}
	live, err := db.LiveSeriesMemberIDs(ser.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(live) != len(ids) {
		t.Fatalf("改名不该动成员：%d → %d", len(ids), len(live))
	}
	if err := db.RenameSeriesDir("ser_不存在", "/tmp/a/x", "x"); err == nil {
		t.Fatal("改不存在的剧应报错")
	}
}

func TestRemoveSeriesMediaIDsCompactsPositions(t *testing.T) {
	db := openFeedDB(t)
	lib := newLib("lib_a", "A", "/tmp/a")
	if err := db.CreateLibrary(lib); err != nil {
		t.Fatal(err)
	}
	ser, ids := seedSeries(t, db, lib.ID, "剧A", 3)

	removed, err := db.RemoveSeriesMediaIDs(ser.ID, []string{ids[0], ids[2]})
	if err != nil {
		t.Fatal(err)
	}
	if removed != 2 {
		t.Fatalf("应移除 2 条，实际 %d", removed)
	}
	eps, medias, err := db.ListSeriesEpisodes(domain.LibraryScope{All: true}, ser.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(eps) != 1 || medias[0].ID != ids[1] {
		t.Fatalf("应只剩中间那条，实际 %+v", medias)
	}
	if eps[0].Position != 1 {
		t.Fatalf("移除后 position 应压紧到 1，实际 %d", eps[0].Position)
	}
	// 幂等：再删同一批不是错误，也不改任何东西
	removed, err = db.RemoveSeriesMediaIDs(ser.ID, []string{ids[0], ids[2]})
	if err != nil {
		t.Fatalf("重复移除不该报错：%v", err)
	}
	if removed != 0 {
		t.Fatalf("重复移除应返回 0，实际 %d", removed)
	}
	removed, err = db.RemoveSeriesMediaIDs(ser.ID, nil)
	if err != nil || removed != 0 {
		t.Fatalf("空列表应是无操作：removed=%d err=%v", removed, err)
	}
}

// TestApplySeriesEpisodesNeverErasesKnownNumbers：识别器"这次没认出来"不许把**已知**的
// 季/集号擦成 NULL（2026-10-10 实现时发现：短剧库扫描按目录给的季号，会被扫描结束后的
// 自动识别任务抹掉 —— 那边同时修了识别规则，这里是写入端那道保险）。
func TestApplySeriesEpisodesNeverErasesKnownNumbers(t *testing.T) {
	db := openFeedDB(t)
	lib := newLib("lib_1", "剧库", "/tmp/drama")
	if err := db.CreateLibrary(lib); err != nil {
		t.Fatal(err)
	}
	ser, ids := seedSeries(t, db, lib.ID, "某剧", 1)
	season, episode := 1, 1
	if _, err := db.ApplySeriesEpisodes(ser.ID, []EpisodeAssignment{{
		MediaID: ids[0], Season: &season, Episode: &episode, Source: domain.EpisodeSourceFilename,
	}}); err != nil {
		t.Fatal(err)
	}
	// 识别器这次什么都没认出来（nil/nil）：已知值必须原样保留
	if _, err := db.ApplySeriesEpisodes(ser.ID, []EpisodeAssignment{{
		MediaID: ids[0], Source: domain.EpisodeSourceFilename,
	}}); err != nil {
		t.Fatal(err)
	}
	eps, _, err := db.ListSeriesEpisodes(domain.LibraryScope{All: true}, ser.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(eps) != 1 || eps[0].Season == nil || *eps[0].Season != 1 || eps[0].Episode == nil || *eps[0].Episode != 1 {
		t.Fatalf("已知的季/集号被 NULL 覆盖了：%+v", eps)
	}
	// 有真值时要能正常更新（只补季、集号保留）
	onlySeason := 2
	if _, err := db.ApplySeriesEpisodes(ser.ID, []EpisodeAssignment{{
		MediaID: ids[0], Season: &onlySeason, Source: domain.EpisodeSourceFilename,
	}}); err != nil {
		t.Fatal(err)
	}
	eps, _, err = db.ListSeriesEpisodes(domain.LibraryScope{All: true}, ser.ID)
	if err != nil {
		t.Fatal(err)
	}
	if eps[0].Season == nil || *eps[0].Season != 2 || eps[0].Episode == nil || *eps[0].Episode != 1 {
		t.Fatalf("补季号后 = %+v（集号应保留）", eps[0])
	}
	// 手动改过的（manual）永远不被识别器覆盖
	manualEp := 9
	if _, err := db.ApplySeriesEpisodes(ser.ID, []EpisodeAssignment{{
		MediaID: ids[0], Episode: &manualEp, Source: domain.EpisodeSourceManual,
	}}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ApplySeriesEpisodes(ser.ID, []EpisodeAssignment{{
		MediaID: ids[0], Episode: &episode, Source: domain.EpisodeSourceFilename,
	}}); err != nil {
		t.Fatal(err)
	}
	eps, _, err = db.ListSeriesEpisodes(domain.LibraryScope{All: true}, ser.ID)
	if err != nil {
		t.Fatal(err)
	}
	if eps[0].Episode == nil || *eps[0].Episode != 9 {
		t.Fatalf("手动集号被识别器覆盖了：%+v", eps[0])
	}
}
