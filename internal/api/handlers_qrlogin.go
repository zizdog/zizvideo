package api

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"
	"time"

	qrcode "github.com/skip2/go-qrcode"

	"github.com/zizdog/zizvideo/internal/domain"
)

// 扫码登录（用户 2026-09-27："开发一个扫码登录的功能，手机 app 直接扫码不需要输入信息即可登录"）。
//
// 为什么放服务端发二维码图：电视端只需要 <img src=...>，App 里不必塞 QR 编码器；
// 二维码内容是 zizvideo://qr?id=..&s=..&u=.. 深链 —— 手机 App 用相机扫，系统相机/任意扫码工具
// 扫了也能拉起 App（兜底）。
//
// 时序（三段式，和主流电视扫码登录一致）：
//   ① 电视 POST /auth/qr/start（匿名）→ 拿到 id/secret + 二维码图；电视开始轮询
//   ② 手机（已登录）POST /auth/qr/claim（要 cookie + CSRF）→ 把这个挑战绑到自己账号上
//   ③ 电视 GET /auth/qr/poll?id&s → claimed 时**响应里直接下发会话 cookie**，电视就登录好了
//
// 安全：secret 是 128 位随机、只出现在二维码里、2 分钟过期、一次性；
// 领码必须已登录且带 CSRF（不然攻击者能让受害者浏览器替他领码 = 会话固定攻击）；
// 轮询也要带 secret（只有出示二维码的那台电视能领走会话）。
const (
	qrTTL        = 2 * time.Minute
	qrClaimedTTL = 2 * time.Minute // 已被领走但电视还没取走：再多留一会儿
)

type qrSession struct {
	id        string
	secret    string
	base      string // 二维码是为哪个服务器地址发的（手机确认时核对，防止跨服务器错领）
	link      string
	createdAt time.Time
	expiresAt time.Time
	claimedBy *domain.User
	used      bool
	png       []byte
	imageErr  bool
}

type qrStore struct {
	mu       sync.Mutex
	sessions map[string]*qrSession
	starts   map[string][]time.Time // 每 IP 的 start 时间窗（限速，匿名接口）
}

func newQRStore() *qrStore {
	return &qrStore{sessions: map[string]*qrSession{}, starts: map[string][]time.Time{}}
}

func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand 读失败极其罕见；退化成时间戳（宁可弱一点也不能 panic）
		return hex.EncodeToString([]byte(time.Now().Format(time.RFC3339Nano)))[:n*2]
	}
	return hex.EncodeToString(buf)
}

// prune 顺手清过期（没有后台协程：这个接口调用频率低，惰性清理够用且没有额外 goroutine）。
func (st *qrStore) prune(now time.Time) {
	for id, s := range st.sessions {
		if now.After(s.expiresAt) {
			delete(st.sessions, id)
		}
	}
	for ip, list := range st.starts {
		keep := list[:0]
		for _, t := range list {
			if now.Sub(t) < time.Minute {
				keep = append(keep, t)
			}
		}
		if len(keep) == 0 {
			delete(st.starts, ip)
		} else {
			st.starts[ip] = keep
		}
	}
}

func (st *qrStore) allowStart(ip string, now time.Time) bool {
	list := st.starts[ip]
	if len(list) >= 20 { // 每分钟每 IP 最多 20 个二维码：正常用户远远够用，堵住刷图
		return false
	}
	st.starts[ip] = append(list, now)
	return true
}

func (st *qrStore) get(id, secret string) *qrSession {
	if id == "" || secret == "" {
		return nil
	}
	s := st.sessions[id]
	if s == nil || s.secret != secret {
		return nil
	}
	return s
}

// qrLink 是二维码里真正编码的内容（手机 App 深链）。
func qrLink(base, id, secret string) string {
	return "zizvideo://qr?id=" + id + "&s=" + secret + "&u=" + base64.RawURLEncoding.EncodeToString([]byte(base))
}

// HandleQrStart 发一个新挑战（匿名）。返回 id/secret/图片地址/深链/有效期。
func (s *Server) HandleQrStart(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	ip := clientIPFrom(r.Context())
	s.QR.mu.Lock()
	s.QR.prune(now)
	if !s.QR.allowStart(ip, now) {
		s.QR.mu.Unlock()
		s.fail(w, r, domain.New("RATE_LIMITED", "操作过于频繁，请稍后再试", 429))
		return
	}
	base := qrBaseFrom(r)
	id := "qr_" + randomHex(6)
	secret := randomHex(16)
	sess := &qrSession{
		id: id, secret: secret, base: base,
		link:      qrLink(base, id, secret),
		createdAt: now,
		expiresAt: now.Add(qrTTL),
	}
	s.QR.sessions[id] = sess
	s.QR.mu.Unlock()

	s.audit(r, "auth.qr.start", id, true, "")
	respond(w, http.StatusOK, map[string]any{
		"id":         id,
		"secret":     secret,
		"expires_in": int(qrTTL.Seconds()),
		"image":      "/api/v1/auth/qr/image/" + id + "?s=" + secret,
		"link":       sess.link,
		"base":       base,
	}, nil)
}

// qrBaseFrom 猜"这台电视是从哪个地址来的"：优先级 X-Forwarded-Proto/Host > Host > 配置监听地址。
// 只用于二维码里的 u= 参数（手机拿它核对"是同一台服务器"），猜错也不影响主流程。
func qrBaseFrom(r *http.Request) string {
	host := r.Host
	if host == "" {
		return ""
	}
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	return scheme + "://" + host
}

// HandleQrImage 出二维码 PNG（匿名，但要 secret）。
func (s *Server) HandleQrImage(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	secret := r.URL.Query().Get("s")
	s.QR.mu.Lock()
	sess := s.QR.get(id, secret)
	if sess == nil || time.Now().After(sess.expiresAt) {
		s.QR.mu.Unlock()
		s.fail(w, r, domain.ErrNotFound)
		return
	}
	png := sess.png
	imageErr := sess.imageErr
	s.QR.mu.Unlock()
	if png == nil && !imageErr {
		// 编码一次就缓存：轮询期间电视只请求一次图，但刷新/多标签会重复要
		data, err := qrcode.Encode(sess.link, qrcode.Medium, 512)
		s.QR.mu.Lock()
		if err != nil {
			sess.imageErr = true
		} else {
			sess.png = data
		}
		s.QR.mu.Unlock()
		if err != nil {
			s.Log.Error("二维码编码失败", "error", err.Error())
			s.fail(w, r, domain.ErrInternal)
			return
		}
		png = data
	}
	if png == nil {
		s.fail(w, r, domain.ErrInternal)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(png)
}

// HandleQrClaim 手机端确认（要已登录 + CSRF）。
func (s *Server) HandleQrClaim(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID     string `json:"id"`
		Secret string `json:"secret"`
		Base   string `json:"base"`
	}
	if err := s.decodeJSON(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	u := UserFrom(r.Context())
	now := time.Now()
	s.QR.mu.Lock()
	s.QR.prune(now)
	sess := s.QR.get(req.ID, req.Secret)
	if sess == nil || now.After(sess.expiresAt) {
		s.QR.mu.Unlock()
		s.audit(r, "auth.qr.claim", req.ID, false, "expired")
		s.fail(w, r, domain.New("QR_EXPIRED", "二维码已过期，请在电视上刷新后重扫", 410))
		return
	}
	if sess.claimedBy != nil {
		s.QR.mu.Unlock()
		s.audit(r, "auth.qr.claim", req.ID, false, "already-claimed")
		s.fail(w, r, domain.New("QR_ALREADY_CLAIMED", "这个码已经被确认过了，请刷新后重扫", 409))
		return
	}
	// 手机在另一个地址（另一个服务器）上登录着：不能在 A 服务器上替 B 服务器的码背书
	if req.Base != "" && sess.base != "" && !sameBase(req.Base, sess.base) {
		s.QR.mu.Unlock()
		s.audit(r, "auth.qr.claim", req.ID, false, "base-mismatch")
		s.fail(w, r, domain.New("QR_BASE_MISMATCH", "这个码不是本服务器的，请连对服务器再扫", 409))
		return
	}
	if u == nil {
		s.QR.mu.Unlock()
		s.fail(w, r, domain.ErrUnauthorized)
		return
	}
	sess.claimedBy = u
	sess.expiresAt = now.Add(qrClaimedTTL) // 已被确认的码：给电视留足取走的时间
	s.QR.mu.Unlock()

	s.audit(r, "auth.qr.claim", req.ID, true, "user:"+u.Username)
	respond(w, http.StatusOK, map[string]any{"status": "claimed", "username": u.Username}, nil)
}

// sameBase 忽略大小写与结尾斜杠地比地址。
func sameBase(a, b string) bool {
	norm := func(s string) string { return strings.ToLower(strings.TrimRight(strings.TrimSpace(s), "/")) }
	return norm(a) == norm(b)
}

// HandleQrPoll 电视轮询（匿名，但要 secret）。claimed 时**当场下发会话 cookie**。
func (s *Server) HandleQrPoll(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	secret := r.URL.Query().Get("s")
	now := time.Now()
	s.QR.mu.Lock()
	s.QR.prune(now)
	sess := s.QR.get(id, secret)
	if sess == nil || now.After(sess.expiresAt) {
		s.QR.mu.Unlock()
		respond(w, http.StatusOK, map[string]any{"status": "expired"}, nil)
		return
	}
	if sess.claimedBy == nil {
		s.QR.mu.Unlock()
		respond(w, http.StatusOK, map[string]any{"status": "pending"}, nil)
		return
	}
	if sess.used {
		s.QR.mu.Unlock()
		// 已经取走过：再轮询就说"已用"，不重复发会话
		respond(w, http.StatusOK, map[string]any{"status": "used"}, nil)
		return
	}
	user := sess.claimedBy
	sess.used = true
	delete(s.QR.sessions, id) // 一次性：取走就销毁
	s.QR.mu.Unlock()

	token, err := s.Auth.IssueSession(user.ID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.setSessionCookies(w, r, token)
	s.Log.Info("扫码登录成功", "request_id", RequestID(r.Context()), "user", user.Username, "client_ip", clientIPFrom(r.Context()))
	respond(w, http.StatusOK, map[string]any{
		"status": "claimed",
		"user":   map[string]any{"username": user.Username, "display_name": user.DisplayName},
	}, nil)
}
