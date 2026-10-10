package api

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/zizdog/zizvideo/internal/domain"
	"github.com/zizdog/zizvideo/internal/media"
)

// 用户上传（UGC，docs/上传设计.md）：白名单（users.can_upload）才可开上传会话。
// 文件先落 <data>/inbox/<user>/<日期>/，**只有审核通过才移进媒体库登记 media** ——
// 所以待审/驳回的内容不在 media 表里，普通列表天然看不到，不靠过滤兜底。
//
// 文件划分（2026-10-11 拆分，纯搬家：原来 974 行一个文件）：
//   · handlers_ugc.go         —— 上传会话 / PUT 续传 / finish 定稿 / 我的上传与预览
//   · handlers_ugc_review.go  —— 后台待审列表、单个与批量通过/驳回
//   · handlers_ugc_inbox.go   —— 收件箱路径与配额、条目视图、跨目录搬运的小工具
// 接口：POST /api/v1/uploads（开会话）→ PUT /api/v1/uploads/{id}（分片续传）
//      → POST /api/v1/uploads/{id}/finish（定稿待审）→ 后台 approve/reject。
// 断点只认磁盘上的 .zvpart：进程重启后 GET /uploads/{id} 仍能接着传。

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
// 分片写入内核在 upload_part.go（与后台上传唯一一份）；这里只保留 UGC 的策略：
// 网络中断**不清** .zvpart（这正是续传的意义），错误里带上真实进度，进度落库。
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
	res, derr := s.writePart(w, r, partPolicy{
		PartPath: part, DeclaredSize: it.Size, MaxBytes: s.Cfg.UploadMaxBytes(),
		Mode: 0o600, QueryOffset: true,
	})
	// 进度落库只在这三种情况做（与老实现一致）：真动过 .part 才写；
	// 断点不符/打不开目录时直接返回，不覆盖上一次记下的进度。磁盘上的 .zvpart 才是事实。
	if derr == nil || derr.Code == codePartTooLarge || derr.Code == codePartWriteFail {
		_ = s.DB.SetUploadReceived(it.ID, res.Total)
	}
	if derr != nil {
		// 与后台口同一套语义：拦在**声明大小**上 ⇒ 400 UPLOAD_SIZE_MISMATCH（如实说清
		// 收到多少、声明多少）；只有真撞到全局单文件上限才 413。
		if derr.Code == codePartTooLarge && res.CapDeclared {
			s.fail(w, r, domain.New("UPLOAD_SIZE_MISMATCH",
				fmt.Sprintf("收到的字节数超过声明（收到 %d，声明 %d）", res.Total, it.Size), 400))
			return
		}
		s.fail(w, r, uploadPartError(derr,
			"无法写入收件目录：",
			fmt.Sprintf("文件超过单文件上限 %d MB", s.Cfg.UploadMaxFileMB),
			fmt.Sprintf("上传中断，已保留 %d 字节可续传", res.Total)))
		return
	}
	respond(w, http.StatusOK, map[string]any{"received": res.Total >= it.Size,
		"received_bytes": res.Total, "size": it.Size}, nil)
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
