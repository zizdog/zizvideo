-- P1 转码队列（docs/上传设计.md 七）：兼容优先地把内容转成 H.264/AAC + 720p 上限。
-- 为什么单独记状态：转码失败的 media 必须**保持原文件可用**（不许"转码失败就没得看"），
-- 所以状态与探测错误（status/error_class）分开存，界面才能如实说"这条没转成，但还能播"。
ALTER TABLE media ADD COLUMN transcode_state TEXT NOT NULL DEFAULT ''; -- ''|running|done|failed
ALTER TABLE media ADD COLUMN transcode_note  TEXT NOT NULL DEFAULT ''; -- 结论/失败原因（给人看）

-- 每个任务当前文件的百分比：转码是分钟级动作，只有"处理了几个"看不出卡在哪。
ALTER TABLE job_tasks ADD COLUMN percent INTEGER NOT NULL DEFAULT 0;
