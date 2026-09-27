-- 0022_media_loudness: 每个视频的整体响度（LUFS），用来做**音量均一化**
-- （用户 2026-09-26："不同视频音量不同，应做均一化"）。
--
-- 0 = 还没量过。量的时机：**第一次播它时**在后台量一次（只读音频、取几十秒样本，一次几秒），
-- 第二次播放起就按它调音量。为什么不扫描时整库量：整库是纯 CPU 开销，而真正会看的只是一部分。
ALTER TABLE media ADD COLUMN loudness_lufs REAL NOT NULL DEFAULT 0;
