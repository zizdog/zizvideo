package api_test

import (
	"bytes"
	"encoding/json"
	"image/png"
	"net/http"
	"strings"
	"testing"

	"github.com/makiuchi-d/gozxing"
	"github.com/makiuchi-d/gozxing/qrcode"

	"github.com/zizdog/zizvideo/internal/api"
)

// 扫码登录门禁（用户 2026-09-27 要的功能）：
//  ① 二维码**真的能被解出那条深链**（拿真解码器解生成的 PNG —— 码扫不动等于没做）；
//  ② 三段式时序：start(匿名) → 手机 claim(已登录+CSRF) → 电视 poll 拿到会话 cookie；
//  ③ 红线：匿名不能 claim；别人的 secret 兑不走会话；一次性（兑过就没了）；过期/不存在的码只回 expired。
//
// 为什么用"解二维码 + 走完整 HTTP 时序"而不是直接调函数：这个功能的价值全在
// "手机扫出来的东西"和"电视最后拿到的那张 cookie"上，中间任何一环编错了，单测函数都测不出来。

type qrStartBody struct {
	ID        string `json:"id"`
	Secret    string `json:"secret"`
	ExpiresIn int    `json:"expires_in"`
	Image     string `json:"image"`
	Link      string `json:"link"`
	Base      string `json:"base"`
}

type qrPollBody struct {
	Status string `json:"status"`
	User   *struct {
		Username    string `json:"username"`
		DisplayName string `json:"display_name"`
	} `json:"user"`
}

func qrStart(t *testing.T, e *env, c *http.Client) qrStartBody {
	t.Helper()
	res, raw := e.callWith(c, "", http.MethodPost, "/api/v1/auth/qr/start", nil, false)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("qr/start 应 200，实际 %d: %s", res.StatusCode, raw)
	}
	var body struct {
		Data qrStartBody `json:"data"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatal(err)
	}
	if body.Data.ID == "" || body.Data.Secret == "" {
		t.Fatalf("qr/start 没给 id/secret: %s", raw)
	}
	return body.Data
}

func qrPoll(t *testing.T, e *env, c *http.Client, id, secret string) (qrPollBody, *http.Response) {
	t.Helper()
	res, raw := e.callWith(c, "", http.MethodGet, "/api/v1/auth/qr/poll?id="+id+"&s="+secret, nil, false)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("qr/poll 应 200，实际 %d: %s", res.StatusCode, raw)
	}
	var body struct {
		Data qrPollBody `json:"data"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatal(err)
	}
	return body.Data, res
}

// 二维码图片解出来必须就是 link 字段那条深链（用真 ZXing 解码器验）。
func TestQrLoginImageDecodesToDeepLink(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	tv := e.anonClient()
	start := qrStart(t, e, tv)

	res, raw := e.callWith(tv, "", http.MethodGet, start.Image, nil, false)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("取二维码图应 200，实际 %d", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); ct != "image/png" {
		t.Fatalf("二维码图 Content-Type = %q，期望 image/png", ct)
	}
	img, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("二维码不是合法 PNG：%v", err)
	}
	bmp, err := gozxing.NewBinaryBitmapFromImage(img)
	if err != nil {
		t.Fatal(err)
	}
	text, err := qrcode.NewQRCodeReader().Decode(bmp, nil)
	if err != nil {
		t.Fatalf("二维码解不出来（电视上扫不动）：%v", err)
	}
	if got := text.GetText(); got != start.Link {
		t.Fatalf("二维码内容 = %q，期望 %q", got, start.Link)
	}
	if !strings.HasPrefix(start.Link, "zizvideo://qr?id="+start.ID+"&s="+start.Secret+"&u=") {
		t.Fatalf("深链格式不对：%q", start.Link)
	}
	// 错的 secret 不能看图，也不能轮询
	resBad, _ := e.callWith(tv, "", http.MethodGet, "/api/v1/auth/qr/image/"+start.ID+"?s=deadbeef", nil, false)
	if resBad.StatusCode == http.StatusOK {
		t.Fatal("secret 不对也把二维码发出去了")
	}
}

// 完整时序：手机（已登录）确认 ⇒ 电视轮询到 claimed 并且**拿到能用的会话**。
func TestQrLoginFullFlow(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	phone := e.anonClient()
	if res, raw := e.loginAs(phone, "admin", "adminpass123"); res.StatusCode != http.StatusOK {
		t.Fatalf("手机登录失败 %d: %s", res.StatusCode, raw)
	}
	tv := e.anonClient() // 电视：一台没有会话的新设备
	start := qrStart(t, e, tv)

	if got, _ := qrPoll(t, e, tv, start.ID, start.Secret); got.Status != "pending" {
		t.Fatalf("还没人扫时应 pending，实际 %q", got.Status)
	}

	// 手机确认（带自己的 cookie + CSRF）
	res, _, raw := e.writeAs(phone, http.MethodPost, "/api/v1/auth/qr/claim",
		map[string]string{"id": start.ID, "secret": start.Secret, "base": start.Base})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("claim 应 200，实际 %d: %s", res.StatusCode, raw)
	}

	got, pollRes := qrPoll(t, e, tv, start.ID, start.Secret)
	if got.Status != "claimed" {
		t.Fatalf("确认后应 claimed，实际 %q", got.Status)
	}
	if got.User == nil || got.User.Username != "admin" {
		t.Fatalf("claimed 应带上被登录的用户，实际 %s", raw)
	}
	// 关键：**响应里必须下发会话 cookie**（电视就是靠这张 cookie 登录的）
	if !hasCookie(pollRes, api.CookieSession) {
		t.Fatal("poll 的响应里没有 zv_session —— 电视拿不到会话")
	}
	// 电视带着这张 cookie 访问 /auth/me 应当是已登录
	resMe, envMe, rawMe := e.doAs(tv, http.MethodGet, "/api/v1/auth/me")
	if resMe.StatusCode != http.StatusOK {
		t.Fatalf("电视拿到会话后 /auth/me 应 200，实际 %d: %s", resMe.StatusCode, rawMe)
	}
	if !strings.Contains(string(envMe.Data), `"admin"`) {
		t.Fatalf("/auth/me 返回的不是被扫的用户：%s", envMe.Data)
	}

	// 一次性：同一个码再轮询不给第二次会话
	again, _ := qrPoll(t, e, tv, start.ID, start.Secret)
	if again.Status == "claimed" {
		t.Fatal("同一个二维码被兑了两次会话（应一次性）")
	}
}

// 红线：匿名不能领码；错 secret 兑不走会话。
func TestQrLoginRejectsAnonymousAndWrongSecret(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	phone := e.anonClient()
	if res, _ := e.loginAs(phone, "admin", "adminpass123"); res.StatusCode != http.StatusOK {
		t.Fatal("手机登录失败")
	}
	tv := e.anonClient()
	start := qrStart(t, e, tv)

	// ① 没登录（没有 cookie）去 claim：必须 401
	anon := e.anonClient()
	res, _ := e.callWith(anon, "", http.MethodPost, "/api/v1/auth/qr/claim",
		map[string]string{"id": start.ID, "secret": start.Secret}, false)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("匿名 claim 应 401，实际 %d", res.StatusCode)
	}
	// ② 已登录但不带 CSRF：必须被挡住（会话固定攻击的口子）
	res, _ = e.callWith(phone, "", http.MethodPost, "/api/v1/auth/qr/claim",
		map[string]string{"id": start.ID, "secret": start.Secret}, false)
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("无 CSRF 的 claim 应 403，实际 %d", res.StatusCode)
	}
	// ③ 错的 secret 只能看到 expired，兑不走任何东西
	got, _ := qrPoll(t, e, tv, start.ID, "deadbeefdeadbeef")
	if got.Status != "expired" {
		t.Fatalf("错 secret 应 expired，实际 %q", got.Status)
	}
	// ④ 别人（另一台电视）的 secret 也兑不走这台电视的码
	other := e.anonClient()
	otherStart := qrStart(t, e, other)
	got2, _ := qrPoll(t, e, tv, otherStart.ID, otherStart.Secret)
	if got2.Status == "claimed" {
		t.Fatal("另一台电视的码被兑走了")
	}
}

func hasCookie(res *http.Response, name string) bool {
	for _, c := range res.Cookies() {
		if c.Name == name && c.Value != "" {
			return true
		}
	}
	return false
}
