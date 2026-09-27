package ffmpeg

import "testing"

// TestParseLoudness 盯的是"ffmpeg 的 ebur128 摘要怎么读"：真实输出里 I: 那一行在最后一段摘要里，
// 前面还有很多帧统计行（都带 LRA/LUFS 字样），所以必须取**最后一条**而不是第一条。
func TestParseLoudness(t *testing.T) {
	stderr := []byte(`[Parsed_ebur128_0 @ 0x7f] t: 1.0 M: -20.1 S: -21.0 I: -22.5 LUFS LRA: 5.2 LU
[Parsed_ebur128_0 @ 0x7f] t: 2.0 M: -19.4 S: -20.1 I: -21.8 LUFS LRA: 5.0 LU
Summary:

  Integrated loudness:
    I:         -18.6 LUFS
    Threshold: -28.9 LUFS

  Loudness range:
    LRA:         4.9 LU
`)
	got, err := ParseLoudness(stderr)
	if err != nil {
		t.Fatalf("解析失败：%v", err)
	}
	if got != -18.6 {
		t.Fatalf("应取摘要里的 -18.6，实际 %v", got)
	}
	if _, err := ParseLoudness([]byte("nothing here")); err == nil {
		t.Fatal("没有 LUFS 时应当报错，而不是返回 0")
	}
	if _, err := ParseLoudness([]byte("I: 3.2 LUFS")); err == nil {
		t.Fatal("LUFS 是正数说明解析错了，应当报错")
	}
}

// TestGainDBFor 盯住"只衰减不放大 + 上限 24dB + 没量过(0)不调"这三条规矩。
func TestGainDBFor(t *testing.T) {
	cases := []struct {
		lufs float64
		want float64
	}{
		{0, 0},    // 没量过
		{-16, 0},  // 正好达标
		{-10, -6}, // 太响：衰减 6dB
		{-8, -8},  // 更响
		{-24, 0},  // 偏轻：不放大（volume 上限 1.0，放大得上 Web Audio）
		{-40, 0},  // 更轻：还是不动
		{-50, 0},  // 极轻/近乎静音：也不动（宁可不调，也不给 +34dB 那种怪值）
	}
	for _, c := range cases {
		if got := GainDBFor(c.lufs); got != c.want {
			t.Errorf("GainDBFor(%v) = %v，想要 %v", c.lufs, got, c.want)
		}
	}
}
