import { describe, expect, it, vi } from 'vitest';
import { onGroupAccessRevoked, revokeGroupAccess, runGroupOperation } from '../../../src/services/groupAccessCoordinator';

describe('群组操作与撤销串行化', () => {
  it('同群成员删除等待在途加入结束，随后新加入观察到已撤销；其它群不阻塞', async () => {
    const order: string[] = [];
    let finish!: () => void;
    const pending = runGroupOperation(1, async () => { order.push('join'); await new Promise<void>(resolve => { finish = resolve; }); });
    await Promise.resolve();
    const revoke = runGroupOperation(1, async () => { order.push('revoke'); });
    const late = runGroupOperation(1, async () => { order.push('late-denied'); });
    await runGroupOperation(2, async () => { order.push('other-group'); });
    expect(order).toEqual(['join', 'other-group']);
    finish();
    await Promise.all([pending, revoke, late]);
    expect(order).toEqual(['join', 'other-group', 'revoke', 'late-denied']);
  });
  it('一次数据库失败不会卡死该群后续操作', async () => {
    await expect(runGroupOperation(3, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    await expect(runGroupOperation(3, async () => 'ok')).resolves.toBe('ok');
  });
  it('清理失败不能阻止其它登录设备清理，且不伪装为数据库回滚', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const healthy = vi.fn();
    const off1 = onGroupAccessRevoked(() => { throw new Error('redis offline'); });
    const off2 = onGroupAccessRevoked(healthy);
    try {
      await expect(revokeGroupAccess({ groupId: 4, reason: 'deleted' })).resolves.toBeUndefined();
      expect(healthy).toHaveBeenCalledWith({ groupId: 4, reason: 'deleted' });
      expect(log).toHaveBeenCalledWith('group_realtime_cleanup_failed', { groupId: 4 });
    } finally { off1(); off2(); log.mockRestore(); }
  });
});
