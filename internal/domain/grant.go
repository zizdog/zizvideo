package domain

// UserLibraryGrant 是 user_libraries 的一行 + 库名 + 来源。
// source（admin/default）只做显示/审计，绝不参与判据（B.8 不变量）。
type UserLibraryGrant struct {
	LibraryID string `json:"library_id"`
	Name      string `json:"name"`
	Source    string `json:"source"`
}

// LibraryGroup 是媒体库分组（用户 2026-09-22）。一个库最多属于一个组，
// group_id 为空 = 未分组；组只用于归类显示、批量操作与批量授权。
type LibraryGroup struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	SortOrder    int    `json:"sort_order"`
	LibraryCount int    `json:"library_count"`
	CreatedAt    string `json:"created_at"`
	UpdatedAt    string `json:"updated_at"`
}

// UserLibraryGroupGrant 是"某用户被授权访问某个组"的回读行（含组名与库数）。
type UserLibraryGroupGrant struct {
	GroupID      string `json:"group_id"`
	Name         string `json:"name"`
	LibraryCount int    `json:"library_count"`
}

// DefaultBackfillResult 是补发默认可见库的计数；与 DB 行数一致，不许谎报。
type DefaultBackfillResult struct {
	UsersTotal   int `json:"users_total"`
	UsersGranted int `json:"users_granted"`
	UsersSkipped int `json:"users_skipped"`
	RowsWritten  int `json:"rows_written"`
}
