package api

import (
	"context"
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

func (s *Server) inboxRoot() string { return filepath.Join(s.Cfg.DataDir, ugcInboxName) }

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
	item := &domain.UploadItem{ID: domain.NewID("upl"), UploaderID: u.ID, Name: filepath.Base(path),
		Title: strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)),
		Path:  path, Size: req.Size, State: domain.UploadUploading}
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
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(longUploadWindow))
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
}

// HandleAdminApproveUpload 通过：把文件从 inbox 移进选定的媒体库并登记 media（立刻可播）。
// 探测失败就把文件移回 inbox 并如实报错——绝不把放不了的内容塞进库。
func (s *Server) HandleAdminApproveUpload(w http.ResponseWriter, r *http.Request) {
	admin := UserFrom(r.Context())
	it, err := s.DB.GetUploadItem(r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if it.State != domain.UploadPending {
		s.fail(w, r, domain.New("UPLOAD_STATE_INVALID", "这条上传不在待审状态", 409))
		return
	}
	if !media.Within(it.Path, s.inboxRoot()) {
		s.fail(w, r, domain.ErrPathNotAllowed)
		return
	}
	var req ugcApproveReq
	if derr := s.decodeJSON(w, r, &req); derr != nil {
		s.fail(w, r, derr)
		return
	}
	lib, lerr := s.uploadLibrary(req.LibraryID)
	if lerr != nil {
		s.fail(w, r, lerr)
		return
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
		s.fail(w, r, err)
		return
	}
	mediaID, perr := s.probeApproved(r.Context(), lib, dest, title)
	if perr != nil {
		// 移回去，保持待审：坏文件不该进库，也不该凭空消失。
		if back := moveBack(s.inboxRoot(), dest, it.Path); back != nil {
			s.Log.Error("审核通过失败后回滚文件失败", "upload", it.ID, "error", back.Error())
		}
		s.fail(w, r, domain.New("UPLOAD_PROBE_FAILED",
			"这个文件探测不出视频信息（可能损坏或不是视频），已退回待审", 422))
		return
	}
	ok, aerr := s.DB.ApproveUploadItem(it.ID, mediaID, lib.ID, admin.ID)
	if aerr != nil {
		s.fail(w, r, aerr)
		return
	}
	if !ok {
		s.fail(w, r, domain.New("UPLOAD_STATE_INVALID", "这条上传已经被别人审过了", 409))
		return
	}
	s.audit(r, "upload.ugc.approve", "upload:"+it.ID, true,
		fmt.Sprintf("media:%s library:%s", mediaID, lib.ID))
	respond(w, http.StatusOK, map[string]any{"media_id": mediaID, "library_id": lib.ID,
		"path": dest, "title": title}, nil)
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
	it, err := s.DB.GetUploadItem(r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if it.State != domain.UploadPending {
		s.fail(w, r, domain.New("UPLOAD_STATE_INVALID", "这条上传不在待审状态", 409))
		return
	}
	if !media.Within(it.Path, s.inboxRoot()) {
		s.fail(w, r, domain.ErrPathNotAllowed)
		return
	}
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
	if err := os.Remove(it.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
		s.fail(w, r, domain.New("UPLOAD_REJECT_FAILED", "文件删不掉，未改状态："+err.Error(), 500))
		return
	}
	if _, err := os.Stat(it.Path); err == nil {
		s.fail(w, r, domain.New("UPLOAD_REJECT_FAILED", "文件仍在磁盘上，未改状态", 500))
		return
	}
	ok, rerr := s.DB.RejectUploadItem(it.ID, note, admin.ID)
	if rerr != nil {
		s.fail(w, r, rerr)
		return
	}
	if !ok {
		s.fail(w, r, domain.New("UPLOAD_STATE_INVALID", "这条上传已经被别人审过了", 409))
		return
	}
	_ = os.Remove(filepath.Join(s.Cfg.CoversDir(), "ugc-"+it.ID+".jpg"))
	s.audit(r, "upload.ugc.reject", "upload:"+it.ID, true, "note:"+note)
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
