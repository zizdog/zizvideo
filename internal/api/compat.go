package api

import (
	"strconv"
	"strings"

	"github.com/zizdog/zizvideo/internal/domain"
)

type uaInfo struct {
	family string
	major  int
}

// parseUA classifies a User-Agent into a coarse family. The server owns this
// decision so the frontend never guesses from codec strings.
func parseUA(ua string) uaInfo {
	lower := strings.ToLower(ua)
	pick := func(token string) int {
		idx := strings.Index(lower, token)
		if idx < 0 {
			return -1
		}
		rest := lower[idx+len(token):]
		end := 0
		for end < len(rest) && rest[end] >= '0' && rest[end] <= '9' {
			end++
		}
		if end == 0 {
			return 0
		}
		n, err := strconv.Atoi(rest[:end])
		if err != nil {
			return 0
		}
		return n
	}
	switch {
	// Android App 的 WebView（UA 里有我们自己的标记，也有 Android 字样）：
	// ⚠️ 它的解码能力来自**平台 MediaCodec**（小米电视这类机器有硬件 HEVC 解码器），
	//    跟"桌面 Chrome 107 才有 HEVC"完全不是一回事 —— 老规则会把能放的机器误判成"放不了"。
	//    所以这里单独成一家族；真正放不放得了由客户端先试、失败如实说（见 feed.js 的兜底）。
	case strings.Contains(lower, "zizvideo-android"):
		return uaInfo{"android", 0}
	case strings.Contains(lower, "android"):
		return uaInfo{"android", 0}
	case strings.Contains(lower, "edg/") || strings.Contains(lower, "edge/"):
		return uaInfo{"edge", pick("edg/")}
	case strings.Contains(lower, "opr/") || strings.Contains(lower, "opera"):
		return uaInfo{"opera", pick("opr/")}
	case strings.Contains(lower, "fxios"):
		return uaInfo{"firefox", pick("fxios/")}
	case strings.Contains(lower, "crios"):
		return uaInfo{"chrome", pick("crios/")}
	case strings.Contains(lower, "firefox/"):
		return uaInfo{"firefox", pick("firefox/")}
	case strings.Contains(lower, "headlesschrome/"):
		return uaInfo{"chrome", pick("headlesschrome/")}
	case strings.Contains(lower, "chromium/"):
		return uaInfo{"chrome", pick("chromium/")}
	case strings.Contains(lower, "chrome/"):
		return uaInfo{"chrome", pick("chrome/")}
	case strings.Contains(lower, "safari/"):
		return uaInfo{"safari", pick("version/")}
	}
	return uaInfo{"other", 0}
}

type compatibility struct {
	Direct bool   `json:"direct"`
	Reason string `json:"reason"`
}

// evaluateCompat decides direct playback from the probed codec plus a coarse UA
// family table. Phase1 never transcodes, so a false here is a truthful warning.
func evaluateCompat(codecs domain.Codecs, ua uaInfo) compatibility {
	video := strings.ToLower(codecs.Video)
	switch video {
	case "h264", "avc1", "mpeg4", "vp8":
		return compatibility{Direct: true}
	case "hevc", "h265":
		switch ua.family {
		case "safari":
			return compatibility{Direct: true}
		case "android":
			// Android WebView / 我们的 App：交给平台解码器（有硬件 HEVC 就能放）。
			// 播放失败时前端会如实报错并给"用原生播放器打开"这条兜底（ExoPlayer 一定走 MediaCodec）。
			return compatibility{Direct: true, Reason: "HEVC：由这台设备的解码器决定（放不了会提示换原生播放器）"}
		case "chrome", "edge", "opera":
			if ua.major >= 107 {
				return compatibility{Direct: true}
			}
		}
		return compatibility{Direct: false, Reason: "该浏览器放不了 HEVC，请用 Safari（转码属 Phase2）"}
	case "av1":
		switch ua.family {
		case "android":
			return compatibility{Direct: true, Reason: "AV1：由这台设备的解码器决定（放不了会提示换原生播放器）"}
		case "chrome", "edge", "opera":
			if ua.major >= 70 {
				return compatibility{Direct: true}
			}
		case "firefox":
			if ua.major >= 67 {
				return compatibility{Direct: true}
			}
		case "safari":
			if ua.major >= 17 {
				return compatibility{Direct: true}
			}
		}
		return compatibility{Direct: false, Reason: "该浏览器放不了 AV1，请换新版浏览器（转码属 Phase2）"}
	case "vp9":
		if ua.family == "safari" && ua.major < 14 {
			return compatibility{Direct: false, Reason: "该浏览器放不了 VP9，请换新版浏览器（转码属 Phase2）"}
		}
		return compatibility{Direct: true}
	case "":
		return compatibility{Direct: false, Reason: "尚未探测到编码信息，请等扫描完成"}
	default:
		return compatibility{Direct: false, Reason: "这个编码暂无直出支持，转码属 Phase2"}
	}
}

// audioProblem reports an audio codec no browser in the target set accepts.
func audioProblem(codecs domain.Codecs) string {
	switch strings.ToLower(codecs.Audio) {
	case "", "aac", "mp3", "opus", "vorbis", "flac", "ac3", "eac3", "alac", "pcm_s16le":
		return ""
	default:
		return "音轨编码可能无法播放"
	}
}
