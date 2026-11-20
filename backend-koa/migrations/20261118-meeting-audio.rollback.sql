-- 回滚：删除音频保存字段。七牛对象与本地暂存不受本回滚影响，需人工清理。
ALTER TABLE meeting_minutes
  DROP COLUMN audioStatus,
  DROP COLUMN audioStorageRef,
  DROP COLUMN audioError,
  DROP COLUMN audioPausedAttachDeadline;
