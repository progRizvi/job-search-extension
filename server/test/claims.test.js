import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { makePool, migrate } from '../db.js';
import { seedCountries } from '../routes/collector.js';

const KEY = 'claims-key';
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
  const a = await call('/collector/next');
  await call('/collector/results', { countryCode: a.country.code, templateIndex: 0, engine: 'Bing', urls: ['https://one.com', 'https://two.com'] });
});
after(async () => { server.close(); await pool.end(); });

test('two browsers asking at the same moment get different links, and a third gets nothing', async () => {
  const [a, b] = await Promise.all([call('/checker/next'), call('/checker/next')]);
  assert.notEqual(a.url, b.url);
  assert.deepEqual(await call('/checker/next'), { done: true });
});

test('peek does not claim', async () => {
  const a = await call('/checker/next?peek=1');
  const b = await call('/checker/next?peek=1');
  assert.equal(a.id, b.id);
});

test('release gives a link back, and a result clears the claim', async () => {
  const a = await call('/checker/next');
  const b = await call('/checker/next');
  await call('/checker/release', { id: a.id });
  assert.equal((await call('/checker/next')).id, a.id);
  await call('/checker/result', { id: b.id, url: b.url, status: 'checked', kind: 'board' });
  const [[row]] = await pool.query('SELECT claimed_at FROM urls WHERE id = ?', [b.id]);
  assert.equal(row.claimed_at, null);
});

test('a claim that was not renewed for 10 minutes expires; a heartbeat renews it', async () => {
  const a = await call('/checker/next');
  await call('/checker/next'); // claims the other link too, so only expiry can free `a`
  await pool.query("UPDATE urls SET claimed_at = NOW() - INTERVAL 20 MINUTE WHERE id = ?", [a.id]);
  await call('/checker/heartbeat', { id: a.id }); // the owner is still alive
  assert.deepEqual(await call('/checker/next'), { done: true });
  await pool.query("UPDATE urls SET claimed_at = NOW() - INTERVAL 20 MINUTE WHERE id = ?", [a.id]); // the owner vanished
  assert.equal((await call('/checker/next')).id, a.id);
});

test('the links list says which link is being checked, and requeue clears claims', async () => {
  const a = await call('/checker/next');
  const rows = (await call('/links')).rows;
  assert.equal(rows.find((r) => r.id === a.id).checking, true);
  assert.equal(rows.find((r) => r.id !== a.id).checking, false);
  await call('/checker/result', { id: a.id, url: a.url, status: 'checked', kind: 'board' });
  const b = await call('/checker/next');
  await call('/checker/result', { id: b.id, url: b.url, status: 'unreachable', kind: 'unknown' });
  await call('/checker/requeue', { which: 'all' });
  assert.equal((await call('/links')).rows.filter((r) => r.checking).length, 0);
});
