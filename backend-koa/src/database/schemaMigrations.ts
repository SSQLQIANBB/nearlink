import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type SchemaQuery = (sql: string, values?: unknown[]) => Promise<any[]>;
const migrationFiles = ['20260925-login-sessions.up.sql', '20260925-remote-control.up.sql', '20260926-remote-lifecycle.up.sql', '20260927-assistance-duration.up.sql'];
const requiredColumns: Record<string, string[]> = {
  users: ['authVersion'],
  login_sessions: ['id', 'userId', 'authVersion', 'refreshHash', 'version', 'expiresAt', 'revokedAt', 'rotationRequestId', 'rotationInputHash', 'rotationResponse', 'rotationExpiresAt', 'createdAt', 'updatedAt'],
  remote_devices: ['id', 'ownerUserId', 'publicKey', 'fingerprint', 'keyVersion', 'alias', 'platform', 'revokedAt', 'createdAt', 'updatedAt'],
  remote_assistance_grants: ['id', 'hostDeviceId', 'createdBySid', 'controllerUserId', 'expiresAt', 'revokedAt', 'createdAt', 'updatedAt'],
  remote_sessions: ['sessionId', 'controllerUserId', 'hostUserId', 'controllerSid', 'hostSid', 'hostDeviceId', 'grantId', 'scope', 'state', 'revision', 'endedAt', 'endReason', 'createdAt', 'updatedAt', 'requestId', 'requestHash', 'controllerEndpointId', 'grantCreatedBySid'],
  remote_session_events: ['sessionId', 'eventSeq', 'eventType', 'reason', 'occurredAt', 'observedAt'],
};

async function columns(query: SchemaQuery, table: string) {
  return query('SELECT COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
}

async function indexes(query: SchemaQuery, table: string) {
  return query(`SELECT INDEX_NAME, NON_UNIQUE, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columnList
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
    GROUP BY INDEX_NAME, NON_UNIQUE`, [table]);
}

export async function assertDatabaseSchema(query: SchemaQuery) {
  for (const [table, names] of Object.entries(requiredColumns)) {
    const actual = await columns(query, table);
    const missing = names.filter(name => !actual.some(column => column.COLUMN_NAME === name));
    if (missing.length) throw new Error(`数据库迁移未完成：${table}.${missing.join(', ')}；停止后端、备份后运行 pnpm db:migrate`);
    if (table === 'remote_assistance_grants' && actual.find(column => column.COLUMN_NAME === 'expiresAt')?.IS_NULLABLE !== 'YES') {
      throw new Error('数据库迁移未完成：协助许可 expiresAt 必须允许 NULL');
    }
    if (table === 'users' && actual.find(column => column.COLUMN_NAME === 'authVersion')?.IS_NULLABLE !== 'NO') {
      throw new Error('数据库迁移未完成：users.authVersion 必须为 NOT NULL');
    }
  }
  const [invalid] = await query("SELECT COUNT(*) AS count FROM users WHERE authVersion IS NULL OR authVersion = ''");
  if (Number(invalid.count)) throw new Error('数据库迁移未完成：用户认证版本尚未回填');
  const sessionIndexes = await indexes(query, 'remote_sessions');
  if (!sessionIndexes.some(index => !Number(index.NON_UNIQUE) && index.columnList === 'controllerSid,requestId')) {
    throw new Error('数据库迁移未完成：远控请求幂等唯一索引缺失');
  }
}

/** Explicit, additive maintenance command. MySQL DDL commits immediately, so every step is resumable. */
export async function migrateDatabase(query: SchemaQuery) {
  const [lock] = await query("SELECT GET_LOCK(CONCAT('todesk-schema-', LEFT(SHA2(DATABASE(), 256), 40)), 30) AS acquired");
  if (Number(lock.acquired) !== 1) throw new Error('无法取得数据库迁移锁');
  try {
    if (!(await columns(query, 'users')).length) {
      // A genuinely empty database is bootstrapped by the existing model sync at startup.
      const tables = await query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
      if (tables.length) throw new Error('数据库非空但缺少 users 表，拒绝自动迁移');
      return;
    }
    for (const file of migrationFiles) {
      const sql = readFileSync(resolve(__dirname, '../../migrations', file), 'utf8').replace(/^--.*$/gm, '');
      for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) {
        const alter = /^ALTER TABLE (\w+)\s+([\s\S]+)$/i.exec(statement);
        if (!alter) {
          // Tables may already have been created by the old startup sync. Never drop them.
          await query(statement.replace(/^CREATE TABLE (?!IF NOT EXISTS)/i, 'CREATE TABLE IF NOT EXISTS '));
          continue;
        }
        const [, table, actions] = alter;
        for (const action of actions.split(/,\s*(?=ADD\s)/i)) {
          const column = /^ADD COLUMN (\w+)\s/i.exec(action);
          const index = /^ADD (UNIQUE )?INDEX (\w+)\s*\(([^)]+)\)$/i.exec(action);
          if (column && (await columns(query, table)).some(value => value.COLUMN_NAME === column[1])) continue;
          if (index) {
            const expected = index[3].replace(/\s/g, '');
            const actual = await indexes(query, table);
            if (actual.some(value => value.columnList === expected && (!index[1] || !Number(value.NON_UNIQUE)))) continue;
          }
          if (/^MODIFY COLUMN authVersion /i.test(action)) {
            const current = (await columns(query, table)).find(value => value.COLUMN_NAME === 'authVersion');
            if (current?.IS_NULLABLE === 'NO') continue;
          }
          if (table === 'remote_assistance_grants' && /^MODIFY COLUMN expiresAt /i.test(action)
            && (await columns(query, table)).find(value => value.COLUMN_NAME === 'expiresAt')?.IS_NULLABLE === 'YES') continue;
          await query(`ALTER TABLE ${table} ${action}`);
        }
      }
    }
    await assertDatabaseSchema(query);
  } finally {
    await query("SELECT RELEASE_LOCK(CONCAT('todesk-schema-', LEFT(SHA2(DATABASE(), 256), 40)))");
  }
}
