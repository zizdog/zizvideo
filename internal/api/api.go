// Package api implements the REST handlers and middleware for /api/v1.
package api

import (
	"context"
	"path/filepath"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zizdog/zizvideo/internal/auth"
	"github.com/zizdog/zizvideo/internal/autoscan"
	"github.com/zizdog/zizvideo/internal/config"
	"github.com/zizdog/zizvideo/internal/domain"
	"github.com/zizdog/zizvideo/internal/ffmpeg"
	"github.com/zizdog/zizvideo/internal/storage"
	"github.com/zizdog/zizvideo/internal/task"
	"github.com/zizdog/zizvideo/internal/transcode"
)

// Version is the reported build version; overridable with -ldflags.
var Version = "0.1.32-mvp"

// Server holds every dependency the handlers need.
type Server struct {
	Cfg    *config.Config
	DB     *storage.DB
	Auth   *auth.Manager
	Tasks  *task.Manager
	Roots  *config.Roots
	Runner ffmpeg.Runner
	Log    *slog.Logger

	// Auto 负责定时/事件驱动的增量扫描；StartAutoScan 之前不运行。
	Auto *autoscan.Scheduler

	// Uploads 是三步上传的进程内会话（start/PUT/finish）。
	Uploads *uploadStore

	// Transcodes 是 P1 转码队列（单工作协程，串行）。
	Transcodes *transcode.Queue

	StartedAt time.Time

	mu   sync.RWMutex
	caps ffmpeg.Capabilities

	// coverMu/coverLocks：封面冷缓存时**同一 media 只抽一次**（并发请求不重复起 ffmpeg）。
	// 零值可用，不用改构造函数。
	coverMu    sync.Mutex
	coverLocks map[string]*sync.Mutex
}

// lockCover 返回该 media 的封面生成解锁函数（每个 id 一把锁）。
func (s *Server) lockCover(id string) func() {
	s.coverMu.Lock()
	if s.coverLocks == nil {
		s.coverLocks = map[string]*sync.Mutex{}
	}
	mu := s.coverLocks[id]
	if mu == nil {
		mu = &sync.Mutex{}
		s.coverLocks[id] = mu
	}
	s.coverMu.Unlock()
	mu.Lock()
	return mu.Unlock
}

// NewServer wires a Server and probes ffmpeg capabilities once at startup.
// Roots is the single source of truth for media allow roots.
func NewServer(cfg *config.Config, db *storage.DB, a *auth.Manager, t *task.Manager,
	roots *config.Roots, r ffmpeg.Runner, log *slog.Logger) *Server {
	s := &Server{Cfg: cfg, DB: db, Auth: a, Tasks: t, Roots: roots, Runner: r, Log: log,
		Uploads: newUploadStore(), StartedAt: time.Now()}
	// 收件箱配错（落在媒体允许根里）就退回默认位置并大声报错：不能让待审文件被扫描器入库。
	if s.inboxUnsafe() {
		s.Log.Error("upload_inbox_dir 落在媒体允许根内，已退回默认收件箱",
			"configured", cfg.UploadInboxDir, "fallback", filepath.Join(cfg.DataDir, "inbox"))
		cfg.UploadInboxDir = ""
	} else if cfg.UploadInboxDir != "" {
		s.Log.Info("用户上传收件箱", "dir", s.inboxRoot())
	}
	s.Transcodes = transcode.NewQueue(cfg, db, roots, r, log)
	// 范围判据只在这里构造（scopeAll 是唯一构造点）：转码队列拿到的永远是"能查到的这条"。
	s.Transcodes.LoadMedia = func(id string) (*domain.Media, error) {
		return db.GetMediaIn(scopeAll(), id)
	}
	// 扫描成功结束后自动补齐识别（不改变 task.Manager 对 api 的依赖方向）。
	if t != nil {
		t.SetAfterScan(s.OnScanFinished)
	}
	// 自动扫描复用 task.Manager.StartScan，扫描结果与后置识别都留在任务中心。
	s.Auto = autoscan.New(db, t, log)
	s.RefreshCapabilities(context.Background())
	return s
}

// StartAutoScan 启动后先扫一轮（覆盖停机期间的变动），再按设置定时/事件触发。
func (s *Server) StartAutoScan(ctx context.Context) {
	if s.Auto != nil {
		s.Auto.Start(ctx)
	}
}

// StopAutoScan stops the timer and the event watcher.
func (s *Server) StopAutoScan() {
	if s.Auto != nil {
		s.Auto.Stop()
	}
}

// StopBackground 停掉本进程的后台队列（转码）；扫描由 task.Manager 自己收尾。
func (s *Server) StopBackground() {
	if s.Transcodes != nil {
		s.Transcodes.Stop()
	}
}

// AutoScanChanged asks the scheduler to re-read settings and rebuild watches.
func (s *Server) AutoScanChanged() {
	if s.Auto != nil {
		s.Auto.Reload()
	}
}

// RefreshCapabilities re-detects ffmpeg/ffprobe availability.
func (s *Server) RefreshCapabilities(ctx context.Context) {
	caps := ffmpeg.Detect(ctx, s.Runner, s.Cfg.FFmpegBin, s.Cfg.FFprobeBin)
	s.mu.Lock()
	s.caps = caps
	s.mu.Unlock()
	// 转码队列用同一份探测结果决定有没有硬件编码器（别在队列里再跑一次 ffmpeg -encoders）。
	if s.Transcodes != nil {
		s.Transcodes.VideoToolbox = caps.VideoToolboxH264
	}
	if !caps.FFmpegOK || !caps.FFprobeOK {
		s.Log.Error("外部工具不可用", "ffmpeg_ok", caps.FFmpegOK,
			"ffprobe_ok", caps.FFprobeOK, "error", caps.Error)
	}
}

// Capabilities returns the last probe result.
func (s *Server) Capabilities() ffmpeg.Capabilities {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.caps
}

// ============================================================================
//  Response envelope
// ============================================================================

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type envelope struct {
	Data  any        `json:"data"`
	Meta  any        `json:"meta"`
	Error *errorBody `json:"error"`
}

func writeJSON(w http.ResponseWriter, status int, body envelope) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	_ = enc.Encode(body)
}

// respond writes a success envelope.
func respond(w http.ResponseWriter, status int, data any, meta any) {
	if meta == nil {
		meta = map[string]any{}
	}
	writeJSON(w, status, envelope{Data: data, Meta: meta})
}

// fail maps a domain error to its HTTP status and writes the error envelope.
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	var de *domain.Error
	if !errors.As(err, &de) {
		s.Log.Error("请求处理失败", "request_id", RequestID(r.Context()), "error", err.Error())
		de = domain.ErrInternal
	}
	writeJSON(w, de.Status, envelope{
		Meta:  map[string]any{"request_id": RequestID(r.Context())},
		Error: &errorBody{Code: de.Code, Message: de.Message},
	})
}

// decodeJSON reads a size-limited JSON body into dst.
func (s *Server) decodeJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return domain.ErrBadRequest
	}
	return nil
}

func queryInt(r *http.Request, key string, def, minV, maxV int) int {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return def
	}
	if n < minV {
		return minV
	}
	if n > maxV {
		return maxV
	}
	return n
}

// ============================================================================
//  Context helpers
// ============================================================================

type ctxKey int

const (
	ctxRequestID ctxKey = iota
	ctxUser
	ctxClientIP
	ctxScope
)

// RequestID returns the per-request correlation id.
func RequestID(ctx context.Context) string {
	v, _ := ctx.Value(ctxRequestID).(string)
	return v
}

func withRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, ctxRequestID, id)
}

// UserFrom returns the authenticated user, or nil.
func UserFrom(ctx context.Context) *domain.User {
	v, _ := ctx.Value(ctxUser).(*domain.User)
	return v
}

func withUser(ctx context.Context, u *domain.User) context.Context {
	return context.WithValue(ctx, ctxUser, u)
}

func clientIPFrom(ctx context.Context) string {
	v, _ := ctx.Value(ctxClientIP).(string)
	return v
}

func withClientIP(ctx context.Context, ip string) context.Context {
	return context.WithValue(ctx, ctxClientIP, ip)
}

var _ = runtime.NumCPU
