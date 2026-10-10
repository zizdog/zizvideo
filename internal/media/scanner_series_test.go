package media

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/zizdog/zizvideo/internal/domain"
	"github.com/zizdog/zizvideo/internal/storage"
)

// 这一组门禁钉住"短视频 / 短剧分离"的**第 2 步语义**（设计 §3，用户 2026-10-10 拍板）：
//   · short 库行为与今天完全一样（不归组）；
//   · drama 库：库根一级目录 = 一部剧、季目录给出季号、剧目下散片季号留空、
//     库根散片 = 未归组（不建剧、不塞进任何剧）；
//   · 幂等：重复扫描不重复插入、不打乱 position；
//   · 剧目录改名 = 剧改名（剧 id 不变、成员不丢）；
//   · 文件在剧目录之间移动 = 换剧（media id 不变）。

func makeDrama(t *testing.T, env *scanEnv) {
	t.Helper()
	kind := domain.KindDrama
	if _, err := env.db.UpdateLibrary(env.lib.ID, storage.LibraryPatch{Kind: &kind}); err != nil {
		t.Fatal(err)
	}
	env.lib.Kind = domain.KindDrama
}

type memberSnap struct {
	mediaID  string
	path     string
	position int
	season   *int
	episode  *int
}

func membersByPath(t *testing.T, env *scanEnv, seriesID string) map[string]memberSnap {
	t.Helper()
	eps, medias, err := env.db.ListSeriesEpisodes(domain.LibraryScope{All: true}, seriesID)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]memberSnap{}
	for i := range eps {
		out[medias[i].Path] = memberSnap{mediaID: eps[i].MediaID, path: medias[i].Path,
			position: eps[i].Position, season: eps[i].Season, episode: eps[i].Episode}
	}
	return out
}

func seriesByDirPath(t *testing.T, env *scanEnv, dir string) *domain.Series {
	t.Helper()
	list, err := env.db.ListSeries(domain.LibraryScope{All: true})
	if err != nil {
		t.Fatal(err)
	}
	for i := range list {
		if list[i].DirPath != "" && filepath.Clean(list[i].DirPath) == filepath.Clean(dir) {
			return &list[i]
		}
	}
	return nil
}

func seriesCount(t *testing.T, env *scanEnv) int {
	t.Helper()
	n, err := env.db.SeriesCount()
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func intPtr(v int) *int { return &v }

func sameIntPtr(a, b *int) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func describeIntPtr(v *int) string {
	if v == nil {
		return "空"
	}
	return strconv.Itoa(*v)
}

// ① short 库（默认类型）绝不能归组：库里有剧目录结构也一个剧都不建。
// 这条钉的是"库类型是 short ⇒ 行为与今天完全一样"（第 2 步规则 1）。
func TestScanShortLibraryNeverGroupsSeries(t *testing.T) {
	env := newScanEnv(t)
	env.write(t, "剧A/Season 1/01.mp4", "a")
	env.write(t, "剧A/散片.mp4", "b")
	env.write(t, "root.mp4", "c")

	task := env.run(t)
	if task.Status != domain.TaskSuccess {
		t.Fatalf("状态 = %s, 期望 success (%s)", task.Status, task.Error)
	}
	if n := seriesCount(t, env); n != 0 {
		t.Fatalf("short 库不许建剧，实际建了 %d 部", n)
	}
	if got := len(env.media(t)); got != 3 {
		t.Fatalf("short 库媒体数 = %d, 期望 3", got)
	}
}

// ② drama 库：一级目录→一部剧、季目录→季号、剧目下散文件→季号空、库根散文件→未归组。
func TestScanDramaGroupsDirsSeasonsAndUngrouped(t *testing.T) {
	env := newScanEnv(t)
	env.write(t, "剧A/Season 1/01.mp4", "a1")
	env.write(t, "剧A/Season 1/02.mp4", "a2")
	env.write(t, "剧A/剧集03.mp4", "a3")    // 剧目录下直接放的视频：季号未知
	env.write(t, "剧A/S02/01.mp4", "a4")  // Sxx 也是季目录
	env.write(t, "剧B/第一季/第1集.mp4", "b1") // 中文季目录
	env.write(t, "root.mp4", "r")        // 库根散片：未归组
	makeDrama(t, env)

	task := env.run(t)
	if task.Status != domain.TaskSuccess {
		t.Fatalf("状态 = %s (%s)", task.Status, task.Error)
	}
	if n := seriesCount(t, env); n != 2 {
		t.Fatalf("drama 库应按一级目录建 2 部剧，实际 %d 部", n)
	}
	root := env.root
	sa := seriesByDirPath(t, env, filepath.Join(root, "剧A"))
	if sa == nil {
		t.Fatal("没按目录建出「剧A」")
	}
	if sa.Title != "剧A" {
		t.Fatalf("剧名应取目录名，实际 %q", sa.Title)
	}
	sb := seriesByDirPath(t, env, filepath.Join(root, "剧B"))
	if sb == nil {
		t.Fatal("没按目录建出「剧B」")
	}

	ma := membersByPath(t, env, sa.ID)
	if len(ma) != 4 {
		t.Fatalf("剧A 成员数 = %d, 期望 4（S1 两集 + 散片 + S02 一集）", len(ma))
	}
	// Season 1/01.mp4：季号由目录给出（1），集号由文件名给出（1）
	s1 := ma[filepath.Join(root, "剧A", "Season 1", "01.mp4")]
	if !sameIntPtr(s1.season, intPtr(1)) || !sameIntPtr(s1.episode, intPtr(1)) {
		t.Fatalf("Season 1/01.mp4 应记为 S1E1，实际 season=%s episode=%s",
			describeIntPtr(s1.season), describeIntPtr(s1.episode))
	}
	// 剧目录下的散片：季号留空（不猜），集号仍从文件名拿到 3
	loose := ma[filepath.Join(root, "剧A", "剧集03.mp4")]
	if loose.season != nil {
		t.Fatalf("剧目录下直接放的视频季号必须留空，实际 season=%s", describeIntPtr(loose.season))
	}
	if !sameIntPtr(loose.episode, intPtr(3)) {
		t.Fatalf("剧集03.mp4 集号应为 3，实际 %s", describeIntPtr(loose.episode))
	}
	// S02/01.mp4：季号 2
	s2 := ma[filepath.Join(root, "剧A", "S02", "01.mp4")]
	if !sameIntPtr(s2.season, intPtr(2)) || !sameIntPtr(s2.episode, intPtr(1)) {
		t.Fatalf("S02/01.mp4 应记为 S2E1，实际 season=%s episode=%s",
			describeIntPtr(s2.season), describeIntPtr(s2.episode))
	}

	mb := membersByPath(t, env, sb.ID)
	if len(mb) != 1 {
		t.Fatalf("剧B 成员数 = %d, 期望 1", len(mb))
	}
	cn := mb[filepath.Join(root, "剧B", "第一季", "第1集.mp4")]
	if !sameIntPtr(cn.season, intPtr(1)) || !sameIntPtr(cn.episode, intPtr(1)) {
		t.Fatalf("第一季/第1集.mp4 应记为 S1E1，实际 season=%s episode=%s",
			describeIntPtr(cn.season), describeIntPtr(cn.episode))
	}

	// 库根散片：不建剧、不塞进任何剧
	var rootID string
	for _, m := range env.media(t) {
		if m.Path == filepath.Join(root, "root.mp4") {
			rootID = m.ID
		}
	}
	if rootID == "" {
		t.Fatal("库根散片没有被登记成 media")
	}
	refs, err := env.db.SeriesRefsByMedia([]string{rootID})
	if err != nil {
		t.Fatal(err)
	}
	if len(refs[rootID]) != 0 {
		t.Fatalf("库根散片属于未归组，不许塞进任何剧，实际挂在 %+v", refs[rootID])
	}
}

// ③ 幂等：同一批文件连扫两轮，剧数/成员数/position/季集号一字不变。
func TestScanDramaGroupingIsIdempotent(t *testing.T) {
	env := newScanEnv(t)
	env.write(t, "剧A/Season 1/02.mp4", "a2")
	env.write(t, "剧A/Season 1/01.mp4", "a1")
	env.write(t, "剧A/剧集03.mp4", "a3")
	env.write(t, "剧B/第1季/01.mp4", "b1")
	env.write(t, "root.mp4", "r")
	makeDrama(t, env)

	env.run(t)
	before := snapshotMembers(t, env)
	if len(before) != 4 {
		t.Fatalf("前置扫描后应有 4 个剧成员，实际 %d", len(before))
	}

	env.run(t)
	after := snapshotMembers(t, env)
	if len(after) != len(before) {
		t.Fatalf("重扫后成员数变了：%d → %d（重复插入了）", len(before), len(after))
	}
	for key, b := range before {
		a, ok := after[key]
		if !ok {
			t.Fatalf("重扫后成员 %s 不见了", key)
		}
		if a.mediaID != b.mediaID || a.position != b.position ||
			!sameIntPtr(a.season, b.season) || !sameIntPtr(a.episode, b.episode) {
			t.Fatalf("重扫打乱了成员 %s：%+v → %+v", key, b, a)
		}
	}
	if n := seriesCount(t, env); n != 2 {
		t.Fatalf("重扫后剧数 = %d, 期望仍为 2", n)
	}
}

func snapshotMembers(t *testing.T, env *scanEnv) map[string]memberSnap {
	t.Helper()
	list, err := env.db.ListSeries(domain.LibraryScope{All: true})
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]memberSnap{}
	for _, s := range list {
		for path, m := range membersByPath(t, env, s.ID) {
			out[s.ID+"|"+path] = m
		}
	}
	return out
}

// ④ 剧目录改名 = 剧改名：剧数不变、旧剧 dir_path 更新、标题跟着目录名、成员与 media id 不丢。
func TestScanDramaDirRenameRenamesSeries(t *testing.T) {
	env := newScanEnv(t)
	env.write(t, "老剧名/第01集.mp4", "a")
	env.write(t, "老剧名/第02集.mp4", "bb")
	makeDrama(t, env)
	env.run(t)

	old := seriesByDirPath(t, env, filepath.Join(env.root, "老剧名"))
	if old == nil {
		t.Fatal("前置扫描没建出「老剧名」")
	}
	oldMembers := membersByPath(t, env, old.ID)
	if len(oldMembers) != 2 {
		t.Fatalf("前置成员数 = %d, 期望 2", len(oldMembers))
	}

	if err := os.Rename(filepath.Join(env.root, "老剧名"), filepath.Join(env.root, "新剧名")); err != nil {
		t.Fatal(err)
	}
	task := env.run(t)
	if task.Status != domain.TaskSuccess {
		t.Fatalf("状态 = %s (%s)", task.Status, task.Error)
	}

	if n := seriesCount(t, env); n != 1 {
		t.Fatalf("目录改名不该新建成两部剧，实际 %d 部", n)
	}
	renamed := seriesByDirPath(t, env, filepath.Join(env.root, "新剧名"))
	if renamed == nil {
		t.Fatal("改名后没找到「新剧名」")
	}
	if renamed.ID != old.ID {
		t.Fatalf("剧 id 变了（%s → %s）：成员/观看进度会跟着丢", old.ID, renamed.ID)
	}
	if renamed.Title != "新剧名" {
		t.Fatalf("剧名应跟目录名走，实际 %q", renamed.Title)
	}
	now := membersByPath(t, env, old.ID)
	if len(now) != 2 {
		t.Fatalf("改名后成员数 = %d, 期望 2（不许丢成员）", len(now))
	}
	nowByMedia := map[string]memberSnap{}
	for _, m := range now {
		nowByMedia[m.mediaID] = m
		if filepath.Dir(m.path) != filepath.Join(env.root, "新剧名") {
			t.Fatalf("改名的剧成员路径没跟着更新：%s", m.path)
		}
	}
	for _, m := range oldMembers {
		got, ok := nowByMedia[m.mediaID]
		if !ok {
			t.Fatalf("改名后成员 media id %s 丢了", m.mediaID)
		}
		if !sameIntPtr(got.episode, m.episode) {
			t.Fatalf("改名后集号丢了：%s → %s", describeIntPtr(m.episode), describeIntPtr(got.episode))
		}
	}
}

// ⑤ 文件在剧目录之间移动 = 换剧：media id 不变、从旧剧移除、加入新剧。
func TestScanDramaFileMovedBetweenSeriesSwitchesSeries(t *testing.T) {
	env := newScanEnv(t)
	env.write(t, "剧A/a.mp4", "aaa")
	env.write(t, "剧A/b.mp4", "bbb")
	env.write(t, "剧B/c.mp4", "ccc")
	makeDrama(t, env)
	env.run(t)

	sa := seriesByDirPath(t, env, filepath.Join(env.root, "剧A"))
	sb := seriesByDirPath(t, env, filepath.Join(env.root, "剧B"))
	if sa == nil || sb == nil {
		t.Fatal("前置扫描没建出两部剧")
	}
	before := membersByPath(t, env, sa.ID)
	if len(before) != 2 {
		t.Fatalf("剧A 前置成员数 = %d, 期望 2", len(before))
	}
	movedPath := filepath.Join(env.root, "剧A", "a.mp4")
	movedID := before[movedPath].mediaID

	if err := os.Rename(movedPath, filepath.Join(env.root, "剧B", "a.mp4")); err != nil {
		t.Fatal(err)
	}
	env.run(t)

	if n := seriesCount(t, env); n != 2 {
		t.Fatalf("换剧不该新建/丢弃剧，实际 %d 部", n)
	}
	ma := membersByPath(t, env, sa.ID)
	if _, still := ma[movedPath]; still {
		t.Fatal("搬走的文件还留在旧剧里")
	}
	if len(ma) != 1 {
		t.Fatalf("剧A 应只剩 b.mp4，实际 %d 个成员", len(ma))
	}
	for _, m := range ma {
		if m.position != 1 {
			t.Fatalf("移除后 position 应连续（1），实际 %d", m.position)
		}
	}
	newPath := filepath.Join(env.root, "剧B", "a.mp4")
	mb := membersByPath(t, env, sb.ID)
	got, ok := mb[newPath]
	if !ok {
		t.Fatal("搬进来的文件没加进新剧")
	}
	if got.mediaID != movedID {
		t.Fatalf("换剧后 media id 变了（%s → %s）", movedID, got.mediaID)
	}
	if len(mb) != 2 {
		t.Fatalf("剧B 成员数 = %d, 期望 2", len(mb))
	}
}

// 认领：目录导入阶段建的剧按标题建、没记 dir_path（handlers_series_import），
// 重扫时要认领它而不是再建一部重名的。
func TestScanDramaAdoptsTitleSeriesWithoutDirPath(t *testing.T) {
	env := newScanEnv(t)
	env.write(t, "剧A/01.mp4", "a")
	makeDrama(t, env)

	// 模拟目录导入：剧已建（无 dir_path），media 行已登记并挂在剧里。
	ser := &domain.Series{ID: domain.NewID("ser"), Title: "剧A", LibraryID: env.lib.ID}
	if err := env.db.CreateSeries(ser); err != nil {
		t.Fatal(err)
	}
	mediaPath := filepath.Join(env.root, "剧A", "01.mp4")
	m := &domain.Media{ID: domain.NewID("med"), LibraryID: env.lib.ID,
		Path: mediaPath, Title: "01", Size: 1}
	if err := env.db.InsertMedia(m); err != nil {
		t.Fatal(err)
	}
	if _, err := env.db.AddSeriesMedia(ser.ID, []storage.SeriesMediaInput{{
		MediaID: m.ID, Source: domain.EpisodeSourceFilename}}); err != nil {
		t.Fatal(err)
	}

	env.run(t)

	if n := seriesCount(t, env); n != 1 {
		t.Fatalf("同名剧应被认领而不是新建，实际 %d 部", n)
	}
	got := seriesByDirPath(t, env, filepath.Join(env.root, "剧A"))
	if got == nil {
		t.Fatal("认领后剧应带上 dir_path")
	}
	if got.ID != ser.ID {
		t.Fatalf("认领应复用原剧 id：%s → %s", ser.ID, got.ID)
	}
	members := membersByPath(t, env, ser.ID)
	if len(members) != 1 || members[mediaPath].mediaID != m.ID {
		t.Fatalf("认领后成员应保持原样，实际 %+v", members)
	}
	if !sameIntPtr(members[mediaPath].episode, intPtr(1)) {
		t.Fatalf("认领后集号应补齐为 1，实际 %s", describeIntPtr(members[mediaPath].episode))
	}
}

// 软删的媒体不许出现在剧里：归组读的是 live media（归组必须在 reconcile 之后）。
// 读路径（ListSeriesEpisodes / episode_count）对软删行的过滤是既有语义，这条钉住它别被绕开。
func TestScanDramaSoftDeletedMediaLeavesSeries(t *testing.T) {
	env := newScanEnv(t)
	env.write(t, "剧A/a.mp4", "aaa")
	env.write(t, "剧A/b.mp4", "bbb")
	env.write(t, "keep.mp4", "k")
	makeDrama(t, env)
	env.run(t)

	sa := seriesByDirPath(t, env, filepath.Join(env.root, "剧A"))
	if sa == nil {
		t.Fatal("前置扫描没建出「剧A」")
	}
	var victim string
	for _, m := range env.media(t) {
		if m.Path == filepath.Join(env.root, "剧A", "a.mp4") {
			victim = m.ID
		}
	}
	if victim == "" {
		t.Fatal("没找到 a.mp4 的记录")
	}
	if _, err := env.db.SoftDeleteMedia([]string{victim}); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(env.root, "剧A", "a.mp4")); err != nil {
		t.Fatal(err)
	}
	env.run(t)

	members := membersByPath(t, env, sa.ID)
	if len(members) != 1 {
		t.Fatalf("剧A 应只剩 b.mp4，实际 %d 个成员", len(members))
	}
	if _, ok := members[filepath.Join(env.root, "剧A", "b.mp4")]; !ok {
		t.Fatal("活着的成员 b.mp4 不该丢")
	}
	fresh, err := env.db.GetSeries(sa.ID)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.EpisodeCount != 1 {
		t.Fatalf("软删的集不许计数，episode_count = %d, 期望 1", fresh.EpisodeCount)
	}
	// 软删那条不许被归组"复活"成另一个剧的成员
	for _, m := range members {
		if m.mediaID == victim {
			t.Fatal("软删的媒体出现在了剧里")
		}
	}
}
