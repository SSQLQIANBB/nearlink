import { describe, expect, it } from 'vitest';
import { createPublicEnv } from '@/config/publicEnv';

describe('前端公开环境变量', () => {
  it('允许空值使用同源地址，并移除末尾斜杠', () => {
    expect(createPublicEnv({})).toEqual({ apiBaseUrl: '', socketUrl: '' });
    expect(
      createPublicEnv({
        VITE_API_BASE_URL: ' https://api.example.com/ ',
        VITE_SOCKET_URL: 'https://socket.example.com///',
      }),
    ).toEqual({
      apiBaseUrl: 'https://api.example.com',
      socketUrl: 'https://socket.example.com',
    });
  });

  it('拒绝非 HTTP 协议和 URL 内嵌凭据', () => {
    expect(() => createPublicEnv({ VITE_API_BASE_URL: '/api' })).toThrow(/完整的 HTTP/);
    expect(() =>
      createPublicEnv({
        VITE_SOCKET_URL: 'https://user:password@socket.example.com',
      }),
    ).toThrow(/不包含凭据/);
  });
});
