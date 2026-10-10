package api

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/zizdog/zizvideo/internal/domain"
	"github.com/zizdog/zizvideo/internal/media"
)

// UGC 的收件箱与配额：路径拼装与校验、配额统计、条目视图，以及「移进媒体库 / 搬回 / 复制」的小工具。

const (
	// 配额 50 条 / 20GB，数据盘剩余低于 20GB 就不再收件（用户 2026-09-24 拍板）。
	ugcMaxItems      = 50
	ugcMaxTotalBytes = int64(20) << 30
	ugcMinFreeBytes  = int64(20) << 30
	ugcInboxName     = "inbox"
)

// inboxRoot 是待审文件的落点：默认 <数据目录>/inbox，可用 upload_inbox_dir 指到别的盘
// （媒体库在外置盘时，指到同一个卷上，审核通过就一直是瞬时 rename 而不是跨卷复制）。
func (s *Server) inboxRoot() string {
	if dir := strings.TrimSpace(s.Cfg.UploadInboxDir); dir != "" {
		return filepath.Clean(dir)
	}
	return filepath.Join(s.Cfg.DataDir, ugcInboxName)
}

// inboxUnsafe 检查收件箱是不是落在"媒体允许根"里面 —— 那样扫描器会把待审文件当正式内容入库。
// 配置错了只在启动时大声报一次，并退回默认位置（宁可慢一点，也不能让待审内容漏进库）。
func (s *Server) inboxUnsafe() bool {
	root := s.inboxRoot()
	for _, allow := range s.Roots.List() {
		if allow == "" {
			continue
		}
		if media.Within(root, allow) {
			return true
		}
	}
	return false
}

// inboxPath 只用服务端生成的值拼路径：用户 id + 日期 + 清理过的文件名。
func (s *Server) inboxPath(uploaderID, name string) (string, error) {
	clean, err := safeFileName(name)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(s.inboxRoot(), uploaderID, time.Now().Format("2006-01-02"))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", domain.New("UPLOAD_INBOX_FAILED", "创建收件目录失败："+err.Error(), 500)
	}
	return filepath.Join(dir, clean), nil
}

// ugcQuotaJSON 把配额与磁盘阈值一次交代清楚，前端据此提示而不是自己猜。
type ugcQuotaJSON struct {
	Items        int   `json:"items"`
	MaxItems     int   `json:"max_items"`
	Bytes        int64 `json:"bytes"`
	MaxBytes     int64 `json:"max_bytes"`
	FreeBytes    int64 `json:"free_bytes"`
	MinFreeBytes int64 `json:"min_free_bytes"`
}

func (s *Server) ugcQuota(uploaderID string) (ugcQuotaJSON, error) {
	items, bytes, err := s.DB.UploadUsage(uploaderID)
	if err != nil {
		return ugcQuotaJSON{}, err
	}
	// 收件根可能还没建过（全新实例）：先建出来，否则读不到剩余空间。
	if err := os.MkdirAll(s.inboxRoot(), 0o700); err != nil {
		return ugcQuotaJSON{}, domain.New("UPLOAD_INBOX_FAILED", "创建收件目录失败："+err.Error(), 500)
	}
	free, _ := availableBytes(s.inboxRoot())
	return ugcQuotaJSON{Items: items, MaxItems: ugcMaxItems, Bytes: bytes,
		MaxBytes: ugcMaxTotalBytes, FreeBytes: free, MinFreeBytes: ugcMinFreeBytes}, nil
}

// ugcItemJSON 是给客户端看的条目；received_bytes 以磁盘为准（进程重启后也准）。
type ugcItemJSON struct {
	domain.UploadItem
	URL string `json:"url,omitempty"`
}

func (s *Server) ugcItemView(it *domain.UploadItem) ugcItemJSON {
	view := ugcItemJSON{UploadItem: *it}
	view.Received = ugcReceivedBytes(it)
	if it.State != domain.UploadRejected {
		view.URL = "/api/v1/uploads/" + it.ID
	}
	return view
}

// ugcReceivedBytes 读磁盘上真实的进度（.zvpart 优先，已定稿就是最终文件）；
// 审核过的条目文件已经不在 inbox（搬进库/被删），按库里记的字节数回答。
func ugcReceivedBytes(it *domain.UploadItem) int64 {
	if it.State == domain.UploadApproved || it.State == domain.UploadRejected {
		return it.Received
	}
	if st, err := os.Stat(it.Path + partSuffix); err == nil {
		return st.Size()
	}
	if st, err := os.Stat(it.Path); err == nil {
		return st.Size()
	}
	return 0
}

// ugcItemFor 取条目并校验归属：别人的条目一律按"不存在"回答（不泄露存在性）。
func (s *Server) ugcItemFor(r *http.Request, id string) (*domain.UploadItem, error) {
	it, err := s.DB.GetUploadItem(id)
	if err != nil {
		return nil, domain.ErrNotFound
	}
	u := UserFrom(r.Context())
	if u == nil || (it.UploaderID != u.ID && u.Role != domain.RoleAdmin) {
		return nil, domain.ErrNotFound
	}
	return it, nil
}

// ============================================================================
//  文件移动
// ============================================================================

// moveIntoRoot 把 inbox 文件移进媒体库：目标必须落在库根内（复核一次），
// 同卷用 rename，跨卷退化成复制 + fsync + 删源（复制失败绝不动源文件）。
func moveIntoRoot(roots []string, libRoot, src, dst string) error {
	if _, err := media.ValidateMediaFile(roots, libRoot, dst); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err != nil {
		if err := copyThenRemove(src, dst); err != nil {
			return err
		}
	}
	// inbox 里的 .zvpart 是 0600（用户内容）；进了媒体库就跟扫描到的文件同权限 0644。
	if err := os.Chmod(dst, 0o644); err != nil {
		return err
	}
	return nil
}

// moveBack 是审核失败时的回滚：目标必须仍在 inbox 根内。
func moveBack(inboxRoot, src, dst string) error {
	if !media.Within(dst, inboxRoot) {
		return domain.ErrPathNotAllowed
	}
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	return copyThenRemove(src, dst)
}

func copyThenRemove(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		_ = os.Remove(dst)
		return err
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		_ = os.Remove(dst)
		return err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(dst)
		return err
	}
	return os.Remove(src)
}
