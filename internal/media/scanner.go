package media

import (
	"context"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/zizdog/zizvideo/internal/config"
	"github.com/zizdog/zizvideo/internal/domain"
	"github.com/zizdog/zizvideo/internal/ffmpeg"
	"github.com/zizdog/zizvideo/internal/storage"
)

// DefaultIgnoreRules always apply on top of a library's own rules.
var DefaultIgnoreRules = []string{
	"@eaDir", "#recycle", ".DS_Store", "lost+found", "*.part", "*.!bt", "~$*",
}

// Scanner walks libraries and keeps the media table in sync.
type Scanner struct {
	Cfg    *config.Config
	DB     *storage.DB
	Roots  *config.Roots
	Runner ffmpeg.Runner
	Log    *slog.Logger
}

// NewScanner wires a Scanner; roots is the live allow-root source of truth.
func NewScanner(cfg *config.Config, db *storage.DB, roots *config.Roots,
	r ffmpeg.Runner, log *slog.Logger) *Scanner {
	return &Scanner{Cfg: cfg, DB: db, Roots: roots, Runner: r, Log: log}
}

type fileEntry struct {
	Path    string
	Size    int64
	MtimeNS int64
}

// Run executes one scan task to completion and records the terminal status.
func (s *Scanner) Run(ctx context.Context, task *domain.ScanTask, lib *domain.Library) {
	res := s.run(ctx, task, lib)
	status := domain.TaskSuccess
	if res.interrupted {
		status = domain.TaskInterrupted
	}
	if err := s.DB.FinishScanTask(task.ID, status, res.errMsg, res.missing, res.suspected, res.renamed); err != nil {
		s.Log.Error("写入任务终态失败", "task_id", task.ID, "library_id", lib.ID, "error", err.Error())
	}
	s.Log.Info("扫描结束", "task_id", task.ID, "library_id", lib.ID, "status", status,
		"total", res.total, "scanned", res.scanned, "failed", res.failed,
		"missing", res.missing, "suspected", res.suspected, "renamed", res.renamed)
}

type scanResult struct {
	total       int
	scanned     int
	failed      int
	missing     int
	suspected   int
	renamed     int
	interrupted bool
	errMsg      string
}

func (s *Scanner) run(ctx context.Context, task *domain.ScanTask, lib *domain.Library) scanResult {
	var res scanResult

	// Re-check the allow list before touching the filesystem: a root that was
	// removed from config must not be walked even if a scan was queued (坑 2).
	if err := ValidateAllowedLibrary(s.Roots.List(), lib.RootPath); err != nil {
		res.interrupted = true
		res.errMsg = "媒体库根路径不在允许根内，已拒绝扫描（未遍历任何目录）"
		return res
	}
	st, err := os.Stat(lib.RootPath)
	if err != nil {
		res.interrupted = true
		res.errMsg = "媒体库根路径不可访问，已中断（不做删除）"
		return res
	}
	dev := deviceID(st)
	if lib.MountID != "" && lib.MountID != dev {
		res.interrupted = true
		res.errMsg = "设备号变化，已中断（不做删除）"
		return res
	}
	if lib.MountID == "" {
		if _, err := s.DB.UpdateLibrary(lib.ID, storage.LibraryPatch{MountID: &dev}); err != nil {
			s.Log.Warn("记录设备号失败", "library_id", lib.ID, "error", err.Error())
		}
	}

	entries, interrupted := s.enumerate(ctx, lib)
	if interrupted {
		res.interrupted = true
		res.errMsg = "扫描过程中根路径不可用或设备变化，已中断（不做删除）"
		return res
	}
	res.total = len(entries)

	states, err := s.DB.MediaStatesByLibrary(lib.ID)
	if err != nil {
		res.interrupted = true
		res.errMsg = "读取现有媒体失败"
		return res
	}

	// 改名/移动识别（用户 2026-09-22 要求）：先于对账做，这样"文件换了名字"不会
	// 变成"新增一行 + 留一条僵尸记录"，观看进度/收藏/剧场成员都跟着旧行保留。
	res.renamed = s.migrateRenamed(lib, entries, states)

	var processed, updated, failed int64
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		s.reportProgress(ctx, task.ID, len(entries), &processed, &updated, &failed, stop)
	}()

	entriesCh := make(chan fileEntry)
	seen := &sync.Map{}
	var workers sync.WaitGroup
	for i := 0; i < s.Cfg.ScanWorkers; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for e := range entriesCh {
				seen.Store(e.Path, true)
				ok := s.processFile(ctx, lib, e, states[e.Path])
				atomic.AddInt64(&processed, 1)
				if ok {
					atomic.AddInt64(&updated, 1)
				} else {
					atomic.AddInt64(&failed, 1)
				}
			}
		}()
	}
	for _, e := range entries {
		select {
		case <-ctx.Done():
			close(entriesCh)
			workers.Wait()
			close(stop)
			wg.Wait()
			res.interrupted = true
			res.errMsg = "服务停止，任务中断"
			return res
		case entriesCh <- e:
		}
	}
	close(entriesCh)
	workers.Wait()
	close(stop)
	wg.Wait()

	res.scanned = int(atomic.LoadInt64(&processed))
	res.failed = int(atomic.LoadInt64(&failed))

	res.missing, res.suspected, _ = s.reconcile(lib, seen)
	return res
}

// enumerate collects media candidates, applying ignore rules and the extension
// whitelist. Symlinks are rejected by default.
func (s *Scanner) enumerate(ctx context.Context, lib *domain.Library) ([]fileEntry, bool) {
	rules := append(append([]string{}, DefaultIgnoreRules...), lib.IgnoreRules...)
	var out []fileEntry
	interrupted := false
	root := lib.RootPath

	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if ctx.Err() != nil {
			return filepath.SkipAll
		}
		if err != nil {
			if path == root {
				interrupted = true
				return filepath.SkipAll
			}
			return nil
		}
		name := d.Name()
		if path != root && ignored(name, rules) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if path != root && !lib.Recursive {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(name))
		if !s.Cfg.ExtAllowed(ext) {
			return nil
		}
		info, ierr := d.Info()
		if ierr != nil {
			return nil
		}
		if _, verr := ValidateMediaFile(s.Roots.List(), root, filepath.Clean(path)); verr != nil {
			s.Log.Warn("跳过错配文件", "library_id", lib.ID, "error", verr.Error())
			return nil
		}
		out = append(out, fileEntry{
			Path:    filepath.Clean(path),
			Size:    info.Size(),
			MtimeNS: info.ModTime().UnixNano(),
		})
		return nil
	})
	if err != nil && ctx.Err() == nil {
		interrupted = true
	}
	return out, interrupted
}

func ignored(name string, rules []string) bool {
	if strings.HasPrefix(name, ".") {
		return true
	}
	for _, r := range rules {
		if r == "" {
			continue
		}
		if name == r {
			return true
		}
		if ok, err := filepath.Match(r, name); err == nil && ok {
			return true
		}
	}
	return false
}

// IgnoredName exposes the ignore-rule match so the event watcher and the
// scanner skip exactly the same directories (不许第二套判据).
func IgnoredName(name string, rules []string) bool { return ignored(name, rules) }

// migrateRenamed 识别"同一个文件换了名字/换了目录"：磁盘上出现一个数据库里没有的新文件，
// 而数据库里恰好有一条"这次没在磁盘上看到"的行，两者 **size+mtime 完全一致** ⇒ 判定为改名，
// 把旧行改指到新路径（保留 id ⇒ 观看进度、收藏、稍后再看、剧场成员全部保留）。
//
// 只在**一对一唯一匹配**时迁移：同一 (size,mtime) 有多条缺行或多个新文件时一律不动。
// 理由：重命名不改变 size/mtime，但复制粘贴可能撞上同样的组合，有歧义就必须"不猜"
// （宁可留一条缺失记录让用户点清理，也不能把 A 的进度接到 B 上）。
// 迁移成功后同步更新 states，processFile 会把它当成"已存在的行"按 size+mtime 跳过重探。
func (s *Scanner) migrateRenamed(lib *domain.Library, entries []fileEntry,
	states map[string]storage.MediaState) int {
	type key struct {
		size    int64
		mtimeNS int64
	}
	onDisk := make(map[string]bool, len(entries))
	for _, e := range entries {
		onDisk[e.Path] = true
	}
	newFiles := map[key][]fileEntry{}
	for _, e := range entries {
		if _, ok := states[e.Path]; ok {
			continue // 数据库里已有这一行，不是新文件
		}
		k := key{e.Size, e.MtimeNS}
		newFiles[k] = append(newFiles[k], e)
	}
	if len(newFiles) == 0 {
		return 0
	}
	missingRows := map[key][]string{}
	for path, st := range states {
		if onDisk[path] {
			continue
		}
		k := key{st.Size, st.MtimeNS}
		missingRows[k] = append(missingRows[k], path)
	}

	migrated := 0
	for k, files := range newFiles {
		olds := missingRows[k]
		if len(files) != 1 || len(olds) != 1 {
			continue // 有歧义：不动，交给"缺失 + 清理"那条路
		}
		oldPath, entry := olds[0], files[0]
		st := states[oldPath]
		title := strings.TrimSuffix(filepath.Base(entry.Path), filepath.Ext(entry.Path))
		if err := s.DB.RepointMediaPath(st.ID, entry.Path, title); err != nil {
			s.Log.Warn("改名迁移失败", "library_id", lib.ID, "media_id", st.ID, "error", err.Error())
			continue
		}
		delete(states, oldPath)
		states[entry.Path] = st
		migrated++
		s.Log.Info("识别到改名/移动", "library_id", lib.ID, "media_id", st.ID,
			"from", oldPath, "to", entry.Path)
	}
	return migrated
}

// processFile probes one file (with backoff retries) and upserts its row.
func (s *Scanner) processFile(ctx context.Context, lib *domain.Library, e fileEntry, prev storage.MediaState) bool {
	if prev.ID != "" && prev.Size == e.Size && prev.MtimeNS == e.MtimeNS && prev.Status != domain.MediaProbeFail {
		return true
	}
	id := prev.ID
	if id == "" {
		id = domain.NewID("med")
	}
	title := strings.TrimSuffix(filepath.Base(e.Path), filepath.Ext(e.Path))

	probe, perr := s.probeWithRetry(ctx, e.Path)
	if perr != nil {
		class := domain.ClassInvalidFormat
		var pe *ffmpeg.ProbeError
		if ok := asProbeError(perr, &pe); ok {
			class = pe.Class
		}
		m := &domain.Media{ID: id, LibraryID: lib.ID, Path: e.Path, Title: title,
			Size: e.Size, MtimeNS: e.MtimeNS}
		if prev.ID == "" {
			m.Status = domain.MediaProbeFail
			m.ErrorClass = class
			m.ErrorMessage = "探测失败"
			if err := s.DB.InsertMedia(m); err != nil {
				s.Log.Error("写入失败记录出错", "library_id", lib.ID, "error", err.Error())
			}
		} else if err := s.DB.MarkProbeFailed(id, class, "探测失败", 1); err != nil {
			s.Log.Error("标记探测失败出错", "library_id", lib.ID, "error", err.Error())
		}
		s.Log.Warn("探测失败", "library_id", lib.ID, "media_id", id, "class", class)
		return false
	}

	cover := filepath.Join(s.Cfg.CoversDir(), id+".jpg")
	if err := os.MkdirAll(filepath.Dir(cover), 0o700); err != nil {
		s.Log.Warn("创建封面目录失败", "error", err.Error())
	}
	if err := ffmpeg.ExtractCover(ctx, s.Runner, s.Cfg.FFmpegBin, e.Path, cover,
		ffmpeg.CoverTime(probe.DurationMS), s.Cfg.CoverQuality, s.Cfg.ProbeTimeout()); err != nil {
		// Probe data is still valid; /cover falls back to a placeholder.
		s.Log.Warn("封面抽取失败", "library_id", lib.ID, "media_id", id)
	}

	m := &domain.Media{
		ID: id, LibraryID: lib.ID, Path: e.Path, Title: title,
		Size: e.Size, MtimeNS: e.MtimeNS, Container: probe.Container,
		Codecs: domain.Codecs{Video: probe.VideoCodec, Audio: probe.AudioCodec},
		Width:  probe.Width, Height: probe.Height, DurationMS: probe.DurationMS,
		Bitrate: probe.Bitrate, FPS: probe.FPS, Status: domain.MediaReady,
	}
	var err error
	if prev.ID == "" {
		err = s.DB.InsertMedia(m)
	} else {
		err = s.DB.UpdateMediaProbe(m)
	}
	if err != nil {
		s.Log.Error("写入媒体失败", "library_id", lib.ID, "media_id", id, "error", err.Error())
		return false
	}
	return true
}

func (s *Scanner) probeWithRetry(ctx context.Context, path string) (*ffmpeg.ProbeResult, error) {
	backoffs := s.Cfg.ScanRetryBackoffMS
	attempts := len(backoffs) + 1
	var lastErr error
	for i := 0; i < attempts; i++ {
		res, err := ffmpeg.Probe(ctx, s.Runner, s.Cfg.FFprobeBin, path, s.Cfg.ProbeTimeout())
		if err == nil {
			return res, nil
		}
		lastErr = err
		var pe *ffmpeg.ProbeError
		if asProbeError(err, &pe) && pe.Class == domain.ClassNotFound {
			break // retrying a vanished file is pointless
		}
		if i < attempts-1 {
			select {
			case <-ctx.Done():
				return nil, lastErr
			case <-time.After(time.Duration(backoffs[i]) * time.Millisecond):
			}
		}
	}
	return nil, lastErr
}

func asProbeError(err error, target **ffmpeg.ProbeError) bool {
	for err != nil {
		if pe, ok := err.(*ffmpeg.ProbeError); ok {
			*target = pe
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}

// reconcile is the two-phase deletion step: first sighting only marks a row as
// missing, and deletion needs a second, threshold-bounded confirmation.
func (s *Scanner) reconcile(lib *domain.Library, seen *sync.Map) (missing, suspected, deleted int) {
	byPath, missingSince, err := s.DB.MediaIDsByLibrary(lib.ID)
	if err != nil {
		s.Log.Error("读取媒体清单失败", "library_id", lib.ID, "error", err.Error())
		return 0, 0, 0
	}
	live := len(byPath)
	now := domain.NowString()
	var toDelete []string
	for path, id := range byPath {
		if _, ok := seen.Load(path); ok {
			if missingSince[id] != "" {
				_ = s.DB.ClearMissing(id)
			}
			continue
		}
		missing++
		if missingSince[id] == "" {
			_ = s.DB.MarkMissing(id, now)
			continue
		}
		toDelete = append(toDelete, id)
	}
	if missing == 0 {
		return 0, 0, 0
	}
	if overThreshold(missing, live, s.Cfg.ScanDeleteRatio, s.Cfg.ScanDeleteCount) {
		s.Log.Warn("疑似丢失，超过阈值不软删", "library_id", lib.ID, "missing", missing, "live", live)
		return missing, missing, 0
	}
	if err := s.DB.ApplyDeletions(toDelete); err != nil {
		s.Log.Error("软删除失败", "library_id", lib.ID, "error", err.Error())
		return missing, missing, 0
	}
	// Deleted rows are no longer "missing"; report only what is still absent.
	return missing - len(toDelete), 0, len(toDelete)
}

func overThreshold(missing, live int, ratio float64, count int) bool {
	if missing > count {
		return true
	}
	if live > 0 && ratio > 0 && float64(missing)/float64(live) > ratio {
		return true
	}
	return false
}

// reportProgress writes counters to the DB at most once per second.
func (s *Scanner) reportProgress(ctx context.Context, taskID string, total int,
	processed, updated, failed *int64, stop <-chan struct{}) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			_ = s.DB.UpdateScanTaskProgress(taskID, total,
				int(atomic.LoadInt64(processed)), int(atomic.LoadInt64(updated)), int(atomic.LoadInt64(failed)))
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			_ = s.DB.UpdateScanTaskProgress(taskID, total,
				int(atomic.LoadInt64(processed)), int(atomic.LoadInt64(updated)), int(atomic.LoadInt64(failed)))
		}
	}
}

func deviceID(st os.FileInfo) string {
	if sys, ok := st.Sys().(*syscall.Stat_t); ok {
		return strconvFormatUint(uint64(sys.Dev))
	}
	return ""
}

func strconvFormatUint(v uint64) string {
	if v == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	return string(buf[i:])
}
