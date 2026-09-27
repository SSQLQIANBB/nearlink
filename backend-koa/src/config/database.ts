import { Sequelize } from 'sequelize';
import mysql from 'mysql2/promise';
import { env } from './env';
import { assertDatabaseSchema } from '../database/schemaMigrations';

const { database } = env;

// 创建数据库（如果不存在）
async function createDatabaseIfNotExists() {
  const connection = await mysql.createConnection({
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
  });

  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${database.name}\`
       CHARACTER SET utf8mb4
       COLLATE utf8mb4_unicode_ci;`,
    );

    console.log(`✓ 数据库 "${database.name}" 检查/创建完成`);
  } finally {
    await connection.end();
  }
}

// 使用 MySQL 配置
const sequelize = new Sequelize({
  database: database.name,
  username: database.user,
  password: database.password,
  host: database.host,
  port: database.port,
  dialect: 'mysql',
  logging: database.logging,
  // 连接池配置
  pool: {
    max: 5,
    min: 0,
    acquire: 30000,
    idle: 10000,
  },
  retry: {
    max: 3,
  },
  define: {
    charset: 'utf8mb4',
    collate: 'utf8mb4_unicode_ci',
  },
});

export async function initDatabase() {
  try {
    if (database.autoCreate) {
      // 1. 先创建数据库
      await createDatabaseIfNotExists();
    }

    // 2. 连接数据库
    await sequelize.authenticate();
    console.log('✓ 数据库连接成功');

    // 加载所有模型以及模型关联
    await import('../models');
    console.log('✓ 模型加载完成');

    // 生产环境默认只创建缺失的表，不自动修改已有表结构
    await sequelize.sync({
      alter: database.syncAlter,
    });

    // A reachable database is not enough: old tables may still lack new auth fields.
    await assertDatabaseSchema(async (sql, values) => {
      const [rows] = await sequelize.query(sql, { replacements: values });
      return rows;
    });

    console.log(
      database.syncAlter
        ? '✓ 数据库表同步完成，已启用 alter'
        : '✓ 数据库表同步完成，未启用 alter',
    );

    // 5. 显示已创建的表
    const [tables]: any = await sequelize.query('SHOW TABLES');

    console.log(
      '✓ 当前数据库表:',
      tables.map((item: any) => Object.values(item)[0]).join(', '),
    );
  } catch (error: any) {
    console.error('✗ 数据库初始化失败:', error.message);

    if (error.original?.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error(`  → MySQL 用户名或密码错误，当前用户：${database.user}`);
    } else if (error.original?.code === 'ECONNREFUSED') {
      console.error(`  → 无法连接 MySQL：${database.host}:${database.port}`);
    } else if (error.original?.code === 'ER_BAD_DB_ERROR') {
      console.error(`  → 数据库不存在：${database.name}`);
    }

    throw error;
  }
}

export default sequelize;
