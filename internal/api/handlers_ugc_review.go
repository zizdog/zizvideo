package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/zizdog/zizvideo/internal/domain"
	"github.com/zizdog/zizvideo/internal/media"
	"github.com/zizdog/zizvideo/internal/storage"
	"github.com/zizdog/zizvideo/internal/transcode"
)

// 后台的 UGC 审核：待审列表 + 单个/批量通过（选库/选剧/去重）与驳回。

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
//
//	· 给了 series_id 就挂现有的；给了 series_title 就按标题找，找不到就用这个库新建一个；
//	· 集号/季号用**文件名识别**（与后台"识别"同一套 detect.EpisodesFor）；
//	· 挂完按 (season, episode) 重排一次 —— 批量审核很可能乱序通过，不重排播放顺序就乱了。
//
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
