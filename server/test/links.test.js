import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { makePool, migrate } from '../db.js';
import { seedCountries } from '../routes/collector.js';

const KEY = 'links-key';
let pool, server, base;
const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'x-lead-key': KEY, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const call = async (path, body) => (await (body ? post(path, body) : fetch(base + path, { headers: { 'x-lead-key': KEY } }))).json();

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

test('saved links list: filter by status and text, counts jobs, remove and requeue one', async () => {
  const a = await call('/collector/next');
  await call('/collector/results', { countryCode: a.country.code, templateIndex: 0, engine: 'Bing', urls: ['https://alpha.com/jobs', 'https://beta.com/jobs'] });
  await call('/links', { urls: ['https://gamma.com/jobs'] });
  const first = await call('/checker/next'); // the manual one comes first
  await call('/checker/result', { id: first.id, url: first.url, status: 'checked', kind: 'board', results: [
    { jobTitle: 'A', jobUrl: 'https://gamma.com/jobs/1', workType: 'remote', remoteScope: 'worldwide', fit: 'good' },
    { jobTitle: 'B', jobUrl: 'https://gamma.com/jobs/2', workType: 'remote', remoteScope: 'worldwide', fit: 'good' }] });
  let all = await call('/links');
  assert.equal(all.total, 3);
  assert.equal(all.rows[0].url, 'https://gamma.com/jobs'); // newest first
  const g = all.rows.find((r) => r.url === 'https://gamma.com/jobs');
  assert.deepEqual([g.status, g.jobs, g.countries], ['checked', 2, 'Anywhere']);
  assert.equal((await call('/links?status=checked')).total, 1);
  assert.equal((await call('/links?status=manual')).total, 1);
  assert.equal((await call('/links?q=alpha')).rows[0].url, 'https://alpha.com/jobs');
  assert.deepEqual(await call('/checker/requeue', { ids: [g.id] }), { requeued: 1 });
  assert.deepEqual(await call('/links/remove', { id: g.id }), { removed: 1 });
  all = await call('/links');
  assert.equal(all.total, 2);
  const [[left]] = await pool.query('SELECT COUNT(*) n FROM job_results');
  assert.equal(left.n, 0); // its jobs are removed with it
});

test('a link can be edited (re-queued, old jobs dropped), duplicates are refused, and stale results are ignored', async () => {
  const a = await call('/collector/next');
  await call('/collector/results', { countryCode: a.country.code, templateIndex: 0, engine: 'Bing', urls: ['https://old.com/jobs', 'https://other.com/jobs'] });
  const next = await call('/checker/next');
  await call('/checker/result', { id: next.id, url: next.url, status: 'checked', kind: 'board', results: [{ jobTitle: 'A', jobUrl: 'https://old.com/jobs/1', workType: 'remote', remoteScope: 'worldwide', fit: 'good' }] });
  assert.deepEqual(await call('/links/update', { id: next.id, url: 'https://NEW.com/jobs/?utm_a=1' }), { updated: 1 });
  const row = (await call('/links?q=new.com')).rows[0];
  assert.deepEqual([row.url, row.status, row.jobs], ['https://new.com/jobs', 'new', 0]);
  assert.equal((await post('/links/update', { id: next.id, url: 'https://other.com/jobs' })).status, 409);
  assert.equal((await post('/links/update', { id: next.id, url: 'nope' })).status, 400);
  // a result for the old address (the checker was mid-visit when it was edited) must not mark the new one checked
  await call('/checker/result', { id: next.id, url: 'https://old.com/jobs', status: 'checked', kind: 'board', results: [{ jobTitle: 'Stale', jobUrl: 'https://old.com/jobs/9', workType: 'remote', remoteScope: 'worldwide', fit: 'good' }] });
  assert.equal((await call('/links?q=new.com')).rows[0].status, 'new');
  // a result for a removed link is dropped, leaving no orphan rows
  await call('/links/remove', { id: next.id });
  await call('/checker/result', { id: next.id, url: 'https://new.com/jobs', status: 'checked', kind: 'board', results: [{ jobTitle: 'Gone', jobUrl: 'https://x.com/1', workType: 'remote', remoteScope: 'worldwide', fit: 'good' }] });
  const [[left]] = await pool.query('SELECT COUNT(*) n FROM job_results');
  assert.equal(left.n, 0);
});

test('the link being checked can be pinned to the top of the list', async () => {
  const a = await call('/collector/next');
  await call('/collector/results', { countryCode: a.country.code, templateIndex: 0, engine: 'Bing', urls: ['https://p1.com', 'https://p2.com', 'https://p3.com'] });
  const first = await call('/checker/next');
  const res = await call(`/links?limit=1&pin=${first.id}`);
  assert.equal(res.rows[0].id, first.id);
  assert.equal(res.rows[0].pinned, true);
});

test('one link can be fetched by id for a single check, even when it is already checked', async () => {
  const a = await call('/collector/next');
  await call('/collector/results', { countryCode: a.country.code, templateIndex: 0, engine: 'Bing', urls: ['https://one.com/jobs', 'https://two.com/jobs'] });
  const first = await call('/checker/next');
  await call('/checker/result', { id: first.id, url: first.url, status: 'checked', kind: 'board' });
  const item = await call(`/checker/item?id=${first.id}`);
  assert.deepEqual([item.id, item.url, item.countries], [first.id, first.url, [a.country.name]]);
  assert.deepEqual(await call('/checker/item?id=999999'), { done: true }); // a removed link
});
