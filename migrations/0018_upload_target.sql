-- A2（用户 2026-09-24 规划）：上传时可选"投递目标" —— 上传者自己指定想进的媒体库/剧场草稿名，
-- 审核页据此**预填**（一次几十集时，管理员就不用每条都选一遍）。
-- 注意：这只是"建议"，最终仍由管理员在审核时确认（审核通过才真的入库）。
ALTER TABLE upload_items ADD COLUMN target_library_id   TEXT NOT NULL DEFAULT '';
ALTER TABLE upload_items ADD COLUMN target_series_title TEXT NOT NULL DEFAULT '';
