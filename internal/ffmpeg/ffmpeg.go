// Package ffmpeg probes media and extracts covers. Every call is an argument
// list passed to exec.CommandContext — user-supplied names never reach a shell.
package ffmpeg

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/zizdog/zizvideo/internal/domain"
)

// Runner executes an external program and returns its raw output.
type Runner interface {
	Run(ctx context.Context, name string, args ...string) (stdout, stderr []byte, err error)
}

// StreamRunner 是**可选能力**：能边跑边按行回调输出（转码进度要实时看）。
// 故意不塞进 Runner 接口 —— 那会逼所有测试替身都实现一遍；调用方用类型断言即可。
type StreamRunner interface {
	RunStream(ctx context.Context, onLine func(string), name string, args ...string) error
}

// RunStreaming 有流式能力就用流式，没有就退回一次性 Run（调用方照样拿到错误）。
func RunStreaming(ctx context.Context, r Runner, onLine func(string), name string, args ...string) error {
	if sr, ok := r.(StreamRunner); ok {
		return sr.RunStream(ctx, onLine, name, args...)
	}
	_, _, err := r.Run(ctx, name, args...)
	return err
}

// ExecRunner is the production runner. There is no shell involved.
type ExecRunner struct{}

// Run implements Runner.
func (ExecRunner) Run(ctx context.Context, name string, args ...string) ([]byte, []byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var out, errb strings.Builder
	cmd.Stdout = &out
	cmd.Stderr = &errb
	err := cmd.Run()
	return []byte(out.String()), []byte(errb.String()), err
}

// RunStream implements StreamRunner: stdout 按行回调（ffmpeg -progress 就是一行一条），
// stderr 仍然收着（失败时给错误分类看）。回调必须自己够快，别在里面做重活。
func (ExecRunner) RunStream(ctx context.Context, onLine func(string), name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	var errb strings.Builder
	cmd.Stderr = &errb
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		if onLine != nil {
			onLine(scanner.Text())
		}
	}
	waitErr := cmd.Wait()
	if waitErr != nil {
		return &ExecError{Err: waitErr, Stderr: errb.String()}
	}
	return nil
}

// ExecError 带上 stderr 尾巴，便于如实说明"哪一步失败"。
type ExecError struct {
	Err    error
	Stderr string
}

func (e *ExecError) Error() string {
	tail := strings.TrimSpace(e.Stderr)
	if len(tail) > 400 {
		tail = tail[len(tail)-400:]
	}
	if tail == "" {
		return e.Err.Error()
	}
	return e.Err.Error() + "：" + tail
}

func (e *ExecError) Unwrap() error { return e.Err }

// ProbeError carries the classified failure reason for a single file.
type ProbeError struct {
	Class string
	Err   error
}

func (e *ProbeError) Error() string { return e.Class + ": " + e.Err.Error() }
func (e *ProbeError) Unwrap() error { return e.Err }

// ProbeResult is the subset of ffprobe output the MVP stores.
type ProbeResult struct {
	Container  string
	VideoCodec string
	AudioCodec string
	Width      int
	Height     int
	DurationMS int64
	Bitrate    int64
	FPS        float64
}

// Probe runs ffprobe in JSON mode and maps the output.
func Probe(ctx context.Context, r Runner, ffprobeBin, path string, timeout time.Duration) (*ProbeResult, error) {
	if _, err := os.Stat(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, &ProbeError{Class: domain.ClassNotFound, Err: err}
		}
		return nil, &ProbeError{Class: domain.ClassUnreadable, Err: err}
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	stdout, stderr, err := r.Run(cctx, ffprobeBin,
		"-v", "error", "-print_format", "json", "-show_format", "-show_streams", path)
	if err != nil {
		return nil, classify(cctx, err, stderr, ffprobeBin)
	}
	var parsed probeJSON
	if err := json.Unmarshal(stdout, &parsed); err != nil {
		return nil, &ProbeError{Class: domain.ClassInvalidFormat, Err: err}
	}
	if len(parsed.Streams) == 0 {
		return nil, &ProbeError{Class: domain.ClassInvalidFormat,
			Err: errors.New("no streams")}
	}
	res := &ProbeResult{Container: parsed.Format.FormatName}
	for _, s := range parsed.Streams {
		switch s.CodecType {
		case "video":
			if res.VideoCodec != "" {
				continue
			}
			res.VideoCodec = s.CodecName
			res.Width, res.Height = s.Width, s.Height
			res.FPS = parseRatio(s.RFrameRate)
		case "audio":
			if res.AudioCodec == "" {
				res.AudioCodec = s.CodecName
			}
		}
	}
	if res.VideoCodec == "" {
		return nil, &ProbeError{Class: domain.ClassInvalidFormat, Err: errors.New("no video stream")}
	}
	res.DurationMS = secondsToMS(parsed.Format.Duration)
	if res.DurationMS == 0 {
		for _, s := range parsed.Streams {
			if s.CodecType == "video" && s.Duration != "" {
				res.DurationMS = secondsToMS(s.Duration)
				break
			}
		}
	}
	res.Bitrate, _ = strconv.ParseInt(parsed.Format.BitRate, 10, 64)
	return res, nil
}

// classify maps a runner failure onto one of the four documented classes.
func classify(ctx context.Context, err error, stderr []byte, bin string) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return &ProbeError{Class: domain.ClassProbeTimeout, Err: err}
	}
	if errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist) {
		return &ProbeError{Class: domain.ClassInvalidFormat,
			Err: fmt.Errorf("探测程序不可用 %s: %w", bin, err)}
	}
	msg := strings.ToLower(string(stderr))
	switch {
	case strings.Contains(msg, "no such file or directory"):
		return &ProbeError{Class: domain.ClassNotFound, Err: errors.New("file vanished")}
	case strings.Contains(msg, "permission denied"), strings.Contains(msg, "operation not permitted"):
		return &ProbeError{Class: domain.ClassUnreadable, Err: errors.New("permission denied")}
	default:
		return &ProbeError{Class: domain.ClassInvalidFormat, Err: errors.New("probe failed")}
	}
}

// ExtractCover writes a single JPEG frame at the given offset.
func ExtractCover(ctx context.Context, r Runner, ffmpegBin, src, dst string, atSeconds float64, quality int, timeout time.Duration) error {
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if quality < 2 || quality > 31 {
		quality = 3
	}
	_, stderr, err := r.Run(cctx, ffmpegBin,
		"-nostdin", "-y",
		"-ss", strconv.FormatFloat(atSeconds, 'f', 3, 64),
		"-i", src,
		"-frames:v", "1",
		"-q:v", strconv.Itoa(quality),
		"-f", "image2",
		dst)
	if err != nil {
		return classify(cctx, err, stderr, ffmpegBin)
	}
	return nil
}

// CoverTime picks the documented offset: min(1.0, max(0.05*duration, 0.5)).
func CoverTime(durationMS int64) float64 {
	t := 0.05 * float64(durationMS) / 1000.0
	if t < 0.5 {
		t = 0.5
	}
	if t > 1.0 {
		t = 1.0
	}
	return t
}

// Capabilities is the startup probe result used by /readyz and system info.
type Capabilities struct {
	FFmpegPath       string
	FFmpegVersion    string
	FFmpegOK         bool
	FFprobePath      string
	FFprobeVersion   string
	FFprobeOK        bool
	VideoToolboxH264 bool
	Error            string
}

// Detect versions and the h264_videotoolbox encoder. A missing binary is
// reported, never assumed.
func Detect(ctx context.Context, r Runner, ffmpegBin, ffprobeBin string) Capabilities {
	cap := Capabilities{FFmpegPath: ffmpegBin, FFprobePath: ffprobeBin}
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	if out, _, err := r.Run(cctx, ffmpegBin, "-version"); err == nil {
		cap.FFmpegVersion = firstVersionLine(string(out))
		cap.FFmpegOK = true
	} else {
		cap.Error = "ffmpeg 不可用: " + err.Error()
	}
	if out, _, err := r.Run(cctx, ffprobeBin, "-version"); err == nil {
		cap.FFprobeVersion = firstVersionLine(string(out))
		cap.FFprobeOK = true
	} else if cap.Error == "" {
		cap.Error = "ffprobe 不可用: " + err.Error()
	}
	if cap.FFmpegOK {
		if out, _, err := r.Run(cctx, ffmpegBin, "-hide_banner", "-encoders"); err == nil {
			cap.VideoToolboxH264 = strings.Contains(string(out), "h264_videotoolbox")
		}
	}
	return cap
}

func firstVersionLine(out string) string {
	line := out
	if i := strings.IndexByte(out, '\n'); i >= 0 {
		line = out[:i]
	}
	f := strings.Fields(line)
	for i, tok := range f {
		if tok == "version" && i+1 < len(f) {
			return f[i+1]
		}
	}
	return strings.TrimSpace(line)
}

func secondsToMS(s string) int64 {
	if s == "" || s == "N/A" {
		return 0
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || v < 0 {
		return 0
	}
	return int64(v * 1000)
}

func parseRatio(s string) float64 {
	if s == "" || s == "0/0" {
		return 0
	}
	if i := strings.IndexByte(s, '/'); i > 0 {
		num, err1 := strconv.ParseFloat(s[:i], 64)
		den, err2 := strconv.ParseFloat(s[i+1:], 64)
		if err1 == nil && err2 == nil && den != 0 {
			return num / den
		}
		return 0
	}
	v, _ := strconv.ParseFloat(s, 64)
	return v
}

type probeJSON struct {
	Streams []struct {
		CodecType  string `json:"codec_type"`
		CodecName  string `json:"codec_name"`
		Width      int    `json:"width"`
		Height     int    `json:"height"`
		RFrameRate string `json:"r_frame_rate"`
		Duration   string `json:"duration"`
	} `json:"streams"`
	Format struct {
		FormatName string `json:"format_name"`
		Duration   string `json:"duration"`
		BitRate    string `json:"bit_rate"`
	} `json:"format"`
}

// LoudnessTargetLUFS 是音量均一化的目标响度（流媒体普遍用 -16 LUFS 左右）。
const LoudnessTargetLUFS = -16.0

// lufsRe 抓 ebur128 摘要里的整体响度那一行（`I:  -23.4 LUFS`）。
var lufsRe = regexp.MustCompile(`I:\s*(-?\d+(?:\.\d+)?)\s*LUFS`)

// MeasureLoudness 用 ffmpeg 的 ebur128 滤镜量**整体响度**（LUFS），做音量均一化用
// （用户 2026-09-26："不同视频音量不同，应做均一化"）。
//
// 只读音频（-vn）、只取一段样本（默认 30 秒、从 1/3 处开始）：整片量一遍要解码整条音轨，
// 对一集几十分钟的剧完全不划算；样本足够代表这一集的响度（同一集内响度基本一致）。
func MeasureLoudness(ctx context.Context, r Runner, ffmpegBin, path string, durationMS int64,
	timeout time.Duration) (float64, error) {
	at := 0.0
	if durationMS > 90_000 { // 太短的片子就从头量
		at = float64(durationMS) / 3000.0
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	_, stderr, err := r.Run(cctx, ffmpegBin,
		"-hide_banner", "-nostdin",
		"-ss", strconv.FormatFloat(at, 'f', 3, 64), "-t", "30",
		"-i", path,
		"-vn", "-af", "ebur128=peak=none", "-f", "null", "-")
	if err != nil {
		return 0, classify(cctx, err, stderr, ffmpegBin)
	}
	return ParseLoudness(stderr)
}

// ParseLoudness 从 ffmpeg 的 stderr 里取最后一条整体响度（导出给测试用）。
func ParseLoudness(stderr []byte) (float64, error) {
	all := lufsRe.FindAllSubmatch(stderr, -1)
	if len(all) == 0 {
		return 0, errors.New("ffmpeg 输出里没有 LUFS 摘要")
	}
	raw := string(all[len(all)-1][1])
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0, err
	}
	if v >= 0 {
		return 0, errors.New("LUFS 不可能是正数：" + raw)
	}
	return v, nil
}

// GainDBFor 由响度算出该给的增益（dB）：目标 -16 LUFS，**只衰减不放大**，
// 上限 24dB 的衰减。为什么只衰减：网页端 HTMLMediaElement.volume 上限是 1.0，
// 放大要么得上 Web Audio 的 GainNode、要么在原生侧超 1.0 可能削波 —— 第一版先不动这条链路。
// lufs >= 0 表示"还没量过"，返回 0（什么都不做）。
func GainDBFor(lufs float64) float64 {
	if lufs >= 0 {
		return 0
	}
	gain := LoudnessTargetLUFS - lufs
	if gain > 0 {
		gain = 0
	}
	if gain < -24 {
		gain = -24
	}
	return gain
}
