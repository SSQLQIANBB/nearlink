import { describe, expect, it } from 'vitest';
import { MediaRoomRegistry } from '../../../src/services/mediaRoomRegistry';

describe('MediaRoomRegistry', () => {
  it('按 userId 去重并返回参与者快照', () => {
    const registry = new MediaRoomRegistry();
    registry.join('group:7:video', 'socket-a', 1);
    registry.join('group:7:video', 'socket-b', 2);
    registry.join('group:7:video', 'socket-c', 2);

    expect(registry.getUserIds('group:7:video')).toEqual([1, 2]);
  });

  it('同一用户最后一个 socket 离开后才变为未参与', () => {
    const registry = new MediaRoomRegistry();
    registry.join('group:7:screen', 'socket-a', 2);
    registry.join('group:7:screen', 'socket-b', 2);

    registry.leave('group:7:screen', 'socket-a');
    expect(registry.getUserIds('group:7:screen')).toEqual([2]);

    registry.leave('group:7:screen', 'socket-b');
    expect(registry.getUserIds('group:7:screen')).toEqual([]);
  });

  it('断线时从所有媒体房间移除 socket 且房间互不污染', () => {
    const registry = new MediaRoomRegistry();
    registry.join('group:7:video', 'socket-a', 1);
    registry.join('group:7:screen', 'socket-a', 1);
    registry.join('group:8:video', 'socket-b', 2);

    expect(registry.leaveSocket('socket-a')).toEqual(['group:7:screen', 'group:7:video']);
    expect(registry.getUserIds('group:8:video')).toEqual([2]);
  });
});
