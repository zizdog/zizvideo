package storage

import (
	"database/sql"
	"errors"
	"strings"

	"github.com/zizdog/zizvideo/internal/domain"
)

// 媒体库分组（用户 2026-09-22）：一个库最多属于一个组；组用于归类显示、批量操作与批量授权。
// 访问判据不在这里 —— 唯一判据是 scope.go 的 UserLibraryIDs（直授 ∪ 组授）。

// ListLibraryGroups 按 sort_order、名称返回全部组，带成员库数。
func (db *DB) ListLibraryGroups() ([]domain.LibraryGroup, error) {
	rows, err := db.Query(`SELECT g.id, g.name, g.sort_order,
		(SELECT COUNT(1) FROM media_libraries l WHERE l.group_id = g.id AND l.deleted_at IS NULL),
		g.created_at, g.updated_at
		FROM library_groups g ORDER BY g.sort_order ASC, g.name ASC, g.id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.LibraryGroup{}
	for rows.Next() {
		var g domain.LibraryGroup
		if err := rows.Scan(&g.ID, &g.Name, &g.SortOrder, &g.LibraryCount, &g.CreatedAt, &g.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// GetLibraryGroup 读一个组（不存在 = ErrNotFound）。
func (db *DB) GetLibraryGroup(id string) (*domain.LibraryGroup, error) {
	row := db.QueryRow(`SELECT g.id, g.name, g.sort_order,
		(SELECT COUNT(1) FROM media_libraries l WHERE l.group_id = g.id AND l.deleted_at IS NULL),
		g.created_at, g.updated_at
		FROM library_groups g WHERE g.id = ?`, id)
	var g domain.LibraryGroup
	if err := row.Scan(&g.ID, &g.Name, &g.SortOrder, &g.LibraryCount, &g.CreatedAt, &g.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	return &g, nil
}

// CreateLibraryGroup 建组；重名回 409（唯一索引兜底，消息给人话）。
func (db *DB) CreateLibraryGroup(name string, sortOrder int) (*domain.LibraryGroup, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, domain.New("VALIDATION_GROUP_NAME", "组名不能为空", 400)
	}
	now := domain.NowString()
	g := &domain.LibraryGroup{ID: domain.NewID("grp"), Name: name, SortOrder: sortOrder, CreatedAt: now, UpdatedAt: now}
	if _, err := db.Exec(`INSERT INTO library_groups (id, name, sort_order, created_at, updated_at)
		VALUES (?,?,?,?,?)`, g.ID, g.Name, g.SortOrder, now, now); err != nil {
		return nil, groupNameConflict(err)
	}
	return g, nil
}

// UpdateLibraryGroup 改名 / 改排序（传 nil 表示不改该项）。
func (db *DB) UpdateLibraryGroup(id string, name *string, sortOrder *int) (*domain.LibraryGroup, error) {
	if _, err := db.GetLibraryGroup(id); err != nil {
		return nil, err
	}
	sets := []string{}
	args := []any{}
	if name != nil {
		trimmed := strings.TrimSpace(*name)
		if trimmed == "" {
			return nil, domain.New("VALIDATION_GROUP_NAME", "组名不能为空", 400)
		}
		sets = append(sets, "name = ?")
		args = append(args, trimmed)
	}
	if sortOrder != nil {
		sets = append(sets, "sort_order = ?")
		args = append(args, *sortOrder)
	}
	if len(sets) == 0 {
		return db.GetLibraryGroup(id)
	}
	sets = append(sets, "updated_at = ?")
	args = append(args, domain.NowString(), id)
	if _, err := db.Exec(`UPDATE library_groups SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...); err != nil {
		return nil, groupNameConflict(err)
	}
	return db.GetLibraryGroup(id)
}

// DeleteLibraryGroup 删组：**只解绑**成员（group_id 置空），绝不删库；同一事务内完成。
// 返回被解绑的库数，供界面如实显示。
func (db *DB) DeleteLibraryGroup(id string) (int64, error) {
	if _, err := db.GetLibraryGroup(id); err != nil {
		return 0, err
	}
	tx, err := db.Begin()
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	res, err := tx.Exec(`UPDATE media_libraries SET group_id = '', updated_at = ?
		WHERE group_id = ? AND deleted_at IS NULL`, domain.NowString(), id)
	if err != nil {
		return 0, err
	}
	unbound, _ := res.RowsAffected()
	if _, err := tx.Exec(`DELETE FROM user_library_groups WHERE group_id = ?`, id); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(`DELETE FROM library_groups WHERE id = ?`, id); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return unbound, nil
}

// SetLibraryGroup 把一个库归入某组（groupID 空串 = 移出到未分组）；目标组必须存在。
func (db *DB) SetLibraryGroup(libraryID, groupID string) error {
	if _, err := db.GetLibrary(libraryID); err != nil {
		return err
	}
	groupID = strings.TrimSpace(groupID)
	if groupID != "" {
		if _, err := db.GetLibraryGroup(groupID); err != nil {
			return err
		}
	}
	_, err := db.Exec(`UPDATE media_libraries SET group_id = ?, updated_at = ?
		WHERE id = ? AND deleted_at IS NULL`, groupID, domain.NowString(), libraryID)
	return err
}

// SetLibrariesGroup 批量归组（下拉多选/整组）：一次事务，返回实际改动的库数。
// 只认活库；不存在的 id 直接跳过（不让一个笔误把整批回滚成静默半成品）。
func (db *DB) SetLibrariesGroup(libraryIDs []string, groupID string) (int64, error) {
	groupID = strings.TrimSpace(groupID)
	if groupID != "" {
		if _, err := db.GetLibraryGroup(groupID); err != nil {
			return 0, err
		}
	}
	tx, err := db.Begin()
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	var changed int64
	now := domain.NowString()
	for _, raw := range libraryIDs {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		res, err := tx.Exec(`UPDATE media_libraries SET group_id = ?, updated_at = ?
			WHERE id = ? AND deleted_at IS NULL`, groupID, now, id)
		if err != nil {
			return 0, err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			changed += n
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return changed, nil
}

// SetGroupEnabled 整组启用/停用（只碰活库），返回实际改动行数 —— 界面照它显示，不许凑数。
func (db *DB) SetGroupEnabled(groupID string, enabled bool) (int64, error) {
	if _, err := db.GetLibraryGroup(groupID); err != nil {
		return 0, err
	}
	res, err := db.Exec(`UPDATE media_libraries SET enabled = ?, updated_at = ?
		WHERE group_id = ? AND deleted_at IS NULL`, boolToInt(enabled), domain.NowString(), groupID)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// ListLibrariesInGroup 返回某组的活库（整组扫描用）。
func (db *DB) ListLibrariesInGroup(groupID string) ([]domain.Library, error) {
	rows, err := db.Query(`SELECT `+libCols+` FROM media_libraries
		WHERE group_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Library{}
	for rows.Next() {
		l, err := scanLibrary(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *l)
	}
	return out, rows.Err()
}

// groupNameConflict 把唯一索引冲突翻成人话（否则用户只看到 SQL 原文）。
func groupNameConflict(err error) error {
	if err == nil {
		return nil
	}
	if strings.Contains(strings.ToLower(err.Error()), "unique") {
		return domain.New("VALIDATION_GROUP_EXISTS", "已存在同名分组", 409)
	}
	return err
}
