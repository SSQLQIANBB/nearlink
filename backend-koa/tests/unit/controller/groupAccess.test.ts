import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ findMember: vi.fn(), destroy: vi.fn(), deleteMembers: vi.fn(), deleteGroup: vi.fn(), transaction: vi.fn() }));
vi.mock('../../../src/models', () => ({
  GroupMember: { findOne: mocks.findMember, destroy: mocks.deleteMembers },
  Group: { findByPk: vi.fn(async () => ({ id: 7 })), destroy: mocks.deleteGroup },
  GroupMessage: { destroy: vi.fn() }, GroupInvitation: { destroy: vi.fn() }, User: {},
}));
vi.mock('../../../src/config/database', () => ({ default: { transaction: mocks.transaction } }));
vi.mock('../../../src/services/redisService', () => ({ default: { delGroupInfo: vi.fn(), delGroupMembers: vi.fn(), delPattern: vi.fn() } }));
import { deleteGroup, leaveGroup } from '../../../src/controller/groupController';
import { onGroupAccessRevoked, runGroupOperation } from '../../../src/services/groupAccessCoordinator';
const context = () => ({ params: { id: '7' }, state: { user: { userId: 2 } } }) as any;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMember.mockResolvedValue({ role: 'member', destroy: mocks.destroy });
  mocks.destroy.mockResolvedValue(undefined);
  mocks.transaction.mockImplementation(async cb => cb({}));
});
describe('HTTP群成员变更同步撤销长连接', () => {
  it('退群提交后通知指定用户的所有连接', async () => {
    const listener = vi.fn(() => { expect(mocks.destroy).toHaveBeenCalled(); });
    const off = onGroupAccessRevoked(listener);
    try {
      const ctx = context(); await leaveGroup(ctx);
      expect(ctx.body).toEqual({ message: '已退出群组' });
      expect(listener).toHaveBeenCalledWith({ groupId: 7, userId: 2, reason: 'left' });
    } finally { off(); }
  });
  it('删群事务成功后撤销整个群，事务失败不发布伪撤销', async () => {
    mocks.findMember.mockResolvedValue({ role: 'owner' });
    const listener = vi.fn(); const off = onGroupAccessRevoked(listener);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await deleteGroup(context());
      expect(mocks.deleteMembers).toHaveBeenCalled();
      expect(listener).toHaveBeenCalledWith({ groupId: 7, reason: 'deleted' });
      listener.mockClear();
      mocks.transaction.mockRejectedValueOnce(new Error('rollback'));
      const ctx = context(); await deleteGroup(ctx);
      expect(ctx.status).toBe(500);
      expect(listener).not.toHaveBeenCalled();
    } finally { off(); log.mockRestore(); }
  });
  it('HTTP退群与同群Socket操作共用队列', async () => {
    let release!: () => void;
    const joining = runGroupOperation(7, () => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve(); await Promise.resolve();
    const leaving = leaveGroup(context());
    await Promise.resolve();
    expect(mocks.destroy).not.toHaveBeenCalled();
    release(); await Promise.all([joining, leaving]);
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
});
