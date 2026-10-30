import mysql from 'mysql2/promise';
import { readFileSync } from 'node:fs';

export function makePool(database = process.env.MYSQL_DATABASE) {
  return mysql.createPool({
    host: process.env.MYSQL_HOST, user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD,
    database, connectionLimit: 5, multipleStatements: true,
  });
}

export async function migrate(pool) {
  await pool.query(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
}
