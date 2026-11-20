import { describe, expect, it } from 'vitest';
import { parsePageParams } from '../../../src/utils/meetingQuery';

describe('parsePageParams（HTTP 边界）', () => {
  it('缺省 page=1 pageSize=20', () => {
    expect(parsePageParams({})).toEqual({ page: 1, pageSize: 20 });
  });

  it('数字字符串正常转换', () => {
    expect(parsePageParams({ page: '2', pageSize: '50' })).toEqual({ page: 2, pageSize: 50 });
  });

  it('非法参数返回 null（400），不静默回到第一页', () => {
    expect(parsePageParams({ page: '0' })).toBeNull();
    expect(parsePageParams({ page: '-1' })).toBeNull();
    expect(parsePageParams({ page: 'abc' })).toBeNull();
    expect(parsePageParams({ page: 1.5 })).toBeNull();
    expect(parsePageParams({ pageSize: '0' })).toBeNull();
    expect(parsePageParams({ pageSize: '101' })).toBeNull();
    expect(parsePageParams({ pageSize: 'huge' })).toBeNull();
  });
});
