-- 0013_scan_renamed: 扫描回执里记录"识别到多少个改名/移动"。
-- 为什么要落库：改名后旧行改指新路径（保留观看进度/收藏/剧场成员）是用户可见的好事，
-- 必须能在界面上说出来 —— 不然用户只会看到"疑似丢失 N 个"，以为文件真丢了。
ALTER TABLE scan_tasks ADD COLUMN renamed INTEGER NOT NULL DEFAULT 0;
