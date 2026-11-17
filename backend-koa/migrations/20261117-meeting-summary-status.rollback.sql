-- 回滚 20261117-meeting-summary-status：移除纪要独立状态列。
ALTER TABLE meeting_minutes
  DROP COLUMN summaryError,
  DROP COLUMN summaryStatus;
