-- 0024_library_kind: 媒体库分类型（短视频库 / 短剧库）
--
-- 用户 2026-10-10 拍板的模型（"大概就你 jellyfin 里的电影和电视剧一样。后台各管各的"）：
--   · kind='short' = 短视频库（对应 Jellyfin 电影库）：一条视频就是一个独立条目；
--   · kind='drama' = 短剧库（对应 Jellyfin 电视剧库）：**目录结构决定归属** ——
--     库根下的一级目录 = 一部剧，其下 Season xx/Sxx 目录 = 季，再下面是集；
--   · 首页 feed 只出 short，剧场只出 drama；后台分「短视频管理」「短剧管理」两块。
--
-- 存量归类：**有剧场的库判 drama，其余判 short**。
-- 判据用 series（剧场）而不是 series_media：只要这个库下建过剧，就按短剧库对待，
-- 否则会出现"短剧功能还在用、但库已经变成短视频库"的半吊子状态。
ALTER TABLE media_libraries ADD COLUMN kind TEXT NOT NULL DEFAULT 'short';

UPDATE media_libraries SET kind = 'drama'
  WHERE id IN (SELECT DISTINCT library_id FROM series WHERE library_id IS NOT NULL AND library_id != '');

CREATE INDEX IF NOT EXISTS idx_media_libraries_kind ON media_libraries(kind);
