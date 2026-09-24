package api_test

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/zizdog/zizvideo/internal/domain"
)

// P1 转码队列门禁（用户拍板"要转码，兼容优先"）：
//  1. 排队 → 任务终态如实（成功/失败计数对得上）；
//  2. 成功：替换原文件 + 重新探测 + media.transcode_state=done；
//  3. 失败（产物探不出视频流）：**原文件必须完好可用**，状态 failed + 原因，临时文件不许留下。
func TestTranscodeQueueReplacesOrKeepsOriginal(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	lib := e.newLibrary("转码库", e.Root)
	good := e.newMedia(lib.ID, filepath.Join(e.Root, "good.mp4"), []byte("original-good"))
	// 路径里带 bad ⇒ 测试用的 ffprobe 桩会失败，正是"转码产物是坏的"那条路。
	bad := e.newMedia(lib.ID, filepath.Join(e.Root, "bad.mp4"), []byte("original-bad"))

	res, env, raw := e.write(http.MethodPost, "/api/v1/admin/transcodes",
		map[string]any{"media_ids": []string{good.ID, bad.ID}})
	if res.StatusCode != http.StatusAccepted {
		t.Fatalf("排队失败 %d: %s", res.StatusCode, raw)
	}
	var queued struct {
		JobID string `json:"job_id"`
		Total int    `json:"total"`
	}
	decodeInto(t, env.Data, &queued)
	if queued.JobID == "" || queued.Total != 2 {
		t.Fatalf("排队响应不合法: %s", raw)
	}

	deadline := time.Now().Add(20 * time.Second)
	var job map[string]any
	for time.Now().Before(deadline) {
		_, env, _ := e.do(http.MethodGet, "/api/v1/admin/tasks/"+queued.JobID, nil)
		decodeInto(t, env.Data, &job)
		status, _ := job["status"].(string)
		if status == "success" || status == "failed" || status == "interrupted" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if job == nil {
		t.Fatal("没拿到任务终态")
	}
	if job["status"] != "failed" {
		t.Fatalf("一条失败时任务应为 failed（如实），实际 %v", job["status"])
	}
	if job["error"] == nil || job["error"] == "" {
		t.Fatal("failed 任务必须带原因")
	}
	if n, _ := job["processed"].(float64); int(n) != 2 {
		t.Fatalf("processed 应为 2，实际 %v", job["processed"])
	}
	if n, _ := job["failed"].(float64); int(n) != 1 {
		t.Fatalf("failed 应为 1，实际 %v", job["failed"])
	}
	if n, _ := job["percent"].(float64); int(n) != 100 {
		t.Fatalf("终态 percent 应为 100，实际 %v", job["percent"])
	}

	// 成功那条：字节被替换、状态 done、原临时文件不在了
	got, err := e.DB.GetMediaIn(domain.LibraryScope{All: true}, good.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.TranscodeState != domain.TranscodeDone {
		t.Fatalf("成功那条 transcode_state = %q，期望 done（note=%q）", got.TranscodeState, got.TranscodeNote)
	}
	if body, _ := os.ReadFile(got.Path); string(body) == "original-good" {
		t.Fatal("成功那条的文件内容没被替换")
	}
	if _, err := os.Stat(got.Path + ".zvtranscode"); err == nil {
		t.Fatal("临时文件没清掉")
	}
	// 重新探测过：桩返回 640x360 h264，时长 5000ms
	if got.Width != 640 || got.DurationMS != 5000 || got.Status != domain.MediaReady {
		t.Fatalf("转码后应重新探测成 ready：%+v", got)
	}

	// 失败那条：原文件一个字节都不能动，状态 failed 且有原因
	failed, err := e.DB.GetMediaIn(domain.LibraryScope{All: true}, bad.ID)
	if err != nil {
		t.Fatal(err)
	}
	if failed.TranscodeState != domain.TranscodeFailed {
		t.Fatalf("失败那条 transcode_state = %q，期望 failed", failed.TranscodeState)
	}
	if failed.TranscodeNote == "" {
		t.Fatal("失败必须写明原因（界面要显示它）")
	}
	if body, _ := os.ReadFile(failed.Path); string(body) != "original-bad" {
		t.Fatal("转码失败后原文件被改坏了（这是最要紧的红线）")
	}
	if _, err := os.Stat(failed.Path + ".zvtranscode"); err == nil {
		t.Fatal("失败后临时文件没清掉")
	}
	if failed.Status != domain.MediaReady {
		t.Fatalf("转码失败不该影响可播状态，实际 %q", failed.Status)
	}
}

// 不存在的 id 直接 400/404，不许排进队列后才失败。
func TestTranscodeRejectsUnknownMedia(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	res, _, _ := e.write(http.MethodPost, "/api/v1/admin/transcodes",
		map[string]any{"media_ids": []string{"med_does_not_exist"}})
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("未知 media 应 404，实际 %d", res.StatusCode)
	}
}
