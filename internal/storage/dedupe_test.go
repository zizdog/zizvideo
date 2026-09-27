package storage

import (
	"fmt"
	"testing"

	"github.com/zizdog/zizvideo/internal/domain"
)

// 去重门禁（用户 2026-09-27 报障："把 A 库的视频移动到 B 库后，去重里出现这些视频"）。
// 判据：**文件已不在**（missing_since 非空）的记录不算"疑似重复"—— 它只是待清理的缺失记录。
func TestDuplicateGroupsSkipMissingRows(t *testing.T) {
	db := openFeedDB(t)
	libA := newLib("lib_a", "A", "/tmp/a")
	libB := newLib("lib_b", "B", "/tmp/b")
	for _, l := range []*domain.Library{libA, libB} {
		if err := db.CreateLibrary(l); err != nil {
			t.Fatal(err)
		}
	}
	mk := func(id, lib, path string) *domain.Media {
		return &domain.Media{ID: id, LibraryID: lib, Path: path, Title: "clip",
			Size: 1234, Status: domain.MediaReady, DurationMS: 5000}
	}
	// 同一个视频的两条记录：A 库旧路径（文件被移走）+ B 库新路径 —— 这就是用户那种"搬家"现场
	old := mk("med_old", libA.ID, "/tmp/a/clip.mp4")
	moved := mk("med_new", libB.ID, "/tmp/b/clip.mp4")
	for _, m := range []*domain.Media{old, moved} {
		if err := db.InsertMedia(m); err != nil {
			t.Fatal(err)
		}
	}

	groups, err := db.DuplicateGroups(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 1 {
		t.Fatalf("两条都在（文件都在）时应成一组，实际 %d 组", len(groups))
	}

	// 旧路径那条被移走（扫描会打上缺失标记）⇒ 不该再出现在去重里
	if err := db.MarkMissing(old.ID, domain.NowString()); err != nil {
		t.Fatal(err)
	}
	groups, err = db.DuplicateGroups(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 0 {
		ids := []string{}
		for _, g := range groups {
			for _, m := range g.Members {
				ids = append(ids, fmt.Sprintf("%s(%s)", m.ID, m.MissingSince))
			}
		}
		t.Fatalf("缺失记录不该算重复，实际仍有 %d 组: %v", len(groups), ids)
	}
}
