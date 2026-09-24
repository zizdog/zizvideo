-- 0021_upload_sessions: 后台上传的会话落库（原来是内存 map）。
-- 为什么：上传大文件动辄几分钟，服务一重启（升级/崩溃）会话就没了，
-- 继续传直接 404「上传会话不存在或已过期」——用户只能从头再传（用户 2026-09-24 点名要修）。
-- files 存 JSON 数组：每个文件的 index/name/size/最终路径/是否已完成。
CREATE TABLE IF NOT EXISTS upload_sessions (
  id          TEXT PRIMARY KEY,
  dir         TEXT NOT NULL,
  library_id  TEXT NOT NULL DEFAULT '',
  series_id   TEXT NOT NULL DEFAULT '',
  overwrite   INTEGER NOT NULL DEFAULT 0 CHECK (overwrite IN (0,1)),
  files       TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_created ON upload_sessions(created_at);
