package storage

import (
	"database/sql"
	"errors"

	"github.com/zizdog/zizvideo/internal/domain"
)

// UGC（用户上传）条目：文件先落 inbox，审核通过才移进媒体库。
// 状态机 uploading → pending → approved / rejected；配额只算前三种（驳回的不占额度）。

const uploadCols = `id, uploader_id, name, title, path, size, received_bytes, content_hash,
	state, review_note, media_id, library_id, reviewed_by, COALESCE(reviewed_at,''),
	created_at`

// uploadColsQ 是 JOIN users 时的限定写法（id/created_at 会撞名）。
const uploadColsQ = `it.id, it.uploader_id, it.name, it.title, it.path, it.size, it.received_bytes,
	it.content_hash, it.state, it.review_note, it.media_id, it.library_id, it.reviewed_by,
	COALESCE(it.reviewed_at,''), it.created_at`

func scanUploadItem(s interface{ Scan(...any) error }) (*domain.UploadItem, error) {
	var it domain.UploadItem
	if err := s.Scan(&it.ID, &it.UploaderID, &it.Name, &it.Title, &it.Path, &it.Size,
		&it.Received, &it.ContentHash, &it.State, &it.ReviewNote, &it.MediaID,
		&it.LibraryID, &it.ReviewedBy, &it.ReviewedAt, &it.CreatedAt); err != nil {
		return nil, err
	}
	return &it, nil
}

// CreateUploadItem 开一条上传条目（state=uploading）。
func (db *DB) CreateUploadItem(it *domain.UploadItem) error {
	now := domain.NowString()
	it.CreatedAt = now
	if it.State == "" {
		it.State = domain.UploadUploading
	}
	_, err := db.Exec(`INSERT INTO upload_items
		(id, uploader_id, name, title, path, size, received_bytes, content_hash, state,
		 review_note, media_id, library_id, reviewed_by, created_at, updated_at)
		VALUES (?,?,?,?,?,?,0,'',?, '', '', '', '', ?, ?)`,
		it.ID, it.UploaderID, it.Name, it.Title, it.Path, it.Size, it.State, now, now)
	return err
}

// GetUploadItem loads one upload row.
func (db *DB) GetUploadItem(id string) (*domain.UploadItem, error) {
	row := db.QueryRow(`SELECT `+uploadCols+` FROM upload_items WHERE id = ?`, id)
	it, err := scanUploadItem(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, domain.ErrNotFound
	}
	return it, err
}

// SetUploadReceived 记下落盘进度（GET 续传时以磁盘上的 .zvpart 为准，这里是给列表看的）。
func (db *DB) SetUploadReceived(id string, n int64) error {
	_, err := db.Exec(`UPDATE upload_items SET received_bytes = ?, updated_at = ?
		WHERE id = ?`, n, domain.NowString(), id)
	return err
}

// UploadItemPathTaken 判断 inbox 目标名是否已被别的条目占用（含已通过/待审）。
func (db *DB) UploadItemPathTaken(path string) (bool, error) {
	var n int
	err := db.QueryRow(`SELECT COUNT(1) FROM upload_items
		WHERE path = ? AND state <> ?`, path, domain.UploadRejected).Scan(&n)
	return n > 0, err
}

// FinishUploadItem 把条目推进到待审：只允许从 uploading 走这一步。
func (db *DB) FinishUploadItem(id string, size int64, hash string) (bool, error) {
	res, err := db.Exec(`UPDATE upload_items SET state = ?, size = ?, received_bytes = ?,
		content_hash = ?, updated_at = ? WHERE id = ? AND state = ?`,
		domain.UploadPending, size, size, hash, domain.NowString(), id, domain.UploadUploading)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// UploadHashExists 内容去重：同一个上传者、同一份内容（pending/approved）只留一条。
func (db *DB) UploadHashExists(uploaderID, hash string) (*domain.UploadItem, error) {
	if hash == "" {
		return nil, nil
	}
	row := db.QueryRow(`SELECT `+uploadCols+` FROM upload_items
		WHERE uploader_id = ? AND content_hash = ? AND state IN (?,?)
		ORDER BY created_at ASC LIMIT 1`,
		uploaderID, hash, domain.UploadPending, domain.UploadApproved)
	it, err := scanUploadItem(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return it, err
}

// ListUploadsByUploader 是「我的上传」：全部状态，最新在前。
func (db *DB) ListUploadsByUploader(uploaderID string) ([]domain.UploadItem, error) {
	rows, err := db.Query(`SELECT `+uploadCols+` FROM upload_items
		WHERE uploader_id = ? ORDER BY created_at DESC, id DESC`, uploaderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectUploads(rows)
}

// ListPendingUploads 是后台「待审」：带上上传者用户名。
func (db *DB) ListPendingUploads() ([]domain.UploadItem, error) {
	rows, err := db.Query(`SELECT `+uploadColsQ+`, COALESCE(u.username,'') FROM upload_items it
		LEFT JOIN users u ON u.id = it.uploader_id
		WHERE it.state = ? ORDER BY it.created_at ASC, it.id ASC`, domain.UploadPending)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.UploadItem{}
	for rows.Next() {
		it, err := scanUploadItemWithUploader(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *it)
	}
	return out, rows.Err()
}

// UploadUsage 是配额判据：条目数 + 字节数（uploading 按声明大小算，防止无限占坑）。
func (db *DB) UploadUsage(uploaderID string) (items int, bytes int64, err error) {
	var b sql.NullInt64
	err = db.QueryRow(`SELECT COUNT(1), COALESCE(SUM(size),0) FROM upload_items
		WHERE uploader_id = ? AND state IN (?,?,?)`,
		uploaderID, domain.UploadUploading, domain.UploadPending, domain.UploadApproved).
		Scan(&items, &b)
	return items, b.Int64, err
}

// ApproveUploadItem 审核通过：只允许从 pending 走，记录落到哪个库/哪条 media。
func (db *DB) ApproveUploadItem(id, mediaID, libraryID, reviewer string) (bool, error) {
	res, err := db.Exec(`UPDATE upload_items SET state = ?, media_id = ?, library_id = ?,
		reviewed_by = ?, reviewed_at = ?, review_note = '', updated_at = ?
		WHERE id = ? AND state = ?`,
		domain.UploadApproved, mediaID, libraryID, reviewer, domain.NowString(),
		domain.NowString(), id, domain.UploadPending)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// RejectUploadItem 审核驳回：记录原因（文件由 handler 先删掉再调这里）。
func (db *DB) RejectUploadItem(id, note, reviewer string) (bool, error) {
	res, err := db.Exec(`UPDATE upload_items SET state = ?, review_note = ?, reviewed_by = ?,
		reviewed_at = ?, updated_at = ? WHERE id = ? AND state = ?`,
		domain.UploadRejected, truncate(note, 200), reviewer, domain.NowString(),
		domain.NowString(), id, domain.UploadPending)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// DeleteUploadItem 只用于取消未完成的上传（handler 已清掉 .zvpart）。
func (db *DB) DeleteUploadItem(id string) error {
	_, err := db.Exec(`DELETE FROM upload_items WHERE id = ? AND state = ?`,
		id, domain.UploadUploading)
	return err
}

func collectUploads(rows *sql.Rows) ([]domain.UploadItem, error) {
	out := []domain.UploadItem{}
	for rows.Next() {
		it, err := scanUploadItem(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *it)
	}
	return out, rows.Err()
}

func scanUploadItemWithUploader(s interface{ Scan(...any) error }) (*domain.UploadItem, error) {
	var it domain.UploadItem
	if err := s.Scan(&it.ID, &it.UploaderID, &it.Name, &it.Title, &it.Path, &it.Size,
		&it.Received, &it.ContentHash, &it.State, &it.ReviewNote, &it.MediaID,
		&it.LibraryID, &it.ReviewedBy, &it.ReviewedAt, &it.CreatedAt, &it.Uploader); err != nil {
		return nil, err
	}
	return &it, nil
}
