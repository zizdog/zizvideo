-- 用户上传（UGC）第一段：白名单开关 + 待审条目表（docs/上传设计.md）。
-- 文件先落 <data>/inbox/<user>/<日期>/，审核通过才移进媒体库并登记 media；
-- 所以 pending 内容根本不进 media 表，普通列表天然看不到它（不靠过滤兜底）。

ALTER TABLE users ADD COLUMN can_upload INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS upload_items (
  id             TEXT PRIMARY KEY,
  uploader_id    TEXT NOT NULL,
  name           TEXT NOT NULL,
  title          TEXT NOT NULL DEFAULT '',
  path           TEXT NOT NULL,
  size           INTEGER NOT NULL DEFAULT 0,
  received_bytes INTEGER NOT NULL DEFAULT 0,
  content_hash   TEXT NOT NULL DEFAULT '',
  state          TEXT NOT NULL DEFAULT 'uploading'
                 CHECK (state IN ('uploading','pending','approved','rejected')),
  review_note    TEXT NOT NULL DEFAULT '',
  media_id       TEXT NOT NULL DEFAULT '',
  library_id     TEXT NOT NULL DEFAULT '',
  reviewed_by    TEXT NOT NULL DEFAULT '',
  reviewed_at    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upload_items_uploader
  ON upload_items(uploader_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_upload_items_state
  ON upload_items(state, created_at DESC);
