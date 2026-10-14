import { describe, expect, it } from 'vitest';
import { mergeContactPresence } from '../../../src/services/contactPresence';

describe('联系人列表与在线状态', () => {
  it('Socket 尚未连接时保留联系人，在线增量到达后覆盖状态与 socketId', () => {
    const known = [
      { id: 1, username: 'self', status: 'online' as const },
      { id: 2, username: 'alice', status: 'online' as const },
    ];
    expect(mergeContactPresence(known, [], [], 1)).toEqual([
      { id: 2, username: 'alice', status: 'offline', socketId: '' },
    ]);
    expect(
      mergeContactPresence(
        known,
        [],
        [{ id: 2, username: 'alice', status: 'busy', socketId: 'socket-2' }],
        1,
      ),
    ).toEqual([{ id: 2, username: 'alice', status: 'busy', socketId: 'socket-2' }]);
  });
});
