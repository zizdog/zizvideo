package api

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/zizdog/zizvideo/internal/domain"
)

// ============================================================================
// D11 磁盘告警 + 上传页「收件盘 / 存储盘」（用户 2026-09-24 报障：上传页显示的是
// **系统盘**的剩余空间，不是媒体库所在盘）。
//
// 一块盘算"吃紧"：剩余 < 5GB 或 < 5%。两处都用同一份判据（后端算好，前端只显示），
// 免得界面上两处数字互相打架。
// ============================================================================

const (
	diskLowFloorBytes uint64 = 5 << 30
	diskLowPercent           = 5
)

// diskJSON 是给界面看的一块盘。role 只有三种：data（数据目录）/ inbox（收件盘）/ library（媒体库）。
type diskJSON struct {
	Role       string `json:"role"`
	Label      string `json:"label"`
	Path       string `json:"path"`
	FreeBytes  uint64 `json:"free_bytes"`
	TotalBytes uint64 `json:"total_bytes"`
	FreePct    int    `json:"free_percent"`
	Low        bool   `json:"low"`
	Error      string `json:"error,omitempty"`
}

// inboxDisk：收件根可能还没建过（全新实例）——先建出来，否则 Statfs 读不到任何数字。
func (s *Server) inboxDisk() diskJSON {
	_ = os.MkdirAll(s.inboxRoot(), 0o700)
	return diskInfoOf("inbox", "收件盘（上传暂存）", s.inboxRoot())
}

func diskInfoOf(role, label, path string) diskJSON {
	d := diskJSON{Role: role, Label: label, Path: path}
	free, total, err := diskUsage(path)
	if err != nil {
		d.Error = err.Error()
		return d
	}
	d.FreeBytes, d.TotalBytes = free, total
	if total > 0 {
		d.FreePct = int(free * 100 / total)
	}
	d.Low = free < diskLowFloorBytes || (total > 0 && free*100/total < diskLowPercent)
	return d
}

// disksReport：数据目录 + 收件盘 + 每个媒体库根。库根可能重复（同一块盘多个库）也照列，
// 因为"哪个库在哪块盘上"正是用户要看的。
func (s *Server) disksReport() []diskJSON {
	out := []diskJSON{diskInfoOf("data", "数据目录（数据库/封面）", s.Cfg.DataDir)}
	out = append(out, s.inboxDisk())
	libs, err := s.DB.ListLibraries()
	if err == nil {
		for i := range libs {
			out = append(out, diskInfoOf("library", libs[i].Name, libs[i].RootPath))
		}
	}
	return out
}

func diskWarnings(list []diskJSON) []string {
	out := []string{}
	for _, d := range list {
		if d.Error != "" {
			out = append(out, d.Label+"：读不到磁盘信息（"+d.Error+"）")
			continue
		}
		if d.Low {
			out = append(out, d.Label+" 只剩 "+humanBytes(int64(d.FreeBytes))+"（"+itoa(d.FreePct)+"%），上传/转码可能失败")
		}
	}
	return out
}

// sameVolume 判断两个目录是否在同一卷（同一块盘）——跨卷时"审核通过"要真搬字节（慢但安全）。
func sameVolume(a, b string) bool {
	var sa, sb syscall.Stat_t
	if err := syscall.Stat(a, &sa); err != nil {
		return false
	}
	if err := syscall.Stat(b, &sb); err != nil {
		return false
	}
	return sa.Dev == sb.Dev
}

// HandleSystemDisks 给后台「系统」页：所有盘的剩余量与告警。
func (s *Server) HandleSystemDisks(w http.ResponseWriter, r *http.Request) {
	list := s.disksReport()
	respond(w, http.StatusOK, map[string]any{"disks": list, "warnings": diskWarnings(list)}, nil)
}

type uploadSpaceJSON struct {
	Inbox     diskJSON `json:"inbox"`
	Library   diskJSON `json:"library"`
	SameVol   bool     `json:"same_volume"`
	Warning   string   `json:"warning,omitempty"`
	LibraryID string   `json:"library_id,omitempty"`
	// Defaulted：用户没指定投递库，这块盘只是"他第一个可访问的库"（入库时管理员还能改）。
	Defaulted bool `json:"defaulted,omitempty"`
}

// HandleMyUploadSpace 给上传页：收件盘 + **目标媒体库所在盘**的剩余空间。
// 目标库取 ?library_id=；没给就用这个用户能访问的第一个库（与上传页选择器的默认一致）。
func (s *Server) HandleMyUploadSpace(w http.ResponseWriter, r *http.Request) {
	u := UserFrom(r.Context())
	if u == nil {
		s.fail(w, r, domain.ErrUnauthorized)
		return
	}
	scope, err0 := s.resolveScope(u)
	if err0 != nil {
		s.fail(w, r, err0)
		return
	}
	want := strings.TrimSpace(r.URL.Query().Get("library_id"))
	libs, err := s.DB.ListLibraries()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	var target *domain.Library
	for i := range libs {
		if !scope.Allows(libs[i].ID) {
			continue
		}
		if want != "" && libs[i].ID == want {
			target = &libs[i]
			break
		}
		if want == "" && target == nil {
			target = &libs[i]
		}
	}
	inbox := s.inboxDisk()
	out := uploadSpaceJSON{Inbox: inbox}
	if target == nil {
		out.Warning = "你还没有可访问的媒体库：现在只能传进收件盘，等管理员授权后才能入库。"
		respond(w, http.StatusOK, out, nil)
		return
	}
	out.LibraryID = target.ID
	out.Defaulted = want == ""

	out.Library = diskInfoOf("library", target.Name, target.RootPath)
	out.SameVol = sameVolume(s.inboxRoot(), target.RootPath)
	// 存储盘吃紧是最要紧的一条：收件盘够、存储盘不够，审核通过时照样会失败
	if out.Library.Error != "" {
		out.Warning = target.Name + "：读不到磁盘信息（" + out.Library.Error + "）"
	} else if out.Library.Low {
		out.Warning = target.Name + " 只剩 " + humanBytes(int64(out.Library.FreeBytes)) +
			"（" + itoa(out.Library.FreePct) + "%），审核通过（入库）可能失败"
	} else if inbox.Low {
		out.Warning = "收件盘只剩 " + humanBytes(int64(inbox.FreeBytes)) + "，大文件可能传不完"
	}
	respond(w, http.StatusOK, out, nil)
}

// ============================================================================
// D10 备份导出：把数据库快照 + 一份清单打成 tar.gz 下载。
// 不含视频文件与封面缓存（视频是用户自己的文件，封面能重新抽），清单里写明这一点。
// ============================================================================

// HandleExportBackup GET /api/v1/admin/backup
func (s *Server) HandleExportBackup(w http.ResponseWriter, r *http.Request) {
	dir, err := os.MkdirTemp("", "zv-backup-")
	if err != nil {
		s.fail(w, r, domain.New("BACKUP_TEMP", "建临时目录失败："+err.Error(), 500))
		return
	}
	defer os.RemoveAll(dir)
	snap := filepath.Join(dir, "zizvideo.db")
	// VACUUM INTO 出一份一致的快照（WAL 也一并落进快照），不阻塞读、不用停机。
	if _, err := s.DB.Exec("VACUUM INTO ?", snap); err != nil {
		s.fail(w, r, domain.New("BACKUP_VACUUM", "数据库快照失败："+err.Error(), 500))
		return
	}
	libs, _ := s.DB.ListLibraries()
	mediaCount, _ := s.DB.CountMedia("")
	users, _ := s.DB.ListUsers()
	manifest := map[string]any{
		"version": Version, "created_at": domain.NowString(), "schema": "sqlite",
		"data_dir": s.Cfg.DataDir, "listen": s.Cfg.Listen,
		"libraries": len(libs), "media": mediaCount, "users": len(users),
		"note": "只含数据库快照：用户/媒体库/剧场/观看进度/上传记录。不含视频文件与封面缓存" +
			"（视频请另外备份媒体库目录；封面会在播放/扫描时重新生成）。",
	}
	manifestBody, _ := json.MarshalIndent(manifest, "", "  ")

	name := "zizvideo-backup-" + time.Now().Format("20060102-150405") + ".tar.gz"
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+name+"\"")
	gz := gzip.NewWriter(w)
	defer gz.Close()
	tw := tar.NewWriter(gz)
	defer tw.Close()
	if err := addFileToTar(tw, snap, "zizvideo.db"); err != nil {
		s.Log.Warn("备份打包失败", "error", err.Error())
		return
	}
	hdr := &tar.Header{Name: "manifest.json", Mode: 0o600, Size: int64(len(manifestBody)),
		ModTime: time.Now()}
	if err := tw.WriteHeader(hdr); err != nil {
		return
	}
	if _, err := tw.Write(manifestBody); err != nil {
		return
	}
	if err := tw.Flush(); err != nil {
		return
	}
	s.audit(r, "system.backup", "db", true, fmt.Sprintf("media:%d", mediaCount))
}

func addFileToTar(tw *tar.Writer, path, name string) error {
	st, err := os.Stat(path)
	if err != nil {
		return err
	}
	hdr := &tar.Header{Name: name, Mode: 0o600, Size: st.Size(), ModTime: st.ModTime()}
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(tw, f)
	return err
}
