import { expect, it } from 'vitest';
import { engineReadinessMessage } from '@/services/remoteEngineDiagnostics';
it('区分启动超时和资源损坏并保留原生错误码', () => {
  expect(engineReadinessMessage('REMOTE_ENGINE_PROBE_TIMEOUT')).toContain('5 秒');
  expect(engineReadinessMessage('REMOTE_ENGINE_PROBE_TIMEOUT')).toContain('REMOTE_ENGINE_PROBE_TIMEOUT');
  expect(engineReadinessMessage('REMOTE_ENGINE_CONTENT_CHANGED')).toContain('内容校验失败');
});
it('不展示原生路径或任意诊断文本', () => {
  expect(engineReadinessMessage('C:\\private\\secret.txt')).not.toContain('secret');
  expect(engineReadinessMessage(undefined)).toContain('REMOTE_ENGINE_NOT_READY');
});
