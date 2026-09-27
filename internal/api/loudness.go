package api

import (
	"context"
	"sync"

	"github.com/zizdog/zizvideo/internal/domain"
	"github.com/zizdog/zizvideo/internal/ffmpeg"
)

// 音量均一化（用户 2026-09-26："不同视频音量不同，应做均一化"）。
//
// 思路：给每个视频量一个**整体响度**（LUFS），播放时按"目标 -16 LUFS"给一个**只衰减**的增益。
// 为什么放在"第一次播它时"而不是扫描时整库量：整库量一遍是纯 CPU 开销（每集都要跑一遍 ffmpeg），
// 而用户真正会看的只是一部分；一次测量只读音频 30 秒样本，几秒钟完事，而且量完就存库不再重复。
//
// 只衰减不放大：网页端 HTMLMediaElement.volume 上限是 1.0，放大要么上 Web Audio 的 GainNode、
// 要么在原生侧超过 1.0 有削波风险 —— 第一版不动这条链路（偏轻的内容保持原样）。
type loudnessJob struct {
	id         string
	path       string
	durationMS int64
}

type loudnessQueue struct {
	srv  *Server
	ch   chan loudnessJob
	mu   sync.Mutex
	seen map[string]bool
}

func newLoudnessQueue(s *Server) *loudnessQueue {
	return &loudnessQueue{srv: s, ch: make(chan loudnessJob, 64), seen: map[string]bool{}}
}

// enqueue 只登记，不阻塞播放路径（队列满就丢掉这次，下次播放再排）。同一个 id 只排一次。
func (q *loudnessQueue) enqueue(m *domain.Media) {
	if m == nil || m.ID == "" || m.Path == "" || m.Codecs.Audio == "" {
		return // 没音轨的不用均一化
	}
	if q.srv.Cfg == nil || !q.srv.Cfg.LoudnessNormalize || q.srv.Runner == nil || q.srv.Cfg.FFmpegBin == "" {
		return
	}
	q.mu.Lock()
	if q.seen[m.ID] {
		q.mu.Unlock()
		return
	}
	q.seen[m.ID] = true
	q.mu.Unlock()
	select {
	case q.ch <- loudnessJob{id: m.ID, path: m.Path, durationMS: m.DurationMS}:
	default:
		q.mu.Lock()
		delete(q.seen, m.ID)
		q.mu.Unlock()
	}
}

func (q *loudnessQueue) run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case job := <-q.ch:
			q.measure(ctx, job)
			q.mu.Lock()
			delete(q.seen, job.id)
			q.mu.Unlock()
		}
	}
}

func (q *loudnessQueue) measure(ctx context.Context, job loudnessJob) {
	// 超时给宽一点：读 30 秒音频本身很快，慢的是外置盘/网络盘上开文件
	lufs, err := ffmpeg.MeasureLoudness(ctx, q.srv.Runner, q.srv.Cfg.FFmpegBin, job.path,
		job.durationMS, 2*q.srv.Cfg.ProbeTimeout())
	if err != nil {
		// 失败不写库（下次播放会再试一次）；真有问题会一直在日志里可见
		q.srv.Log.Warn("量响度失败", "media_id", job.id, "error", err.Error())
		return
	}
	if err := q.srv.DB.UpdateMediaLoudness(job.id, lufs); err != nil {
		q.srv.Log.Warn("写响度失败", "media_id", job.id, "error", err.Error())
		return
	}
	q.srv.Log.Info("响度已量（音量均一化用）",
		"media_id", job.id, "lufs", lufs, "gain_db", ffmpeg.GainDBFor(lufs))
}

// noteLoudness 在"要播这条"时调：没量过就排一次后台测量（量完下次播放生效）。
func (s *Server) noteLoudness(m *domain.Media) {
	if s.loud == nil || m == nil || m.LoudnessLUFS != 0 {
		return
	}
	s.loud.enqueue(m)
}
