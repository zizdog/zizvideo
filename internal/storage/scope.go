package storage

import (
	"database/sql"
	"sort"
	"strings"

	"github.com/zizdog/zizvideo/internal/domain"
)

// scopeWhere 生成 " AND <col> IN (?,...)"；All ⇒ 无子句，空集合 ⇒ AND 1=0
// （fail-closed，绝不回落成全部）。args 顺序与占位符在文本中的顺序一致（ITERATION-2 B.3）。
func scopeWhere(scope domain.LibraryScope, col string) (string, []any) {
	if scope.All {
		return "", nil
	}
	if len(scope.IDs) == 0 {
		return " AND 1=0", nil
	}
	ids := make([]string, 0, len(scope.IDs))
	for id := range scope.IDs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	return " AND " + col + " IN (" + strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",") + ")", args
}

// UserLibraryIDs 是唯一的授权判据 SQL：**直授 ∪ 组授**，软删库 JOIN 掉（B.1 幽灵授权）。
// 组授（user_library_groups）与直授并集叠加、互不覆盖（用户 2026-09-22 确认）；
// 库被移出组或组被删 ⇒ 组授那条自动消失，不需要回填任何 user_libraries 行。
func (db *DB) UserLibraryIDs(userID string) (map[string]bool, error) {
	rows, err := db.Query(`SELECT ul.library_id FROM user_libraries ul
		JOIN media_libraries l ON l.id = ul.library_id AND l.deleted_at IS NULL
		WHERE ul.user_id = ?
		UNION
		SELECT l.id FROM user_library_groups g
		JOIN media_libraries l ON l.group_id = g.group_id AND l.deleted_at IS NULL
		WHERE g.user_id = ?`, userID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

// GrantUserLibrary 写入一条直授（重复授权幂等）。P3 的管理端保存会复用它。
func (db *DB) GrantUserLibrary(userID, libraryID string) error {
	_, err := db.Exec(`INSERT INTO user_libraries (user_id, library_id, created_at)
		VALUES (?,?,?) ON CONFLICT(user_id, library_id) DO NOTHING`,
		userID, libraryID, domain.NowString())
	return err
}

// ListLibrariesIn 返回范围内的库（id/name/组名，无 root_path），范围外一条都不返回。
func (db *DB) ListLibrariesIn(scope domain.LibraryScope) ([]domain.LibraryBrief, error) {
	w, args := scopeWhere(scope, "l.id")
	rows, err := db.Query(`SELECT l.id, l.name, COALESCE(l.group_id,''), COALESCE(g.name,'')
		FROM media_libraries l LEFT JOIN library_groups g ON g.id = l.group_id
		WHERE l.deleted_at IS NULL`+
		w+` ORDER BY l.created_at ASC, l.id ASC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.LibraryBrief{}
	for rows.Next() {
		var b domain.LibraryBrief
		if err := rows.Scan(&b.ID, &b.Name, &b.GroupID, &b.GroupName); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// ListUserLibraryGroupGrants 读回某用户的组授行（组名 + 组内库数），供管理界面显示。
func (db *DB) ListUserLibraryGroupGrants(userID string) ([]domain.UserLibraryGroupGrant, error) {
	rows, err := db.Query(`SELECT g.group_id, gr.name,
		(SELECT COUNT(1) FROM media_libraries l WHERE l.group_id = g.group_id AND l.deleted_at IS NULL)
		FROM user_library_groups g JOIN library_groups gr ON gr.id = g.group_id
		WHERE g.user_id = ? ORDER BY gr.sort_order ASC, gr.name ASC, g.group_id ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.UserLibraryGroupGrant{}
	for rows.Next() {
		var g domain.UserLibraryGroupGrant
		if err := rows.Scan(&g.GroupID, &g.Name, &g.LibraryCount); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// SetUserLibraryGroups 整体替换组授行（与 SetUserLibraries 同语义：未勾选整行删除，
// 提交后回读真实行）。直授行一个都不动 —— 两组权限是并集，不是替换。
func (db *DB) SetUserLibraryGroups(userID string, groupIDs []string) ([]domain.UserLibraryGroupGrant, error) {
	ids := make([]string, 0, len(groupIDs))
	seen := map[string]bool{}
	for _, raw := range groupIDs {
		id := strings.TrimSpace(raw)
		if id == "" || seen[id] {
			continue
		}
		// 只接受真实存在的组：不存在的 id 一律丢掉，不写幽灵授权。
		if _, err := db.GetLibraryGroup(id); err != nil {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	tx, err := db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`DELETE FROM user_library_groups WHERE user_id = ?`, userID); err != nil {
		return nil, err
	}
	now := domain.NowString()
	for _, id := range ids {
		if _, err := tx.Exec(`INSERT INTO user_library_groups (user_id, group_id, created_at)
			VALUES (?,?,?) ON CONFLICT(user_id, group_id) DO NOTHING`, userID, id, now); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return db.ListUserLibraryGroupGrants(userID)
}

// querier 让默认库读取能跑在 *DB 或 *sql.Tx 上（注册继承必须同事务快照）。
type querier interface {
	Query(string, ...any) (*sql.Rows, error)
	QueryRow(string, ...any) *sql.Row
}

// defaultLibraryIDs 取默认可见库集合：空 = 未设置（fail-closed），不回落成全部。
func defaultLibraryIDs(q querier) ([]string, error) {
	rows, err := q.Query(`SELECT id FROM media_libraries
		WHERE default_for_new_users = 1 AND deleted_at IS NULL ORDER BY created_at ASC, id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// DefaultLibraryIDs 是默认可见库集合（B.8 语义 1）。
func (db *DB) DefaultLibraryIDs() ([]string, error) { return defaultLibraryIDs(db) }

// ListUserLibraryGrants 读回某用户的授权行（库名 + 来源），软删库 JOIN 掉。
func (db *DB) ListUserLibraryGrants(userID string) ([]domain.UserLibraryGrant, error) {
	rows, err := db.Query(`SELECT ul.library_id, l.name, ul.source FROM user_libraries ul
		JOIN media_libraries l ON l.id = ul.library_id AND l.deleted_at IS NULL
		WHERE ul.user_id = ? ORDER BY ul.created_at ASC, ul.library_id ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.UserLibraryGrant{}
	for rows.Next() {
		var g domain.UserLibraryGrant
		if err := rows.Scan(&g.LibraryID, &g.Name, &g.Source); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// SetUserLibraries 整体替换授权行：勾选写 source='admin'，未勾选整行删除；
// 提交后回读，返回值就是 DB 里的真实行（回读一致才算保存成功，B.7）。
func (db *DB) SetUserLibraries(userID string, libraryIDs []string) ([]domain.UserLibraryGrant, error) {
	ids := make([]string, 0, len(libraryIDs))
	seen := map[string]bool{}
	for _, raw := range libraryIDs {
		id := strings.TrimSpace(raw)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	sort.Strings(ids)
	tx, err := db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	for _, id := range ids {
		var n int
		if err := tx.QueryRow(`SELECT COUNT(1) FROM media_libraries
			WHERE id = ? AND deleted_at IS NULL`, id).Scan(&n); err != nil {
			return nil, err
		}
		if n == 0 {
			return nil, domain.ErrNotFound
		}
	}
	if len(ids) == 0 {
		if _, err := tx.Exec(`DELETE FROM user_libraries WHERE user_id = ?`, userID); err != nil {
			return nil, err
		}
	} else {
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
		args := make([]any, 0, len(ids)+1)
		args = append(args, userID)
		for _, id := range ids {
			args = append(args, id)
		}
		if _, err := tx.Exec(`DELETE FROM user_libraries WHERE user_id = ? AND library_id NOT IN (`+
			placeholders+`)`, args...); err != nil {
			return nil, err
		}
		now := domain.NowString()
		for _, id := range ids {
			if _, err := tx.Exec(`INSERT INTO user_libraries (user_id, library_id, source, created_at)
				VALUES (?,?, 'admin', ?)
				ON CONFLICT(user_id, library_id) DO UPDATE SET source = 'admin'`,
				userID, id, now); err != nil {
				return nil, err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return db.ListUserLibraryGrants(userID)
}

// CountUsersWithoutLibraries 数 role='user' 且一条授权行都没有的活跃账号（B.7 提示）。
func (db *DB) CountUsersWithoutLibraries() (int, error) {
	var n int
	// "没有库"= 直授与组授都没有：只数直授会把"有组权限"的用户误报成看不到内容。
	err := db.QueryRow(`SELECT COUNT(1) FROM users u
		WHERE u.deleted_at IS NULL AND u.role = 'user'
		AND NOT EXISTS (SELECT 1 FROM user_libraries ul WHERE ul.user_id = u.id)
		AND NOT EXISTS (SELECT 1 FROM user_library_groups ug WHERE ug.user_id = u.id)`).Scan(&n)
	return n, err
}

// BackfillDefaultLibraries 把当前默认库补发给"一条授权都没有"的普通用户；
// 已有授权的跳过、不追加不覆盖；幂等（第二次 granted=0）。本阶段同步执行，未走任务中心。
func (db *DB) BackfillDefaultLibraries() (domain.DefaultBackfillResult, error) {
	var out domain.DefaultBackfillResult
	tx, err := db.Begin()
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback() }()
	ids, err := defaultLibraryIDs(tx)
	if err != nil {
		return out, err
	}
	if len(ids) == 0 {
		return out, domain.New("DEFAULT_LIBRARIES_UNSET", "未设置默认可见库，无法补发", 409)
	}
	users, err := tx.Query(`SELECT id, role FROM users WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC`)
	if err != nil {
		return out, err
	}
	type target struct{ id, role string }
	targets := []target{}
	for users.Next() {
		var t target
		if err := users.Scan(&t.id, &t.role); err != nil {
			_ = users.Close()
			return out, err
		}
		targets = append(targets, t)
	}
	if err := users.Err(); err != nil {
		_ = users.Close()
		return out, err
	}
	_ = users.Close()
	out.UsersTotal = len(targets)
	now := domain.NowString()
	for _, t := range targets {
		if t.role != domain.RoleUser {
			continue
		}
		var n int
		// 直授与组授都算"已有权限"：有组授权的用户不该被默认库补发塞进一堆库。
		if err := tx.QueryRow(`SELECT (SELECT COUNT(1) FROM user_libraries WHERE user_id = ?)
			+ (SELECT COUNT(1) FROM user_library_groups WHERE user_id = ?)`, t.id, t.id).Scan(&n); err != nil {
			return out, err
		}
		if n > 0 {
			out.UsersSkipped++
			continue
		}
		for _, libID := range ids {
			res, err := tx.Exec(`INSERT INTO user_libraries (user_id, library_id, source, created_at)
				VALUES (?,?, 'default', ?) ON CONFLICT(user_id, library_id) DO NOTHING`, t.id, libID, now)
			if err != nil {
				return out, err
			}
			if n, _ := res.RowsAffected(); n > 0 {
				out.RowsWritten++
			}
		}
		out.UsersGranted++
	}
	if err := tx.Commit(); err != nil {
		return out, err
	}
	return out, nil
}
