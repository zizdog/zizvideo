package api_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// 门禁：分片写入内核（internal/api/upload_part.go）**全项目唯一一份** ——
// 后台管理员的 PUT 与用户投稿的 PUT 对同一批断点场景必须给出**同一个状态码 + 同一个 code**。
//
// 两条流水线的**响应体与清理策略**本来就不同（admin 写失败删半截、UGC 保留 .part 续传；
// admin 传完当场 rename、UGC 等 finish），所以这里只对"内核语义"取证：
// 状态码 + error.code（外加"该拒的时候 .part 有没有被动过"）。
//
// 为什么这条门禁能在修之前红：合并前两个端点各有一份实现，下面每一行至少有一个端点
// 与另一个端点对不上（例：断点 0 与磁盘不符时 admin 直接 TRUNCATE、UGC 回 409；
// 写超声明大小时 admin 是事后 400 UPLOAD_SIZE_MISMATCH、UGC 是 409/413）。
//
// 用例表一行同时跑两个端点，加用例只需往 uploadKernelCases 里塞一行。

type uploadKernelCase struct {
	name       string
	file       string // 每个用例独立文件名（避免 .part 撞车）
	size       int64  // 声明大小
	part       []byte // 预先摆到磁盘上的 .part 字节（"已收到"的事实）
	offset     int64  // Content-Range 起点
	body       []byte
	rawRange   string // 非空时直接当 Content-Range 用（非法头用例）
	wantStatus int
	wantCode   string // 空 = 成功
	wantPart   int    // 0=不断言；-1=必须不存在；>0=请求后 .part 的字节数
}

func uploadKernelCases() []uploadKernelCase {
	return []uploadKernelCase{
		{name: "断点正确续传", file: "resume.mp4", size: 6,
			part: []byte("abc"), offset: 3, body: []byte("def"),
			wantStatus: http.StatusOK},
		{name: "断点与磁盘不符", file: "mismatch.mp4", size: 6,
			part: []byte("abc"), offset: 9, body: []byte("xyz"),
			wantStatus: http.StatusConflict, wantCode: "UPLOAD_RESUME_MISMATCH", wantPart: 3},
		{name: "断点超过声明大小", file: "over-declared.mp4", size: 6,
			part: []byte("abcdefg"), offset: 7, body: []byte("z"),
			wantStatus: http.StatusConflict, wantCode: "UPLOAD_RESUME_MISMATCH", wantPart: 7},
		// 写超**声明大小**：两个端点都必须是 400 UPLOAD_SIZE_MISMATCH 并说清收到/声明多少
		// （说成"文件超过单文件上限 100 MB"就是谎报 —— 100MB 根本没超，超的是它自己声明的大小）。
		// 真撞**全局单文件上限**的 413 UPLOAD_FILE_TOO_LARGE 路径由 upload_limits_test.go 覆盖
		// （那条要造一个超过 upload_max_file_mb 的请求体，放这里不划算）。
		{name: "写超声明大小", file: "too-big.mp4", size: 6,
			part: []byte("abc"), offset: 3, body: []byte("defghi"),
			wantStatus: http.StatusBadRequest, wantCode: "UPLOAD_SIZE_MISMATCH"},
		{name: "断点头非法", file: "bad-range.mp4", size: 6,
			body: []byte("x"), rawRange: "pages 0-0/6",
			wantStatus: http.StatusBadRequest, wantCode: "UPLOAD_RANGE_INVALID", wantPart: -1},
	}
}

// kernelOutcome 是"端点跑完这一行之后能观察到的事实"。
type kernelOutcome struct {
	status     int
	code       string
	partExists bool
	partLen    int
}

func TestUploadPutKernelSharedByBothPipelines(t *testing.T) {
	e := newEnv(t)
	e.setupAdmin()
	e.newLibrary("内核库", e.Root)
	client, userID := e.ugcUser(t, "kerneluploader")
	if res, _, raw := e.write(http.MethodPatch, "/api/v1/users/"+userID,
		map[string]any{"can_upload": true}); res.StatusCode != http.StatusOK {
		t.Fatalf("开白名单失败 %d: %s", res.StatusCode, raw)
	}

	for _, c := range uploadKernelCases() {
		t.Run(c.name, func(t *testing.T) {
			admin := e.runAdminKernelCase(t, e.Root, c)
			ugc := e.runUGCKernelCase(t, client, c)

			assertKernelOutcome(t, "后台 PUT", c, admin)
			assertKernelOutcome(t, "UGC PUT", c, ugc)

			// 这就是"合并后内核语义真的统一了"的证据：两个端点必须一模一样。
			if admin.status != ugc.status || admin.code != ugc.code {
				t.Fatalf("两个端点语义不一致：后台=(%d,%q) UGC=(%d,%q)",
					admin.status, admin.code, ugc.status, ugc.code)
			}
		})
	}
}

func assertKernelOutcome(t *testing.T, which string, c uploadKernelCase, got kernelOutcome) {
	t.Helper()
	if got.status != c.wantStatus {
		t.Fatalf("%s：状态码 = %d，期望 %d（code=%q）", which, got.status, c.wantStatus, got.code)
	}
	if got.code != c.wantCode {
		t.Fatalf("%s：error.code = %q，期望 %q", which, got.code, c.wantCode)
	}
	switch {
	case c.wantPart > 0:
		if !got.partExists || got.partLen != c.wantPart {
			t.Fatalf("%s：请求后 .part 应仍是 %d 字节（被拒时不写不删），实际 exists=%v len=%d",
				which, c.wantPart, got.partExists, got.partLen)
		}
	case c.wantPart < 0:
		if got.partExists {
			t.Fatalf("%s：请求后不该有 .part，实际 %d 字节", which, got.partLen)
		}
	}
}

// runAdminKernelCase 走 /api/v1/admin/uploads/{id}/{index}：先开会话，再把 .part 摆成用例要的样子。
func (e *env) runAdminKernelCase(t *testing.T, dir string, c uploadKernelCase) kernelOutcome {
	t.Helper()
	uploadID, index := e.startAdminUpload(dir, c.file, int(c.size))
	part := filepath.Join(dir, c.file) + ".zvpart"
	if len(c.part) > 0 {
		if err := os.WriteFile(part, c.part, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	header := map[string]string{"Content-Range": uploadKernelRange(c)}
	res, raw := e.uploadPut(t, fmt.Sprintf("/api/v1/admin/uploads/%s/%d", uploadID, index), c.body, header)
	return uploadKernelOutcome(t, res.StatusCode, raw, part)
}

// runUGCKernelCase 走 /api/v1/uploads/{id}：先把条目开出来，再按条目真实 Path 摆 .part。
func (e *env) runUGCKernelCase(t *testing.T, client *http.Client, c uploadKernelCase) kernelOutcome {
	t.Helper()
	res, start, raw := e.ugcStart(t, client, c.file, int(c.size))
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("UGC 开会话失败 %d: %s", res.StatusCode, raw)
	}
	it, err := e.DB.GetUploadItem(start.Item.ID)
	if err != nil {
		t.Fatal(err)
	}
	part := it.Path + ".zvpart"
	if len(c.part) > 0 {
		if err := os.WriteFile(part, c.part, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	res, raw = e.uploadRaw(t, client, http.MethodPut, "/api/v1/uploads/"+it.ID, c.body,
		map[string]string{"Content-Range": uploadKernelRange(c)})
	return uploadKernelOutcome(t, res.StatusCode, raw, part)
}

func uploadKernelRange(c uploadKernelCase) string {
	if c.rawRange != "" {
		return c.rawRange
	}
	return fmt.Sprintf("bytes %d-%d/%d", c.offset, c.offset+int64(len(c.body))-1, c.size)
}

func uploadKernelOutcome(t *testing.T, status int, raw []byte, part string) kernelOutcome {
	t.Helper()
	out := kernelOutcome{status: status}
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("解析响应失败: %v (%s)", err, raw)
	}
	if env.Error != nil {
		out.code = env.Error.Code
	}
	if st, err := os.Stat(part); err == nil {
		out.partExists, out.partLen = true, int(st.Size())
	}
	return out
}
