-- 0023_media_size_mtime_index: 给"按 (size, mtime) 认同一个文件"的查询加索引
-- （2026-10-10 全量审计的 P2 性能项）。
--
-- 现象：扫描/导入时对**每个新文件**都要问一次"这个 (size, mtime) 是不是已有记录换了位置"
-- （scanner 的 migrateRenamed/migrateAcrossLibraries → MediaBySizeMtime），而这条 SQL
-- 在 media 表上没有可用索引 ⇒ 每个新文件一次全表扫描。新库导入两万文件 ≈ 两万次全表扫，
-- 这是"两万文件导入被拖成分钟级"的隐藏放大器。
--
-- 条件与查询严格对齐（`deleted_at IS NULL AND size = ? AND mtime_ns = ?`）才吃得到部分索引。
CREATE INDEX IF NOT EXISTS idx_media_size_mtime
  ON media(size, mtime_ns) WHERE deleted_at IS NULL;
