// Package transcode 是 P1 的转码队列：兼容优先地把库里的视频转成 H.264/AAC + 720p 上限。
//
// 三条纪律（docs/上传设计.md 七）：
//  1. **失败不许毁原件**：输出先写同目录的临时文件，成功才原子改名；失败删临时文件，media 保持原样可播。
//  2. **已兼容的不重编**：h264 + aac + ≤720p 只做容器/快速起播整理（-c copy），几秒钟的事。
//  3. **进度如实**：解析 ffmpeg -progress 的 out_time_us，按真实时长算百分比；算不出来就报 0，不编。
package transcode

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zizdog/zizvideo/internal/config"
	"github.com/zizdog/zizvideo/internal/domain"
	"github.com/zizdog/zizvideo/internal/ffmpeg"
	"github.com/zizdog/zizvideo/internal/media"
	"github.com/zizdog/zizvideo/internal/storage"
)

// 720p 上限：短剧/短视频在手机上看够用，再高只是浪费带宽与解码。
const maxHeight = 720

// tempSuffix 是同目录临时产物：扩展名不在允许列表里，扫描器不会把它当成一条媒体；
// 同目录 ⇒ 成功时 os.Rename 是原子的（跨卷复制会有"半成品被看到"的窗口）。
const tempSuffix = ".zvtranscode"

// Options 是给 BuildPlan 的输入（都能从已探测的 media 行拿到）。
type Options struct {
	In         string
	Out        string
	VideoCodec string
	AudioCodec string
	Height     int
	DurationMS int64
	// VideoToolbox：本机 ffmpeg 有 h264_videotoolbox（Mac 上硬件编码，快很多）。
	VideoToolbox bool
}

// Plan 是一次转码的完整决策：命令行 + 一句人话说明（写进 transcode_note，界面直接显示）。
type Plan struct {
	Args []string
	Mode string // remux | transcode
	Note string
}

func needsVideoReencode(codec string, height int) bool {
	switch strings.ToLower(codec) {
	case "h264", "avc1":
		return height > maxHeight
	}
	return true
}

func needsAudioReencode(codec string) bool {
	switch strings.ToLower(codec) {
	case "", "aac":
		return false
	}
	return true
}

// BuildPlan 决定"重编还是只换容器"，并给出可复现的 ffmpeg 参数。
// 判据只看编解码与分辨率，**不看浏览器 UA**（服务端不该为某个客户端做决定）。
func BuildPlan(o Options) Plan {
	video := needsVideoReencode(o.VideoCodec, o.Height)
	audio := needsAudioReencode(o.AudioCodec)

	args := []string{"-nostdin", "-y", "-i", o.In}
	note := ""
	switch {
	case !video && !audio:
		args = append(args, "-c", "copy", "-movflags", "+faststart")
		note = "已兼容（H.264/AAC + " + heightNote(o.Height) + "）：只换成 MP4 并整理快速起播"
	case !video:
		args = append(args, "-c:v", "copy")
		args = append(args, audioArgs()...)
		note = "视频已兼容（H.264），只重编音频为 AAC"
	default:
		args = append(args, videoArgs(o.VideoToolbox, o.Height)...)
		if audio {
			args = append(args, audioArgs()...)
		} else {
			args = append(args, "-c:a", "copy")
		}
		note = "转成 H.264" + toolNote(o.VideoToolbox) + " + AAC，" + heightNote(o.Height) + " 封顶"
	}
	args = append(args, "-movflags", "+faststart", "-f", "mp4",
		"-progress", "pipe:1", "-nostats", o.Out)
	return Plan{Args: args, Mode: map[bool]string{true: "transcode", false: "remux"}[video], Note: note}
}

func heightNote(h int) string {
	if h <= 0 {
		return "分辨率未知"
	}
	if h <= maxHeight {
		return fmt.Sprintf("%dp", h)
	}
	return fmt.Sprintf("%dp→%dp", h, maxHeight)
}

func toolNote(vt bool) string {
	if vt {
		return "（硬件编码）"
	}
	return ""
}

// videoArgs：videotoolbox 不吃 -crf，用码率；libx264 用 crf + veryfast（个人库够快够好）。
func videoArgs(vt bool, height int) []string {
	out := []string{"-vf", scaleFilter(height)}
	if vt {
		out = append(out, "-c:v", "h264_videotoolbox", "-b:v", "2500k", "-maxrate", "3500k", "-bufsize", "7000k")
	} else {
		out = append(out, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23")
	}
	return append(out, "-pix_fmt", "yuv420p")
}

// scaleFilter 只降不升：高度超过 720 才缩，宽度按比例取偶数（编码器要求偶数）。
func scaleFilter(height int) string {
	if height <= maxHeight {
		return "scale=trunc(iw/2)*2:trunc(ih/2)*2"
	}
	return "scale=-2:'min(720,ih)'"
}

func audioArgs() []string {
	return []string{"-c:a", "aac", "-b:a", "128k", "-ac", "2"}
}

// Item 是队列里的一件：一条 media 的转码请求。
type Item struct {
	MediaID string
	// Source 是触发来源（upload_approve / manual_media），只用于审计与任务说明。
	Source string
}

// Queue 是单工作协程的转码队列：转码吃满 CPU/GPU，串行才是对的。
type Queue struct {
	cfg    *config.Config
	db     *storage.DB
	roots  *config.Roots
	runner ffmpeg.Runner
	log    *slog.Logger

	mu      sync.Mutex
	jobs    map[string]chan struct{} // jobID → 取消信号
	pending chan *job
	started bool
	stop    chan struct{}
	wg      sync.WaitGroup

	// VideoToolbox 由 server 启动时探测后注入（不在这里再跑一次 ffmpeg -encoders）。
	VideoToolbox bool

	// LoadMedia 由 api 层注入：库范围判据只允许在 internal/api/authz.go 里构造，
	// 所以这里不自己拼 LibraryScope，而是让调用方把"怎么按 id 取一条"交进来。
	LoadMedia func(id string) (*domain.Media, error)
}

type job struct {
	ID    string
	Items []Item
}

// NewQueue 建队列（不启动）。
func NewQueue(cfg *config.Config, db *storage.DB, roots *config.Roots,
	r ffmpeg.Runner, log *slog.Logger) *Queue {
	return &Queue{cfg: cfg, db: db, roots: roots, runner: r, log: log,
		jobs: map[string]chan struct{}{}, pending: make(chan *job, 64), stop: make(chan struct{})}
}

// Start 起工作协程；重复调用无副作用。
func (q *Queue) Start() {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.started {
		return
	}
	q.started = true
	q.wg.Add(1)
	go q.worker()
}

// Stop 通知协程收尾（正在跑的 ffmpeg 由 ctx 取消）。
func (q *Queue) Stop() {
	q.mu.Lock()
	if !q.started {
		q.mu.Unlock()
		return
	}
	q.started = false
	q.mu.Unlock()
	close(q.stop)
	q.wg.Wait()
}

// Enqueue 建一个 job_tasks 行并排队；返回任务 id（前端据此看进度）。
func (q *Queue) Enqueue(items []Item, trigger string) (string, error) {
	if len(items) == 0 {
		return "", errors.New("没有要转码的内容")
	}
	t := &domain.JobTask{ID: domain.NewID("job"), Kind: domain.JobKindTranscode,
		Trigger: trigger, Total: len(items)}
	if err := q.db.CreateJobTask(t); err != nil {
		return "", err
	}
	select {
	case q.pending <- &job{ID: t.ID, Items: items}:
	default:
		// 队列满（64 个任务）说明积压异常：如实报错，别静默丢。
		_ = q.db.FinishJobTask(t.ID, domain.TaskFailed, "转码队列已满，请稍后再试", "{}", 0, false, "")
		return "", errors.New("转码队列已满，请稍后再试")
	}
	q.Start()
	return t.ID, nil
}

func (q *Queue) worker() {
	defer q.wg.Done()
	for {
		select {
		case <-q.stop:
			return
		case j := <-q.pending:
			q.runJob(j)
		}
	}
}

// runJob 串行处理一个任务的每一件：单件失败不影响其余，最后如实汇总。
func (q *Queue) runJob(j *job) {
	ctx, cancel := context.WithCancel(context.Background())
	q.mu.Lock()
	q.jobs[j.ID] = make(chan struct{})
	done := q.jobs[j.ID]
	q.mu.Unlock()
	defer func() {
		cancel()
		q.mu.Lock()
		delete(q.jobs, j.ID)
		q.mu.Unlock()
		close(done)
	}()

	succeeded, failed, skipped := 0, 0, 0
	results := make([]string, 0, len(j.Items))
	for i, item := range j.Items {
		if err := ctx.Err(); err != nil {
			break
		}
		_ = q.db.UpdateJobTaskProgress(j.ID, i, succeeded, failed, 0)
		_ = q.db.UpdateJobTaskPercent(j.ID, 0)
		res := q.one(ctx, j.ID, item)
		switch res.Kind {
		case "done":
			succeeded++
		case "skipped":
			skipped++
		default:
			failed++
		}
		results = append(results, res.Text)
	}
	_ = q.db.UpdateJobTaskProgress(j.ID, len(j.Items), succeeded, failed, skipped)
	_ = q.db.UpdateJobTaskPercent(j.ID, 100)

	summary := fmt.Sprintf(`{"items":%d,"succeeded":%d,"failed":%d,"skipped":%d,"results":%s}`,
		len(j.Items), succeeded, failed, skipped, jsonStrings(results))
	status, errMsg := domain.TaskSuccess, ""
	if failed > 0 {
		status = domain.TaskFailed
		errMsg = fmt.Sprintf("%d/%d 条转码失败（原文件保持可用）", failed, len(j.Items))
	}
	if err := q.db.FinishJobTask(j.ID, status, errMsg, summary, 0, false, ""); err != nil {
		q.log.Error("写转码任务终态失败", "job", j.ID, "error", err.Error())
	}
}

type outcome struct {
	Kind string // done | failed | skipped
	Text string
}

// one 处理一条 media：探测过的事实来自库里的行，转码结果落盘后重新探测并写回。
func (q *Queue) one(ctx context.Context, jobID string, item Item) outcome {
	if q.LoadMedia == nil {
		return outcome{Kind: "failed", Text: item.MediaID + "：转码队列没接上媒体查询"}
	}
	m, err := q.LoadMedia(item.MediaID)
	if err != nil {
		return outcome{Kind: "failed", Text: item.MediaID + "：记录不存在"}
	}
	if _, err := media.ValidateMediaFile(q.roots.List(), q.libraryRoot(m.LibraryID), m.Path); err != nil {
		return outcome{Kind: "failed", Text: m.Title + "：文件不在允许根内"}
	}
	if _, err := os.Stat(m.Path); err != nil {
		return outcome{Kind: "failed", Text: m.Title + "：文件不在了"}
	}
	plan := BuildPlan(Options{In: m.Path, Out: m.Path + tempSuffix, VideoCodec: m.Codecs.Video,
		AudioCodec: m.Codecs.Audio, Height: m.Height, DurationMS: m.DurationMS,
		VideoToolbox: q.VideoToolbox})

	_ = q.db.SetMediaTranscode(m.ID, domain.TranscodeRunning, plan.Note)
	tmp := m.Path + tempSuffix
	_ = os.Remove(tmp)
	started := time.Now()
	err = ffmpeg.RunStreaming(ctx, q.runner, func(line string) {
		if pct, ok := progressPercent(line, m.DurationMS); ok {
			_ = q.db.UpdateJobTaskPercent(jobID, pct)
		}
	}, q.cfg.FFmpegBin, plan.Args...)
	if err != nil {
		_ = os.Remove(tmp)
		note := "转码失败：" + friendlyErr(err)
		_ = q.db.SetMediaTranscode(m.ID, domain.TranscodeFailed, note)
		q.log.Warn("转码失败", "media", m.ID, "error", err.Error())
		return outcome{Kind: "failed", Text: m.Title + "：" + note}
	}
	// 产物必须先能探测出视频流，才允许替换原件（"转码成功但文件是坏的"不能发生）。
	if _, perr := ffmpeg.Probe(ctx, q.runner, q.cfg.FFprobeBin, tmp, q.cfg.ProbeTimeout()); perr != nil {
		_ = os.Remove(tmp)
		note := "转码产物探测失败，已保留原文件"
		_ = q.db.SetMediaTranscode(m.ID, domain.TranscodeFailed, note)
		return outcome{Kind: "failed", Text: m.Title + "：" + note}
	}
	if err := os.Rename(tmp, m.Path); err != nil {
		_ = os.Remove(tmp)
		note := "替换原文件失败：" + err.Error()
		_ = q.db.SetMediaTranscode(m.ID, domain.TranscodeFailed, note)
		return outcome{Kind: "failed", Text: m.Title + "：" + note}
	}
	// 改了字节就要重新探测（时长/编码/尺寸都变了），并重抽封面。
	scanner := media.NewScanner(q.cfg, q.db, q.roots, q.runner, q.log)
	if rerr := scanner.RefreshFile(ctx, m.ID, m.Path); rerr != nil {
		_ = q.db.SetMediaTranscode(m.ID, domain.TranscodeDone, plan.Note+"；重新探测失败，请手动扫描")
		return outcome{Kind: "done", Text: m.Title + "：已转码（重新探测失败）"}
	}
	note := plan.Note + fmt.Sprintf("；耗时 %s", shortDuration(time.Since(started)))
	_ = q.db.SetMediaTranscode(m.ID, domain.TranscodeDone, note)
	q.log.Info("转码完成", "media", m.ID, "mode", plan.Mode, "elapsed", time.Since(started).String())
	return outcome{Kind: "done", Text: m.Title + "：" + note}
}

func (q *Queue) libraryRoot(libraryID string) string {
	if lib, err := q.db.GetLibrary(libraryID); err == nil {
		return lib.RootPath
	}
	return ""
}

// progressPercent 解析 ffmpeg -progress 的一行；算不出来就返回 false（不编进度）。
func progressPercent(line string, durationMS int64) (int, bool) {
	line = strings.TrimSpace(line)
	if durationMS <= 0 || !strings.HasPrefix(line, "out_time_us=") {
		return 0, false
	}
	us, err := strconv.ParseInt(strings.TrimPrefix(line, "out_time_us="), 10, 64)
	if err != nil || us <= 0 {
		return 0, false
	}
	pct := int(us / 1000 * 100 / durationMS)
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	return pct, true
}

// friendlyErr 把 ffmpeg 的失败压缩成一句人话（stderr 已经在 ExecError 里截过尾巴）。
func friendlyErr(err error) string {
	msg := err.Error()
	if len(msg) > 200 {
		msg = msg[:200] + "…"
	}
	return msg
}

func shortDuration(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%.0f 秒", d.Seconds())
	}
	return fmt.Sprintf("%.1f 分钟", d.Minutes())
}

func jsonStrings(items []string) string {
	parts := make([]string, 0, len(items))
	for _, s := range items {
		parts = append(parts, strconv.Quote(s))
	}
	return "[" + strings.Join(parts, ",") + "]"
}

// TempSuffixFor 给测试/清理用：临时产物后缀（扫描器会忽略它）。
func TempSuffixFor(path string) string { return filepath.Clean(path) + tempSuffix }
