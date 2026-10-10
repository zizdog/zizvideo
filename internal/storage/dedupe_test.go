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

// 去重的组/成员顺序与 limit 语义必须与老实现（1 次查组 + 每组 1 次查成员）完全一致 ——
// 2026-10-11 把 N+1 改成一条 CTE JOIN，这条门禁钉住"改写不改行为"。
func TestDuplicateGroupsOrderAndLimit(t *testing.T) {
	db := openFeedDB(t)
	lib := newLib("lib_a", "A", "/tmp/a")
	if err := db.CreateLibrary(lib); err != nil {
		t.Fatal(err)
	}
	// 三组：1000/1000 有 3 个成员（最多）、2000/1000 有 2 个、3000/1000 有 2 个
	add := func(id string, size, dur int64, created string) {
		m := &domain.Media{ID: id, LibraryID: lib.ID, Path: "/tmp/a/" + id + ".mp4", Title: id,
			Size: size, Status: domain.MediaReady, DurationMS: dur, CreatedAt: created}
		if err := db.InsertMedia(m); err != nil {
			t.Fatal(err)
		}
		if created != "" {
			if _, err := db.Exec(`UPDATE media SET created_at = ? WHERE id = ?`, created, id); err != nil {
				t.Fatal(err)
			}
		}
	}
	add("s3a", 1000, 1000, "2026-01-03T00:00:00Z")
	add("s3b", 1000, 1000, "2026-01-01T00:00:00Z")
	add("s3c", 1000, 1000, "2026-01-02T00:00:00Z")
	add("s2lo", 2000, 1000, "2026-01-01T00:00:00Z")
	add("s2lo2", 2000, 1000, "2026-01-02T00:00:00Z")
	add("s2hi", 3000, 1000, "2026-01-01T00:00:00Z")
	add("s2hi2", 3000, 1000, "2026-01-02T00:00:00Z")
	add("solo", 9000, 1000, "")

	groups, err := db.DuplicateGroups(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 3 {
		t.Fatalf("应 3 组，实际 %d", len(groups))
	}
	// 组顺序：成员多的在前，其次 size 大的在前
	if groups[0].Size != 1000 || len(groups[0].Members) != 3 {
		t.Fatalf("第一组应是 1000 的 3 成员组：%+v", groups[0])
	}
	if groups[1].Size != 3000 || groups[2].Size != 2000 {
		t.Fatalf("其余应按 size 降序：%d, %d", groups[1].Size, groups[2].Size)
	}
	// 组成员顺序：created_at 升序（老实现是 ORDER BY created_at ASC, id ASC）
	got := []string{}
	for _, m := range groups[0].Members {
		got = append(got, m.ID)
	}
	want := []string{"s3b", "s3c", "s3a"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("成员顺序 = %v，期望 %v（created_at 升序）", got, want)
		}
	}
	// limit 只限**组数**，不截断成员
	one, err := db.DuplicateGroups(1)
	if err != nil {
		t.Fatal(err)
	}
	if len(one) != 1 || len(one[0].Members) != 3 {
		t.Fatalf("limit=1 应只回 1 组且成员完整，实际 %d 组 / %d 成员", len(one), len(one[0].Members))
	}
	// 不存在的组不会被带出来
	if n := len(groups[2].Members); n != 2 {
		t.Fatalf("2000 那组应 2 个成员，实际 %d", n)
	}
	for _, g := range groups {
		for _, m := range g.Members {
			if m.Size != g.Size || m.DurationMS != g.DurationMS {
				t.Fatalf("成员 %s 与组键不一致：%+v", m.ID, m)
			}
		}
	}
}
