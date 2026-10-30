import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { makePool, migrate } from '../db.js';
import { normalizeUrl } from '../normalize.js';
import { seedCountries } from '../routes/collector.js';

const KEY = 'test-key';
let pool, server, base;
const call = async (path, body) => {
  const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'x-lead-key': KEY, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return r.json();
};

before(async () => {
  pool = makePool(process.env.MYSQL_TEST_DATABASE);
  await migrate(pool);
  server = await new Promise((res) => { const s = createApp(pool, { key: KEY }).listen(0, '127.0.0.1', () => res(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  await pool.query('TRUNCATE countries; TRUNCATE urls; TRUNCATE url_countries; TRUNCATE job_results');
  await seedCountries(pool);
});
after(async () => { server.close(); await pool.end(); });

test('normalizeUrl strips tracking, fragment, trailing slash and lowercases the host', () => {
  assert.equal(normalizeUrl('https://A.com/x/?utm_source=a#b'), 'https://a.com/x');
  assert.equal(normalizeUrl('https://a.com/'), 'https://a.com');
});

test('same url for two countries is one url row and two country rows', async () => {
  const first = await call('/collector/next');
  await call('/collector/results', { countryCode: first.country.code, templateIndex: 0, engine: 'Bing', urls: ['https://x.com/jobs?utm_a=1'] });
  await pool.query("UPDATE countries SET status='done' WHERE code=?", [first.country.code]);
  const second = await call('/collector/next');
  const r = await call('/collector/results', { countryCode: second.country.code, templateIndex: 0, engine: 'Bing', urls: ['https://x.com/jobs'] });
  assert.equal(r.added, 0);
  assert.equal(r.duplicates, 1);
  const [[u]] = await pool.query('SELECT COUNT(*) n FROM urls');
  const [[uc]] = await pool.query('SELECT COUNT(*) n FROM url_countries');
  assert.deepEqual([u.n, uc.n], [1, 2]);
});

test('next resumes at the saved template, then moves to the next country after the last one', async () => {
  const a = await call('/collector/next');
  assert.equal(a.templateIndex, 0);
  assert.equal(a.query, `remote node js jobs in ${a.country.name}`);
  await call('/collector/results', { countryCode: a.country.code, templateIndex: 0, engine: 'Bing', urls: [] });
  assert.equal((await call('/collector/next')).templateIndex, 1);
  for (const i of [1, 2, 3]) await call('/collector/results', { countryCode: a.country.code, templateIndex: i, engine: 'Bing', urls: [] });
  const b = await call('/collector/next');
  assert.notEqual(b.country.code, a.country.code);
  assert.equal(b.templateIndex, 0);
  const stats = await call('/stats');
  assert.equal(stats.countriesDone, 1);
  assert.equal(stats.countriesTotal, 198); // Bangladesh, India, Pakistan and Afghanistan are skipped
});

test('skipped countries are never handed out, even if already stored', async () => {
  await pool.query("INSERT IGNORE INTO countries (code, name) VALUES ('AF', 'Afghanistan'), ('IN', 'India')");
  await seedCountries(pool);
  const [rows] = await pool.query("SELECT code FROM countries WHERE code IN ('BD','IN','PK','AF')");
  assert.equal(rows.length, 0);
  assert.notEqual((await call('/collector/next')).country.name, 'Afghanistan');
});
