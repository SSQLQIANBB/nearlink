-- 会议录音音频保存：状态、七牛对象引用、暂停恢复截止时间。
-- 音频状态（audioStatus）与录音状态（status）、纪要状态（summaryStatus）相互独立：
--   recording   录制中，分片在写入暂存；
--   pending     已停止采集但尚未保存完成（含进程重启后待续传、上传中）；
--   uploading   正在上传七牛私有空间；
--   ready       已上传，audioStorageRef 为稳定的 qiniu://private/<key> 对象引用；
--   partial     尾片完整性无法确认，按已有分片保存；
--   failed      保存失败，本地暂存保留供重试；
--   missing     无音频（旧版本录制的历史数据或无音频的异常记录）。
ALTER TABLE meeting_minutes
  ADD COLUMN audioStatus VARCHAR(16) NOT NULL DEFAULT 'recording' AFTER endReason,
  ADD COLUMN audioStorageRef VARCHAR(255) NULL DEFAULT NULL AFTER audioStatus,
  ADD COLUMN audioError VARCHAR(64) NULL DEFAULT NULL AFTER audioStorageRef,
  ADD COLUMN audioPausedAttachDeadline DATETIME NULL DEFAULT NULL AFTER audioError;

-- 存量数据：已结束的旧记录没有音频暂存，明确标记为 missing；
-- 活动录音（recording/paused/finalizing）维持 recording/pending，由启动续传流程处理。
UPDATE meeting_minutes
SET audioStatus = 'missing'
WHERE status IN ('ended', 'failed') AND audioStatus = 'recording' AND durationSeconds > 0;
