package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/zizdog/zizvideo/internal/domain"
	"github.com/zizdog/zizvideo/internal/transcode"
)

// P1 转码队列的入口（管理员）：把选中的 media 排进转码任务，进度看 /api/v1/admin/tasks/{id}。
// 用户上传「通过」时也能顺手带上 transcode=true（见 handlers_ugc.go）。

type transcodeReq struct {
	MediaIDs []string `json:"media_ids"`
}

// HandleStartTranscode 排队转码：一次最多 dirImportMaxFiles 条（与批量识别同口径）。
func (s *Server) HandleStartTranscode(w http.ResponseWriter, r *http.Request) {
	var req transcodeReq
	if err := s.decodeJSON(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if len(req.MediaIDs) == 0 || len(req.MediaIDs) > dirImportMaxFiles {
		s.fail(w, r, domain.New("VALIDATION_TRANSCODE",
			"请选择 1-"+strconv.Itoa(dirImportMaxFiles)+" 个媒体", 400))
		return
	}
	if s.Transcodes == nil {
		s.fail(w, r, domain.New("TRANSCODE_UNAVAILABLE", "转码队列未启动", 503))
		return
	}
	items := make([]transcode.Item, 0, len(req.MediaIDs))
	seen := map[string]bool{}
	for _, id := range req.MediaIDs {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		// 先核实这条存在且可见（管理员全见）：不存在的 id 直接报错，别排进去才失败。
		if _, err := s.DB.GetMediaIn(scopeAll(), id); err != nil {
			s.fail(w, r, domain.New("VALIDATION_NOT_FOUND", "媒体不存在: "+id, 404))
			return
		}
		seen[id] = true
		items = append(items, transcode.Item{MediaID: id, Source: domain.JobTriggerManualMedia})
	}
	if len(items) == 0 {
		s.fail(w, r, domain.New("VALIDATION_TRANSCODE", "没有有效的媒体 id", 400))
		return
	}
	jobID, err := s.Transcodes.Enqueue(items, domain.JobTriggerManualMedia)
	if err != nil {
		s.fail(w, r, domain.New("TRANSCODE_ENQUEUE_FAILED", err.Error(), 503))
		return
	}
	s.audit(r, "media.transcode", "job:"+jobID, true, "media:"+strconv.Itoa(len(items)))
	respond(w, http.StatusAccepted, map[string]any{"job_id": jobID, "total": len(items)}, nil)
}
