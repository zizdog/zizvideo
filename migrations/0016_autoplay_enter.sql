-- 首页「进入自动播放」开关（用户 2026-09-24）：默认开；关掉时首页只显示预览帧，不自动起播。
ALTER TABLE user_prefs ADD COLUMN autoplay_enter INTEGER NOT NULL DEFAULT 1;
