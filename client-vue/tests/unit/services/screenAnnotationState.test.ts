import { describe, expect, it } from 'vitest';
import {
  createScreenAnnotationState,
  type AnnotationAction,
} from '../../../src/services/screenAnnotationState';

const startedAt = '2026-07-05T10:00:00.000Z';
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

describe('screenAnnotationState', () => {
  it('后加入者从快照恢复，重复完成事件不会产生重复标注', () => {
    const state = createScreenAnnotationState();
    state.startSession(startedAt);
    state.applySnapshot(startedAt, [action]);
    state.applyComplete(startedAt, action);

    expect(state.actions.value).toEqual([action]);
  });

  it('完整动作替换同 actionId 的临时轨迹', () => {
    const state = createScreenAnnotationState();
    state.startSession(startedAt);
    state.applyDraft(startedAt, { ...action, points: [action.points[0]!] });
    state.applyComplete(startedAt, action);

    expect(state.drafts.value).toEqual([]);
    expect(state.actions.value).toEqual([action]);
  });

  it('撤销和清空同步更新画布状态', () => {
    const state = createScreenAnnotationState();
    state.startSession(startedAt);
    state.applyComplete(startedAt, action);
    state.applyUndo(startedAt, 'action-1');
    expect(state.actions.value).toEqual([]);

    state.applyDraft(startedAt, action);
    state.clear();
    expect(state.drafts.value).toEqual([]);
  });

  it('忽略上一次共享会话迟到的标注事件', () => {
    const state = createScreenAnnotationState();
    state.startSession('2026-07-05T11:00:00.000Z');

    expect(state.applyComplete(startedAt, action)).toBe(false);
    expect(state.actions.value).toEqual([]);
  });
});
