import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readRemoteViewPreferences as read, saveRemoteViewPreferences as save } from '@/services/remoteViewPreferences';
const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
beforeEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
describe('每账号每设备显示偏好', () => {
  it('账号、设备隔离，持久字段仅包含显示偏好与版本', () => {
    expect(save(1, first, { scale: '150', showStats: false, token: 'must-not-save', scope: 'control' } as any)).toBe(true);
    expect(read(1, first)).toEqual({ scale: '150', showStats: false });
    expect(read(2, first).scale).toBe('fit'); expect(read(1, second).scale).toBe('fit');
    const stored = localStorage.getItem(`remote-view:v1:1:${first}`)!;
    expect(JSON.parse(stored)).toEqual({ version: 1, scale: '150', showStats: false });
  });
  it('损坏、未来版本与无效身份使用默认值', () => {
    for (const raw of ['bad json', '{"version":2,"scale":"200","showStats":false}', '{"version":1,"scale":"NaN","showStats":true}']) {
      localStorage.setItem(`remote-view:v1:1:${first}`, raw); expect(read(1, first).scale).toBe('fit');
    }
    expect(save(0, first, { scale: '100', showStats: true })).toBe(false);
    expect(save(1, '../device', { scale: '100', showStats: true })).toBe(false);
  });
  it('存储被禁用时不阻断会话，保存失败可显示提示', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(read(1, first)).toEqual({ scale: 'fit', showStats: true });
    expect(save(1, first, { scale: '200', showStats: true })).toBe(false);
  });
});
