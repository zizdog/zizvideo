package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/zizdog/zizvideo/internal/domain"
	"github.com/zizdog/zizvideo/internal/transcode"
)

// ============================================================================
// ② 任务中心（用户 2026-09-24）：一个列表看全后台任务（转码 / 扫描 / 识别），
// 能取消正在跑的、能重试失败或中断的。
//
// 两个来源（各自独立的表，别硬捏成一张）：
//   · job_tasks  —— 跨库任务（转码、一键识别），带 params（迁移 0020）⇒ 能重试；
//   · scan_tasks —— 单库扫描（library_id 外键），重试 = 再扫一次那个库。
//
// 取消是"真停"：转码把 ctx 断掉（ffmpeg 被杀，原文件保持可用），扫描停在下一个检查点；
// 终态都如实写 interrupted。**取消不了的情况（已经跑完/进程重启过）就如实说**，不当成功。
// ============================================================================

// taskRow 是列表里的一行（两个来源归一化后的形状）。
type taskRow struct {
	ID        string `json:"id"`
	Source    string `json:"source"` // job | scan
	Kind      string `json:"kind"`
	Status    string `json:"status"`
	Title     string `json:"title"`
	Total     int    `json:"total"`
	Processed int    `json:"processed"`
	Percent   int    `json:"percent"`
	Failed    int    `json:"failed"`
	Error     string `json:"error,omitempty"`
	Summary   string `json:"summary,omitempty"`
	LibraryID string `json:"library_id,omitempty"`
	Library   string `json:"library,omitempty"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
	// CanCancel / CanRetry 由后端算好（前端别自己猜状态机）。
	CanCancel bool `json:"can_cancel"`
	CanRetry  bool `json:"can_retry"`
}

func runningStatus(s string) bool {
	return s == domain.TaskRunning || s == domain.TaskPending
}

// HandleListTasks 合并列出最近的后台任务（新的在前）。
// limit 在这里就夹住（1..200，缺省 50）：storage 的兜底是">200 就退回 50"，
// 语义与"夹到 200"不同，不能靠它当唯一一道（那是兜底，不是本接口的契约）。
func (s *Server) HandleListTasks(w http.ResponseWriter, r *http.Request) {
	limit := queryInt(r, "limit", 50, 1, 200)
	names := map[string]string{}
	if libs, err := s.DB.ListLibraries(); err == nil {
		for i := range libs {
			names[libs[i].ID] = libs[i].Name
		}
	}
	out := []taskRow{}

	if jobs, err := s.DB.ListJobTasks(limit); err == nil {
		for i := range jobs {
			j := jobs[i]
			row := taskRow{
				ID: j.ID, Source: "job", Kind: j.Kind, Status: j.Status,
				Title: transcodeJobTitle(j), Total: j.Total, Processed: j.Processed,
				Percent: j.Percent, Failed: j.Failed, Error: j.Error,
				CreatedAt: j.CreatedAt, UpdatedAt: j.UpdatedAt,
			}
			if j.Kind == domain.JobKindTranscode {
				row.Summary = transcodeSummary(j)
				row.CanRetry = j.Params != "" && !runningStatus(j.Status)
			}
			row.CanCancel = runningStatus(j.Status)
			out = append(out, row)
		}
	}
	if scans, err := s.DB.ListScanTasks(limit); err == nil {
		for i := range scans {
			t := scans[i]
			out = append(out, taskRow{
				ID: t.ID, Source: "scan", Kind: "scan_" + t.Kind, Status: t.Status,
				Title: "扫描媒体库：" + orDefault(names[t.LibraryID], t.LibraryID),
				Total: t.Total, Processed: t.Scanned, Failed: t.Failed, Error: t.Error,
				LibraryID: t.LibraryID, Library: names[t.LibraryID],
				CreatedAt: t.CreatedAt, UpdatedAt: t.UpdatedAt,
				CanCancel: runningStatus(t.Status),
				// 重试 = 再扫一次同一个库；库没了就不能重试（别报个假的成功）
				CanRetry: names[t.LibraryID] != "" && !runningStatus(t.Status),
			})
		}
	}
	// 两个来源合起来按创建时间倒序（字符串时间戳可直接比大小，同格式）
	sortTaskRows(out)
	respond(w, http.StatusOK, map[string]any{"list": out}, nil)
}

func orDefault(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}

// transcodeJobTitle：转码任务的标题带上尺寸与来源，一眼知道是干什么的。
func transcodeJobTitle(j domain.JobTask) string {
	label := map[string]string{
		domain.JobTriggerManualMedia:   "手动排队",
		domain.JobTriggerUploadApprove: "上传通过时排队",
	}[j.Trigger]
	if label == "" {
		label = j.Trigger
	}
	return "转码 " + strconv.Itoa(j.Total) + " 条（" + label + "）"
}

// transcodeSummary 把存在 summary 里的逐条结论摘成一句给列表看（太长就截断）。
func transcodeSummary(j domain.JobTask) string {
	var body struct {
		Succeeded int      `json:"succeeded"`
		Failed    int      `json:"failed"`
		Skipped   int      `json:"skipped"`
		Results   []string `json:"results"`
	}
	if j.Summary == "" {
		return ""
	}
	if err := json.Unmarshal([]byte(j.Summary), &body); err != nil {
		return ""
	}
	text := "成功 " + strconv.Itoa(body.Succeeded) + " / 失败 " + strconv.Itoa(body.Failed)
	if body.Skipped > 0 {
		text += " / 跳过 " + strconv.Itoa(body.Skipped)
	}
	return text
}

func sortTaskRows(rows []taskRow) {
	// 简单插入排序就够（≤100 行），避免为一个列表引 sort 的 Less 闭包
	for i := 1; i < len(rows); i++ {
		for k := i; k > 0 && rows[k].CreatedAt > rows[k-1].CreatedAt; k-- {
			rows[k], rows[k-1] = rows[k-1], rows[k]
		}
	}
}

// HandleCancelTask 取消一个正在跑的任务（转码 / 扫描）。
func (s *Server) HandleCancelTask(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if strings.HasPrefix(id, "scn_") {
		if s.Tasks == nil || !s.Tasks.Cancel(id) {
			s.fail(w, r, domain.New("TASK_NOT_RUNNING", "这次扫描已经结束了，取消不了", 409))
			return
		}
		s.audit(r, "task.cancel", "scan:"+id, true, "")
		respond(w, http.StatusOK, map[string]any{"canceled": true, "id": id}, nil)
		return
	}
	if s.Transcodes == nil || !s.Transcodes.Cancel(id) {
		s.fail(w, r, domain.New("TASK_NOT_RUNNING", "这个任务已经跑完了（或没在跑），取消不了", 409))
		return
	}
	s.audit(r, "task.cancel", "job:"+id, true, "")
	respond(w, http.StatusOK, map[string]any{"canceled": true, "id": id}, nil)
}

// HandleRetryTask 重试：转码按存下来的 params 重新排队；扫描 = 再扫一次那个库。
func (s *Server) HandleRetryTask(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if strings.HasPrefix(id, "scn_") {
		t, err := s.DB.GetScanTask(id)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		if s.Tasks == nil {
			s.fail(w, r, domain.New("SCAN_UNAVAILABLE", "扫描服务没启动", 503))
			return
		}
		fresh, err := s.Tasks.StartScan(t.LibraryID, t.Kind)
		if err != nil {
			s.fail(w, r, err)
			return
		}
		s.audit(r, "task.retry", "scan:"+fresh.ID, true, "from:"+id)
		respond(w, http.StatusAccepted, map[string]any{"task_id": fresh.ID, "source": "scan"}, nil)
		return
	}
	if s.Transcodes == nil {
		s.fail(w, r, domain.New("TRANSCODE_UNAVAILABLE", "转码队列没启动", 503))
		return
	}
	job, err := s.DB.GetJobTask(id)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if job.Kind != domain.JobKindTranscode {
		s.fail(w, r, domain.New("TASK_RETRY_UNSUPPORTED",
			"这类任务不支持重试（只有转码能按原参数重排）", 400))
		return
	}
	var params struct {
		MediaIDs  []string `json:"media_ids"`
		MaxHeight int      `json:"max_height"`
	}
	if err := json.Unmarshal([]byte(job.Params), &params); err != nil || len(params.MediaIDs) == 0 {
		s.fail(w, r, domain.New("TASK_RETRY_NO_PARAMS",
			"这个任务没留下重试参数（老版本排的），请到媒体页重新选一次", 409))
		return
	}
	items := make([]transcode.Item, 0, len(params.MediaIDs))
	for _, mid := range params.MediaIDs {
		if _, err := s.DB.GetMediaIn(scopeAll(), mid); err != nil {
			continue // 媒体已经不在了就跳过，别为它整批失败
		}
		items = append(items, transcode.Item{MediaID: mid,
			Source: domain.JobTriggerManualMedia, MaxHeight: params.MaxHeight})
	}
	if len(items) == 0 {
		s.fail(w, r, domain.New("TASK_RETRY_NOTHING", "原来那批媒体都不在了，没什么可重试的", 409))
		return
	}
	jobID, err := s.Transcodes.Enqueue(items, domain.JobTriggerManualMedia)
	if err != nil {
		s.fail(w, r, domain.New("TRANSCODE_ENQUEUE_FAILED", err.Error(), 503))
		return
	}
	s.audit(r, "task.retry", "job:"+jobID, true, "from:"+id)
	respond(w, http.StatusAccepted, map[string]any{"task_id": jobID, "source": "job",
		"total": len(items)}, nil)
}
