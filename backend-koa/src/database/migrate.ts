import mysql from 'mysql2/promise';
import { env } from '../config/env';
import { assertDatabaseSchema, migrateDatabase, type SchemaQuery } from './schemaMigrations';

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0] !== '--check')) throw new Error('用法：pnpm db:migrate [--check]');
  const connection = await mysql.createConnection({
    host: env.database.host, port: env.database.port, user: env.database.user,
    password: env.database.password, database: env.database.name,
  });
  const query: SchemaQuery = async (sql, values) => (await connection.query(sql, values))[0] as any[];
  try {
    if (args[0] === '--check') await assertDatabaseSchema(query);
    else await migrateDatabase(query);
    console.log('✓ 数据库认证与远控结构检查完成');
  } finally { await connection.end(); }
}
main().catch(error => { console.error('✗ 数据库迁移失败：', error.message); process.exitCode = 1; });
