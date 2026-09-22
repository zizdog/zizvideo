-- 0011_watch_later: 「稍后再看」（每人一份）。
-- 与收藏同为"标记"语义，但列表独立、互不影响；播完不自动移除（用户手动取消），
-- 观看历史仍然只由 watch_progress 记录。
CREATE TABLE IF NOT EXISTS watch_later (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id   TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, media_id)
);
