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
  // Older databases have no claim marker on links.
  const [claim] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'urls' AND COLUMN_NAME = 'claimed_at'"
  );
  if (!claim.length) await pool.query('ALTER TABLE urls ADD COLUMN claimed_at TIMESTAMP NULL DEFAULT NULL');
  // Older databases kept one job per link (url_id was the key). Move them to one row per job.
  const [cols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'job_results' AND COLUMN_NAME = 'job_hash'"
  );
  if (!cols.length) {
    await pool.query(
      "ALTER TABLE job_results DROP PRIMARY KEY, ADD COLUMN id INT AUTO_INCREMENT PRIMARY KEY FIRST, ADD COLUMN job_hash CHAR(40) NOT NULL DEFAULT '' AFTER url_id, ADD UNIQUE KEY uq_url_job (url_id, job_hash)"
    );
    await pool.query('UPDATE job_results SET job_hash = SHA1(job_url) WHERE job_url IS NOT NULL');
  }
}
