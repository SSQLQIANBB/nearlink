-- 会议记录：纪要状态独立化（summaryStatus/summaryError），录音状态补充 paused/finalizing/failed。
-- 前置迁移 20261116-meeting-minutes 已建表并可能已部署；本迁移只做增量，不改写旧迁移。
ALTER TABLE meeting_minutes
  ADD COLUMN summaryStatus VARCHAR(16) NOT NULL DEFAULT 'idle' AFTER mindmap,
  ADD COLUMN summaryError VARCHAR(64) NULL DEFAULT NULL AFTER summaryStatus;

-- 存量数据：已生成纪要的记录标记为 ready。
UPDATE meeting_minutes
SET summaryStatus = 'ready'
WHERE mindmap IS NOT NULL AND mindmap <> '';
