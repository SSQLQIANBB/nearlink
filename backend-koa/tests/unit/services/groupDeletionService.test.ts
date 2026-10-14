import { describe, expect, it, vi } from 'vitest';
import {
  GroupDeletionService,
  type GroupDeletionDependencies,
} from '../../../src/services/groupDeletionService';

function createDependencies(role: 'owner' | 'admin' | 'member' | null = 'owner') {
  const calls: string[] = [];
  const transaction = { id: 'transaction-1' };
  const dependencies: GroupDeletionDependencies = {
    findMembership: vi.fn().mockResolvedValue(role ? { role } : null),
    findGroup: vi.fn().mockResolvedValue({ id: 7 }),
    transaction: vi.fn(async (callback) => callback(transaction)),
    deleteMessages: vi.fn(async (_groupId, receivedTransaction) => {
      expect(receivedTransaction).toBe(transaction);
      calls.push('messages');
    }),
    deleteInvitations: vi.fn(async (_groupId, receivedTransaction) => {
      expect(receivedTransaction).toBe(transaction);
      calls.push('invitations');
    }),
    deleteMembers: vi.fn(async (_groupId, receivedTransaction) => {
      expect(receivedTransaction).toBe(transaction);
      calls.push('members');
    }),
    deleteGroup: vi.fn(async (_groupId, receivedTransaction) => {
      expect(receivedTransaction).toBe(transaction);
      calls.push('group');
    }),
  };
  return { dependencies, calls };
}

describe('GroupDeletionService', () => {
  it.each(['admin', 'member'] as const)('%s 不能删除群组', async (role) => {
    const { dependencies } = createDependencies(role);
    const service = new GroupDeletionService(dependencies);

    await expect(service.delete(7, 2)).rejects.toMatchObject({
      status: 403,
      message: '只有群主可以删除群组',
    });
    expect(dependencies.transaction).not.toHaveBeenCalled();
  });

  it('非群组成员不能删除群组', async () => {
    const { dependencies } = createDependencies(null);
    const service = new GroupDeletionService(dependencies);

    await expect(service.delete(7, 2)).rejects.toMatchObject({ status: 403 });
    expect(dependencies.findGroup).not.toHaveBeenCalled();
  });

  it('群组不存在时返回 404', async () => {
    const { dependencies } = createDependencies('owner');
    vi.mocked(dependencies.findGroup).mockResolvedValue(null);
    const service = new GroupDeletionService(dependencies);

    await expect(service.delete(7, 1)).rejects.toMatchObject({ status: 404 });
    expect(dependencies.transaction).not.toHaveBeenCalled();
  });

  it('群主在同一事务中按依赖顺序删除群组数据', async () => {
    const { dependencies, calls } = createDependencies('owner');
    const service = new GroupDeletionService(dependencies);

    await service.delete(7, 1);

    expect(calls).toEqual(['messages', 'invitations', 'members', 'group']);
    expect(dependencies.transaction).toHaveBeenCalledTimes(1);
  });

  it('事务失败时向上抛出错误，不返回伪成功', async () => {
    const { dependencies } = createDependencies('owner');
    vi.mocked(dependencies.deleteMembers).mockRejectedValue(new Error('database failed'));
    const service = new GroupDeletionService(dependencies);

    await expect(service.delete(7, 1)).rejects.toThrow('database failed');
  });
});
