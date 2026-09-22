-- 0012_library_groups: 媒体库分组 + 组访问。
-- 语义（用户 2026-09-22 确认）：
--   · 一个库最多属于一个组：media_libraries.group_id 空串 = 未分组；
--   · 组授权与"逐库直授 / 新用户默认可看库"**并集叠加**，互不覆盖；
--   · 删除组只解绑（把成员的 group_id 置空），绝不删库。
CREATE TABLE IF NOT EXISTS library_groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_library_groups_name ON library_groups(name);

ALTER TABLE media_libraries ADD COLUMN group_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_media_libraries_group ON media_libraries(group_id);

CREATE TABLE IF NOT EXISTS user_library_groups (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id   TEXT NOT NULL REFERENCES library_groups(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_user_library_groups_group ON user_library_groups(group_id);
