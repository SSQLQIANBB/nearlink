import { beforeEach, describe, expect, it } from 'vitest';
import {
  advanceGroupCursor,
  initializeGroupCursor,
  readGroupCursors,
} from '../../../src/services/groupMessageCursor';

beforeEach(() => localStorage.clear());

describe('群消息游标', () => {
  it('按账号隔离，重复消息不能让游标倒退', () => {
    initializeGroupCursor(1, 7, 0);
    expect(readGroupCursors(1)[7]).toBe(0);
    advanceGroupCursor(1, 7, 12);
    advanceGroupCursor(1, 7, 9);
    initializeGroupCursor(1, 7, 99);
    expect(readGroupCursors(1)[7]).toBe(12);
    expect(readGroupCursors(2)[7]).toBeUndefined();
  });
});
