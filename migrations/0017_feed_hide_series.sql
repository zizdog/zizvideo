-- 首页是否显示剧场内容（用户 2026-09-24 拍板做"用户级"开关，默认关＝保持原行为）：
-- 打开后首页随机流里排除已属于某个剧场的媒体 —— 免得首页刷到剧集、把「观看中」的进度打乱。
ALTER TABLE user_prefs ADD COLUMN feed_hide_series INTEGER NOT NULL DEFAULT 0;
