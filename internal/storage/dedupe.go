package storage

import (
	"errors"

	"github.com/zizdog/zizvideo/internal/domain"
)

// DuplicateMember is one media row inside a suspected-duplicate group.
type DuplicateMember struct {
	ID           string `json:"id"`
	LibraryID    string `json:"library_id"`
	Path         string `json:"path"`
	Title        string `json:"title"`
	DurationMS   int64  `json:"duration_ms"`
	Size         int64  `json:"size_bytes"`
	Status       string `json:"status"`
	MissingSince string `json:"missing_since,omitempty"`
	CreatedAt    string `json:"created_at"`
}

// DuplicateGroup shares one (size_bytes, duration_ms) key. It is a suspicion
// only: identical size and duration does not prove identical content.
type DuplicateGroup struct {
	Size       int64             `json:"size_bytes"`
	DurationMS int64             `json:"duration_ms"`
	Members    []DuplicateMember `json:"members"`
}

// DuplicateGroups groups live, ready media by (size_bytes, duration_ms) and
// returns only groups with more than one member. limit caps the group count.
//
// ⚠️ 排除"文件已不在"的记录（missing_since 非空）：文件被移走/删掉的那条不是"重复"，
// 它只是一条待清理的缺失记录。用户 2026-09-27 报障就是这条 —— 把 A 库的视频移到 B 库后，
// A 那条只剩缺失标记却仍算一组，于是去重里冒出这些视频（扫描已经会把移动识别成"迁移"，
// 这里是第二道保险：即使没识别出来，也不该当成重复）。
func (db *DB) DuplicateGroups(limit int) ([]DuplicateGroup, error) {
	if limit <= 0 {
		limit = 100
	}
	// 一次查完：先用 CTE 选出"重复键"（组数受 limit 限），再把成员 JOIN 回来。
	// 老实现是 1 次查组 + **每组 1 次**查成员（最多 101 次往返，2026-10-10 审计的 N+1）；
	// 现在固定 2 次以内的往返（SQLite 里 CTE 只算一趟），结果与老的逐组查询逐字节等价。
	rows, err := db.Query(`WITH dup AS (
			SELECT size, duration_ms, COUNT(1) AS n FROM media
			WHERE deleted_at IS NULL AND status = ? AND missing_since IS NULL
			  AND duration_ms > 0 AND size > 0
			GROUP BY size, duration_ms HAVING n > 1
			ORDER BY n DESC, size DESC LIMIT ?
		)
		SELECT m.id, m.library_id, m.path, m.title, m.duration_ms, m.size, m.status,
			COALESCE(m.missing_since,''), m.created_at, d.size, d.duration_ms
		FROM media m JOIN dup d ON m.size = d.size AND m.duration_ms = d.duration_ms
		WHERE m.deleted_at IS NULL AND m.status = ? AND m.missing_since IS NULL
		ORDER BY d.n DESC, d.size DESC, m.created_at ASC, m.id ASC`,
		domain.MediaReady, limit, domain.MediaReady)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	// 组顺序沿用 CTE 的 (n DESC, size DESC)；SQLite 的行序就是上面 ORDER BY 给的，
	// 这里按首次出现顺序建组，成员顺序也保持 created_at,id 升序（与老的逐组查询一致）。
	out := []DuplicateGroup{}
	index := map[[2]int64]int{}
	for rows.Next() {
		var m DuplicateMember
		var size, durationMS int64
		if err := rows.Scan(&m.ID, &m.LibraryID, &m.Path, &m.Title, &m.DurationMS, &m.Size,
			&m.Status, &m.MissingSince, &m.CreatedAt, &size, &durationMS); err != nil {
			return nil, err
		}
		key := [2]int64{size, durationMS}
		i, ok := index[key]
		if !ok {
			out = append(out, DuplicateGroup{Size: size, DurationMS: durationMS, Members: []DuplicateMember{}})
			i = len(out) - 1
			index[key] = i
		}
		out[i].Members = append(out[i].Members, m)
	}
	return out, rows.Err()
}

// MediaByIDs loads live rows for the given ids and reports the ids that are
// gone, so a delete request never silently skips an unknown object.
func (db *DB) MediaByIDs(ids []string) ([]domain.Media, []string, error) {
	found := []domain.Media{}
	missing := []string{}
	for _, id := range ids {
		m, err := db.getMedia(id)
		if errors.Is(err, domain.ErrNotFound) {
			missing = append(missing, id)
			continue
		}
		if err != nil {
			return nil, nil, err
		}
		found = append(found, *m)
	}
	return found, missing, nil
}

// SoftDeleteMedia soft-deletes live rows and returns how many were marked. It
// only writes the database; files on disk are never touched here.
func (db *DB) SoftDeleteMedia(ids []string) (int, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	live := 0
	for _, id := range ids {
		var n int
		if err := db.QueryRow(`SELECT COUNT(1) FROM media WHERE id = ? AND deleted_at IS NULL`,
			id).Scan(&n); err != nil {
			return 0, err
		}
		live += n
	}
	if err := db.ApplyDeletions(ids); err != nil {
		return 0, err
	}
	return live, nil
}
