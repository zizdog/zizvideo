package storage

import (
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/zizdog/zizvideo/internal/domain"
)

const libCols = `id, name, COALESCE(kind,''), root_path, recursive, enabled, ignore_rules,
	default_for_new_users, COALESCE(group_id,''), COALESCE(mount_id,''), created_at, updated_at`

func scanLibrary(s interface{ Scan(...any) error }) (*domain.Library, error) {
	var l domain.Library
	var recursive, enabled, defaultNew int
	var rules string
	if err := s.Scan(&l.ID, &l.Name, &l.Kind, &l.RootPath, &recursive, &enabled, &rules,
		&defaultNew, &l.GroupID, &l.MountID, &l.CreatedAt, &l.UpdatedAt); err != nil {
		return nil, err
	}
	if !domain.ValidLibraryKind(l.Kind) {
		// 空/未知一律按短视频库：宁可少一个形态，也不要让库里出现第三种类型
		l.Kind = domain.KindShort
	}
	l.Recursive = recursive != 0
	l.Enabled = enabled != 0
	l.DefaultForNewUsers = defaultNew != 0
	l.IgnoreRules = []string{}
	if rules != "" {
		_ = json.Unmarshal([]byte(rules), &l.IgnoreRules)
	}
	return &l, nil
}

func encodeRules(rules []string) string {
	if rules == nil {
		rules = []string{}
	}
	b, _ := json.Marshal(rules)
	return string(b)
}

// CreateLibrary inserts a media library.
func (db *DB) CreateLibrary(l *domain.Library) error {
	now := domain.NowString()
	l.CreatedAt, l.UpdatedAt = now, now
	if !domain.ValidLibraryKind(l.Kind) {
		l.Kind = domain.KindShort
	}
	_, err := db.Exec(`INSERT INTO media_libraries
		(id, name, kind, root_path, recursive, enabled, ignore_rules, mount_id, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?)`,
		l.ID, l.Name, l.Kind, l.RootPath, boolToInt(l.Recursive), boolToInt(l.Enabled),
		encodeRules(l.IgnoreRules), l.MountID, now, now)
	return err
}

// GetLibrary loads one live library.
func (db *DB) GetLibrary(id string) (*domain.Library, error) {
	row := db.QueryRow(`SELECT `+libCols+` FROM media_libraries WHERE id = ? AND deleted_at IS NULL`, id)
	l, err := scanLibrary(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, domain.ErrNotFound
	}
	return l, err
}

// ListLibraries returns all live libraries oldest first.
func (db *DB) ListLibraries() ([]domain.Library, error) {
	rows, err := db.Query(`SELECT ` + libCols + ` FROM media_libraries
		WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC`)
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

// ListEnabledLibraries returns libraries a scan may walk.
func (db *DB) ListEnabledLibraries() ([]domain.Library, error) {
	all, err := db.ListLibraries()
	if err != nil {
		return nil, err
	}
	out := []domain.Library{}
	for _, l := range all {
		if l.Enabled {
			out = append(out, l)
		}
	}
	return out, nil
}

// LibraryPatch is a partial library update.
type LibraryPatch struct {
	Name *string
	// Kind 改类型只改归类（不动文件、不改记录 id，随时可改回）；取值必须过 domain.ValidLibraryKind。
	Kind               *string
	RootPath           *string
	Recursive          *bool
	Enabled            *bool
	IgnoreRules        *[]string
	DefaultForNewUsers *bool
	MountID            *string
}

// UpdateLibrary applies a partial update and returns the fresh row.
func (db *DB) UpdateLibrary(id string, p LibraryPatch) (*domain.Library, error) {
	sets := []string{}
	args := []any{}
	if p.Name != nil {
		sets = append(sets, "name = ?")
		args = append(args, *p.Name)
	}
	if p.Kind != nil {
		kind := *p.Kind
		if !domain.ValidLibraryKind(kind) {
			return nil, domain.New("VALIDATION_LIBRARY_KIND", "库类型只能是 short（短视频库）或 drama（短剧库）", 400)
		}
		sets = append(sets, "kind = ?")
		args = append(args, kind)
	}
	if p.RootPath != nil {
		sets = append(sets, "root_path = ?")
		args = append(args, *p.RootPath)
	}
	if p.Recursive != nil {
		sets = append(sets, "recursive = ?")
		args = append(args, boolToInt(*p.Recursive))
	}
	if p.Enabled != nil {
		sets = append(sets, "enabled = ?")
		args = append(args, boolToInt(*p.Enabled))
	}
	if p.IgnoreRules != nil {
		sets = append(sets, "ignore_rules = ?")
		args = append(args, encodeRules(*p.IgnoreRules))
	}
	if p.DefaultForNewUsers != nil {
		sets = append(sets, "default_for_new_users = ?")
		args = append(args, boolToInt(*p.DefaultForNewUsers))
	}
	if p.MountID != nil {
		sets = append(sets, "mount_id = ?")
		args = append(args, *p.MountID)
	}
	if len(sets) == 0 {
		return db.GetLibrary(id)
	}
	sets = append(sets, "updated_at = ?")
	args = append(args, domain.NowString(), id)
	res, err := db.Exec(`UPDATE media_libraries SET `+joinComma(sets)+
		` WHERE id = ? AND deleted_at IS NULL`, args...)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, domain.ErrNotFound
	}
	return db.GetLibrary(id)
}

// DeleteLibrary soft-deletes a library and all of its media rows.
func (db *DB) DeleteLibrary(id string) error {
	now := domain.NowString()
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE media SET deleted_at = ?, updated_at = ?
		WHERE library_id = ? AND deleted_at IS NULL`, now, now, id); err != nil {
		_ = tx.Rollback()
		return err
	}
	res, err := tx.Exec(`UPDATE media_libraries SET deleted_at = ?, updated_at = ?
		WHERE id = ? AND deleted_at IS NULL`, now, now, id)
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		_ = tx.Rollback()
		return domain.ErrNotFound
	}
	return tx.Commit()
}
