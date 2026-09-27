package storage

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/zizdog/zizvideo/internal/domain"
)

// batchSize 是导入/登记的分块大小：每块一个事务，避免逐行 autocommit 的 fsync
// 把两万文件的导入拖成分钟级。
const batchSize = 500

const mediaCols = `id, library_id, path, title, size, mtime_ns, container,
	video_codec, audio_codec, width, height, duration_ms, bitrate, fps,
	status, error_class, error_message, COALESCE(missing_since,''), created_at, updated_at,
	transcode_state, transcode_note, loudness_lufs`

// mediaColsQ is mediaCols qualified for JOINs (created_at 会被别的表撞名).
const mediaColsQ = `m.id, m.library_id, m.path, m.title, m.size, m.mtime_ns, m.container,
	m.video_codec, m.audio_codec, m.width, m.height, m.duration_ms, m.bitrate, m.fps,
	m.status, m.error_class, m.error_message, COALESCE(m.missing_since,''), m.created_at, m.updated_at,
	m.transcode_state, m.transcode_note, m.loudness_lufs`

func scanMedia(s interface{ Scan(...any) error }) (*domain.Media, error) {
	var m domain.Media
	if err := s.Scan(&m.ID, &m.LibraryID, &m.Path, &m.Title, &m.Size, &m.MtimeNS, &m.Container,
		&m.Codecs.Video, &m.Codecs.Audio, &m.Width, &m.Height, &m.DurationMS, &m.Bitrate, &m.FPS,
		&m.Status, &m.ErrorClass, &m.ErrorMessage, &m.MissingSince, &m.CreatedAt, &m.UpdatedAt,
		&m.TranscodeState, &m.TranscodeNote, &m.LoudnessLUFS); err != nil {
		return nil, err
	}
	return &m, nil
}

// MediaByPath loads the live row for a library+normalized path, or nil.
func (db *DB) MediaByPath(libraryID, normalizedPath string) (*domain.Media, error) {
	row := db.QueryRow(`SELECT `+mediaCols+` FROM media
		WHERE library_id = ? AND normalized_path = ? AND deleted_at IS NULL`,
		libraryID, normalizedPath)
	m, err := scanMedia(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return m, err
}

// getMedia loads one live media row without a scope check; only storage may use
// it. The API must go through GetMediaIn so a missing scope cannot compile.
func (db *DB) getMedia(id string) (*domain.Media, error) {
	row := db.QueryRow(`SELECT `+mediaCols+` FROM media WHERE id = ? AND deleted_at IS NULL`, id)
	m, err := scanMedia(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, domain.ErrNotFound
	}
	return m, err
}

// GetMediaIn loads one live media row inside the caller's scope; a row outside
// the scope is ErrNotFound, i.e. indistinguishable from a missing one (B.5).
func (db *DB) GetMediaIn(scope domain.LibraryScope, id string) (*domain.Media, error) {
	w, sargs := scopeWhere(scope, "library_id")
	args := append([]any{id}, sargs...)
	row := db.QueryRow(`SELECT `+mediaCols+` FROM media WHERE id = ? AND deleted_at IS NULL`+w, args...)
	m, err := scanMedia(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, domain.ErrNotFound
	}
	return m, err
}

// InsertMedia creates a new media row.
func (db *DB) InsertMedia(m *domain.Media) error {
	now := domain.NowString()
	m.CreatedAt, m.UpdatedAt = now, now
	_, err := db.Exec(`INSERT INTO media (id, library_id, path, normalized_path, title, size,
		mtime_ns, container, video_codec, audio_codec, width, height, duration_ms, bitrate, fps,
		status, error_class, error_message, probe_attempts, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		m.ID, m.LibraryID, m.Path, m.Path, m.Title, m.Size, m.MtimeNS, m.Container,
		m.Codecs.Video, m.Codecs.Audio, m.Width, m.Height, m.DurationMS, m.Bitrate, m.FPS,
		m.Status, m.ErrorClass, m.ErrorMessage, 0, now, now)
	return err
}

// UpdateMediaProbe writes probed metadata and clears any stale failure state.
func (db *DB) UpdateMediaProbe(m *domain.Media) error {
	_, err := db.Exec(`UPDATE media SET path = ?, title = ?, size = ?, mtime_ns = ?,
		container = ?, video_codec = ?, audio_codec = ?, width = ?, height = ?, duration_ms = ?,
		bitrate = ?, fps = ?, status = ?, error_class = '', error_message = '',
		probe_attempts = 0, missing_since = NULL, updated_at = ?
		WHERE id = ?`,
		m.Path, m.Title, m.Size, m.MtimeNS, m.Container, m.Codecs.Video, m.Codecs.Audio,
		m.Width, m.Height, m.DurationMS, m.Bitrate, m.FPS, m.Status, domain.NowString(), m.ID)
	return err
}

// SetMediaTranscode 写转码状态与结论（失败原因给人看，不覆盖探测错误）。
func (db *DB) SetMediaTranscode(id, state, note string) error {
	_, err := db.Exec(`UPDATE media SET transcode_state = ?, transcode_note = ?, updated_at = ?
		WHERE id = ? AND deleted_at IS NULL`, state, truncate(note, 300), domain.NowString(), id)
	return err
}

// MarkProbeFailed records a classified probe failure.
func (db *DB) MarkProbeFailed(id, class, message string, attempts int) error {
	_, err := db.Exec(`UPDATE media SET status = ?, error_class = ?, error_message = ?,
		probe_attempts = ?, missing_since = NULL, updated_at = ? WHERE id = ?`,
		domain.MediaProbeFail, class, truncate(message, 300), attempts, domain.NowString(), id)
	return err
}

// MarkMissing flags a row as absent since the given time without deleting it.
func (db *DB) MarkMissing(id, since string) error {
	_, err := db.Exec(`UPDATE media SET missing_since = ?, updated_at = ?
		WHERE id = ? AND deleted_at IS NULL`, since, domain.NowString(), id)
	return err
}

// ClearMissing removes a stale missing marker.
func (db *DB) ClearMissing(id string) error {
	_, err := db.Exec(`UPDATE media SET missing_since = NULL, updated_at = ?
		WHERE id = ? AND missing_since IS NOT NULL`, domain.NowString(), id)
	return err
}

// ApplyDeletions soft-deletes rows in one transaction.
func (db *DB) ApplyDeletions(ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	now := domain.NowString()
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	stmt, err := tx.Prepare(`UPDATE media SET deleted_at = ?, updated_at = ? WHERE id = ?`)
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	defer stmt.Close()
	for _, id := range ids {
		if _, err := stmt.Exec(now, now, id); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// RepointMediaPath 把一行改指到新路径（改名/移动识别）：**保留 id**，所以观看进度、
// 收藏、稍后再看、剧场成员关系全部跟着走；顺手清掉可能存在的 missing_since。
func (db *DB) RepointMediaPath(id, newPath, title string) error {
	_, err := db.Exec(`UPDATE media SET path = ?, normalized_path = ?, title = ?,
		missing_since = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
		newPath, newPath, title, domain.NowString(), id)
	return err
}

// MediaPathRef 是"按 size+mtime 找同一条视频"时用的最小字段集（识别跨库移动用，见 scanner.migrateRenamed）。
type MediaPathRef struct {
	ID           string
	LibraryID    string
	Path         string
	Title        string
	Status       string
	MissingSince string
}

// MediaBySizeMtime 跨库列出 (size, mtime) 完全相同的记录。
// 用途只有一个：文件被**移动**（可能换了库）时，把旧记录改指到新路径，而不是"新建一条 + 留一条缺失"
// （用户 2026-09-27 报障：A 库的视频移到 B 库后，去重里冒出这些视频）。
func (db *DB) MediaBySizeMtime(size, mtimeNS int64) ([]MediaPathRef, error) {
	rows, err := db.Query(`SELECT id, library_id, path, title, status, COALESCE(missing_since,'')
		FROM media WHERE deleted_at IS NULL AND size = ? AND mtime_ns = ?`, size, mtimeNS)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MediaPathRef{}
	for rows.Next() {
		var r MediaPathRef
		if err := rows.Scan(&r.ID, &r.LibraryID, &r.Path, &r.Title, &r.Status, &r.MissingSince); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// RepointMedia 把一条记录改指到新路径，并（必要时）换库 —— 识别"文件被移动"时用。
// 保留 id，所以观看进度、收藏、稍后再看、剧场成员全部跟着走；同时清掉缺失标记。
func (db *DB) RepointMedia(id, libraryID, newPath, title string) error {
	_, err := db.Exec(`UPDATE media SET library_id = ?, path = ?, normalized_path = ?, title = ?,
		missing_since = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
		libraryID, newPath, newPath, title, domain.NowString(), id)
	return err
}

// PurgeMissingMedia 软删某个库里所有"文件已不在"的记录（missing_since 非空）。
// 只删数据库记录，**绝不动磁盘文件**；返回真实删除行数供界面如实显示。
// 存在的理由：整库改名/移动后缺失比例会超过扫描的自动删除阈值（默认 10%），
// 自动路径按设计拒绝删除，用户需要一个明确的、自己按下去的清理入口。
func (db *DB) PurgeMissingMedia(libraryID string) (int64, error) {
	if _, err := db.GetLibrary(libraryID); err != nil {
		return 0, err
	}
	res, err := db.Exec(`UPDATE media SET deleted_at = ?, updated_at = ?
		WHERE library_id = ? AND deleted_at IS NULL AND missing_since IS NOT NULL`,
		domain.NowString(), domain.NowString(), libraryID)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// MediaFilter drives the paged list endpoint.
type MediaFilter struct {
	LibraryID string
	Query     string
	Status    string
	Page      int
	PerPage   int
	Sort      string
	Desc      bool
}

// ListMedia returns a page of media inside the scope plus the scoped total.
func (db *DB) ListMedia(scope domain.LibraryScope, f MediaFilter) ([]domain.Media, int, error) {
	where := `deleted_at IS NULL`
	args := []any{}
	if w, sargs := scopeWhere(scope, "library_id"); w != "" {
		where += w
		args = append(args, sargs...)
	}
	if f.LibraryID != "" {
		where += ` AND library_id = ?`
		args = append(args, f.LibraryID)
	}
	if f.Query != "" {
		where += ` AND (title LIKE ? ESCAPE '\' OR path LIKE ? ESCAPE '\')`
		like := "%" + escapeLike(f.Query) + "%"
		args = append(args, like, like)
	}
	if f.Status != "" {
		// "missing" 不是 status 列的值（扫描只写 missing_since，status 仍是 ready），
		// 所以这里必须按 missing_since 判定 —— 否则这个筛选永远查不到东西（用户踩过）。
		// 反过来，筛 "ready" 也要排除这些行：ready 应当意味着"能播"。
		switch f.Status {
		case domain.MediaMissing:
			where += ` AND missing_since IS NOT NULL`
		case domain.MediaReady:
			where += ` AND status = ? AND missing_since IS NULL`
			args = append(args, f.Status)
		default:
			where += ` AND status = ?`
			args = append(args, f.Status)
		}
	}
	var total int
	if err := db.QueryRow(`SELECT COUNT(1) FROM media WHERE `+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	col := "id"
	switch f.Sort {
	case "title":
		col = "title"
	case "created_at":
		col = "created_at"
	case "size":
		col = "size"
	case "duration_ms":
		col = "duration_ms"
	case "id":
		col = "id"
	}
	dir := "DESC"
	if !f.Desc {
		dir = "ASC"
	}
	per := f.PerPage
	if per <= 0 {
		per = 20
	}
	off := (f.Page - 1) * per
	if off < 0 {
		off = 0
	}
	q := `SELECT ` + mediaCols + ` FROM media WHERE ` + where +
		` ORDER BY ` + col + ` ` + dir + `, id DESC LIMIT ? OFFSET ?`
	rows, err := db.Query(q, append(args, per, off)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []domain.Media{}
	for rows.Next() {
		m, err := scanMedia(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, *m)
	}
	return out, total, rows.Err()
}

// FeedNext 已被 storage/feed.go 的 seed+hash 随机游标取代（默认随机播放）。

// MediaIDsByPaths maps normalized_path -> id for one library（分块 IN 查询：
// 5000 文件的预览不能变成 5000 次 SELECT）。
func (db *DB) MediaIDsByPaths(libraryID string, paths []string) (map[string]string, error) {
	out := map[string]string{}
	for start := 0; start < len(paths); start += batchSize {
		end := start + batchSize
		if end > len(paths) {
			end = len(paths)
		}
		chunk := paths[start:end]
		args := make([]any, 0, len(chunk)+1)
		args = append(args, libraryID)
		for _, p := range chunk {
			args = append(args, p)
		}
		q := `SELECT normalized_path, id FROM media WHERE library_id = ? AND deleted_at IS NULL
			AND normalized_path IN (?` + strings.Repeat(",?", len(chunk)-1) + `)`
		rows, err := db.Query(q, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var p, id string
			if err := rows.Scan(&p, &id); err != nil {
				rows.Close()
				return nil, err
			}
			out[p] = id
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

// InsertMediaBatch 登记未探测的媒体记录（upload/按目录导入共用）：status=pending、
// mtime_ns 留 0，这样下次库扫描的 size+mtime 跳过判据不会命中，会补探测。
// 用 INSERT OR IGNORE 容忍并发重复；调用方插入后回读 id 拿权威值。
func (db *DB) InsertMediaBatch(rows []*domain.Media) (int, error) {
	inserted := 0
	for start := 0; start < len(rows); start += batchSize {
		end := start + batchSize
		if end > len(rows) {
			end = len(rows)
		}
		tx, err := db.Begin()
		if err != nil {
			return inserted, err
		}
		stmt, err := tx.Prepare(`INSERT OR IGNORE INTO media (id, library_id, path, normalized_path,
			title, size, mtime_ns, container, video_codec, audio_codec, width, height, duration_ms,
			bitrate, fps, status, error_class, error_message, probe_attempts, created_at, updated_at)
			VALUES (?,?,?,?,?,?,0,'','','',0,0,0,0,0,?, '', '',0,?,?)`)
		if err != nil {
			_ = tx.Rollback()
			return inserted, err
		}
		now := domain.NowString()
		for _, m := range rows[start:end] {
			res, eerr := stmt.Exec(m.ID, m.LibraryID, m.Path, m.Path, m.Title, m.Size,
				domain.MediaPending, now, now)
			if eerr != nil {
				stmt.Close()
				_ = tx.Rollback()
				return inserted, eerr
			}
			if n, _ := res.RowsAffected(); n > 0 {
				inserted += int(n)
			}
		}
		stmt.Close()
		if err := tx.Commit(); err != nil {
			return inserted, err
		}
	}
	return inserted, nil
}

// MediaState is the cheap per-file fingerprint used to skip unchanged files.
type MediaState struct {
	ID      string
	Size    int64
	MtimeNS int64
	Status  string
}

// MediaStatesByLibrary maps normalized path -> fingerprint for one library.
func (db *DB) MediaStatesByLibrary(libraryID string) (map[string]MediaState, error) {
	rows, err := db.Query(`SELECT normalized_path, id, size, mtime_ns, status FROM media
		WHERE library_id = ? AND deleted_at IS NULL`, libraryID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]MediaState{}
	for rows.Next() {
		var p string
		var st MediaState
		if err := rows.Scan(&p, &st.ID, &st.Size, &st.MtimeNS, &st.Status); err != nil {
			return nil, err
		}
		out[p] = st
	}
	return out, rows.Err()
}

// MediaIDsByLibrary lists live media ids and normalized paths for reconciliation.
func (db *DB) MediaIDsByLibrary(libraryID string) (map[string]string, map[string]string, error) {
	rows, err := db.Query(`SELECT id, normalized_path, COALESCE(missing_since,'') FROM media
		WHERE library_id = ? AND deleted_at IS NULL`, libraryID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	byPath := map[string]string{}
	missing := map[string]string{}
	for rows.Next() {
		var id, p, since string
		if err := rows.Scan(&id, &p, &since); err != nil {
			return nil, nil, err
		}
		byPath[p] = id
		missing[id] = since
	}
	return byPath, missing, rows.Err()
}

// CountMedia returns live media count overall or per library.
func (db *DB) CountMedia(libraryID string) (int, error) {
	q := `SELECT COUNT(1) FROM media WHERE deleted_at IS NULL`
	args := []any{}
	if libraryID != "" {
		q += ` AND library_id = ?`
		args = append(args, libraryID)
	}
	var n int
	err := db.QueryRow(q, args...).Scan(&n)
	return n, err
}

// CountFailedMedia returns probe_failed rows overall or per library.
func (db *DB) CountFailedMedia(libraryID string) (int, error) {
	q := `SELECT COUNT(1) FROM media WHERE deleted_at IS NULL AND status = ?`
	args := []any{domain.MediaProbeFail}
	if libraryID != "" {
		q += ` AND library_id = ?`
		args = append(args, libraryID)
	}
	var n int
	err := db.QueryRow(q, args...).Scan(&n)
	return n, err
}

func escapeLike(s string) string {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		if r == '%' || r == '_' || r == '\\' {
			out = append(out, '\\')
		}
		out = append(out, r)
	}
	return string(out)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

var _ = fmt.Sprintf

// UpdateMediaLoudness 记下一次响度测量结果（0 = 还没量过；量失败也写 0，不要写垃圾值）。
// 单独一个方法而不是塞进 UpdateMediaProbe：量响度是"第一次播时才做"的后台步骤，
// 与探测/入库是两条时间线，混在一起会让扫描多背一个 ffmpeg 开销。
func (db *DB) UpdateMediaLoudness(id string, lufs float64) error {
	if lufs > 0 {
		lufs = 0 // LUFS 一定是负数；正数说明解析错了，宁可不调音量
	}
	_, err := db.Exec(`UPDATE media SET loudness_lufs = ?, updated_at = ? WHERE id = ?`,
		lufs, domain.NowString(), id)
	return err
}
