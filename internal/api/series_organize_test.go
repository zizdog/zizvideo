package api_test

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// C9 门禁：按剧场整理到子目录。
//
// 判据只看**磁盘上的真实位置**：（1）dry run 一个文件都不许动；（2）apply 之后文件真在
// <库根>/<剧场名>/ 里、原位置没有残留、DB 指向跟着走（id 不变）；（3）库根之外的文件绝不动。
// 这条门禁存在的理由：这是会**挪用户文件**的操作，最坏情况是"文件没了但库以为还在"。

type organizeItem struct {
	MediaID string `json:"media_id"`
	Title   string `json:"title"`
	From    string `json:"from"`
	To      string `json:"to"`
	Action  string `json:"action"`
	Moved   bool   `json:"moved"`
	Error   string `json:"error"`
}

type organizeBody struct {
	Applied   bool           `json:"applied"`
	TargetDir string         `json:"target_dir"`
	Moves     int            `json:"moves"`
	Moved     int            `json:"moved"`
	Failed    int            `json:"failed"`
	Items     []organizeItem `json:"items"`
}

func (e *env) organize(seriesID string, apply bool) organizeBody {
	e.t.Helper()
	res, env, raw := e.write(http.MethodPost, "/api/v1/admin/series/"+seriesID+"/organize",
		map[string]any{"apply": apply})
	if res.StatusCode != http.StatusOK {
		e.t.Fatalf("整理失败 %d: %s", res.StatusCode, raw)
	}
	if env.Data == nil {
		e.t.Fatalf("整理响应没有 data（HTTP %d）：%s", res.StatusCode, raw)
	}
	var out organizeBody
	decodeInto(e.t, env.Data, &out)
	return out
}

func TestSeriesOrganizeMovesIntoSubdirAndRepoints(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	lib := e.newLibrary("短剧库", e.Root)
	a := e.newMedia(lib.ID, filepath.Join(e.Root, "我的剧-第01集.mp4"), []byte("aaa"))
	b := e.newMedia(lib.ID, filepath.Join(e.Root, "我的剧-第02集.mp4"), []byte("bbb"))
	series := e.createSeriesIn("我的剧", lib.ID)
	if added, _ := e.addSeriesMediaDetailed(series.ID, a.ID, b.ID); added != 2 {
		t.Fatalf("应该加入 2 集，实际 %d", added)
	}

	wantDir := filepath.Join(e.Root, "我的剧")

	// ① dry run：只给清单，磁盘一个字节都不许变
	plan := e.organize(series.ID, false)
	if plan.Applied {
		t.Fatal("dry run 不该 applied")
	}
	if plan.Moves != 2 || plan.TargetDir != wantDir {
		t.Fatalf("清单不对：moves=%d target=%s", plan.Moves, plan.TargetDir)
	}
	if _, err := os.Stat(a.Path); err != nil {
		t.Fatalf("dry run 把文件动了：%v", err)
	}
	if _, err := os.Stat(wantDir); err == nil {
		t.Fatal("dry run 不该建目录")
	}

	// ② apply：文件真的挪进去了，原位置没残留，DB 指向跟着走
	done := e.organize(series.ID, true)
	if !done.Applied || done.Moved != 2 || done.Failed != 0 {
		t.Fatalf("apply 结果不对：%+v", done)
	}
	for _, m := range []struct{ from, name string }{{a.Path, "我的剧-第01集.mp4"}, {b.Path, "我的剧-第02集.mp4"}} {
		dst := filepath.Join(wantDir, m.name)
		if _, err := os.Stat(dst); err != nil {
			t.Fatalf("目标没有文件 %s: %v", dst, err)
		}
		if _, err := os.Stat(m.from); err == nil {
			t.Fatalf("原位置还有残留：%s", m.from)
		}
	}
	// DB 指向要跟着走（用剧场详情这条对外路径读，顺带证明"还是同一条记录"）
	detail := e.seriesDetail(series.ID)
	seen := map[string]string{}
	for _, item := range detail.List {
		seen[item.Media.ID] = item.Media.Path
	}
	for _, id := range []string{a.ID, b.ID} {
		got := seen[id]
		if got == "" {
			t.Fatalf("剧场详情里找不到这条媒体（不是改名，是记录被换了）：%s", id)
		}
		if filepath.Dir(got) != wantDir {
			t.Fatalf("DB 指向没跟着走：%s", got)
		}
	}

	// ③ 再跑一次：应当全是"已在目标目录"，不移动、不报错
	again := e.organize(series.ID, true)
	if again.Moved != 0 || again.Moves != 0 || again.Failed != 0 {
		t.Fatalf("第二次不该再动：%+v", again)
	}

	// ④ 库根之外的文件绝不动
	outsideLib := e.newLibrary("别的库", filepath.Join(e.Base, "media2"))
	out := e.newMedia(outsideLib.ID, filepath.Join(e.Base, "media2", "外部-第01集.mp4"), []byte("ddd"))
	if added, _ := e.addSeriesMediaDetailed(series.ID, out.ID); added != 1 {
		t.Fatalf("应该加入 1 集，实际 %d", added)
	}
	res2 := e.organize(series.ID, true)
	if res2.Moved != 0 {
		t.Fatalf("库根外的文件被移动了：%+v", res2)
	}
	if _, err := os.Stat(out.Path); err != nil {
		t.Fatalf("库根外的原文件不见了：%v", err)
	}
	found := false
	for _, it := range res2.Items {
		if it.MediaID == out.ID && it.Action == "outside" {
			found = true
		}
	}
	if !found {
		t.Fatalf("库根外的文件应标成 outside：%+v", res2.Items)
	}
}

// 同名集数门禁：同一剧场两集都叫 01.mp4（S01/01.mp4、S02/01.mp4），整理后目标文件名撞车。
//
// 判据：两个文件都必须还在、内容各自正确、两条 DB 记录指向**不同**路径。
// 这条门禁存在的理由：os.Rename 遇到同名目标是静默覆盖 —— 一个视频文件丢掉、
// 两条记录指向同一路径，而接口还报"两条都成功"，用户根本看不出丢了东西。
func TestSeriesOrganizeNeverOverwritesSameNameEpisode(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	lib := e.newLibrary("剧库", e.Root)
	a := e.newMedia(lib.ID, filepath.Join(e.Root, "S01", "01.mp4"), []byte("AAA"))
	b := e.newMedia(lib.ID, filepath.Join(e.Root, "S02", "01.mp4"), []byte("BBB"))
	series := e.createSeriesIn("同名剧", lib.ID)
	if added, _ := e.addSeriesMediaDetailed(series.ID, a.ID, b.ID); added != 2 {
		t.Fatalf("应该加入 2 集，实际 %d", added)
	}

	done := e.organize(series.ID, true)
	if done.Moved != 2 || done.Failed != 0 {
		t.Fatalf("两集都该移动成功：%+v", done)
	}
	wantDir := filepath.Join(e.Root, "同名剧")
	paths := map[string]string{}
	for _, item := range e.seriesDetail(series.ID).List {
		paths[item.Media.ID] = item.Media.Path
	}
	if paths[a.ID] == "" || paths[b.ID] == "" {
		t.Fatalf("剧场详情里缺记录（记录被换了）：%v", paths)
	}
	if paths[a.ID] == paths[b.ID] {
		t.Fatalf("两条记录指向同一路径（有一个文件被覆盖了）：%s", paths[a.ID])
	}
	for _, c := range []struct{ id, want string }{{a.ID, "AAA"}, {b.ID, "BBB"}} {
		got := paths[c.id]
		if filepath.Dir(got) != wantDir {
			t.Fatalf("没整理进目标目录：%s", got)
		}
		raw, err := os.ReadFile(got)
		if err != nil {
			t.Fatalf("文件不在了 %s: %v", got, err)
		}
		if string(raw) != c.want {
			t.Fatalf("文件内容被串了：%s = %q，期望 %q", got, raw, c.want)
		}
	}
	if _, err := os.Stat(a.Path); err == nil {
		t.Fatalf("原位置还有残留：%s", a.Path)
	}
	if _, err := os.Stat(b.Path); err == nil {
		t.Fatalf("原位置还有残留：%s", b.Path)
	}
}
