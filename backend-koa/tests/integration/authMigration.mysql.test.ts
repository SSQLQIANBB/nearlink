import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { Sequelize } from 'sequelize';

const testUrl = process.env.AUTH_TEST_MYSQL_URL;
if (testUrl && !/^todesk_auth_test_[a-zA-Z0-9_]+$/.test(new URL(testUrl).pathname.slice(1))) {
  throw new Error('AUTH_TEST_MYSQL_URL must name a disposable todesk_auth_test_* database');
}
const suite = testUrl ? describe : describe.skip;
suite('explicit authentication SQL migration', () => {
  let db: Sequelize;
  const apply = async (name: string) => {
    const sql = readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
    await db.query(sql);
  };
  beforeAll(async () => {
    db = new Sequelize(testUrl!, { logging: false, dialectOptions: { multipleStatements: true } });
    await db.query(
      'CREATE TABLE users (id INT PRIMARY KEY AUTO_INCREMENT, username VARCHAR(50) NOT NULL) ENGINE=InnoDB',
    );
    await db.query("INSERT INTO users (username) VALUES ('existing')");
  });
  afterAll(async () => {
    await db.query('DROP TABLE IF EXISTS login_sessions');
    await db.query('DROP TABLE IF EXISTS users');
    await db.close();
  });
  it('backfills legacy users and safety rollback retains a changed, nonempty version', async () => {
    await apply('20260925-login-sessions.up.sql');
    const [before] = await db.query('SELECT authVersion FROM users');
    const previous = (before as { authVersion: string }[])[0].authVersion;
    expect(previous).toMatch(/^[a-f0-9-]{36}$/);
    await expect(db.query('UPDATE users SET authVersion = NULL')).rejects.toThrow();
    await db.query(
      `INSERT INTO login_sessions (id, userId, authVersion, refreshHash, expiresAt, createdAt, updatedAt)
      VALUES (UUID(), 1, :version, REPEAT('a',64), DATE_ADD(NOW(), INTERVAL 1 DAY), NOW(), NOW())`,
      { replacements: { version: previous } },
    );
    await apply('20260925-login-sessions.rollback.sql');
    const [after] = await db.query('SELECT authVersion FROM users');
    expect((after as { authVersion: string }[])[0].authVersion).not.toBe(previous);
    const [sessions] = await db.query('SELECT revokedAt FROM login_sessions');
    expect((sessions as { revokedAt: Date | null }[])[0].revokedAt).not.toBeNull();
  });
});
