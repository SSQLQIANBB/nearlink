import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mysql, { type Connection } from 'mysql2/promise';
import { assertDatabaseSchema, migrateDatabase, type SchemaQuery } from '../../src/database/schemaMigrations';

const url = process.env.AUTH_TEST_MYSQL_URL;
if (url && !/^todesk_auth_test_[a-zA-Z0-9_]+$/.test(new URL(url).pathname.slice(1))) throw new Error('Disposable test database required');
const suite = url ? describe : describe.skip;
suite('resumable production schema migration', () => {
  let connection: Connection;
  let query: SchemaQuery;
  const tables = ['remote_session_events', 'remote_sessions', 'remote_assistance_grants', 'remote_devices', 'login_sessions', 'users'];
  beforeAll(async () => {
    connection = await mysql.createConnection(url!);
    query = async (sql, values) => (await connection.query(sql, values))[0] as any[];
  });
  afterAll(async () => {
    for (const table of tables) await query(`DROP TABLE IF EXISTS ${table}`);
    await connection.end();
  });
  it('detects a legacy database, migrates twice without changing existing credentials or data', async () => {
    await query('CREATE TABLE users (id INT PRIMARY KEY AUTO_INCREMENT, username VARCHAR(50), password VARCHAR(100)) ENGINE=InnoDB');
    await query("INSERT INTO users (username, password) VALUES ('legacy', 'unchanged')");
    await expect(assertDatabaseSchema(query)).rejects.toThrow('users.authVersion');
    await migrateDatabase(query);
    const [expiry] = await query("SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='remote_assistance_grants' AND COLUMN_NAME='expiresAt'");
    expect(expiry.IS_NULLABLE).toBe('YES');
    const [before] = await query('SELECT * FROM users');
    expect(before.authVersion).toMatch(/^[a-f0-9-]{36}$/);
    await query(`INSERT INTO login_sessions (id,userId,authVersion,refreshHash,expiresAt,createdAt,updatedAt)
      VALUES (UUID(),1,?,REPEAT('a',64),DATE_ADD(NOW(),INTERVAL 1 DAY),NOW(),NOW())`, [before.authVersion]);
    await migrateDatabase(query);
    expect(await query('SELECT * FROM users')).toEqual([before]);
    const [session] = await query('SELECT authVersion,revokedAt FROM login_sessions');
    expect(session).toEqual({ authVersion: before.authVersion, revokedAt: null });
    await assertDatabaseSchema(query);
  });
  it('resumes partially applied DDL and backfills only missing account versions', async () => {
    await query('ALTER TABLE users MODIFY authVersion CHAR(36) NULL');
    await query("INSERT INTO users (username,password) VALUES ('partial','unchanged')");
    await query('ALTER TABLE remote_sessions DROP INDEX remote_history_retention, DROP COLUMN requestHash');
    const [before] = await query('SELECT authVersion FROM users WHERE id=1');
    await migrateDatabase(query);
    await assertDatabaseSchema(query);
    expect((await query('SELECT authVersion FROM users WHERE id=1'))[0]).toEqual(before);
    expect((await query('SELECT authVersion FROM users WHERE id=2'))[0].authVersion).toMatch(/^[a-f0-9-]{36}$/);
    await expect(query('UPDATE users SET authVersion=NULL WHERE id=2')).rejects.toThrow();
  });
  it('accepts existing equivalent ORM index names and fails closed for unknown incomplete tables', async () => {
    await query('ALTER TABLE remote_sessions RENAME INDEX remote_request_idempotency TO remote_sessions_controller_sid_request_id');
    await migrateDatabase(query);
    await query('ALTER TABLE login_sessions DROP COLUMN rotationResponse');
    await expect(migrateDatabase(query)).rejects.toThrow('login_sessions.rotationResponse');
    const [lock] = await query("SELECT IS_FREE_LOCK(CONCAT('todesk-schema-', LEFT(SHA2(DATABASE(),256),40))) AS free");
    expect(Number(lock.free)).toBe(1);
  });
});
