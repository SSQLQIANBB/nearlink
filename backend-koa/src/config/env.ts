import { z } from 'zod';

const booleanValue = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

function integerValue(name: string, defaultValue: number, minimum: number, maximum: number) {
  return z
    .string()
    .trim()
    .regex(/^\d+$/, `${name} 必须是整数`)
    .default(String(defaultValue))
    .transform(Number)
    .pipe(z.number().int().min(minimum).max(maximum));
}

function requiredValue(name: string) {
  return z
    .string()
    .trim()
    .min(1, `${name} 不能为空`)
    .refine((value) => !value.startsWith('change-me'), `${name} 仍是示例值`);
}

function secretValue(name: string) {
  return requiredValue(name).refine((value) => value.length >= 32, `${name} 至少需要 32 个字符`);
}

function domainValue(name: string) {
  return requiredValue(name).refine(
    (value) => !value.includes('://') && /^[a-z0-9.-]+$/i.test(value),
    `${name} 只能填写不带协议和路径的域名`,
  );
}

const optionalValue = z
  .string()
  .trim()
  .optional()
  .transform((value) => value || undefined);

const optionalSecret = optionalValue.refine(
  (value) => !value?.startsWith('change-me'),
  'SMTP_PASSWORD 仍是示例值',
);

const rawEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: integerValue('PORT', 3000, 1, 65535),
    DB_HOST: z.string().trim().min(1).default('localhost'),
    DB_PORT: integerValue('DB_PORT', 3306, 1, 65535),
    DB_NAME: z.string().trim().min(1).default('todesk'),
    DB_USER: z.string().trim().min(1).default('root'),
    DB_PASSWORD: requiredValue('DB_PASSWORD'),
    DB_AUTO_CREATE: booleanValue,
    DB_SYNC_ALTER: booleanValue,
    DB_LOGGING: booleanValue,
    REDIS_HOST: z.string().trim().min(1).default('localhost'),
    REDIS_PORT: integerValue('REDIS_PORT', 6379, 1, 65535),
    REDIS_PASSWORD: z
      .string()
      .default('')
      .refine((value) => !value.startsWith('change-me'), 'REDIS_PASSWORD 仍是示例值'),
    REDIS_DB: integerValue('REDIS_DB', 0, 0, 15),
    JWT_SECRET: secretValue('JWT_SECRET'),
    REFRESH_TOKEN_SECRET: secretValue('REFRESH_TOKEN_SECRET'),
    SMTP_HOST: optionalValue,
    SMTP_PORT: integerValue('SMTP_PORT', 465, 1, 65535),
    SMTP_USER: optionalValue,
    SMTP_PASSWORD: optionalSecret,
    SMTP_FROM: optionalValue,
    FILES_DOMAIN: domainValue('FILES_DOMAIN'),
    PRIVATE_FILES_DOMAIN: domainValue('PRIVATE_FILES_DOMAIN'),
    QINIU_ACCESS_KEY: requiredValue('QINIU_ACCESS_KEY'),
    QINIU_SECRET_KEY: requiredValue('QINIU_SECRET_KEY'),
  })
  .superRefine((values, context) => {
    if (values.JWT_SECRET === values.REFRESH_TOKEN_SECRET) {
      context.addIssue({
        code: 'custom',
        path: ['REFRESH_TOKEN_SECRET'],
        message: 'REFRESH_TOKEN_SECRET 必须与 JWT_SECRET 不同',
      });
    }

    const smtpFields = [
      ['SMTP_HOST', values.SMTP_HOST],
      ['SMTP_USER', values.SMTP_USER],
      ['SMTP_PASSWORD', values.SMTP_PASSWORD],
      ['SMTP_FROM', values.SMTP_FROM],
    ] as const;
    const configuredSmtpFields = smtpFields.filter(([, value]) => value);

    if (configuredSmtpFields.length > 0 && configuredSmtpFields.length !== smtpFields.length) {
      for (const [name, value] of smtpFields) {
        if (!value) {
          context.addIssue({
            code: 'custom',
            path: [name],
            message: 'SMTP 配置必须完整填写或全部留空',
          });
        }
      }
    }

    if (values.NODE_ENV === 'production') {
      if (!values.REDIS_PASSWORD) {
        context.addIssue({
          code: 'custom',
          path: ['REDIS_PASSWORD'],
          message: '生产环境必须配置 Redis 密码',
        });
      }
      if (configuredSmtpFields.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['SMTP_HOST'],
          message: '生产环境必须配置验证码邮件服务',
        });
      }
      if (values.DB_AUTO_CREATE || values.DB_SYNC_ALTER) {
        context.addIssue({
          code: 'custom',
          path: ['DB_AUTO_CREATE'],
          message: '生产环境禁止自动创建数据库或自动修改表结构',
        });
      }
    }
  });

export type AppEnv = ReturnType<typeof createEnv>;

export function createEnv(source: NodeJS.ProcessEnv) {
  const parsed = rawEnvSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'ENV'}: ${issue.message}`)
      .join('; ');
    throw new Error(`环境变量配置无效：${details}`);
  }

  const values = parsed.data;
  const smtp = values.SMTP_HOST
    ? Object.freeze({
        host: values.SMTP_HOST,
        port: values.SMTP_PORT,
        user: values.SMTP_USER!,
        password: values.SMTP_PASSWORD!,
        from: values.SMTP_FROM!,
      })
    : null;

  return Object.freeze({
    app: Object.freeze({
      nodeEnv: values.NODE_ENV,
      port: values.PORT,
    }),
    database: Object.freeze({
      host: values.DB_HOST,
      port: values.DB_PORT,
      name: values.DB_NAME,
      user: values.DB_USER,
      password: values.DB_PASSWORD,
      autoCreate: values.DB_AUTO_CREATE,
      syncAlter: values.DB_SYNC_ALTER,
      logging: values.DB_LOGGING,
    }),
    redis: Object.freeze({
      host: values.REDIS_HOST,
      port: values.REDIS_PORT,
      password: values.REDIS_PASSWORD,
      db: values.REDIS_DB,
    }),
    auth: Object.freeze({
      jwtSecret: values.JWT_SECRET,
      refreshTokenSecret: values.REFRESH_TOKEN_SECRET,
    }),
    qiniu: Object.freeze({
      accessKey: values.QINIU_ACCESS_KEY,
      secretKey: values.QINIU_SECRET_KEY,
      publicDomain: `https://${values.FILES_DOMAIN}`,
      privateDomain: `https://${values.PRIVATE_FILES_DOMAIN}`,
    }),
    smtp,
  });
}

export const env = createEnv(process.env);
