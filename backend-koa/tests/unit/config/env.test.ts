import { describe, expect, it } from 'vitest';
import { createEnv } from '../../../src/config/env';

const validEnv = {
  NODE_ENV: 'development',
  DB_PASSWORD: 'local-database-password',
  JWT_SECRET: 'jwt-secret-with-at-least-32-characters',
  REFRESH_TOKEN_SECRET: 'refresh-secret-with-at-least-32-characters',
  FILES_DOMAIN: 'files.example.test',
  PRIVATE_FILES_DOMAIN: 'private-files.example.test',
  QINIU_ACCESS_KEY: 'qiniu-access-key',
  QINIU_SECRET_KEY: 'qiniu-secret-key',
};

describe('后端环境变量', () => {
  it('集中转换字符串类型并应用非敏感默认值', () => {
    const env = createEnv({
      ...validEnv,
      PORT: '3100',
      DB_LOGGING: 'true',
      REDIS_DB: '2',
    });

    expect(env.app).toMatchObject({ nodeEnv: 'development', port: 3100 });
    expect(env.database.logging).toBe(true);
    expect(env.database.autoCreate).toBe(false);
    expect(env.database.syncAlter).toBe(false);
    expect(env.redis).toMatchObject({ host: 'localhost', port: 6379, db: 2 });
    expect(env.qiniu).toMatchObject({
      publicDomain: 'https://files.example.test',
      privateDomain: 'https://private-files.example.test',
    });
    expect(env.smtp).toBeNull();
  });

  it('拒绝带协议的七牛 CDN 域名', () => {
    expect(() =>
      createEnv({
        ...validEnv,
        FILES_DOMAIN: 'https://files.example.test',
      }),
    ).toThrow(/FILES_DOMAIN.*域名/s);
  });

  it('拒绝示例密钥、相同 JWT 密钥和不完整 SMTP 配置', () => {
    expect(() =>
      createEnv({
        ...validEnv,
        DB_PASSWORD: 'change-me-password',
        REFRESH_TOKEN_SECRET: validEnv.JWT_SECRET,
        SMTP_HOST: 'smtp.example.test',
      }),
    ).toThrow(/DB_PASSWORD.*示例值.*REFRESH_TOKEN_SECRET.*不同.*SMTP_USER/s);

    expect(() =>
      createEnv({
        ...validEnv,
        REDIS_PASSWORD: 'change-me-redis-password',
      }),
    ).toThrow(/REDIS_PASSWORD.*示例值/s);

    expect(() =>
      createEnv({
        ...validEnv,
        SMTP_HOST: 'smtp.example.test',
        SMTP_USER: 'sender',
        SMTP_PASSWORD: 'change-me-smtp-password',
        SMTP_FROM: 'sender@example.test',
      }),
    ).toThrow(/SMTP_PASSWORD.*示例值/s);
  });

  it('拒绝生产环境弱化 Redis、邮件或数据库迁移约束', () => {
    expect(() =>
      createEnv({
        ...validEnv,
        NODE_ENV: 'production',
        DB_AUTO_CREATE: 'true',
      }),
    ).toThrow(/REDIS_PASSWORD.*生产环境.*SMTP_HOST.*生产环境.*DB_AUTO_CREATE/s);
  });
});
