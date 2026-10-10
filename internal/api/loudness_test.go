package api_test

import (
	"net/http"
	"path/filepath"
	"testing"
)

// 音量均一化（用户 2026-09-26）：量过响度的行，接口必须给出 **gain_db**（≤0 只衰减），
// 网页/原生据此调音量；没量过（0）就是 0（不动）。这条门禁盯的是"量出来的值真的要传到播放端"。
func TestMediaGainDBExposed(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	lib := e.newLibrary("标配库", t.TempDir())
	// 绝对路径：相对路径会把测试文件写进源码树（internal/api/a.mp4 就是这么被提交的）。
	m := e.newMedia(lib.ID, filepath.Join(lib.RootPath, "a.mp4"), []byte("x"))

	// 没量过：gain_db 必须是 0（不许凭空调音量）
	_, env, raw := e.do(http.MethodGet, "/api/v1/media/"+m.ID, nil)
	var before struct {
		GainDB float64 `json:"gain_db"`
	}
	decodeInto(t, env.Data, &before)
	if before.GainDB != 0 {
		t.Fatalf("没量过响度时 gain_db 应当是 0，实际 %v（%s）", before.GainDB, raw)
	}

	// 量到 -10 LUFS（比目标 -16 响）⇒ 应当衰减 6dB
	if err := e.DB.UpdateMediaLoudness(m.ID, -10); err != nil {
		t.Fatalf("写响度失败：%v", err)
	}
	_, env2, raw2 := e.do(http.MethodGet, "/api/v1/media/"+m.ID, nil)
	var after struct {
		GainDB      float64 `json:"gain_db"`
		LoudnessOut float64 `json:"loudness_lufs"`
	}
	decodeInto(t, env2.Data, &after)
	if after.GainDB != -6 {
		t.Fatalf("响度 -10 LUFS（目标 -16）应当给 -6dB，实际 %v（%s）", after.GainDB, raw2)
	}
	// 响度本身不进接口（内部数据，别把 LUFS 暴露给前端）
	if after.LoudnessOut != 0 {
		t.Fatalf("loudness_lufs 不该出现在接口里，实际 %v", after.LoudnessOut)
	}
}
