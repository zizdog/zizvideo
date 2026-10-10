package detect

import (
	"strconv"
	"testing"

	"github.com/zizdog/zizvideo/internal/domain"
)

// 短剧库扫描按**目录结构**给季号（剧A/Season 1/01.mp4 ⇒ 第 1 季），而扫描结束后 api 会
// 自动跑一次识别；识别器如果只认文件名，就会把刚落库的季号抹成 NULL（2026-10-10 实现时发现）。
// 这条钉住"文件名优先、父目录兜底"的规则。
func TestEpisodesForTakesSeasonFromDirectory(t *testing.T) {
	num := func(v int) *int { return &v }
	cases := []struct {
		name        string
		media       domain.Media
		wantSeason  *int
		wantEpisode *int
		wantOK      bool
	}{
		{"父目录是 Season 1，文件名只有集号",
			domain.Media{Path: "/lib/剧A/Season 1/01.mp4"}, num(1), num(1), true},
		{"父目录是 S02，文件名只有集号",
			domain.Media{Path: "/lib/剧A/S02/03.mp4"}, num(2), num(3), true},
		{"父目录是中文季目录",
			domain.Media{Path: "/lib/剧B/第一季/第1集.mp4"}, num(1), num(1), true},
		{"文件名自带季集号（优先于目录）",
			domain.Media{Path: "/lib/剧A/Season 1/S09E09.mp4"}, num(9), num(9), true},
		{"剧目录下直接放的文件：季号留空、不猜",
			domain.Media{Path: "/lib/剧A/第07集.mp4"}, nil, num(7), true},
		{"库根散片：文件名认不出就不写",
			domain.Media{Path: "/lib/随手拍.mp4"}, nil, nil, false},
	}
	for _, c := range cases {
		season, episode, ok := EpisodesFor(c.media)
		if ok != c.wantOK {
			t.Fatalf("%s: ok=%v 期望 %v", c.name, ok, c.wantOK)
		}
		if !intPtrEqual(season, c.wantSeason) || !intPtrEqual(episode, c.wantEpisode) {
			t.Fatalf("%s: 得到 season=%v episode=%v，期望 %v/%v",
				c.name, ptrText(season), ptrText(episode), ptrText(c.wantSeason), ptrText(c.wantEpisode))
		}
	}
}

func ptrText(v *int) string {
	if v == nil {
		return "空"
	}
	return strconv.Itoa(*v)
}
