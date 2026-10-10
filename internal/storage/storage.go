// Package storage owns the SQLite connection, migrations and repositories.
package storage

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/zizdog/zizvideo/internal/domain"
	"github.com/zizdog/zizvideo/migrations"
)

// DB wraps the connection pool with the repositories.
type DB struct {
	*sql.DB
}

// Open creates the parent directory, opens SQLite with the documented PRAGMAs
// and applies pending migrations. Safe to call repeatedly on the same file.
//
// ⚠️ 打开阶段要**容忍短暂的 BUSY**（2026-10-10 审计发现）：`_pragma=journal_mode(WAL)`
// 需要一次短暂的排它锁，而它**不遵守 busy_timeout**（SQLite 的 pragma 直接返回
// SQLITE_BUSY）。于是"升级后面板用新二进制调 `zizvideo roots add`、旧 daemon 同时还在
// 跑"这种两个进程同时开同一个库的场景，可能一上来就 process-level 失败。这里对
// "database is locked/BUSY" 重试几次（其它错误立刻返回，不掩盖真问题）。
func Open(path string) (*DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("创建数据目录失败: %w", err)
	}
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	dsn := u.String() +
		"?_pragma=busy_timeout(5000)" +
		"&_pragma=journal_mode(WAL)" +
		"&_pragma=synchronous(NORMAL)" +
		"&_pragma=foreign_keys(ON)" +
		"&_pragma=temp_store(MEMORY)"

	var lastErr error
	for attempt := 0; attempt < 10; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * 200 * time.Millisecond)
		}
		sqldb, err := sql.Open("sqlite", dsn)
		if err != nil {
			return nil, fmt.Errorf("打开数据库失败: %w", err)
		}
		sqldb.SetMaxOpenConns(16)
		sqldb.SetMaxIdleConns(4)
		if err := sqldb.Ping(); err != nil {
			_ = sqldb.Close()
			lastErr = fmt.Errorf("连接数据库失败: %w", err)
			if busyErr(err) {
				continue
			}
			return nil, lastErr
		}
		db := &DB{DB: sqldb}
		if err := db.Migrate(); err != nil {
			_ = sqldb.Close()
			lastErr = err
			if busyErr(err) {
				continue
			}
			return nil, err
		}
		return db, nil
	}
	return nil, lastErr
}

// busyErr 判定"只是被别人占着"这类可重试错误（SQLITE_BUSY / database is locked）。
func busyErr(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "database is locked") || strings.Contains(msg, "sqlite_busy")
}

// Swap 用一份新打开的连接替换当前的连接（备份恢复用）。
// 必须保持 **同一个 *DB 指针**：server / scanner / 转码队列都握着它，
// 换指针会让它们指向已经关闭的旧连接（实测会变成"随机 500"）。
func (db *DB) Swap(fresh *DB) {
	db.DB = fresh.DB
}

// migration is one versioned SQL file.
type migration struct {
	version int
	name    string
	sql     string
}

func loadMigrations() ([]migration, error) {
	entries, err := migrations.FS.ReadDir(".")
	if err != nil {
		return nil, err
	}
	var out []migration
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		idx := strings.IndexByte(e.Name(), '_')
		if idx <= 0 {
			return nil, fmt.Errorf("迁移文件名不合规: %s", e.Name())
		}
		v, err := strconv.Atoi(e.Name()[:idx])
		if err != nil {
			return nil, fmt.Errorf("迁移文件名不含版本号: %s", e.Name())
		}
		body, err := migrations.FS.ReadFile(e.Name())
		if err != nil {
			return nil, err
		}
		out = append(out, migration{version: v, name: e.Name(), sql: string(body)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].version < out[j].version })
	// 同版本号会让后一个迁移被静默跳过（Migrate 按 version 判重），必须当错误报出来。
	for i := 1; i < len(out); i++ {
		if out[i].version == out[i-1].version {
			return nil, fmt.Errorf("迁移版本号重复: %s 与 %s", out[i-1].name, out[i].name)
		}
	}
	return out, nil
}

// Migrate applies every migration newer than the recorded schema version.
// It is idempotent: applied versions are recorded in schema_migrations.
//
// ⚠️ 每条迁移跑在**手写的 BEGIN IMMEDIATE** 里（2026-10-10 审计 P2）：
// 老实现是"先 SELECT COUNT 判重、再开 deferred 事务执行"，判重与应用不原子，
// 而且 storage.Open 不止进程启动调一次（`zizvideo roots add` 也 Open 同一个库，
// 升级后面板完全可能在旧 daemon 还在跑时调它）⇒ 两个进程可能都看到"没跑过"、
// 都去 ALTER TABLE，后到者拿到 "duplicate column name"，Open 直接失败（打断一次升级）。
// BEGIN IMMEDIATE 先拿写锁，锁内**重新判重**，另一个进程要么等（busy_timeout）要么
// 看到已应用而跳过。
func (db *DB) Migrate() error {
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`); err != nil {
		return fmt.Errorf("创建迁移表失败: %w", err)
	}
	migs, err := loadMigrations()
	if err != nil {
		return err
	}
	ctx := context.Background()
	// 固定用**同一条连接**跑 BEGIN…COMMIT：database/sql 的连接池会把不同语句
	// 分派到不同连接，那样事务边界就丢了。
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	for _, m := range migs {
		if err := applyMigration(ctx, conn, m); err != nil {
			return err
		}
	}
	return nil
}

func applyMigration(ctx context.Context, conn *sql.Conn, m migration) error {
	if _, err := conn.ExecContext(ctx, `BEGIN IMMEDIATE`); err != nil {
		return fmt.Errorf("锁定迁移（BEGIN IMMEDIATE）失败: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_, _ = conn.ExecContext(ctx, `ROLLBACK`)
		}
	}()
	// 锁内重新判重：另一个进程可能刚刚应用过同一条
	var n int
	if err := conn.QueryRowContext(ctx,
		`SELECT COUNT(1) FROM schema_migrations WHERE version = ?`, m.version).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		if _, err := conn.ExecContext(ctx, `COMMIT`); err != nil {
			return err
		}
		committed = true
		return nil
	}
	if _, err := conn.ExecContext(ctx, m.sql); err != nil {
		return fmt.Errorf("执行迁移 %s 失败: %w", m.name, err)
	}
	if _, err := conn.ExecContext(ctx,
		`INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)`,
		m.version, domain.NowString()); err != nil {
		return err
	}
	if _, err := conn.ExecContext(ctx, `COMMIT`); err != nil {
		return err
	}
	committed = true
	return nil
}

// SchemaVersion reports the highest applied migration version.
func (db *DB) SchemaVersion() (int, error) {
	var v sql.NullInt64
	if err := db.QueryRow(`SELECT MAX(version) FROM schema_migrations`).Scan(&v); err != nil {
		return 0, err
	}
	return int(v.Int64), nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// nullStr turns an empty string into NULL.
func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
