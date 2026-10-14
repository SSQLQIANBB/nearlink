export type GroupDeletionRole = 'owner' | 'admin' | 'member';

export interface GroupDeletionDependencies {
  findMembership(groupId: number, userId: number): Promise<{ role?: GroupDeletionRole } | null>;
  findGroup(groupId: number): Promise<{ id: number } | null>;
  transaction(callback: (transaction: unknown) => Promise<void>): Promise<unknown>;
  deleteMessages(groupId: number, transaction: unknown): Promise<unknown>;
  deleteInvitations(groupId: number, transaction: unknown): Promise<unknown>;
  deleteMembers(groupId: number, transaction: unknown): Promise<unknown>;
  deleteGroup(groupId: number, transaction: unknown): Promise<unknown>;
}

export class GroupDeletionError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GroupDeletionError';
  }
}

export class GroupDeletionService {
  constructor(private readonly dependencies: GroupDeletionDependencies) {}

  async delete(groupId: number, userId: number) {
    const membership = await this.dependencies.findMembership(groupId, userId);
    if (!membership) {
      throw new GroupDeletionError(403, '您不是该群组成员');
    }
    if (membership.role !== 'owner') {
      throw new GroupDeletionError(403, '只有群主可以删除群组');
    }

    const group = await this.dependencies.findGroup(groupId);
    if (!group) {
      throw new GroupDeletionError(404, '群组不存在');
    }

    // 关联数据必须在同一事务内完成，任何一步失败都会整体回滚。
    await this.dependencies.transaction(async (transaction) => {
      await this.dependencies.deleteMessages(groupId, transaction);
      await this.dependencies.deleteInvitations(groupId, transaction);
      await this.dependencies.deleteMembers(groupId, transaction);
      await this.dependencies.deleteGroup(groupId, transaction);
    });
  }
}
