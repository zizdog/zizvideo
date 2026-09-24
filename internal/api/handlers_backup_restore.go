package api

import (
	"archive/tar"
	"compress/gzip"
	"database/sql"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/zizdog/zizvideo/internal/domain"
	"github.com/zizdog/zizvideo/internal/storage"
)

// ============================================================================
// ③ 备份恢复（配 D10 的导出）。这是**会整体替换数据库**的操作，所以规矩比别处严：
//   1. 两段式：先「看里面是什么」（解包 + 校验 + 报数），确认后才动；
//   2. 确认要说口令（跟"连文件一起删"同一套纪律）；
//   3. 动手前**自动把当前库备份一份**（路径写在回执里，出事能退回去）；
//   4. 旧库比当前二进制的 schema 还新 ⇒ 拒绝（不支持降级，别把库弄成半新半旧）；
//   5. 有扫描/转码在跑 ⇒ 拒绝（别在写入者脚下换库）；
//   6. 换文件时先干掉 -wal/-shm，否则旧 WAL 会污染新库（SQLite 的经典坑）。
// ============================================================================

const (
	restoreConfirmWord = "恢复"
	restoreMaxUpload   = 1 << 30 // 1GB 上限：再大就不是"备份"了
	restoreTTL         = 30 * time.Minute
)

type restoreStash struct {
	path     string
	name     string
	manifest map[string]any
	created  time.Time
}

var (
	restoreMu    sync.Mutex
	restoreStore = map[string]restoreStash{}
)

func (s *Server) restoreDir() string { return filepath.Join(s.Cfg.DataDir, "restore") }

// requiredTables 是"这确实是个 zizvideo 库"的最低判据（缺一个就不是我们的库）。
var requiredTables = []string{"users", "media_libraries", "media", "schema_migrations"}

// inspectBackupDB 用只读方式打开候选库，校验 + 报数（不动任何东西）。
func inspectBackupDB(path string) (map[string]any, []string, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro&_pragma=busy_timeout(3000)")
	if err != nil {
		return nil, nil, err
	}
	defer db.Close()
	warnings := []string{}
	for _, table := range requiredTables {
		var n int
		if err := db.QueryRow(`SELECT COUNT(1) FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&n); err != nil {
			return nil, nil, err
		}
		if n == 0 {
			return nil, nil, domain.New("RESTORE_NOT_ZIZVIDEO",
				"这不像 zizvideo 的备份（缺表 "+table+"）", 400)
		}
	}
	counts := map[string]any{}
	for _, pair := range [][2]string{
		{"users", "SELECT COUNT(1) FROM users WHERE deleted_at IS NULL"},
		{"libraries", "SELECT COUNT(1) FROM media_libraries"},
		{"media", "SELECT COUNT(1) FROM media WHERE deleted_at IS NULL"},
		{"series", "SELECT COUNT(1) FROM series"},
	} {
		var n int
		// 表可能来自更老的版本（比如还没有 series）：数不出来就记 0 并说明
		if err := db.QueryRow(pair[1]).Scan(&n); err != nil {
			counts[pair[0]] = 0
			warnings = append(warnings, "读不到 "+pair[0]+" 计数（老版本备份？）")
			continue
		}
		counts[pair[0]] = n
	}
	var version int
	if err := db.QueryRow(`SELECT COALESCE(MAX(version),0) FROM schema_migrations`).Scan(&version); err != nil {
		return nil, nil, err
	}
	counts["schema_version"] = version
	return counts, warnings, nil
}

// HandleRestorePreview 收下备份文件、解包、校验、报数（不改任何东西）。
func (s *Server) HandleRestorePreview(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, restoreMaxUpload)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		s.fail(w, r, domain.New("RESTORE_UPLOAD_BAD", "上传的备份读不出来："+err.Error(), 400))
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		s.fail(w, r, domain.New("RESTORE_UPLOAD_BAD", "没有收到备份文件（字段名 file）", 400))
		return
	}
	defer file.Close()

	if err := os.MkdirAll(s.restoreDir(), 0o700); err != nil {
		s.fail(w, r, domain.New("RESTORE_TEMP", "建暂存目录失败："+err.Error(), 500))
		return
	}
	dir, err := os.MkdirTemp(s.restoreDir(), "in-")
	if err != nil {
		s.fail(w, r, domain.New("RESTORE_TEMP", "建临时目录失败："+err.Error(), 500))
		return
	}
	dbPath := filepath.Join(dir, "candidate.db")
	if err := extractBackupDB(file, dbPath); err != nil {
		_ = os.RemoveAll(dir)
		s.fail(w, r, err)
		return
	}

	counts, warnings, err := inspectBackupDB(dbPath)
	if err != nil {
		_ = os.RemoveAll(dir)
		s.fail(w, r, err)
		return
	}
	// 降级不支持：备份的 schema 比当前二进制还新 ⇒ 明确拒绝（别换上去让程序半死不活）
	cur := schemaVersionOrZero(s)
	if v, _ := counts["schema_version"].(int); v > cur {
		_ = os.RemoveAll(dir)
		s.fail(w, r, domain.New("RESTORE_SCHEMA_TOO_NEW",
			fmt.Sprintf("这份备份的库结构（v%d）比当前程序（v%d）还新，不能恢复", v, cur), 409))
		return
	}
	if v, _ := counts["schema_version"].(int); v < cur {
		warnings = append(warnings, fmt.Sprintf("备份是 v%d，当前是 v%d：恢复后会自动补齐迁移", v, cur))
	}
	if users, _ := counts["users"].(int); users == 0 {
		warnings = append(warnings, "备份里一个账号都没有：恢复后要先重新初始化管理员")
	}

	token := domain.NewID("rst")
	restoreMu.Lock()
	// 过期的一次性暂存清掉（免得磁盘上堆一堆候选库）
	for k, v := range restoreStore {
		if time.Since(v.created) > restoreTTL {
			_ = os.RemoveAll(filepath.Dir(v.path))
			delete(restoreStore, k)
		}
	}
	restoreStore[token] = restoreStash{path: dbPath, name: header.Filename,
		manifest: counts, created: time.Now()}
	restoreMu.Unlock()

	s.audit(r, "system.restore.preview", "file:"+header.Filename, true, "")
	respond(w, http.StatusOK, map[string]any{
		"applied": false, "token": token, "file": header.Filename,
		"counts": counts, "warnings": warnings,
		"confirm_word": restoreConfirmWord,
		"note":         "确认前什么都没改；确认后我会先把当前数据库备份一份再替换。",
	}, nil)
}

// extractBackupDB 从上传内容里取出数据库：支持 tar.gz（D10 导出的形状）与裸 .db。
func extractBackupDB(r io.Reader, dst string) error {
	head := make([]byte, 2)
	n, err := io.ReadFull(r, head)
	if err != nil && err != io.ErrUnexpectedEOF {
		return domain.New("RESTORE_READ_FAILED", "读取上传内容失败", 400)
	}
	head = head[:n]
	stream := io.MultiReader(strings.NewReader(string(head)), r)
	if n == 2 && head[0] == 0x1f && head[1] == 0x8b {
		gz, err := gzip.NewReader(stream)
		if err != nil {
			return domain.New("RESTORE_BAD_GZIP", "不是合法的 gzip："+err.Error(), 400)
		}
		defer gz.Close()
		tr := tar.NewReader(gz)
		found := false
		for {
			hdr, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return domain.New("RESTORE_BAD_TAR", "tar 读取失败："+err.Error(), 400)
			}
			// 只认数据库文件；其余条目（manifest.json 等）跳过，但路径必须干净
			if strings.Contains(hdr.Name, "..") || strings.HasPrefix(hdr.Name, "/") {
				return domain.New("RESTORE_BAD_PATH", "备份里有不安全的路径："+hdr.Name, 400)
			}
			if filepath.Base(hdr.Name) != "zizvideo.db" {
				continue
			}
			out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
			if err != nil {
				return domain.New("RESTORE_TEMP", "写入临时库失败："+err.Error(), 500)
			}
			if _, err := io.Copy(out, tr); err != nil {
				_ = out.Close()
				return domain.New("RESTORE_WRITE_FAILED", "解包失败："+err.Error(), 500)
			}
			if err := out.Close(); err != nil {
				return domain.New("RESTORE_WRITE_FAILED", "落盘失败："+err.Error(), 500)
			}
			found = true
			break
		}
		if !found {
			return domain.New("RESTORE_NO_DB", "备份里没有 zizvideo.db", 400)
		}
		return nil
	}
	// 裸数据库文件：直接落盘，稍后由 SQLite 自己判合法性
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return domain.New("RESTORE_TEMP", "写入临时库失败："+err.Error(), 500)
	}
	defer out.Close()
	if _, err := io.Copy(out, stream); err != nil {
		return domain.New("RESTORE_WRITE_FAILED", "写入失败："+err.Error(), 500)
	}
	return nil
}

// HandleRestoreApply 执行恢复：口令 → 自备份 → 停写入者 → 换文件 → 重开库。
func (s *Server) HandleRestoreApply(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token   string `json:"token"`
		Confirm string `json:"confirm"`
	}
	if err := s.decodeJSON(w, r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if strings.TrimSpace(req.Confirm) != restoreConfirmWord {
		s.fail(w, r, domain.New("RESTORE_CONFIRM_REQUIRED",
			"请输入「"+restoreConfirmWord+"」两个字确认（这一步会整体替换数据库）", 400))
		return
	}
	restoreMu.Lock()
	stash, ok := restoreStore[req.Token]
	if ok {
		delete(restoreStore, req.Token)
	}
	restoreMu.Unlock()
	if !ok {
		s.fail(w, r, domain.New("RESTORE_TOKEN_INVALID",
			"这次恢复的候选备份已过期，请重新选文件（先看一遍再确认）", 409))
		return
	}
	defer os.RemoveAll(filepath.Dir(stash.path))

	// 写入者还在跑就别换库（换了它的 in-flight 写会落到新库上，页码/路径全乱）
	if s.Transcodes != nil && s.Transcodes.Busy() {
		s.fail(w, r, domain.New("RESTORE_BUSY", "有转码任务在跑，等它结束再恢复", 409))
		return
	}
	if libs, err := s.DB.ListLibraries(); err == nil && s.Tasks != nil {
		for i := range libs {
			if s.Tasks.Busy(libs[i].ID) {
				s.fail(w, r, domain.New("RESTORE_BUSY", "有扫描任务在跑，等它结束再恢复", 409))
				return
			}
		}
	}
	// 再校验一次（暂存期间文件可能被清掉）
	counts, _, err := inspectBackupDB(stash.path)
	if err != nil {
		s.fail(w, r, err)
		return
	}

	// ① 先把当前库备份一份（VACUUM INTO，一致快照）
	backupDir := filepath.Join(s.Cfg.DataDir, "backups")
	if err := os.MkdirAll(backupDir, 0o700); err != nil {
		s.fail(w, r, domain.New("RESTORE_BACKUP_DIR", "建备份目录失败："+err.Error(), 500))
		return
	}
	safety := filepath.Join(backupDir, "pre-restore-"+time.Now().Format("20060102-150405")+".db")
	if _, err := s.DB.Exec("VACUUM INTO ?", safety); err != nil {
		s.fail(w, r, domain.New("RESTORE_SAFETY_FAILED",
			"恢复前的自动备份失败，已中止（你的数据没动）："+err.Error(), 500))
		return
	}
	if _, err := os.Stat(safety); err != nil {
		s.fail(w, r, domain.New("RESTORE_SAFETY_FAILED", "自动备份回读失败，已中止", 500))
		return
	}

	// ② 换文件：旧库（含 -wal/-shm）先挪走，再把候选库放到位
	live := s.Cfg.DatabasePath
	aside := live + ".replaced-" + time.Now().Format("150405")
	if err := s.swapDatabase(live, stash.path, aside); err != nil {
		// 尽量把现场还原回去（aside 还在就换回来）
		_ = s.swapDatabase(live, aside, live+".failed-"+time.Now().Format("150405"))
		s.fail(w, r, domain.New("RESTORE_SWAP_FAILED",
			"替换数据库失败，已尝试还原原库："+err.Error(), 500))
		return
	}
	// ③ 重开连接（同一个 *storage.DB 指针，所有引用继续有效）+ 跑迁移
	fresh, err := storage.Open(live)
	if err != nil {
		s.fail(w, r, domain.New("RESTORE_REOPEN_FAILED",
			"新库打不开，原库已备份在 "+safety+"，请把它复制回 "+live, 500))
		return
	}
	s.DB.Swap(fresh)
	_ = os.Remove(aside)
	_ = os.Remove(live + "-wal")
	_ = os.Remove(live + "-shm")

	s.audit(r, "system.restore.apply", "db:"+live, true, "safety:"+filepath.Base(safety))
	respond(w, http.StatusOK, map[string]any{
		"applied": true, "safety_backup": safety, "counts": counts,
		"note": "已恢复。原来的库备份在 " + safety + "（建议重启一次服务，并重新登录）。",
	}, nil)
}

// swapDatabase 把 src 换成 dst：dst（连同 -wal/-shm）挪到 aside，再把 src 复制成 dst。
// 用复制而不是 rename：候选库在临时目录（可能跨卷），rename 会失败。
func (s *Server) swapDatabase(dst, src, aside string) error {
	if err := s.DB.Close(); err != nil {
		return fmt.Errorf("关闭当前数据库失败: %w", err)
	}
	if err := os.Rename(dst, aside); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("挪走当前库失败: %w", err)
	}
	_ = os.Remove(dst + "-wal")
	_ = os.Remove(dst + "-shm")
	if err := copyFile(src, dst); err != nil {
		return fmt.Errorf("放入新库失败: %w", err)
	}
	if _, err := os.Stat(dst); err != nil {
		return fmt.Errorf("新库回读失败: %w", err)
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}
