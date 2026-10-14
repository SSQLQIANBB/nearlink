import { describe, expect, it } from 'vitest';
import type { GroupSession } from '../../../src/services/groupSessionService';
import {
  ScreenAnnotationService,
  type AnnotationAction,
  type ScreenAnnotationStore,
} from '../../../src/services/screenAnnotationService';

class MemoryAnnotationStore implements ScreenAnnotationStore {
  readonly records = new Map<string, AnnotationAction[]>();

  async get(key: string) {
    return structuredClone(this.records.get(key) ?? []);
  }

  async set(key: string, actions: AnnotationAction[]) {
    this.records.set(key, structuredClone(actions));
  }

  async delete(key: string) {
    this.records.delete(key);
  }
}

const session: GroupSession = {
  groupId: 7,
  type: 'screen',
  channelId: 'group:7:screen',
  ownerUserId: 1,
  ownerSocketId: 'owner-socket',
  startedAt: '2026-07-05T10:00:00.000Z',
};

const action: AnnotationAction = {
  actionId: 'action-1',
  tool: 'pen',
  points: [
    { x: 0.1, y: 0.2 },
    { x: 0.3, y: 0.4 },
  ],
  color: '#FF0000',
  lineWidth: 0.005,
  userId: 1,
  createdAt: '2026-07-05T10:00:01.000Z',
};

describe('ScreenAnnotationService', () => {
  it('只允许当前共享者写入并让后加入者恢复历史', async () => {
    const service = new ScreenAnnotationService(new MemoryAnnotationStore());

    await expect(service.complete(session, 2, action)).rejects.toThrow(
      '只有当前屏幕共享者可以标注',
    );
    await service.complete(session, 1, action);

    await expect(service.getSnapshot(session)).resolves.toEqual([action]);
  });

  it('相同 actionId 重复到达时只保存一次', async () => {
    const service = new ScreenAnnotationService(new MemoryAnnotationStore());

    await service.complete(session, 1, action);
    await service.complete(session, 1, action);

    await expect(service.getSnapshot(session)).resolves.toHaveLength(1);
  });

  it('共享者可以撤销最后一笔并清空当前会话', async () => {
    const service = new ScreenAnnotationService(new MemoryAnnotationStore());
    await service.complete(session, 1, action);
    await service.complete(session, 1, { ...action, actionId: 'action-2' });

    await expect(service.undo(session, 1)).resolves.toBe('action-2');
    await expect(service.getSnapshot(session)).resolves.toHaveLength(1);

    await service.clear(session, 1);
    await expect(service.getSnapshot(session)).resolves.toEqual([]);
  });

  it('不同 startedAt 的共享会话不复用旧标注', async () => {
    const service = new ScreenAnnotationService(new MemoryAnnotationStore());
    await service.complete(session, 1, action);

    await expect(
      service.getSnapshot({
        ...session,
        startedAt: '2026-07-05T11:00:00.000Z',
      }),
    ).resolves.toEqual([]);
  });

  it('共享结束后删除本次共享历史', async () => {
    const store = new MemoryAnnotationStore();
    const service = new ScreenAnnotationService(store);
    await service.complete(session, 1, action);

    await service.end(session);

    await expect(service.getSnapshot(session)).resolves.toEqual([]);
    expect(store.records.size).toBe(0);
  });

  it('临时动作也校验共享者权限和输入范围', () => {
    const service = new ScreenAnnotationService(new MemoryAnnotationStore());

    expect(() =>
      service.validateDraft(session, 2, {
        actionId: 'draft-1',
        tool: 'pen',
        points: [{ x: 0.2, y: 0.3 }],
        color: '#FF0000',
        lineWidth: 0.005,
      }),
    ).toThrow('只有当前屏幕共享者可以标注');

    expect(() =>
      service.validateDraft(session, 1, {
        actionId: 'draft-1',
        tool: 'pen',
        points: [{ x: 2, y: 0.3 }],
        color: '#FF0000',
        lineWidth: 0.005,
      }),
    ).toThrow('标注坐标无效');
  });

  it.each(['circle', 'line', 'rect'] as const)(
    '保存 %s 的颜色线宽并供后加入的成员恢复',
    async (tool) => {
      const service = new ScreenAnnotationService(new MemoryAnnotationStore());
      const shape = { ...action, tool, color: '#00FF00', lineWidth: 0.012 };
      await service.complete(session, 1, shape);
      expect(await service.getSnapshot(session)).toEqual([shape]);
    },
  );
});
