package api_test

import (
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/zizdog/zizvideo/internal/domain"
)

// ② 任务中心门禁：列表合并（转码 + 扫描）、取消是**真停**（终态 interrupted，不是假装成功）、
// 重试按存下来的参数重新排队、已经跑完的取消要如实报 409（不许报成功）。
//
// 这条门禁存在的理由：取消如果只是"把界面上的状态改一改"，用户会以为停了、实际还在吃 CPU/磁盘；
// 重试如果没存参数，就只能报个假成功。两处都在这里用真实终态盯住。

type taskRowBody struct {
	ID        string `json:"id"`
	Source    string `json:"source"`
	Kind      string `json:"kind"`
	Status    string `json:"status"`
	Total     int    `json:"total"`
	Processed int    `json:"processed"`
	CanCancel bool   `json:"can_cancel"`
	CanRetry  bool   `json:"can_retry"`
	Error     string `json:"error"`
	LibraryID string `json:"library_id"`
}

func (e *env) taskList() []taskRowBody {
	e.t.Helper()
	return e.taskListQuery("")
}

// taskListQuery 带查询串拉任务列表（limit 门禁用）。
func (e *env) taskListQuery(query string) []taskRowBody {
	e.t.Helper()
	res, env, raw := e.do(http.MethodGet, "/api/v1/admin/tasks"+query, nil)
	if res.StatusCode != http.StatusOK {
		e.t.Fatalf("任务列表失败 %d: %s", res.StatusCode, raw)
	}
	var out struct {
		List []taskRowBody `json:"list"`
	}
	decodeInto(e.t, env.Data, &out)
	return out.List
}

// limit 门禁：/admin/tasks 的 limit 必须在本接口夹住（1..200，缺省 50）。
//
// 这条门禁存在的理由：这条列表口是唯一直接吃 Atoi 结果的（没走 queryInt），
// 全靠 storage 兜底 —— 而兜底是">200 就退回 50"，与"夹到 200"语义不同，
// 客户端要 999 条会静默拿到 50 条。判据用真实行数：先塞 205 条任务。
func TestTaskListLimitClamped(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	for i := 0; i < 205; i++ {
		if err := e.DB.CreateJobTask(&domain.JobTask{
			ID: domain.NewID("job"), Kind: domain.JobKindTranscode,
			Trigger: domain.JobTriggerManualMedia, Total: 1,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if got := len(e.taskListQuery("?limit=999")); got != 200 {
		t.Fatalf("limit=999 应当夹到上限 200，实际 %d 条", got)
	}
	if got := len(e.taskListQuery("?limit=0")); got != 1 {
		t.Fatalf("limit=0 应当夹到下限 1，实际 %d 条", got)
	}
	if got := len(e.taskListQuery("?limit=-5")); got != 1 {
		t.Fatalf("limit=-5 应当夹到下限 1，实际 %d 条", got)
	}
	if got := len(e.taskListQuery("?limit=abc")); got != 50 {
		t.Fatalf("limit 不合法应当用缺省 50，实际 %d 条", got)
	}
}

func (e *env) enqueueTranscode(mediaID string) string {
	e.t.Helper()
	res, env, raw := e.write(http.MethodPost, "/api/v1/admin/transcodes",
		map[string]any{"media_ids": []string{mediaID}, "max_height": 0})
	if res.StatusCode != http.StatusAccepted {
		e.t.Fatalf("排队转码失败 %d: %s", res.StatusCode, raw)
	}
	var out struct {
		JobID string `json:"job_id"`
	}
	decodeInto(e.t, env.Data, &out)
	return out.JobID
}

// waitTask 等一个任务离开 pending/running（转码用 stub ffmpeg，通常瞬间完成）。
func (e *env) waitTask(id string, timeout time.Duration) taskRowBody {
	e.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		for _, row := range e.taskList() {
			if row.ID == id && row.Status != domain.TaskRunning && row.Status != domain.TaskPending {
				return row
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	e.t.Fatalf("任务 %s 在 %s 内没结束", id, timeout)
	return taskRowBody{}
}

func TestTaskCenterCancelIsRealAndRetryRequeues(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	lib := e.newLibrary("库", e.Root)
	// 文件名带 slow ⇒ stub ffmpeg 会 sleep 5s，够我们取消它
	slow := e.newMedia(lib.ID, filepath.Join(e.Root, "slow-clip.mp4"), []byte("aaa"))
	fast := e.newMedia(lib.ID, filepath.Join(e.Root, "fast-clip.mp4"), []byte("bbb"))

	// ① 取消**正在跑**的转码：真的停下来，终态如实写 interrupted
	jobID := e.enqueueTranscode(slow.ID)
	// 等它真的开始跑（列表里出现且 running/pending）
	started := false
	for i := 0; i < 60; i++ {
		for _, row := range e.taskList() {
			if row.ID == jobID && (row.Status == domain.TaskRunning || row.Status == domain.TaskPending) {
				started = true
			}
		}
		if started {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !started {
		t.Fatal("转码任务没出现在列表里")
	}
	res, env, raw := e.write(http.MethodPost, "/api/v1/admin/tasks/"+jobID+"/cancel", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("取消失败 %d: %s", res.StatusCode, raw)
	}
	var canceled struct {
		Canceled bool `json:"canceled"`
	}
	decodeInto(t, env.Data, &canceled)
	if !canceled.Canceled {
		t.Fatal("取消接口没说取消成功")
	}
	row := e.waitTask(jobID, 10*time.Second)
	if row.Status != domain.TaskInterrupted {
		t.Fatalf("取消后终态应是 interrupted，实际 %s", row.Status)
	}
	if row.Error == "" {
		t.Fatal("取消要如实写明（error 说明哪条被中止）")
	}

	// ② 已经跑完的任务再取消 ⇒ 409 如实说"取消不了"，绝不许报成功
	res, _, _ = e.write(http.MethodPost, "/api/v1/admin/tasks/"+jobID+"/cancel", nil)
	if res.StatusCode == http.StatusOK {
		t.Fatal("已经结束的任务不该能取消")
	}
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("取消已结束任务应 409，实际 %d", res.StatusCode)
	}

	// ③ 重试：按存下来的参数重新排队（新的任务 id、同样的条数）
	fastJob := e.enqueueTranscode(fast.ID)
	done := e.waitTask(fastJob, 15*time.Second)
	if !done.CanRetry {
		t.Fatalf("跑完的转码任务应可重试：%+v", done)
	}
	res, env, raw = e.write(http.MethodPost, "/api/v1/admin/tasks/"+fastJob+"/retry", nil)
	if res.StatusCode != http.StatusAccepted {
		t.Fatalf("重试失败 %d: %s", res.StatusCode, raw)
	}
	var again struct {
		TaskID string `json:"task_id"`
		Total  int    `json:"total"`
	}
	decodeInto(t, env.Data, &again)
	if again.TaskID == "" || again.TaskID == fastJob {
		t.Fatalf("重试应该排出一个新任务：%+v", again)
	}
	if again.Total != 1 {
		t.Fatalf("重试条数应保持 1，实际 %d", again.Total)
	}
	e.waitTask(again.TaskID, 15*time.Second)

	// ④ 老任务没留参数时，重试要如实报错（别报假成功）
	old := &domain.JobTask{ID: domain.NewID("job"), Kind: domain.JobKindTranscode,
		Trigger: domain.JobTriggerManualMedia, Total: 1, Params: ""}
	if err := e.DB.CreateJobTask(old); err != nil {
		t.Fatal(err)
	}
	if err := e.DB.FinishJobTask(old.ID, domain.TaskFailed, "boom", "{}", 0, false, ""); err != nil {
		t.Fatal(err)
	}
	res, _, _ = e.write(http.MethodPost, "/api/v1/admin/tasks/"+old.ID+"/retry", nil)
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("没参数的老任务重试应 409，实际 %d", res.StatusCode)
	}

	// ⑤ 扫描任务也在同一个列表里，且能重试（= 再扫一次那个库）
	res, env, raw = e.write(http.MethodPost, "/api/v1/libraries/"+lib.ID+"/scan", nil)
	if res.StatusCode != http.StatusAccepted {
		t.Fatalf("触发扫描失败 %d: %s", res.StatusCode, raw)
	}
	var scan struct {
		TaskID string `json:"task_id"`
	}
	decodeInto(t, env.Data, &scan)
	var scanRow taskRowBody
	found := false
	for i := 0; i < 100; i++ {
		for _, r := range e.taskList() {
			if r.ID == scan.TaskID {
				scanRow, found = r, true
			}
		}
		if found && scanRow.Status != domain.TaskRunning && scanRow.Status != domain.TaskPending {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !found {
		t.Fatal("扫描任务没出现在任务中心列表里")
	}
	if scanRow.Source != "scan" || scanRow.LibraryID != lib.ID {
		t.Fatalf("扫描行形状不对：%+v", scanRow)
	}
	if !scanRow.CanRetry {
		t.Fatalf("跑完的扫描应可重试：%+v", scanRow)
	}
	res, env, raw = e.write(http.MethodPost, "/api/v1/admin/tasks/"+scan.TaskID+"/retry", nil)
	if res.StatusCode != http.StatusAccepted {
		t.Fatalf("扫描重试失败 %d: %s", res.StatusCode, raw)
	}
}
