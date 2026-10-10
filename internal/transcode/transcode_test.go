package transcode

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/zizdog/zizvideo/internal/config"
)

// 门禁：转码决策必须只看编解码/分辨率，且"已兼容"不许白重编（P1 的省时省质判据）。
func TestBuildPlanDecidesRemuxVsTranscode(t *testing.T) {
	base := Options{In: "/lib/a.mkv", Out: "/lib/a.mkv.zvtranscode"}
	cases := []struct {
		name     string
		opts     Options
		wantMode string
		mustHave []string
		mustNot  []string
	}{
		{
			name:     "HEVC + AC3 → 重编视频与音频（选 720p 上限）",
			opts:     Options{VideoCodec: "hevc", AudioCodec: "ac3", Height: 1280, MaxHeight: 720, Out: base.Out},
			wantMode: "transcode",
			mustHave: []string{"libx264", "aac", "scale=-2:'min(720,ih)'", "+faststart"},
		},
		{
			name: "有 videotoolbox 就用硬件编码（码率模式，不是 crf）",
			opts: Options{VideoCodec: "hevc", AudioCodec: "aac", Height: 1080, MaxHeight: 720,
				VideoToolbox: true, Out: base.Out},
			wantMode: "transcode",
			mustHave: []string{"h264_videotoolbox", "-b:v"},
			mustNot:  []string{"libx264", "-crf"},
		},
		{
			name:     "H.264+AAC 且不缩尺寸 → 只换容器（-c copy）",
			opts:     Options{VideoCodec: "h264", AudioCodec: "aac", Height: 1080, MaxHeight: 0, Out: base.Out},
			wantMode: "remux",
			mustHave: []string{"-c", "copy"},
			mustNot:  []string{"libx264", "-crf"},
		},
		{
			name:     "视频兼容但音频是 DTS → 只重编音频，视频直接 copy",
			opts:     Options{VideoCodec: "h264", AudioCodec: "dts", Height: 480, Out: base.Out},
			wantMode: "remux",
			mustHave: []string{"-c:v", "copy", "aac"},
			mustNot:  []string{"libx264"},
		},
		{
			name:     "选了 720p 上限：1080p 的 H.264 也要缩",
			opts:     Options{VideoCodec: "h264", AudioCodec: "aac", Height: 1080, MaxHeight: 720, Out: base.Out},
			wantMode: "transcode",
			mustHave: []string{"libx264", "scale=-2:'min(720,ih)'"},
		},
		{
			name: "源码率更低时按源来 —— 不许把已压过的重编大（用户 2026-09-24 报障）",
			opts: Options{VideoCodec: "hevc", AudioCodec: "aac", Height: 1080, MaxHeight: 720,
				SourceBitrate: 300000, Out: base.Out},
			wantMode: "transcode",
			mustHave: []string{"-b:v 300k", "-maxrate 450k", "-bufsize 600k"},
			mustNot:  []string{"2500k", "4500k", "-crf"},
		},
		{
			name:     "源没给码率就按档位上限（480p → 1200kbps 上限）",
			opts:     Options{VideoCodec: "mpeg4", AudioCodec: "aac", Height: 480, MaxHeight: 480, Out: base.Out},
			wantMode: "transcode",
			mustHave: []string{"scale=trunc(iw/2)*2:trunc(ih/2)*2", "-maxrate 1200k"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			plan := BuildPlan(Options{In: base.In, VideoCodec: c.opts.VideoCodec,
				AudioCodec: c.opts.AudioCodec, Height: c.opts.Height,
				MaxHeight: c.opts.MaxHeight, SourceBitrate: c.opts.SourceBitrate,
				DurationMS: 60000, VideoToolbox: c.opts.VideoToolbox, Out: base.Out})
			if plan.Mode != c.wantMode {
				t.Fatalf("mode = %s，期望 %s（args=%v）", plan.Mode, c.wantMode, plan.Args)
			}
			joined := strings.Join(plan.Args, " ")
			for _, want := range c.mustHave {
				if !strings.Contains(joined, want) {
					t.Errorf("参数里缺少 %q：%v", want, plan.Args)
				}
			}
			for _, no := range c.mustNot {
				if strings.Contains(joined, no) {
					t.Errorf("参数里不该出现 %q：%v", no, plan.Args)
				}
			}
			// 输出必须是同目录临时文件（同卷 rename 才原子；后缀不在允许扩展名里，扫描器会跳过）
			if !strings.HasSuffix(plan.Args[len(plan.Args)-1], ".zvtranscode") {
				t.Errorf("输出不是同目录临时文件：%v", plan.Args[len(plan.Args)-1])
			}
			// 进度必须走 stdout（解析 out_time_us）
			if !strings.Contains(joined, "-progress pipe:1") {
				t.Errorf("缺少 -progress pipe:1：%v", plan.Args)
			}
			if plan.Note == "" {
				t.Error("缺少人话说明（界面要显示它）")
			}
		})
	}
}

// 进度解析：只有真的拿到 out_time_us 才算，除零/负数一律不出数（不许编进度）。
func TestProgressPercentHonest(t *testing.T) {
	cases := []struct {
		line     string
		duration int64
		want     int
		ok       bool
	}{
		{"out_time_us=30000000", 60000, 50, true},
		{"out_time_us=0", 60000, 0, false},
		{"out_time_us=abc", 60000, 0, false},
		{"out_time_us=30000000", 0, 0, false},
		{"progress=continue", 60000, 0, false},
		{"out_time_us=99000000", 60000, 100, true}, // 夹到 100
	}
	for _, c := range cases {
		got, ok := progressPercent(c.line, c.duration)
		if ok != c.ok || got != c.want {
			t.Errorf("progressPercent(%q, %d) = (%d,%v)，期望 (%d,%v)", c.line, c.duration, got, ok, c.want, c.ok)
		}
	}
}

// TestStopCancelsInFlightJob：SIGTERM 收尾必须**取消正在跑的转码**。
// 2026-10-10 审计：老实现只 close(stop)+wg.Wait()，而 job 的 ctx 从不被 cancel
// ⇒ 进程会一直挂到当前转码自然结束（长片几十分钟），launchd/systemd 只能强杀。
func TestStopCancelsInFlightJob(t *testing.T) {
	q := NewQueue(config.Default(), nil, nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	q.Start()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	q.mu.Lock()
	q.jobs["job_在跑"] = cancel
	q.mu.Unlock()

	done := make(chan struct{})
	go func() { q.Stop(); close(done) }()
	select {
	case <-ctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("Stop 没有取消正在跑的任务：收尾会卡到转码结束")
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Stop 没有在取消后及时返回")
	}
}

// TestBusyCountsQueuedJobs：排队中但还没开跑的任务也必须算 busy ——
// 备份恢复前的"没有写入者"闸门靠它（老实现只看 q.jobs，会把已 Enqueue 的任务漏掉）。
func TestBusyCountsQueuedJobs(t *testing.T) {
	q := NewQueue(config.Default(), nil, nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if q.Busy() {
		t.Fatal("空队列不该 busy")
	}
	q.pending <- &job{ID: "job_排队中"}
	if !q.Busy() {
		t.Fatal("已排队未开跑的任务必须算 busy（否则恢复备份的闸门会被绕过）")
	}
}

// TestStartAfterStopUsesFreshStopChannel：Stop 之后再 Start 必须还能干活
// （老实现复用同一个 stop 通道，重启后的 worker 会立刻退出）。
func TestStartAfterStopUsesFreshStopChannel(t *testing.T) {
	q := NewQueue(config.Default(), nil, nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	q.Start()
	first := q.stop
	q.Stop()
	q.Start()
	second := q.stop
	if first == second {
		t.Fatal("Stop 后再 Start 必须换一个新的停止信号")
	}
	select {
	case <-second:
		t.Fatal("新启动的停止信号不该是已关闭的")
	default:
	}
	q.Stop()
}
