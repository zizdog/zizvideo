// Package web wires the router, the embedded assets and the API handlers.
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/zizdog/zizvideo/internal/api"
)

// assetsFS holds the no-build frontend: plain ESM, hand-written CSS.
//
//go:embed all:assets
var assetsFS embed.FS

// Router builds the full handler tree: API first, static assets last.
func Router(s *api.Server) http.Handler {
	mux := http.NewServeMux()

	// Liveness and readiness are intentionally unauthenticated.
	mux.HandleFunc("GET /healthz", s.HandleHealthz)
	mux.HandleFunc("GET /readyz", s.HandleReadyz)

	mux.HandleFunc("GET /api/v1/setup/status", s.HandleSetupStatus)
	mux.HandleFunc("POST /api/v1/setup", s.HandleSetup)
	mux.HandleFunc("POST /api/v1/auth/login", s.HandleLogin)
	mux.HandleFunc("POST /api/v1/auth/logout", s.RequireAuth(s.HandleLogout))
	mux.HandleFunc("GET /api/v1/auth/me", s.RequireAuth(s.HandleMe))

	mux.HandleFunc("GET /api/v1/users", s.RequireAdmin(s.HandleListUsers))
	mux.HandleFunc("POST /api/v1/users", s.RequireAdmin(s.HandleCreateUser))
	mux.HandleFunc("PATCH /api/v1/users/{id}", s.RequireAdmin(s.HandlePatchUser))
	// P3：某用户的可见库（整体替换，回读一致）+ 默认可见库预览/补发。
	mux.HandleFunc("GET /api/v1/admin/users/{id}/libraries", s.RequireAdmin(s.HandleGetUserLibraries))
	mux.HandleFunc("PUT /api/v1/admin/users/{id}/libraries", s.RequireAdmin(s.HandlePutUserLibraries))
	mux.HandleFunc("GET /api/v1/admin/libraries/defaults", s.RequireAdmin(s.HandleGetDefaultLibraries))
	mux.HandleFunc("POST /api/v1/admin/libraries/defaults/backfill", s.RequireAdmin(s.HandleBackfillDefaultLibraries))

	mux.HandleFunc("GET /api/v1/libraries", s.RequireAdmin(s.HandleListLibraries))
	mux.HandleFunc("POST /api/v1/libraries", s.RequireAdmin(s.HandleCreateLibrary))
	mux.HandleFunc("GET /api/v1/libraries/{id}", s.RequireAdmin(s.HandleGetLibrary))
	mux.HandleFunc("PATCH /api/v1/libraries/{id}", s.RequireAdmin(s.HandlePatchLibrary))
	mux.HandleFunc("DELETE /api/v1/libraries/{id}", s.RequireAdmin(s.HandleDeleteLibrary))
	mux.HandleFunc("POST /api/v1/libraries/{id}/scan", s.RequireAdmin(s.HandleStartScan))
	mux.HandleFunc("POST /api/v1/libraries/{id}/purge-missing", s.RequireAdmin(s.HandlePurgeMissingMedia))
	mux.HandleFunc("GET /api/v1/scan-tasks/{id}", s.RequireAdmin(s.HandleGetScanTask))

	// 媒体库分组（用户 2026-09-22）：归类显示 + 批量操作 + 批量授权。
	// 组本身不是鉴权判据 —— 可见性仍由 storage.UserLibraryIDs 的"直授 ∪ 组授"决定。
	mux.HandleFunc("GET /api/v1/admin/library-groups", s.RequireAdmin(s.HandleListLibraryGroups))
	mux.HandleFunc("POST /api/v1/admin/library-groups", s.RequireAdmin(s.HandleCreateLibraryGroup))
	mux.HandleFunc("PATCH /api/v1/admin/library-groups/{id}", s.RequireAdmin(s.HandlePatchLibraryGroup))
	mux.HandleFunc("DELETE /api/v1/admin/library-groups/{id}", s.RequireAdmin(s.HandleDeleteLibraryGroup))
	mux.HandleFunc("PUT /api/v1/admin/library-groups/{id}/libraries", s.RequireAdmin(s.HandlePutGroupLibraries))
	mux.HandleFunc("POST /api/v1/admin/library-groups/{id}/action", s.RequireAdmin(s.HandleLibraryGroupAction))
	mux.HandleFunc("PUT /api/v1/libraries/{id}/group", s.RequireAdmin(s.HandleSetLibraryGroup))
	mux.HandleFunc("GET /api/v1/admin/users/{id}/library-groups", s.RequireAdmin(s.HandleGetUserLibraryGroups))
	mux.HandleFunc("PUT /api/v1/admin/users/{id}/library-groups", s.RequireAdmin(s.HandlePutUserLibraryGroups))

	// 用户端读内容一律走 s.WithLibraryScope（唯一判据）；列表类静默过滤，单条越权 404。
	mux.HandleFunc("GET /api/v1/media", s.RequireAuth(s.WithLibraryScope(s.HandleListMedia)))
	mux.HandleFunc("GET /api/v1/media/{id}", s.RequireAuth(s.WithLibraryScope(s.HandleGetMedia)))
	mux.HandleFunc("GET /api/v1/media/{id}/stream", s.RequireAuth(s.WithLibraryScope(s.HandleStream)))
	mux.HandleFunc("GET /api/v1/media/{id}/cover", s.RequireAuth(s.WithLibraryScope(s.HandleCover)))
	// 前台播放页的删除入口（仅管理员）：默认只删记录，delete_file=true 才动磁盘文件。
	mux.HandleFunc("DELETE /api/v1/admin/media/{id}", s.RequireAdmin(s.HandleDeleteMedia))
	mux.HandleFunc("GET /api/v1/feed/next", s.RequireAuth(s.WithLibraryScope(s.HandleFeedNext)))
	mux.HandleFunc("GET /api/v1/feed/settings", s.RequireAuth(s.HandleGetFeedSettings))
	mux.HandleFunc("PATCH /api/v1/feed/settings", s.RequireAuth(s.HandlePatchFeedSettings))

	mux.HandleFunc("PATCH /api/v1/me/progress/{mediaId}", s.RequireAuth(s.WithLibraryScope(s.HandlePatchProgress)))
	mux.HandleFunc("GET /api/v1/me/progress", s.RequireAuth(s.WithLibraryScope(s.HandleListProgress)))
	mux.HandleFunc("DELETE /api/v1/me/progress", s.RequireAuth(s.HandleClearProgress))
	mux.HandleFunc("GET /api/v1/me/favorites", s.RequireAuth(s.WithLibraryScope(s.HandleListFavorites)))
	mux.HandleFunc("DELETE /api/v1/me/favorites", s.RequireAuth(s.HandleClearFavorites))
	mux.HandleFunc("GET /api/v1/me/likes", s.RequireAuth(s.WithLibraryScope(s.HandleListLikes)))
	mux.HandleFunc("DELETE /api/v1/me/likes", s.RequireAuth(s.HandleClearLikes))
	mux.HandleFunc("GET /api/v1/me/watch-later", s.RequireAuth(s.WithLibraryScope(s.HandleListWatchLater)))
	mux.HandleFunc("DELETE /api/v1/me/watch-later", s.RequireAuth(s.HandleClearWatchLater))
	mux.HandleFunc("GET /api/v1/me/libraries", s.RequireAuth(s.WithLibraryScope(s.HandleMyLibraries)))
	mux.HandleFunc("POST /api/v1/me/favorites/{mediaId}", s.RequireAuth(s.WithLibraryScope(s.HandleAddFavorite)))
	mux.HandleFunc("DELETE /api/v1/me/favorites/{mediaId}", s.RequireAuth(s.WithLibraryScope(s.HandleRemoveFavorite)))
	mux.HandleFunc("POST /api/v1/me/watch-later/{mediaId}", s.RequireAuth(s.WithLibraryScope(s.HandleAddWatchLater)))
	mux.HandleFunc("DELETE /api/v1/me/watch-later/{mediaId}", s.RequireAuth(s.WithLibraryScope(s.HandleRemoveWatchLater)))
	mux.HandleFunc("POST /api/v1/media/{id}/reactions", s.RequireAuth(s.WithLibraryScope(s.HandleSetReaction)))
	mux.HandleFunc("PATCH /api/v1/media/{id}/reactions", s.RequireAuth(s.WithLibraryScope(s.HandleSetReaction)))
	mux.HandleFunc("DELETE /api/v1/media/{id}/reactions", s.RequireAuth(s.WithLibraryScope(s.HandleDeleteReaction)))

	// 剧场（短剧）：读给所有登录用户，写只有管理员；剧集只引用已有 media。
	mux.HandleFunc("GET /api/v1/series", s.RequireAuth(s.WithLibraryScope(s.HandleListSeries)))
	mux.HandleFunc("GET /api/v1/series/{id}", s.RequireAuth(s.WithLibraryScope(s.HandleGetSeries)))
	mux.HandleFunc("POST /api/v1/admin/series", s.RequireAdmin(s.HandleCreateSeries))
	mux.HandleFunc("PATCH /api/v1/admin/series/{id}", s.RequireAdmin(s.HandlePatchSeries))
	mux.HandleFunc("DELETE /api/v1/admin/series/{id}", s.RequireAdmin(s.HandleDeleteSeries))
	mux.HandleFunc("POST /api/v1/admin/series/{id}/media", s.RequireAdmin(s.HandleAddSeriesMedia))
	mux.HandleFunc("DELETE /api/v1/admin/series/{id}/media/{mediaId}", s.RequireAdmin(s.HandleRemoveSeriesMedia))
	mux.HandleFunc("PUT /api/v1/admin/series/{id}/order", s.RequireAdmin(s.HandleReorderSeries))
	mux.HandleFunc("POST /api/v1/admin/series/{id}/detect", s.RequireAdmin(s.HandleDetectSeries))
	// P2：批量一键识别（confirm 两段式）+ 跨库任务进度（job_tasks，迁移 0008）。
	mux.HandleFunc("POST /api/v1/admin/series/detect-all", s.RequireAdmin(s.HandleDetectAll))
	mux.HandleFunc("GET /api/v1/admin/tasks/{id}", s.RequireAdmin(s.HandleGetJobTask))
	// P1 转码队列：选中若干 media 排队转码（进度看 /admin/tasks/{id} 的 percent）。
	mux.HandleFunc("POST /api/v1/admin/transcodes", s.RequireAdmin(s.HandleStartTranscode))
	// P4：按目录建剧场。A=剧场内导入一个目录；B=按一级子目录批量建剧场（走任务中心）。
	mux.HandleFunc("POST /api/v1/admin/series/{id}/import-dir/preview", s.RequireAdmin(s.HandlePreviewSeriesDirImport))
	mux.HandleFunc("POST /api/v1/admin/series/{id}/import-dir", s.RequireAdmin(s.HandleSeriesDirImport))
	mux.HandleFunc("POST /api/v1/admin/series/import-dirs/preview", s.RequireAdmin(s.HandlePreviewSeriesDirs))
	mux.HandleFunc("POST /api/v1/admin/series/import-dirs", s.RequireAdmin(s.HandleSeriesDirsImport))
	// P5：上传（start / PUT 流式 / finish）。PUT 单独放开读超时（见 handlers_uploads.go）。
	mux.HandleFunc("POST /api/v1/admin/uploads/start", s.RequireAdmin(s.HandleUploadStart))
	mux.HandleFunc("PUT /api/v1/admin/uploads/{id}/{index}", s.RequireAdmin(s.HandleUploadPut))
	mux.HandleFunc("POST /api/v1/admin/uploads/{id}/finish", s.RequireAdmin(s.HandleUploadFinish))

	// 用户上传（UGC，docs/上传设计.md）：白名单闸门 RequireUploader；文件先落 inbox，
	// 审核通过才移进媒体库。PUT 与 /admin 那条一样单独放开读超时（见 handlers_ugc.go）。
	mux.HandleFunc("POST /api/v1/uploads", s.RequireUploader(s.HandleUGCStart))
	mux.HandleFunc("PUT /api/v1/uploads/{id}", s.RequireUploader(s.HandleUGCPut))
	mux.HandleFunc("GET /api/v1/uploads/{id}", s.RequireUploader(s.HandleUGCGet))
	mux.HandleFunc("DELETE /api/v1/uploads/{id}", s.RequireUploader(s.HandleUGCCancel))
	mux.HandleFunc("POST /api/v1/uploads/{id}/finish", s.RequireUploader(s.HandleUGCFinish))
	mux.HandleFunc("GET /api/v1/uploads/{id}/stream", s.RequireUploader(s.HandleUGCStream))
	mux.HandleFunc("GET /api/v1/uploads/{id}/cover", s.RequireUploader(s.HandleUGCCover))
	mux.HandleFunc("GET /api/v1/me/uploads", s.RequireUploader(s.HandleListMyUploads))
	// 后台「待审」：列表 + 通过（选库）/ 驳回。
	mux.HandleFunc("GET /api/v1/admin/uploads/pending", s.RequireAdmin(s.HandleAdminPendingUploads))
	mux.HandleFunc("POST /api/v1/admin/uploads/{id}/approve", s.RequireAdmin(s.HandleAdminApproveUpload))
	mux.HandleFunc("POST /api/v1/admin/uploads/{id}/reject", s.RequireAdmin(s.HandleAdminRejectUpload))

	mux.HandleFunc("GET /api/v1/admin/system/info", s.RequireAdmin(s.HandleSystemInfo))
	mux.HandleFunc("GET /api/v1/admin/audit", s.RequireAdmin(s.HandleAuditList))

	// 条目 8：注册开关（默认关）+ 唯一公开自助注册入口。
	mux.HandleFunc("GET /api/v1/admin/settings", s.RequireAdmin(s.HandleGetAdminSettings))
	mux.HandleFunc("PATCH /api/v1/admin/settings", s.RequireAdmin(s.HandlePatchAdminSettings))
	mux.HandleFunc("POST /api/v1/auth/register", s.HandleRegister)

	// 自动扫描：设置读写、状态回读、立即触发一轮（扫描仍走任务中心 202+task_id）。
	mux.HandleFunc("GET /api/v1/admin/autoscan", s.RequireAdmin(s.HandleGetAutoScan))
	mux.HandleFunc("PATCH /api/v1/admin/autoscan", s.RequireAdmin(s.HandlePatchAutoScan))
	mux.HandleFunc("POST /api/v1/admin/autoscan/run", s.RequireAdmin(s.HandleRunAutoScan))

	// 条目 11：媒体去重（判据 size+duration，默认只删记录）。
	mux.HandleFunc("GET /api/v1/admin/duplicates", s.RequireAdmin(s.HandleListDuplicates))
	mux.HandleFunc("POST /api/v1/admin/duplicates/delete-records", s.RequireAdmin(s.HandleDeleteDuplicateRecords))
	mux.HandleFunc("POST /api/v1/admin/duplicates/delete-files", s.RequireAdmin(s.HandleDeleteDuplicateFiles))

	// Allow roots + the directory picker. The literal "roots" path is registered
	// before the wildcard, so /media/roots never falls through to /media/{id}.
	mux.HandleFunc("GET /api/v1/media/roots", s.RequireAdmin(s.HandleListMediaRoots))
	mux.HandleFunc("POST /api/v1/media/roots", s.RequireAdmin(s.HandleAddMediaRoot))
	mux.HandleFunc("DELETE /api/v1/media/roots", s.RequireAdmin(s.HandleRemoveMediaRoot))
	mux.HandleFunc("GET /api/v1/fs/browse", s.RequireAdmin(s.HandleBrowseFS))

	// Unknown API paths must answer JSON, not the SPA shell.
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"data":null,"meta":{},"error":{"code":"VALIDATION_NOT_FOUND","message":"接口不存在"}}`))
	})
	mux.Handle("/", staticHandler(s))

	return s.Middleware(mux)
}

// staticHandler serves the frontend. 两条来源：
//   · 默认：内嵌资源（go:embed）—— 生产行为；
//   · ZV_ASSETS_DIR 设了且目录里有 index.html：**从磁盘读**（调试用，改 CSS 刷新即生效），
//     并且不缓存、不打版本 ETag，免得"改了看不到"。
//
// 用户 2026-09-24 报障"顶栏还有背景 / 图标位置没改"——代码里其实早就改了，是**前端被缓存**：
// 内嵌资源没有 Last-Modified，浏览器/WebView 只能按启发式缓存，升级后仍吃旧 CSS。
// 现在所有资源都带"版本 ETag + no-cache"：同版本内浏览器 304 复用，换版本立刻拿到新字节，
// 不再依赖用户手动清缓存（这正是"改了却像没改"的根因）。
func staticHandler(s *api.Server) http.Handler {
	sub, err := fs.Sub(assetsFS, "assets")
	if err != nil {
		panic(err)
	}
	fsys := http.FS(sub)
	devMode := false
	if dir := strings.TrimSpace(s.Cfg.AssetsDir); dir != "" {
		// 目录不可用就退回内嵌（绝不因为一个调试开关把界面弄成 404）。
		if st, serr := os.Stat(filepath.Join(dir, "index.html")); serr == nil && !st.IsDir() {
			fsys = http.FS(os.DirFS(dir))
			devMode = true
			s.Log.Warn("前端从磁盘读取（调试模式：改 CSS 刷新即生效，别在生产开）", "dir", dir)
		} else {
			s.Log.Error("ZV_ASSETS_DIR 不可用，已退回内嵌前端", "dir", dir, "error", serr)
		}
	}
	fileServer := http.FileServer(fsys)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if devMode {
			// 调试模式：不缓存、不发版本 ETag（本地文件会立刻变，缓存只会添乱）
			w.Header().Set("Cache-Control", "no-store")
			fileServer.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		if r.URL.Path == "/" || strings.HasSuffix(r.URL.Path, ".html") {
			w.Header().Set("Cache-Control", "no-cache, no-store")
		}
		w.Header().Set("ETag", `"zv-`+api.Version+`-`+r.URL.Path+`"`)
		fileServer.ServeHTTP(w, r)
	})
}
