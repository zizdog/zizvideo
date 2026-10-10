package api

import (
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/zizdog/zizvideo/internal/domain"
	"github.com/zizdog/zizvideo/internal/media"
)

// C9：把剧场各集的文件整理进库内子目录 <库根>/<剧场名>/。
//
// 规矩（都是踩过坑之后的结论）：
//   - **先给清单再动手**：默认 dry run，界面把"要移动哪个文件、落到哪"摆出来，确认后才真移；
//   - 只动**库根之内**的文件（ValidateMediaFile 同一套判据），库根外的原样不动；
//   - **绝不覆盖**：目标名冲突（同一剧场两集都叫 01.mp4、目标目录里已有同名文件）就加序号避让，
//     计划阶段算一遍、执行前再算一遍（dry run 与 apply 之间文件可能变）；覆盖 = 丢一个视频文件；
//   - 同一卷直接 rename（快、原子）；跨卷才复制 + 回读大小一致 + 删源，任何一步失败都保留原文件；
//   - 移完先 os.Stat 回读新路径，**确认文件真在那儿**才改数据库指向（RepointMediaPath 保留 id，
//     所以进度/收藏/剧场关系都跟着走）。

type organizeReq struct {
	Apply bool `json:"apply"`
}

// organizeItem 是清单/结果里的一行。
type organizeItem struct {
	MediaID string `json:"media_id"`
	Title   string `json:"title"`
	From    string `json:"from"`
	To      string `json:"to"`
	// Action：move（会移动）/ keep（已在目标目录）/ missing（文件不在）/ outside（不在库根内，不动）
	Action string `json:"action"`
	Moved  bool   `json:"moved,omitempty"`
	Error  string `json:"error,omitempty"`
	// want 是"按集名算出来的原始目标名"，只给执行阶段重算用，不进接口
	// （it.To 可能已经被避让加过序号，必须从原始名再算一次，否则会越加越长）。
	want string
}

// safeSegment 把剧场名变成安全的目录名：去掉路径分隔符和容易出事的字符，
// 全是空白/点就退回 "剧场"（绝不生成会跑到上一级去的名字）。
func safeSegment(name string) string {
	replacer := strings.NewReplacer("/", "_", "\\", "_", ":", "：", "\x00", "", "\n", " ", "\r", " ")
	out := strings.TrimSpace(replacer.Replace(name))
	out = strings.Trim(out, ".")
	out = strings.TrimSpace(out)
	if out == "" {
		return "剧场"
	}
	if len(out) > 80 {
		out = strings.TrimSpace(out[:80])
	}
	return out
}

// reservePath 返回本次整理真正可用的目标名，并把它记进 used（本次已经排给谁了）。
//
// 两个坑一起堵（否则 os.Rename 会**静默覆盖**，一个视频文件就这么没了）：
//   - 磁盘上已经有同名文件（库里有旧文件、或两次整理之间别人落了文件）⇒ 退到 name (2).mp4；
//   - 本次计划/执行里已经排给别的集数（同一剧场两集都叫 01.mp4 就是这样）⇒ 同样要退号。
//
// 它在"移动之前"被调用，所以这个 os.Stat 同时就是移动前的存在性复核。
func reservePath(path string, used map[string]bool) string {
	ext := filepath.Ext(path)
	base := strings.TrimSuffix(path, ext)
	for i := 1; i < 1000; i++ {
		cand := path
		if i > 1 {
			cand = base + " (" + itoa(i) + ")" + ext
		}
		if used[cand] {
			continue
		}
		if _, err := os.Stat(cand); err == nil {
			continue
		}
		used[cand] = true
		return cand
	}
	cand := base + " (" + domain.NewID("x") + ")" + ext
	used[cand] = true
	return cand
}

func itoa(n int) string { return strconv.Itoa(n) }

// isCrossDevice：rename 失败是不是"跨卷"（同一份代码在别的文件系统上就会走复制路径）。
func isCrossDevice(err error) bool {
	return errors.Is(err, syscall.EXDEV)
}

// HandleOrganizeSeries 计算（并在 apply=true 时执行）"按剧场整理到子目录"。
func (s *Server) HandleOrganizeSeries(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req organizeReq
	if err := s.decodeJSON(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	series, err := s.DB.GetSeries(id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if strings.TrimSpace(series.LibraryID) == "" {
		s.fail(w, r, domain.New("SERIES_NO_LIBRARY", "这个剧场没挂在媒体库上，没法整理目录", 400))
		return
	}
	lib, err := s.DB.GetLibrary(series.LibraryID)
	if err != nil {
		s.fail(w, r, domain.New("SERIES_NO_LIBRARY", "剧场所属的媒体库不存在了", 400))
		return
	}
	_, medias, err := s.DB.ListSeriesEpisodes(scopeAll(), id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	targetDir := filepath.Join(lib.RootPath, safeSegment(series.Title))
	items := make([]organizeItem, 0, len(medias))
	plan := make([]organizeItem, 0, len(medias))
	// planned 记住本次清单里已经排出去的目标名：同一剧场两集同名时，第二个从这里退号。
	planned := map[string]bool{}
	for i := range medias {
		m := medias[i]
		it := organizeItem{MediaID: m.ID, Title: m.Title, From: m.Path}
		switch {
		case m.Path == "":
			it.Action = "missing"
		case validateInside(s.Roots.List(), lib.RootPath, m.Path) != nil:
			// 库根之外（比如剧场引用了别的库的文件）：不动，如实标出来
			it.Action = "outside"
		default:
			if _, err := os.Stat(m.Path); err != nil {
				it.Action = "missing"
				break
			}
			want := filepath.Join(targetDir, filepath.Base(m.Path))
			if filepath.Clean(want) == filepath.Clean(m.Path) {
				it.Action = "keep"
				it.To = m.Path
				break
			}
			it.want = want
			it.To = reservePath(want, planned)
			it.Action = "move"
			plan = append(plan, it)
		}
		items = append(items, it)
	}

	moves := len(plan)
	if !req.Apply {
		respond(w, http.StatusOK, map[string]any{
			"applied": false, "target_dir": targetDir, "moves": moves, "items": items,
		}, nil)
		return
	}
	if moves == 0 {
		respond(w, http.StatusOK, map[string]any{
			"applied": true, "target_dir": targetDir, "moves": 0, "moved": 0, "failed": 0, "items": items,
		}, nil)
		return
	}
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		s.fail(w, r, domain.New("ORGANIZE_MKDIR", "建目录失败："+err.Error(), 500))
		return
	}
	moved, failed := 0, 0
	// used 是"这次执行已经用掉的目标名"：dry run 与 apply 是两个请求，中间可能有别的整理/上传
	// 落了同名文件，所以每条 move 之前都要重算一次目标名（reservePath 里顺带做存在性复核）。
	used := map[string]bool{}
	for i := range items {
		it := &items[i]
		if it.Action != "move" {
			continue
		}
		want := it.want
		if want == "" {
			want = it.To
		}
		it.To = reservePath(want, used)
		if _, err := os.Stat(it.From); err != nil {
			// 计划之后源文件没了：如实报，不静默跳过（否则用户以为整理成功了）
			it.Error = "原文件不在了：" + err.Error()
			failed++
			s.Log.Warn("整理剧场目录失败", "media", it.MediaID, "from", it.From, "error", it.Error)
			continue
		}
		if err := s.moveMediaFile(it.From, it.To); err != nil {
			it.Error = err.Error()
			it.Moved = false
			failed++
			s.Log.Warn("整理剧场目录失败", "media", it.MediaID, "from", it.From, "to", it.To,
				"error", err.Error())
			continue
		}
		// 回读确认 + 改指向：读不到就报错（宁可文件在新位置、库指向旧的被扫描修正，也不谎报成功）
		if _, err := os.Stat(it.To); err != nil {
			it.Error = "移动后回读失败：" + err.Error()
			failed++
			continue
		}
		if err := s.DB.RepointMediaPath(it.MediaID, it.To, it.Title); err != nil {
			it.Error = "文件已移动，但数据库指向更新失败：" + err.Error()
			failed++
			continue
		}
		it.Moved = true
		moved++
	}
	s.audit(r, "series.organize", "series:"+series.ID, true, itoa(moved)+" moved")
	respond(w, http.StatusOK, map[string]any{
		"applied": true, "target_dir": targetDir, "moves": moves, "moved": moved, "failed": failed,
		"items": items,
	}, nil)
}

// validateInside 用与扫描/播放同一套判据确认文件在库根之内（库根外的绝不动）。
func validateInside(allowRoots []string, libraryRoot, path string) error {
	_, err := media.ValidateMediaFile(allowRoots, libraryRoot, path)
	return err
}

// moveMediaFile 同卷 rename；跨卷（EXDEV）退回"复制 + 回读大小 + 删源"。
// 失败时保证**原文件还在**（复制中途失败会删掉半个目标文件）。
func (s *Server) moveMediaFile(from, to string) error {
	err := os.Rename(from, to)
	if err == nil {
		return nil
	}
	if !isCrossDevice(err) {
		// 不是跨卷的失败（权限/目标被占）：如实返回，不盲目复制
		return err
	}
	src, err := os.Open(from)
	if err != nil {
		return err
	}
	defer src.Close()
	// O_EXCL：跨卷这条路径也不许盖掉同名文件（目标名刚复核过，真撞上就如实报错，别覆盖）
	dst, err := os.OpenFile(to, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		_ = dst.Close()
		_ = os.Remove(to)
		return err
	}
	if err := dst.Close(); err != nil {
		_ = os.Remove(to)
		return err
	}
	stFrom, err1 := os.Stat(from)
	stTo, err2 := os.Stat(to)
	if err1 != nil || err2 != nil || stFrom.Size() != stTo.Size() {
		_ = os.Remove(to)
		return errors.New("跨卷复制后大小不一致，已放弃并保留原文件")
	}
	if err := os.Remove(from); err != nil {
		return err
	}
	return nil
}
