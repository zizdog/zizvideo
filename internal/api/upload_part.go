package api

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/zizdog/zizvideo/internal/domain"
)

// ============================================================================
//  分片写入内核：**全项目唯一一份**
// ============================================================================
//
// 后台管理员上传（handlers_uploads.go）与用户投稿（handlers_ugc.go）都走 writePart：
// 解析 Content-Range 断点 → 与磁盘上 .part 的实际字节数核对 → 打开 .part →
// io.Copy(带 http.MaxBytesReader 上限) → Sync/Close。
//
// 内核**只做这一件事**。调用方负责的业务判断（会话/归属/状态/路径在根内/配额）、
// HTTP 状态码与响应体、以及失败后的清理与落库都留在各自的 handler —— 两条流水线
// 在这些策略上本来就不同：
//   · 后台口：写失败就删掉半截 .part（用户要的就是重传）；整文件 PUT 没传完也删；
//     传完 os.Rename(.part → 最终名)。
//   · UGC：写失败保留 .part 供续传，绝不删；定稿由 finish 接口 rename；
//     另外把进度落库（SetUploadReceived）。
//
// 语义取两份老实现并集里**更严的一支**（两处有意收紧，见 2026-10-10 审计）：
//  1. 磁盘上 .part 的实际大小是"已收到"的**唯一事实**：offset 与它不一致一律 409
//     UPLOAD_RESUME_MISMATCH。老后台口只在 offset>0 时核对 ⇒ 断点 0 会把已有半截
//     TRUNCATE 掉、静默丢数据；现在 0 断点也对不上就拒（客户端据此重读断点）。
//  2. 写入上限 = min(MaxBytes, DeclaredSize-offset)（声明了大小就不许写超）。
//     老后台口用整文件上限兜底，写超了声明大小才在事后判 400；现在由
//     http.MaxBytesReader 在写入时就拦住 ⇒ 413，老后台口那条"收到的字节数超过声明
//     （UPLOAD_SIZE_MISMATCH）"的 400 分支因此永远不会再走到（已删）。
//
// 这里**不** os.Remove(.part)、不写数据库、不决定响应（老代码两处都判了 Sync 与
// Close 的错误，内核照样判；错误只回"码 + 事实"，文案由调用方给）。

// partPolicy 是调用方给的策略（内核不做业务判断）。
type partPolicy struct {
	PartPath     string      // 目标 .part 路径
	DeclaredSize int64       // 0 = 未声明（只按 MaxBytes 兜底）
	MaxBytes     int64       // 本次允许写入的字节上限
	Mode         os.FileMode // 新建 .part 的权限（后台 0644 / UGC 0600）
	QueryOffset  bool        // 是否额外接受 ?offset=（UGC 有这个兼容口，admin 没有）
}

// partResult 是内核交给调用方的事实：写失败时 Offset/Written/Total 照样有值
// （调用方据此落库进度、决定保留还是删除 .part）。
type partResult struct {
	Offset, Written, Total int64
	HasRange               bool
	// CapDeclared：这次的写入上限是**声明大小**（而不是全局单文件上限）拦住的。
	// 调用方据此给**准确**的文案：写超"声明大小"与写超"单文件上限"是两回事，
	// 前者说成"文件超过单文件上限 100 MB"就是谎报（2026-10-11 复核时抓到）。
	CapDeclared bool
}

// 内核只回码，文案由调用方给：前两条是"写"失败（区别于"前置校验"失败），
// 调用方据此决定要不要清掉半截 .part；这几条的措辞两条流水线本来就不一样
// （后台口"目标目录/已清理"，UGC"收件目录/已保留"），所以文案一律由调用方拼。
const (
	codePartOpenFail  = "UPLOAD_OPEN_FAILED"
	codePartTooLarge  = "UPLOAD_FILE_TOO_LARGE"
	codePartWriteFail = "UPLOAD_WRITE_FAILED"
)

// writePart 把请求体写进 p.PartPath；返回写入统计或带码的 domain 错误
// （调用方负责响应与清理）。它不写响应体。
func (s *Server) writePart(w http.ResponseWriter, r *http.Request, p partPolicy) (partResult, *domain.Error) {
	var out partResult
	offset, hasRange, oerr := resumeOffset(r.Header.Get("Content-Range"))
	if oerr != nil {
		return out, domain.New("UPLOAD_RANGE_INVALID", "断点信息不合法", 400)
	}
	if !hasRange && p.QueryOffset {
		if raw := strings.TrimSpace(r.URL.Query().Get("offset")); raw != "" {
			n, aerr := strconv.ParseInt(raw, 10, 64)
			if aerr != nil || n < 0 {
				return out, domain.New("UPLOAD_RANGE_INVALID", "断点位置不合法", 400)
			}
			offset = n
		}
	}
	out.Offset, out.HasRange = offset, hasRange

	// 磁盘上的 .part 才是事实：任何不一致都拒（不许 TRUNCATE 掉别人已收到的字节）。
	var received int64
	if st, serr := os.Stat(p.PartPath); serr == nil {
		received = st.Size()
	}
	if offset != received {
		return out, domain.New("UPLOAD_RESUME_MISMATCH",
			fmt.Sprintf("断点位置与已收到的内容不一致（服务端已有 %d 字节）", received), 409)
	}
	// 断点超过声明大小：收到的东西比声明的还多，只能拒（错误码与断点不符同族）。
	if p.DeclaredSize > 0 && offset > p.DeclaredSize {
		return out, domain.New("UPLOAD_RESUME_MISMATCH", "已收到的内容超过声明大小", 409)
	}

	flags := os.O_CREATE | os.O_WRONLY
	if received > 0 {
		flags |= os.O_APPEND
	} else {
		flags |= os.O_TRUNC
	}
	f, err := os.OpenFile(p.PartPath, flags, p.Mode)
	if err != nil {
		// 只回事实（原因），"目标目录/收件目录"这层措辞由调用方加。
		return out, domain.New(codePartOpenFail, err.Error(), 500)
	}
	limit := p.MaxBytes
	if p.DeclaredSize > 0 {
		if remain := p.DeclaredSize - offset; remain < limit {
			limit, out.CapDeclared = remain, true
		}
	}
	written, cerr := io.Copy(f, http.MaxBytesReader(w, r.Body, limit))
	syncErr := f.Sync()
	closeErr := f.Close()
	out.Written, out.Total = written, offset+written
	if cerr != nil || syncErr != nil || closeErr != nil {
		if isTooLarge(cerr) {
			return out, domain.New(codePartTooLarge, "写入超过上限", 413)
		}
		return out, domain.New(codePartWriteFail, "上传中断", 400)
	}
	return out, nil
}

// uploadPartError 把内核错误翻成调用方自己的文案（码与状态码沿用内核给的事实）。
// 内核不认识业务文案：同一条 UPLOAD_WRITE_FAILED 在后台口是"已清理"、在 UGC 是"已保留"；
// dirPrefix 只用于 UPLOAD_OPEN_FAILED（"无法写入目标目录："/"无法写入收件目录："）。
func uploadPartError(err *domain.Error, dirPrefix, tooLarge, failed string) *domain.Error {
	switch err.Code {
	case codePartOpenFail:
		return domain.New(err.Code, dirPrefix+err.Message, err.Status)
	case codePartTooLarge:
		return domain.New(err.Code, tooLarge, err.Status)
	case codePartWriteFail:
		return domain.New(err.Code, failed, err.Status)
	}
	return err
}

// partSuffix 是"还没传完"的临时后缀：两条流水线共用（.zvpart）。
const partSuffix = ".zvpart"

func isTooLarge(err error) bool {
	var maxErr *http.MaxBytesError
	return errors.As(err, &maxErr)
}

// resumeOffset reads "bytes <start>-<end>/<total>"; empty means start from zero.
// hasRange=true 表示这是分块（未传完时保留 .part 等下一块）。
func resumeOffset(header string) (int64, bool, error) {
	h := strings.TrimSpace(header)
	if h == "" {
		return 0, false, nil
	}
	if !strings.HasPrefix(strings.ToLower(h), "bytes ") {
		return 0, true, errors.New("bad unit")
	}
	spec := strings.TrimSpace(h[len("bytes "):])
	spec = strings.SplitN(spec, "/", 2)[0]
	start := strings.SplitN(spec, "-", 2)[0]
	n, err := strconv.ParseInt(strings.TrimSpace(start), 10, 64)
	if err != nil || n < 0 {
		return 0, true, errors.New("bad start")
	}
	return n, true, nil
}
