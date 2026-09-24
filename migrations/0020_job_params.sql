-- 0020_job_params: 记下"这批任务是怎么来的"（媒体 id + 尺寸等 JSON），
-- 任务中心才能一键重试（用户 2026-09-24："转码/扫描任务列表 + 取消 + 失败重试"）。
-- 只存重试必需的信息，不存文件路径（路径会变，重试时按 id 现取）。
ALTER TABLE job_tasks ADD COLUMN params TEXT NOT NULL DEFAULT '';
