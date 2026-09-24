package storage

import (
	"database/sql"
	"errors"
	"time"

	"github.com/zizdog/zizvideo/internal/domain"
)

// 后台上传会话（迁移 0021）：内存 map 的持久化兜底 —— 服务重启后还能接着传。
// files 保持 JSON 原文（api 层自己定义结构），storage 不解释它，避免两处结构打架。

type UploadSessionRow struct {
	ID        string
	Dir       string
	LibraryID string
	SeriesID  string
	Overwrite bool
	FilesJSON string
	CreatedAt string
	UpdatedAt string
}

func (db *DB) SaveUploadSession(row UploadSessionRow) error {
	now := domain.NowString()
	if row.CreatedAt == "" {
		row.CreatedAt = now
	}
	overwrite := 0
	if row.Overwrite {
		overwrite = 1
	}
	_, err := db.Exec(`INSERT INTO upload_sessions
		(id, dir, library_id, series_id, overwrite, files, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
			dir = excluded.dir, library_id = excluded.library_id, series_id = excluded.series_id,
			overwrite = excluded.overwrite, files = excluded.files, updated_at = excluded.updated_at`,
		row.ID, row.Dir, row.LibraryID, row.SeriesID, overwrite, row.FilesJSON, row.CreatedAt, now)
	return err
}

func (db *DB) GetUploadSession(id string) (*UploadSessionRow, error) {
	var row UploadSessionRow
	var overwrite int
	err := db.QueryRow(`SELECT id, dir, library_id, series_id, overwrite, files, created_at, updated_at
		FROM upload_sessions WHERE id = ?`, id).
		Scan(&row.ID, &row.Dir, &row.LibraryID, &row.SeriesID, &overwrite, &row.FilesJSON,
			&row.CreatedAt, &row.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, domain.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	row.Overwrite = overwrite == 1
	return &row, nil
}

func (db *DB) DeleteUploadSession(id string) error {
	_, err := db.Exec(`DELETE FROM upload_sessions WHERE id = ?`, id)
	return err
}

// PruneUploadSessions 清掉超时会话（与内存里那套 TTL 同一个判据）。
func (db *DB) PruneUploadSessions(before time.Time) (int64, error) {
	res, err := db.Exec(`DELETE FROM upload_sessions WHERE created_at < ?`, before.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
