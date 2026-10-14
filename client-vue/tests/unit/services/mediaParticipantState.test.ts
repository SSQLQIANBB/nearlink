import { describe, expect, it } from 'vitest';
import { createMediaParticipantState } from '../../../src/services/mediaParticipantState';

describe('mediaParticipantState', () => {
  it('按视频和共享频道分别保存参与用户', () => {
    const state = createMediaParticipantState();
    state.apply({ groupId: 7, type: 'video', channelId: 'group:7:video', userIds: [1, 2] });
    state.apply({ groupId: 7, type: 'screen', channelId: 'group:7:screen', userIds: [2] });

    expect(state.isParticipating(7, 'video', 1)).toBe(true);
    expect(state.isParticipating(7, 'screen', 1)).toBe(false);
  });

  it('会话频道切换后忽略旧频道迟到快照', () => {
    const state = createMediaParticipantState();
    state.setChannel(7, 'screen', 'current-channel');

    expect(
      state.apply({
        groupId: 7,
        type: 'screen',
        channelId: 'old-channel',
        userIds: [1],
      }),
    ).toBe(false);
    expect(state.userIds(7, 'screen')).toEqual([]);
  });

  it('断线或会话结束时清除对应参与状态', () => {
    const state = createMediaParticipantState();
    state.apply({ groupId: 7, type: 'video', channelId: 'group:7:video', userIds: [1] });

    state.clear(7, 'video');

    expect(state.userIds(7, 'video')).toEqual([]);
  });

  it('重复 userId 保持唯一并触发一次可观察更新', () => {
    const state = createMediaParticipantState();
    const before = state.version.value;

    state.apply({
      groupId: 7,
      type: 'video',
      channelId: 'group:7:video',
      userIds: [1, 1, 2],
    });

    expect(state.userIds(7, 'video')).toEqual([1, 2]);
    expect(state.version.value).toBe(before + 1);
  });
});
