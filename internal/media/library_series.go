package media

// 短剧库（kind=drama）的归组：**目录结构 = 剧集结构**（设计 §3，用户 2026-10-10 拍板）。
//
//	库根/剧目录/Season 1/第01集.mp4  ⇒ 剧「剧目录」第 1 季第 1 集
//	库根/剧目录/散片.mp4             ⇒ 剧「剧目录」季号未知的一集（季号留空，不猜）
//	库根/散片.mp4                    ⇒ 未归组：不建剧、不塞进任何剧（后台短剧管理单列）
//
// 只在对账（reconcile）之后调用：这里读到的每一行都来自 live media（deleted_at IS NULL），
// 软删的媒体绝不会进剧。归组是**幂等**的：已在剧里的成员一律跳过（AddSeriesMedia 只新增），
// 所以重复扫描既不重复插入、也不打乱已有 position。
//
// short 库（含 kind 为空的旧数据）根本不调用这里 —— 行为与今天完全一样。

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/zizdog/zizvideo/internal/domain"
	"github.com/zizdog/zizvideo/internal/storage"
)

// 季目录名（只认这些形态，认不出就"季号未知"，绝不猜）：
//
//	S01 / s1 / S 01 / Season 1 / season.01 / 第1季 / 第一季 / 第 1 季
var (
	reSeasonShort   = regexp.MustCompile(`(?i)^s\s*(\d{1,2})$`)
	reSeasonWord    = regexp.MustCompile(`(?i)^season[\s._-]*(\d{1,2})$`)
	reSeasonChinese = regexp.MustCompile(`^第\s*([0-9零一二三四五六七八九十百两\s]{1,8})\s*[季部]$`)
)

// seasonDirNumber 从季目录名取季号；不是季目录就 ok=false。
func seasonDirNumber(name string) (int, bool) {
	if m := reSeasonShort.FindStringSubmatch(name); m != nil {
		if n, err := strconv.Atoi(m[1]); err == nil {
			return n, true
		}
	}
	if m := reSeasonWord.FindStringSubmatch(name); m != nil {
		if n, err := strconv.Atoi(m[1]); err == nil {
			return n, true
		}
	}
	if m := reSeasonChinese.FindStringSubmatch(name); m != nil {
		// 复用文件名识别里的中文数字解析（第一季 / 第十二季）。
		if n, ok := parseNumberToken(m[1]); ok {
			return n, true
		}
	}
	return 0, false
}

type seriesMember struct {
	mediaID string
	path    string
	season  *int
	episode *int
}

type seriesGroup struct {
	dir     string // 剧目录（绝对、Clean）
	title   string // 剧名 = 目录名
	members []seriesMember
}

type seriesGroupStats struct {
	created   int // 新建的剧
	renamed   int // 识别为"剧目录改名"的剧
	adopted   int // 认领的剧（目录导入建过、没记 dir_path）
	reused    int // 按 dir_path 直接复用的剧
	added     int // 新增的剧集成员
	moved     int // 换剧：从旧剧移除的成员
	ungrouped int // 库根散片（未归组）
}

func (st seriesGroupStats) changed() bool {
	return st.created+st.renamed+st.adopted+st.added+st.moved > 0
}

// groupSeries 归组一次；任何一步出错都只记日志（归组是派生视图，下一轮扫描会修），
// 不让整次扫描任务失败 —— 扫描的职责是媒体表同步，剧集归属是它的后续步骤。
func (s *Scanner) groupSeries(ctx context.Context, lib *domain.Library) seriesGroupStats {
	var st seriesGroupStats
	byPath, _, err := s.DB.MediaIDsByLibrary(lib.ID)
	if err != nil {
		s.Log.Warn("短剧归组：读取库内媒体失败", "library_id", lib.ID, "error", err.Error())
		return st
	}
	root := filepath.Clean(lib.RootPath)
	index := map[string]*seriesGroup{}
	ids := make([]string, 0, len(byPath))
	for path, id := range byPath {
		ids = append(ids, id)
		rel, rerr := filepath.Rel(root, path)
		if rerr != nil || rel == "." || strings.HasPrefix(rel, "..") {
			continue
		}
		parts := splitRelPath(rel)
		if len(parts) < 2 {
			st.ungrouped++
			continue // 库根直接放的文件 = 未归组（不建剧、不塞进任何剧）
		}
		dir := filepath.Join(root, parts[0])
		g := index[dir]
		if g == nil {
			g = &seriesGroup{dir: dir, title: parts[0]}
			index[dir] = g
		}
		season, episode := memberNumbers(path, parts)
		g.members = append(g.members, seriesMember{mediaID: id, path: path, season: season, episode: episode})
	}
	if len(index) == 0 {
		return st
	}
	// 剧目录顺序稳定，写库顺序就可复现（position 也跟着稳定）。
	dirs := make([]string, 0, len(index))
	for dir := range index {
		dirs = append(dirs, dir)
	}
	sort.Strings(dirs)

	refs, err := s.DB.SeriesRefsByMedia(ids)
	if err != nil {
		s.Log.Warn("短剧归组：读取现有归属失败", "library_id", lib.ID, "error", err.Error())
		return st
	}

	for _, dir := range dirs {
		if ctx.Err() != nil {
			return st
		}
		g := index[dir]
		seriesID, action := s.resolveSeries(lib, g, refs)
		if seriesID == "" {
			continue
		}
		switch action {
		case "created":
			st.created++
		case "renamed":
			st.renamed++
		case "adopted":
			st.adopted++
		default:
			st.reused++
		}
		added, moved := s.syncGroupMembers(lib, g, seriesID, refs)
		st.added += added
		st.moved += moved
	}
	if st.changed() {
		s.Log.Info("短剧归组完成", "library_id", lib.ID,
			"series_created", st.created, "series_reused", st.reused,
			"series_renamed", st.renamed, "series_adopted", st.adopted,
			"episodes_added", st.added, "episodes_moved", st.moved, "ungrouped", st.ungrouped)
	}
	return st
}

// memberNumbers 给出一个成员该写的 (season, episode)：
//   - 季目录给出季号（设计 §3.2，目录结构比文件名更硬）；
//   - 集号仍由文件名识别（detect.EpisodesFor 就是 media.ParseEpisode，
//     detect 依赖本包，只能在这里直接调同一个内核），识别不到就留空，绝不猜。
func memberNumbers(path string, parts []string) (*int, *int) {
	var season, episode *int
	if numbers, ok := ParseEpisode(path); ok {
		season, episode = EpisodePointers(numbers)
	}
	if len(parts) >= 3 {
		if n, ok := seasonDirNumber(parts[1]); ok {
			season = &n
		}
	}
	return season, episode
}

func splitRelPath(rel string) []string {
	return strings.Split(rel, string(filepath.Separator))
}

// resolveSeries 决定这一组媒体归哪部剧：dir_path 匹配 → 改名识别 → 认领同名剧 → 新建。
func (s *Scanner) resolveSeries(lib *domain.Library, g *seriesGroup,
	refs map[string][]storage.SeriesRef) (string, string) {
	cur, err := s.DB.SeriesByDirPath(lib.ID, g.dir)
	if err != nil {
		s.Log.Warn("短剧归组：按目录查剧失败", "library_id", lib.ID, "dir", g.dir, "error", err.Error())
		return "", ""
	}
	if cur != nil {
		if filepath.Clean(cur.DirPath) != g.dir {
			// 只是拼写差异（末尾斜杠之类）：归一，别当成改名（标题不动）。
			if err := s.DB.SetSeriesDir(cur.ID, g.dir); err != nil {
				s.Log.Warn("短剧归组：归一 dir_path 失败", "series_id", cur.ID, "error", err.Error())
			}
		}
		return cur.ID, "reused"
	}
	if old := s.renamedSeries(lib, g, refs); old != nil {
		if err := s.DB.RenameSeriesDir(old.ID, g.dir, g.title); err != nil {
			s.Log.Warn("短剧归组：目录改名落库失败", "series_id", old.ID, "error", err.Error())
			return "", ""
		}
		s.Log.Info("短剧归组：识别到剧目录改名（剧 id 不变）", "library_id", lib.ID,
			"series_id", old.ID, "from", old.DirPath, "to", g.dir, "title", g.title)
		return old.ID, "renamed"
	}
	if id := s.adoptSeriesByTitle(lib, g); id != "" {
		return id, "adopted"
	}
	ser := &domain.Series{ID: domain.NewID("ser"), Title: g.title, LibraryID: lib.ID, DirPath: g.dir}
	if err := s.DB.CreateSeries(ser); err != nil {
		s.Log.Warn("短剧归组：建剧失败", "library_id", lib.ID, "dir", g.dir, "error", err.Error())
		return "", ""
	}
	s.Log.Info("短剧归组：新建剧", "library_id", lib.ID, "series_id", ser.ID,
		"title", g.title, "dir", g.dir, "members", len(g.members))
	return ser.ID, "created"
}

// renamedSeries 判"**剧目录改名 = 剧改名**"（设计 §3）：
// 这一组的媒体当前都属于同一部剧、而且它们就是那部剧的**全部**活成员，那部剧的目录又已经
// 不在磁盘上 ⇒ 是目录换了名字：改它的 dir_path/标题，而不是新建一部剧（成员、观看进度、
// 收藏都留在原 id 上）。有多个候选就返回 nil —— 有歧义不猜。
func (s *Scanner) renamedSeries(lib *domain.Library, g *seriesGroup,
	refs map[string][]storage.SeriesRef) *domain.Series {
	inGroup := map[string]bool{}
	for _, m := range g.members {
		inGroup[m.mediaID] = true
	}
	cand := map[string]bool{}
	for _, m := range g.members {
		for _, r := range refs[m.mediaID] {
			cand[r.ID] = true
		}
	}
	var found *domain.Series
	for id := range cand {
		ser, err := s.DB.GetSeries(id)
		if err != nil || ser == nil {
			continue
		}
		if ser.DirPath == "" || filepath.Clean(ser.DirPath) == g.dir {
			continue
		}
		if ser.LibraryID != "" && ser.LibraryID != lib.ID {
			continue // 别的库的剧：不动
		}
		if _, serr := os.Stat(ser.DirPath); serr == nil {
			continue // 旧目录还在磁盘上 ⇒ 是"搬文件"，不是"改目录名"
		}
		members, merr := s.DB.LiveSeriesMemberIDs(id)
		if merr != nil || len(members) == 0 {
			continue
		}
		all := true
		for _, mid := range members {
			if !inGroup[mid] {
				all = false
				break
			}
		}
		if !all {
			continue // 这部剧还有成员在别处 ⇒ 不是整体改名
		}
		if found != nil {
			return nil // 多个候选：不猜
		}
		found = ser
	}
	return found
}

// adoptSeriesByTitle 认领"目录导入阶段建的剧"：那批剧按目录名建、当时没记 dir_path
// （handlers_series_import 只写 title/library_id），重扫时按 dir_path 匹配不到，
// 若不认领就会给同一部剧再建一个重名的。只认领**成员全在这一组里**的同名剧（没有成员也行）。
func (s *Scanner) adoptSeriesByTitle(lib *domain.Library, g *seriesGroup) string {
	rows, err := s.DB.SeriesByTitleInLibrary(lib.ID, g.title)
	if err != nil {
		s.Log.Warn("短剧归组：按标题查剧失败", "library_id", lib.ID, "title", g.title, "error", err.Error())
		return ""
	}
	inGroup := map[string]bool{}
	for _, m := range g.members {
		inGroup[m.mediaID] = true
	}
	for _, ser := range rows {
		if ser.DirPath != "" {
			continue
		}
		members, merr := s.DB.LiveSeriesMemberIDs(ser.ID)
		if merr != nil {
			continue
		}
		ok := true
		for _, mid := range members {
			if !inGroup[mid] {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		if err := s.DB.SetSeriesDir(ser.ID, g.dir); err != nil {
			s.Log.Warn("短剧归组：认领同名剧失败", "series_id", ser.ID, "error", err.Error())
			return ""
		}
		s.Log.Info("短剧归组：认领同名剧（原先没记目录）", "library_id", lib.ID,
			"series_id", ser.ID, "title", ser.Title, "dir", g.dir)
		return ser.ID
	}
	return ""
}

// syncGroupMembers 把这一组媒体对齐到目标剧：
//   - 还挂在**别的剧**上的成员：从旧剧移除（文件在剧目录之间移动 = 换剧，media id 不变）；
//   - 不在剧里的成员：追加（季/集号按目录结构 + 文件名识别）；
//   - 已有成员的季/集号：按目录结构补写（ApplySeriesEpisodes 的 SQL 门禁保证 manual 永不覆盖）。
func (s *Scanner) syncGroupMembers(lib *domain.Library, g *seriesGroup, seriesID string,
	refs map[string][]storage.SeriesRef) (added, moved int) {
	inGroup := map[string]bool{}
	for _, m := range g.members {
		inGroup[m.mediaID] = true
	}
	// 换剧：只动本库（或还没记库）的剧，别去删别的库里同名剧的成员关系。
	for mediaID, rs := range refs {
		if !inGroup[mediaID] {
			continue
		}
		for _, r := range rs {
			if r.ID == seriesID {
				continue
			}
			ser, err := s.DB.GetSeries(r.ID)
			if err != nil || ser == nil {
				continue
			}
			if ser.LibraryID != "" && ser.LibraryID != lib.ID {
				continue
			}
			n, err := s.DB.RemoveSeriesMediaIDs(r.ID, []string{mediaID})
			if err != nil {
				s.Log.Warn("短剧归组：换剧移除失败", "series_id", r.ID,
					"media_id", mediaID, "error", err.Error())
				continue
			}
			if n > 0 {
				moved += n
				s.Log.Info("短剧归组：换剧（从旧剧移除）", "library_id", lib.ID,
					"from_series", r.ID, "to_series", seriesID, "media_id", mediaID)
			}
		}
	}

	existing := map[string]bool{}
	cur, err := s.DB.LiveSeriesMemberIDs(seriesID)
	if err != nil {
		s.Log.Warn("短剧归组：读取剧成员失败", "series_id", seriesID, "error", err.Error())
		return added, moved
	}
	for _, id := range cur {
		existing[id] = true
	}
	pending := make([]seriesMember, 0, len(g.members))
	for _, m := range g.members {
		if !existing[m.mediaID] {
			pending = append(pending, m)
		}
	}
	if len(pending) > 0 {
		inputs := make([]storage.SeriesMediaInput, 0, len(pending))
		for _, m := range sortMembers(pending) {
			inputs = append(inputs, storage.SeriesMediaInput{
				MediaID: m.mediaID, Season: m.season, Episode: m.episode,
				Source: domain.EpisodeSourceFilename,
			})
		}
		ids, err := s.DB.AddSeriesMedia(seriesID, inputs)
		if err != nil {
			s.Log.Warn("短剧归组：追加成员失败", "series_id", seriesID, "error", err.Error())
		} else {
			added = len(ids)
		}
	}

	// 季号来自目录名、集号来自文件名：把结果补写到已有成员上（manual 的成员 SQL 层面就跳过）。
	assigns := make([]storage.EpisodeAssignment, 0, len(g.members))
	for _, m := range g.members {
		assigns = append(assigns, storage.EpisodeAssignment{
			MediaID: m.mediaID, Season: m.season, Episode: m.episode,
			Source: domain.EpisodeSourceFilename,
		})
	}
	if _, err := s.DB.ApplySeriesEpisodes(seriesID, assigns); err != nil {
		s.Log.Warn("短剧归组：补写季/集号失败", "series_id", seriesID, "error", err.Error())
	}
	return added, moved
}

// sortMembers 按播放顺序（season→episode→文件名自然序，未识别末尾）排成员，
// 让首次写入的 position 就稳定可复现 —— 与 detect/目录导入用的是同一个排序内核。
func sortMembers(members []seriesMember) []seriesMember {
	keys := make([]OrderKey, len(members))
	for i, m := range members {
		keys[i] = OrderKey{Season: m.season, Episode: m.episode, Name: filepath.Base(m.path)}
	}
	order := SortOrderKeys(keys)
	out := make([]seriesMember, 0, len(members))
	for _, idx := range order {
		out = append(out, members[idx])
	}
	return out
}
