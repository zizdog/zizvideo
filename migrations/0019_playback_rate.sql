-- B5（用户 2026-09-24 规划）：播放倍速，按用户记住（与其它播放设置同一张表，走同一套 PATCH）。
ALTER TABLE user_prefs ADD COLUMN playback_rate REAL NOT NULL DEFAULT 1.0;
