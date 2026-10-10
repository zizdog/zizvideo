package api

import (
	"context"
	"sort"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/zizdog/zizvideo/internal/domain"
	"github.com/zizdog/zizvideo/internal/media"
	"github.com/zizdog/zizvideo/internal/storage"
	"github.com/zizdog/zizvideo/internal/transcode"
)

// 用户上传（UGC，docs/上传设计.md）：白名单（users.can_upload）才可开上传会话。
// 文件先落 <data>/inbox/<user>/<日期>/，**只有审核通过才移进媒体库登记 media** ——
// 所以待审/驳回的内容不在 media 表里，普通列表天然看不到，不靠过滤兜底。
//
// 接口：POST /api/v1/uploads（开会话）→ PUT /api/v1/uploads/{id}（分片续传）
//      → POST /api/v1/uploads/{id}/finish（定稿待审）→ 后台 approve/reject。
// 断点只认磁盘上的 .zvpart：进程重启后 GET /uploads/{id} 仍能接着传。

const (
	// 配额 50 条 / 20GB，数据盘剩余低于 20GB 就不再收件（用户 2026-09-24 拍板）。
	ugcMaxItems      = 50
	ugcMaxTotalBytes = int64(20) << 30
	ugcMinFreeBytes  = int64(20) << 30
	ugcInboxName     = "inbox"
)

// inboxRoot 是待审文件的落点：默认 <数据目录>/inbox，可用 upload_inbox_dir 指到别的盘
// （媒体库在外置盘时，指到同一个卷上，审核通过就一直是瞬时 rename 而不是跨卷复制）。
func (s *Server) inboxRoot() string {
	if dir := strings.TrimSpace(s.Cfg.UploadInboxDir); dir != "" {
		return filepath.Clean(dir)
	}
	return filepath.Join(s.Cfg.DataDir, ugcInboxName)
}

// inboxUnsafe 检查收件箱是不是落在"媒体允许根"里面 —— 那样扫描器会把待审文件当正式内容入库。
// 配置错了只在启动时大声报一次，并退回默认位置（宁可慢一点，也不能让待审内容漏进库）。
func (s *Server) inboxUnsafe() bool {
	root := s.inboxRoot()
	for _, allow := range s.Roots.List() {
		if allow == "" {
			continue
		}
		if media.Within(root, allow) {
			return true
		}
	}
	return false
}

// inboxPath 只用服务端生成的值拼路径：用户 id + 日期 + 清理过的文件名。
func (s *Server) inboxPath(uploaderID, name string) (string, error) {
	clean, err := safeFileName(name)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(s.inboxRoot(), uploaderID, time.Now().Format("2006-01-02"))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", domain.New("UPLOAD_INBOX_FAILED", "创建收件目录失败："+err.Error(), 500)
	}
	return filepath.Join(dir, clean), nil
}

// ugcQuotaJSON 把配额与磁盘阈值一次交代清楚，前端据此提示而不是自己猜。
type ugcQuotaJSON struct {
	Items        int   `json:"items"`
	MaxItems     int   `json:"max_items"`
	Bytes        int64 `json:"bytes"`
	MaxBytes     int64 `json:"max_bytes"`
	FreeBytes    int64 `json:"free_bytes"`
	MinFreeBytes int64 `json:"min_free_bytes"`
}

func (s *Server) ugcQuota(uploaderID string) (ugcQuotaJSON, error) {
	items, bytes, err := s.DB.UploadUsage(uploaderID)
	if err != nil {
		return ugcQuotaJSON{}, err
	}
	// 收件根可能还没建过（全新实例）：先建出来，否则读不到剩余空间。
	if err := os.MkdirAll(s.inboxRoot(), 0o700); err != nil {
		return ugcQuotaJSON{}, domain.New("UPLOAD_INBOX_FAILED", "创建收件目录失败："+err.Error(), 500)
	}
	free, _ := availableBytes(s.inboxRoot())
	return ugcQuotaJSON{Items: items, MaxItems: ugcMaxItems, Bytes: bytes,
		MaxBytes: ugcMaxTotalBytes, FreeBytes: free, MinFreeBytes: ugcMinFreeBytes}, nil
}

// ugcItemJSON 是给客户端看的条目；received_bytes 以磁盘为准（进程重启后也准）。
type ugcItemJSON struct {
	domain.UploadItem
	URL string `json:"url,omitempty"`
}

func (s *Server) ugcItemView(it *domain.UploadItem) ugcItemJSON {
	view := ugcItemJSON{UploadItem: *it}
	view.Received = ugcReceivedBytes(it)
	if it.State != domain.UploadRejected {
		view.URL = "/api/v1/uploads/" + it.ID
	}
	return view
}

// ugcReceivedBytes 读磁盘上真实的进度（.zvpart 优先，已定稿就是最终文件）；
// 审核过的条目文件已经不在 inbox（搬进库/被删），按库里记的字节数回答。
func ugcReceivedBytes(it *domain.UploadItem) int64 {
	if it.State == domain.UploadApproved || it.State == domain.UploadRejected {
		return it.Received
	}
	if st, err := os.Stat(it.Path + partSuffix); err == nil {
		return st.Size()
	}
	if st, err := os.Stat(it.Path); err == nil {
		return st.Size()
	}
	return 0
}

// ugcItemFor 取条目并校验归属：别人的条目一律按"不存在"回答（不泄露存在性）。
func (s *Server) ugcItemFor(r *http.Request, id string) (*domain.UploadItem, error) {
	it, err := s.DB.GetUploadItem(id)
	if err != nil {
		return nil, domain.ErrNotFound
	}
	u := UserFrom(r.Context())
	if u == nil || (it.UploaderID != u.ID && u.Role != domain.RoleAdmin) {
		return nil, domain.ErrNotFound
	}
	return it, nil
}

// ============================================================================
//  开会话 / 断点回读 / 取消
// ============================================================================

type ugcStartReq struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	// A2：上传者可选的"投递目标"（只是建议，审核页会预填；能不能用还是管理员说了算）。
	// 目标库必须是**他自己能访问的库** —— 否则传完自己也看不见，等于白传。
	TargetLibraryID   string `json:"target_library_id"`
	TargetSeriesTitle string `json:"target_series_title"`
}

// HandleUGCStart 校验白名单、扩展名、单文件上限、配额与磁盘阈值，然后开一条上传条目。
func (s *Server) HandleUGCStart(w http.ResponseWriter, r *http.Request) {
	u := UserFrom(r.Context())
	var req ugcStartReq
	if err := s.decodeJSON(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	name, nerr := safeFileName(req.Name)
	if nerr != nil {
		s.fail(w, r, nerr)
		return
	}
	if ext := strings.ToLower(filepath.Ext(name)); !s.Cfg.ExtAllowed(ext) {
		s.fail(w, r, domain.New("UPLOAD_EXT_NOT_ALLOWED",
			fmt.Sprintf("%s 不是允许的视频扩展名", name), 400))
		return
	}
	if req.Size <= 0 || req.Size > s.Cfg.UploadMaxBytes() {
		s.fail(w, r, domain.New("UPLOAD_FILE_TOO_LARGE",
			fmt.Sprintf("文件大小不合法（单文件上限 %d MB）", s.Cfg.UploadMaxFileMB), 413))
		return
	}
	quota, err := s.ugcQuota(u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if quota.Items >= quota.MaxItems {
		s.fail(w, r, domain.New("UPLOAD_QUOTA_ITEMS",
			fmt.Sprintf("最多只能有 %d 条上传（含待审），请等审核或删掉旧的上传", quota.MaxItems), 409))
		return
	}
	if quota.Bytes+req.Size > quota.MaxBytes {
		s.fail(w, r, domain.New("UPLOAD_QUOTA_BYTES",
			fmt.Sprintf("上传总容量只剩 %s（上限 %s）",
				humanBytes(quota.MaxBytes-quota.Bytes), humanBytes(quota.MaxBytes)), 409))
		return
	}
	free, ferr := availableBytes(s.inboxRoot())
	if ferr != nil {
		s.fail(w, r, domain.New("UPLOAD_STATFS_FAILED", "无法读取磁盘剩余空间："+ferr.Error(), 500))
		return
	}
	if free-req.Size < ugcMinFreeBytes {
		s.fail(w, r, domain.New("UPLOAD_DISK_FLOOR",
			fmt.Sprintf("磁盘剩余空间不足（服务器保留 %s 余量，当前可用 %s）",
				humanBytes(ugcMinFreeBytes), humanBytes(free)), 409))
		return
	}
	path, perr := s.inboxPath(u.ID, name)
	if perr != nil {
		s.fail(w, r, perr)
		return
	}
	// 同名不覆盖：并发/重复上传各自留一份（inbox 目录永远只增不改）。
	for i := 0; i < 100; i++ {
		taken, terr := s.DB.UploadItemPathTaken(path)
		if terr != nil {
			s.fail(w, r, terr)
			return
		}
		if !taken {
			break
		}
		path = filepath.Join(filepath.Dir(path), uniqueName(filepath.Dir(path), filepath.Base(path)))
	}
	// A2：投递目标要落在"他自己能访问的库"里（scope 是唯一判据）。
	targetLib := strings.TrimSpace(req.TargetLibraryID)
	if targetLib != "" {
		sc, serr := s.resolveScope(u)
		if serr != nil {
			s.fail(w, r, serr)
			return
		}
		if !sc.Allows(targetLib) {
			s.fail(w, r, domain.New("UPLOAD_TARGET_FORBIDDEN",
				"这个媒体库你没有访问权限，换个库或让管理员授权", 403))
			return
		}
		if _, lerr := s.DB.GetLibrary(targetLib); lerr != nil {
			s.fail(w, r, domain.ErrNotFound)
			return
		}
	}
	item := &domain.UploadItem{ID: domain.NewID("upl"), UploaderID: u.ID, Name: filepath.Base(path),
		Title: strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)),
		Path:  path, Size: req.Size, State: domain.UploadUploading,
		TargetLibraryID: targetLib, TargetSeriesTitle: strings.TrimSpace(req.TargetSeriesTitle)}
	if err := s.DB.CreateUploadItem(item); err != nil {
		s.fail(w, r, err)
		return
	}
	s.audit(r, "upload.ugc.start", "upload:"+item.ID, true, fmt.Sprintf("name:%s size:%d", item.Name, item.Size))
	view := s.ugcItemView(item)
	respond(w, http.StatusCreated, map[string]any{"item": view, "quota": quota}, nil)
}

// HandleUGCGet 回读断点：客户端重连后据此接着传（磁盘上的 .zvpart 是唯一权威）。
func (s *Server) HandleUGCGet(w http.ResponseWriter, r *http.Request) {
	it, err := s.ugcItemFor(r, r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	quota, _ := s.ugcQuota(it.UploaderID)
	respond(w, http.StatusOK, map[string]any{"item": s.ugcItemView(it), "quota": quota}, nil)
}

// HandleUGCCancel 取消未定稿的上传：删 .zvpart 再删条目（回读确认过 .zvpart 没了才删记录）。
func (s *Server) HandleUGCCancel(w http.ResponseWriter, r *http.Request) {
	it, err := s.ugcItemFor(r, r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if it.State != domain.UploadUploading {
		s.fail(w, r, domain.New("UPLOAD_STATE_INVALID", "这条上传已经定稿，不能取消", 409))
		return
	}
	part := it.Path + partSuffix
	if err := os.Remove(part); err != nil && !errors.Is(err, os.ErrNotExist) {
		s.fail(w, r, domain.New("UPLOAD_CANCEL_FAILED", "临时文件删不掉："+err.Error(), 500))
		return
	}
	if _, err := os.Stat(part); err == nil {
		s.fail(w, r, domain.New("UPLOAD_CANCEL_FAILED", "临时文件仍在磁盘上，未删记录", 500))
		return
	}
	if err := s.DB.DeleteUploadItem(it.ID); err != nil {
		s.fail(w, r, err)
		return
	}
	s.audit(r, "upload.ugc.cancel", "upload:"+it.ID, true, "name:"+it.Name)
	respond(w, http.StatusOK, map[string]any{"cancelled": true}, nil)
}

// ============================================================================
//  PUT（流式落 .zvpart，可断点续传）
// ============================================================================

// HandleUGCPut 边收边写：offset 必须与磁盘上已有字节数一致，收够 size 才算完成。
// 网络中断不清 .zvpart（这正是续传的意义），错误里带上真实进度。
func (s *Server) HandleUGCPut(w http.ResponseWriter, r *http.Request) {
	s.extendReadDeadline(w)
	it, err := s.ugcItemFor(r, r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if it.State != domain.UploadUploading {
		s.fail(w, r, domain.New("UPLOAD_STATE_INVALID", "这条上传已经定稿，请重新开始", 409))
		return
	}
	if !media.Within(it.Path, s.inboxRoot()) {
		// 落点必须在我们自己的收件根内：越界一律拒绝（纵深防御，不依赖上游校验）。
		s.fail(w, r, domain.ErrPathNotAllowed)
		return
	}
	part := it.Path + partSuffix
	offset, hasRange, oerr := resumeOffset(r.Header.Get("Content-Range"))
	if oerr != nil {
		s.fail(w, r, domain.New("UPLOAD_RANGE_INVALID", "断点信息不合法", 400))
		return
	}
	if !hasRange {
		if raw := strings.TrimSpace(r.URL.Query().Get("offset")); raw != "" {
			n, aerr := strconv.ParseInt(raw, 10, 64)
			if aerr != nil || n < 0 {
				s.fail(w, r, domain.New("UPLOAD_RANGE_INVALID", "断点位置不合法", 400))
				return
			}
			offset = n
		}
	}
	received := int64(0)
	if st, serr := os.Stat(part); serr == nil {
		received = st.Size()
	}
	if offset != received {
		s.fail(w, r, domain.New("UPLOAD_RESUME_MISMATCH",
			fmt.Sprintf("断点位置与已收到的内容不一致（服务端已有 %d 字节）", received), 409))
		return
	}
	if received > it.Size {
		s.fail(w, r, domain.New("UPLOAD_RESUME_MISMATCH", "已收到的内容超过声明大小", 409))
		return
	}
	flags := os.O_CREATE | os.O_WRONLY
	if received > 0 {
		flags |= os.O_APPEND
	} else {
		flags |= os.O_TRUNC
	}
	f, ferr := os.OpenFile(part, flags, 0o600)
	if ferr != nil {
		s.fail(w, r, domain.New("UPLOAD_OPEN_FAILED", "无法写入收件目录："+ferr.Error(), 500))
		return
	}
	remain := it.Size - received
	written, cerr := io.Copy(f, http.MaxBytesReader(w, r.Body, remain))
	syncErr := f.Sync()
	closeErr := f.Close()
	total := received + written
	_ = s.DB.SetUploadReceived(it.ID, total)
	if cerr != nil || syncErr != nil || closeErr != nil {
		if isTooLarge(cerr) {
			s.fail(w, r, domain.New("UPLOAD_FILE_TOO_LARGE",
				fmt.Sprintf("文件超过声明大小（上限 %d MB）", s.Cfg.UploadMaxFileMB), 413))
			return
		}
		s.fail(w, r, domain.New("UPLOAD_WRITE_FAILED",
			fmt.Sprintf("上传中断，已保留 %d 字节可续传", total), 400))
		return
	}
	respond(w, http.StatusOK, map[string]any{"received": total >= it.Size,
		"received_bytes": total, "size": it.Size}, nil)
}

// ============================================================================
//  finish（内容 hash 去重 → 定稿为待审）
// ============================================================================

// HandleUGCFinish 校验完整性与 sha256 内容去重，然后把条目推进到待审。
func (s *Server) HandleUGCFinish(w http.ResponseWriter, r *http.Request) {
	it, err := s.ugcItemFor(r, r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if it.State != domain.UploadUploading {
		s.fail(w, r, domain.New("UPLOAD_STATE_INVALID", "这条上传已经定稿", 409))
		return
	}
	part := it.Path + partSuffix
	st, serr := os.Stat(part)
	if serr != nil {
		s.fail(w, r, domain.New("UPLOAD_INCOMPLETE",
			"还没收到完整文件，请先把剩下的字节传完", 409))
		return
	}
	if st.Size() != it.Size {
		s.fail(w, r, domain.New("UPLOAD_INCOMPLETE",
			fmt.Sprintf("只收到 %d/%d 字节，请续传", st.Size(), it.Size), 409))
		return
	}
	hash, herr := fileSHA256(part)
	if herr != nil {
		s.fail(w, r, domain.New("UPLOAD_HASH_FAILED", "读取上传内容失败："+herr.Error(), 500))
		return
	}
	dup, derr := s.DB.UploadHashExists(it.UploaderID, hash)
	if derr != nil {
		s.fail(w, r, derr)
		return
	}
	if dup != nil && dup.ID != it.ID {
		// 重复内容不留垃圾：删掉 .zvpart 和这条记录，如实告诉客户端"已经传过了"。
		_ = os.Remove(part)
		_ = s.DB.DeleteUploadItem(it.ID)
		s.fail(w, r, domain.New("UPLOAD_DUPLICATE",
			fmt.Sprintf("%s 与已上传的「%s」是同一份内容，不用重复传", it.Name, dup.Name), 409))
		return
	}
	if err := os.Rename(part, it.Path); err != nil {
		s.fail(w, r, domain.New("UPLOAD_RENAME_FAILED", "定稿落盘失败："+err.Error(), 500))
		return
	}
	ok, uerr := s.DB.FinishUploadItem(it.ID, st.Size(), hash)
	if uerr != nil {
		s.fail(w, r, uerr)
		return
	}
	if !ok {
		s.fail(w, r, domain.New("UPLOAD_STATE_INVALID", "这条上传已经定稿", 409))
		return
	}
	s.audit(r, "upload.ugc.finish", "upload:"+it.ID, true,
		fmt.Sprintf("name:%s size:%d", it.Name, it.Size))
	fresh, gerr := s.DB.GetUploadItem(it.ID)
	if gerr != nil {
		fresh = it
		fresh.State = domain.UploadPending
	}
	respond(w, http.StatusOK, map[string]any{"item": s.ugcItemView(fresh)}, nil)
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// ============================================================================
//  我的上传 / 预览（本人或管理员）
// ============================================================================

// HandleListMyUploads 是「我的上传」页：全部状态 + 配额，最新在前。
func (s *Server) HandleListMyUploads(w http.ResponseWriter, r *http.Request) {
	u := UserFrom(r.Context())
	items, err := s.DB.ListUploadsByUploader(u.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	views := make([]ugcItemJSON, 0, len(items))
	for i := range items {
		views = append(views, s.ugcItemView(&items[i]))
	}
	quota, _ := s.ugcQuota(u.ID)
	respond(w, http.StatusOK, map[string]any{"list": views, "quota": quota}, nil)
}

// HandleUGCStream 只给本人和管理员看（审核要能预览），支持 Range。
func (s *Server) HandleUGCStream(w http.ResponseWriter, r *http.Request) {
	it, err := s.ugcItemFor(r, r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if !media.Within(it.Path, s.inboxRoot()) {
		s.fail(w, r, domain.ErrPathNotAllowed)
		return
	}
	f, oerr := os.Open(it.Path)
	if oerr != nil {
		s.fail(w, r, domain.New("MEDIA_FILE_GONE", "文件已不在磁盘上", 404))
		return
	}
	defer f.Close()
	st, serr := f.Stat()
	if serr != nil || st.IsDir() {
		s.fail(w, r, domain.New("MEDIA_FILE_GONE", "文件已不在磁盘上", 404))
		return
	}
	if ct := mime.TypeByExtension(filepath.Ext(it.Path)); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	http.ServeContent(w, r, it.Name, st.ModTime(), f)
}

// HandleUGCCover 给待审条目抽一帧（复用 media 的封面缓存与单飞锁），抽不出来才回占位图。
func (s *Server) HandleUGCCover(w http.ResponseWriter, r *http.Request) {
	it, err := s.ugcItemFor(r, r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if !media.Within(it.Path, s.inboxRoot()) {
		s.fail(w, r, domain.ErrPathNotAllowed)
		return
	}
	id := "ugc-" + it.ID
	path := filepath.Join(s.Cfg.CoversDir(), id+".jpg")
	if s.serveCoverFile(w, r, id, path) {
		return
	}
	if s.extractCover(r.Context(), &domain.Media{ID: id, Path: it.Path}, path) &&
		s.serveCoverFile(w, r, id, path) {
		return
	}
	w.Header().Set("Content-Type", "image/svg+xml")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(placeholderCover))
}

// ============================================================================
//  后台：待审列表 + 通过（选库）/ 驳回
// ============================================================================

// HandleAdminPendingUploads 是后台「待审」页的数据源。
func (s *Server) HandleAdminPendingUploads(w http.ResponseWriter, r *http.Request) {
	items, err := s.DB.ListPendingUploads()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	views := make([]ugcItemJSON, 0, len(items))
	for i := range items {
		views = append(views, s.ugcItemView(&items[i]))
	}
	respond(w, http.StatusOK, map[string]any{"list": views}, nil)
}

type ugcApproveReq struct {
	LibraryID string `json:"library_id"`
	// Title 可选：审核时顺手改标题（进库后的显示名）。
	Title string `json:"title"`
	// Transcode 可选：通过后顺手排队转码（P1 兼容优先，原文件在转码成功前一直是可播的）。
	Transcode bool `json:"transcode"`
	// TranscodeHeight：转码输出高度上限（0=保持原分辨率；2026-09-24 起界面可选尺寸）。
	TranscodeHeight int `json:"transcode_height"`
	// SeriesID：通过后把这条挂进已有剧场；SeriesTitle：按标题找/建"剧场草稿"（P1）。
	// 集号用文件名识别（detect.EpisodesFor），所以"我的剧 第2集.mp4"会直接成为第 2 集。
	SeriesID    string `json:"series_id"`
	SeriesTitle string `json:"series_title"`
}

// approveResult 单条通过的结果（单条与批量共用一份结构，线形状保持一致）。
type approveResult struct {
	MediaID        string
	LibraryID      string
	Path           string
	Title          string
	SeriesID       string
	SeriesError    string
	TranscodeJobID string
	TranscodeError string
}

func (r approveResult) json() map[string]any {
	out := map[string]any{"media_id": r.MediaID, "library_id": r.LibraryID,
		"path": r.Path, "title": r.Title}
	if r.SeriesID != "" {
		out["series_id"] = r.SeriesID
	}
	if r.SeriesError != "" {
		out["series_error"] = r.SeriesError
	}
	if r.TranscodeJobID != "" {
		out["transcode_job_id"] = r.TranscodeJobID
	}
	if r.TranscodeError != "" {
		out["transcode_error"] = r.TranscodeError
	}
	return out
}

// approveOne 是一条待审上传的完整通过流程：校验 → 移进目标库 → 探测登记 media → 记状态
// →（可选）归入剧场 →（可选）排队转码。单条接口与批量接口**只有这一份实现**。
// 调用方负责已取到 it（并确认 id 存在）；这里只做状态/归属校验，失败一律不动状态。
func (s *Server) approveOne(ctx context.Context, adminID string, it *domain.UploadItem,
	req ugcApproveReq) (approveResult, error) {
	var out approveResult
	if it.State != domain.UploadPending {
		return out, domain.New("UPLOAD_STATE_INVALID", "这条上传不在待审状态", 409)
	}
	if !media.Within(it.Path, s.inboxRoot()) {
		return out, domain.ErrPathNotAllowed
	}
	lib, err := s.uploadLibrary(req.LibraryID)
	if err != nil {
		return out, err
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = it.Title
	}
	dest := filepath.Join(filepath.Clean(lib.RootPath), it.Name)
	if _, serr := os.Stat(dest); serr == nil {
		dest = filepath.Join(filepath.Clean(lib.RootPath), uniqueName(lib.RootPath, it.Name))
	}
	if err := moveIntoRoot(s.Roots.List(), lib.RootPath, it.Path, dest); err != nil {
		return out, err
	}
	mediaID, perr := s.probeApproved(ctx, lib, dest, title)
	if perr != nil {
		// 移回去，保持待审：坏文件不该进库，也不该凭空消失。
		if back := moveBack(s.inboxRoot(), dest, it.Path); back != nil {
			s.Log.Error("审核通过失败后回滚文件失败", "upload", it.ID, "error", back.Error())
		}
		return out, domain.New("UPLOAD_PROBE_FAILED",
			"这个文件探测不出视频信息（可能损坏或不是视频），已退回待审", 422)
	}
	ok, aerr := s.DB.ApproveUploadItem(it.ID, mediaID, lib.ID, adminID)
	if aerr != nil {
		return out, aerr
	}
	if !ok {
		return out, domain.New("UPLOAD_STATE_INVALID", "这条上传已经被别人审过了", 409)
	}
	out = approveResult{MediaID: mediaID, LibraryID: lib.ID, Path: dest, Title: title}
	// P1：顺手归入剧场（已有 or 按标题新建的草稿）。失败只如实带回错误，不影响"已经通过"这件事。
	if seriesID, serr := s.linkApprovedSeries(ctx, req, lib, mediaID); serr != nil {
		out.SeriesError = serr.Error()
	} else if seriesID != "" {
		out.SeriesID = seriesID
	}
	// 顺手转码：排队失败不影响"已经通过"这个事实，如实把错误一起带回去。
	if req.Transcode && s.Transcodes != nil && transcodeHeightOK(req.TranscodeHeight) {
		jobID, terr := s.Transcodes.Enqueue([]transcode.Item{
			{MediaID: mediaID, Source: domain.JobTriggerUploadApprove,
				MaxHeight: req.TranscodeHeight}},
			domain.JobTriggerUploadApprove)
		if terr != nil {
			out.TranscodeError = terr.Error()
		} else {
			out.TranscodeJobID = jobID
		}
	}
	return out, nil
}

// rejectOne 驳回一条：**先删文件（回读确认）再改状态**，删不掉就不改状态。
func (s *Server) rejectOne(adminID, uploadID, note string) error {
	it, err := s.DB.GetUploadItem(uploadID)
	if err != nil {
		return err
	}
	if it.State != domain.UploadPending {
		return domain.New("UPLOAD_STATE_INVALID", "这条上传不在待审状态", 409)
	}
	if !media.Within(it.Path, s.inboxRoot()) {
		return domain.ErrPathNotAllowed
	}
	if err := os.Remove(it.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return domain.New("UPLOAD_REJECT_FAILED", "文件删不掉，未改状态："+err.Error(), 500)
	}
	if _, err := os.Stat(it.Path); err == nil {
		return domain.New("UPLOAD_REJECT_FAILED", "文件仍在磁盘上，未改状态", 500)
	}
	ok, rerr := s.DB.RejectUploadItem(it.ID, note, adminID)
	if rerr != nil {
		return rerr
	}
	if !ok {
		return domain.New("UPLOAD_STATE_INVALID", "这条上传已经被别人审过了", 409)
	}
	_ = os.Remove(filepath.Join(s.Cfg.CoversDir(), "ugc-"+it.ID+".jpg"))
	return nil
}

// HandleAdminApproveUpload 通过：把文件从 inbox 移进选定的媒体库并登记 media（立刻可播）。
// 探测失败就把文件移回 inbox 并如实报错——绝不把放不了的内容塞进库。
func (s *Server) HandleAdminApproveUpload(w http.ResponseWriter, r *http.Request) {
	admin := UserFrom(r.Context())
	id := r.PathValue("id")
	it, err := s.DB.GetUploadItem(id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var req ugcApproveReq
	if derr := s.decodeJSON(w, r, &req); derr != nil {
		s.fail(w, r, derr)
		return
	}
	out, err := s.approveOne(r.Context(), admin.ID, it, req)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.audit(r, "upload.ugc.approve", "upload:"+it.ID, true,
		fmt.Sprintf("media:%s library:%s transcode:%v series:%v",
			out.MediaID, out.LibraryID, req.Transcode, out.SeriesID))
	respond(w, http.StatusOK, out.json(), nil)
}

// 批量审核（用户 2026-09-24 规划 A1）：一次几十集的场景，别让人点几十次。
// 一次上限：与批量识别同量级，防止一次请求里塞几千条把审核拖成分钟级。
const ugcBatchMax = 200

// batchItem 是批量里每一条的**如实结果**：一条失败不影响其它条，原因逐条给。
type batchItem struct {
	ID    string         `json:"id"`
	OK    bool           `json:"ok"`
	Error string         `json:"error,omitempty"`
	Item  map[string]any `json:"item,omitempty"`
}

type ugcBatchApproveReq struct {
	IDs []string `json:"ids"`
	ugcApproveReq
}

// HandleAdminApproveBatch 批量通过：逐条走 approveOne（**与单条同一份实现**），逐条如实报结果。
// HTTP 一律 200：成功/失败条数与每条原因都在 body 里（部分成功是常态，不该整批报错）。
func (s *Server) HandleAdminApproveBatch(w http.ResponseWriter, r *http.Request) {
	admin := UserFrom(r.Context())
	var req ugcBatchApproveReq
	if err := s.decodeJSON(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if len(req.IDs) == 0 || len(req.IDs) > ugcBatchMax {
		s.fail(w, r, domain.New("VALIDATION_BATCH", fmt.Sprintf("一次 1-%d 条", ugcBatchMax), 400))
		return
	}
	if _, err := s.uploadLibrary(req.LibraryID); err != nil {
		s.fail(w, r, err)
		return
	}
	results := make([]batchItem, 0, len(req.IDs))
	approved := 0
	for _, id := range req.IDs {
		it, err := s.DB.GetUploadItem(id)
		if err != nil {
			results = append(results, batchItem{ID: id, Error: "这条上传不存在（可能已被处理）"})
			continue
		}
		out, aerr := s.approveOne(r.Context(), admin.ID, it, req.ugcApproveReq)
		if aerr != nil {
			results = append(results, batchItem{ID: id, Error: aerr.Error()})
			s.audit(r, "upload.ugc.approve", "upload:"+id, false, errCode(aerr))
			continue
		}
		approved++
		results = append(results, batchItem{ID: id, OK: true, Item: out.json()})
		s.audit(r, "upload.ugc.approve", "upload:"+id, true,
			fmt.Sprintf("media:%s library:%s series:%v", out.MediaID, out.LibraryID, out.SeriesID))
	}
	respond(w, http.StatusOK, map[string]any{"approved": approved, "failed": len(req.IDs) - approved,
		"total": len(req.IDs), "results": results}, nil)
}

// HandleAdminRejectBatch 批量驳回：原因必填（与单条同语义），逐条如实报结果。
func (s *Server) HandleAdminRejectBatch(w http.ResponseWriter, r *http.Request) {
	admin := UserFrom(r.Context())
	var req struct {
		IDs  []string `json:"ids"`
		Note string   `json:"note"`
	}
	if err := s.decodeJSON(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if len(req.IDs) == 0 || len(req.IDs) > ugcBatchMax {
		s.fail(w, r, domain.New("VALIDATION_BATCH", fmt.Sprintf("一次 1-%d 条", ugcBatchMax), 400))
		return
	}
	note := strings.TrimSpace(req.Note)
	if note == "" {
		s.fail(w, r, domain.New("UPLOAD_REJECT_NOTE_REQUIRED", "请填写驳回原因", 400))
		return
	}
	results := make([]batchItem, 0, len(req.IDs))
	rejected := 0
	for _, id := range req.IDs {
		if err := s.rejectOne(admin.ID, id, note); err != nil {
			results = append(results, batchItem{ID: id, Error: err.Error()})
			s.audit(r, "upload.ugc.reject", "upload:"+id, false, errCode(err))
			continue
		}
		rejected++
		results = append(results, batchItem{ID: id, OK: true})
		s.audit(r, "upload.ugc.reject", "upload:"+id, true, "note:"+note)
	}
	respond(w, http.StatusOK, map[string]any{"rejected": rejected, "failed": len(req.IDs) - rejected,
		"total": len(req.IDs), "results": results}, nil)
}

// linkApprovedSeries 把刚通过的 media 挂进剧场（P1 剧场草稿）：
//   · 给了 series_id 就挂现有的；给了 series_title 就按标题找，找不到就用这个库新建一个；
//   · 集号/季号用**文件名识别**（与后台"识别"同一套 detect.EpisodesFor）；
//   · 挂完按 (season, episode) 重排一次 —— 批量审核很可能乱序通过，不重排播放顺序就乱了。
// 返回挂上的剧场 id（没要求归入剧场时返回空串）。
func (s *Server) linkApprovedSeries(ctx context.Context, req ugcApproveReq, lib *domain.Library, mediaID string) (string, error) {
	wantID := strings.TrimSpace(req.SeriesID)
	wantTitle := strings.TrimSpace(req.SeriesTitle)
	if wantID == "" && wantTitle == "" {
		return "", nil
	}
	var series *domain.Series
	var err error
	if wantID != "" {
		series, err = s.DB.GetSeries(wantID)
		if err != nil {
			return "", domain.New("SERIES_NOT_FOUND", "选择的剧场不存在了", 404)
		}
	} else {
		series, err = s.DB.SeriesByTitle(wantTitle)
		if err != nil {
			return "", err
		}
		if series == nil {
			series, err = s.createSeriesNamed(wantTitle, lib.ID)
			if err != nil {
				return "", err
			}
		}
	}
	m, err := s.DB.GetMediaIn(scopeAll(), mediaID)
	if err != nil {
		return "", err
	}
	if _, err := s.DB.AddSeriesMedia(series.ID, []storage.SeriesMediaInput{seriesMediaFromMedia(*m)}); err != nil {
		return "", err
	}
	if err := s.reorderSeriesByEpisode(ctx, series.ID); err != nil {
		s.Log.Warn("剧场草稿重排失败", "series", series.ID, "error", err.Error())
	}
	return series.ID, nil
}

// reorderSeriesByEpisode 把剧场按 (season, episode, 当前 position) 重排：
// 有集号的按集号在前，没识别出集号的保持原相对顺序排在后面。只在不同才写库。
func (s *Server) reorderSeriesByEpisode(ctx context.Context, seriesID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	eps, _, err := s.DB.ListSeriesEpisodes(scopeAll(), seriesID)
	if err != nil {
		return err
	}
	if len(eps) < 2 {
		return nil
	}
	ordered := make([]domain.SeriesEpisode, len(eps))
	copy(ordered, eps)
	sort.SliceStable(ordered, func(i, j int) bool {
		a, b := ordered[i], ordered[j]
		an, bn := a.Episode != nil, b.Episode != nil
		if an != bn {
			return an // 有集号的在前
		}
		if an && bn {
			as, bs := 0, 0
			if a.Season != nil {
				as = *a.Season
			}
			if b.Season != nil {
				bs = *b.Season
			}
			if as != bs {
				return as < bs
			}
			if *a.Episode != *b.Episode {
				return *a.Episode < *b.Episode
			}
		}
		return a.Position < b.Position
	})
	changed := false
	ids := make([]string, 0, len(ordered))
	for i, e := range ordered {
		ids = append(ids, e.MediaID)
		if eps[i].MediaID != e.MediaID {
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return s.DB.ReorderSeries(seriesID, ids)
}

// probeApproved 登记 media：已经扫描过的路径直接复用，否则探测+抽封面后插入。
func (s *Server) probeApproved(ctx context.Context, lib *domain.Library, dest, title string) (string, error) {
	if prev, err := s.DB.MediaByPath(lib.ID, dest); err == nil && prev != nil {
		return prev.ID, nil
	}
	fi, err := os.Stat(dest)
	if err != nil {
		return "", err
	}
	scanner := media.NewScanner(s.Cfg, s.DB, s.Roots, s.Runner, s.Log)
	m, err := scanner.ProbePath(ctx, lib, dest, fi.Size(), title)
	if err != nil {
		return "", err
	}
	return m.ID, nil
}

type ugcRejectReq struct {
	Note string `json:"note"`
}

// HandleAdminRejectUpload 驳回：先删文件（回读确认没了）再改状态，删不掉就不改状态。
func (s *Server) HandleAdminRejectUpload(w http.ResponseWriter, r *http.Request) {
	admin := UserFrom(r.Context())
	id := r.PathValue("id")
	var req ugcRejectReq
	if derr := s.decodeJSON(w, r, &req); derr != nil {
		s.fail(w, r, derr)
		return
	}
	note := strings.TrimSpace(req.Note)
	if note == "" {
		s.fail(w, r, domain.New("UPLOAD_REJECT_NOTE_REQUIRED", "请填写驳回原因", 400))
		return
	}
	if err := s.rejectOne(admin.ID, id, note); err != nil {
		s.audit(r, "upload.ugc.reject", "upload:"+id, false, errCode(err))
		s.fail(w, r, err)
		return
	}
	s.audit(r, "upload.ugc.reject", "upload:"+id, true, "note:"+note)
	respond(w, http.StatusOK, map[string]any{"rejected": true}, nil)
}

// ============================================================================
//  文件移动
// ============================================================================

// moveIntoRoot 把 inbox 文件移进媒体库：目标必须落在库根内（复核一次），
// 同卷用 rename，跨卷退化成复制 + fsync + 删源（复制失败绝不动源文件）。
func moveIntoRoot(roots []string, libRoot, src, dst string) error {
	if _, err := media.ValidateMediaFile(roots, libRoot, dst); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err != nil {
		if err := copyThenRemove(src, dst); err != nil {
			return err
		}
	}
	// inbox 里的 .zvpart 是 0600（用户内容）；进了媒体库就跟扫描到的文件同权限 0644。
	if err := os.Chmod(dst, 0o644); err != nil {
		return err
	}
	return nil
}

// moveBack 是审核失败时的回滚：目标必须仍在 inbox 根内。
func moveBack(inboxRoot, src, dst string) error {
	if !media.Within(dst, inboxRoot) {
		return domain.ErrPathNotAllowed
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	return copyThenRemove(src, dst)
}

func copyThenRemove(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		_ = os.Remove(dst)
		return err
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		_ = os.Remove(dst)
		return err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(dst)
		return err
	}
	return os.Remove(src)
}
