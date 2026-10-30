import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createApp } from '../app.js';
import { makePool, migrate } from '../db.js';
import { seedCountries } from '../routes/collector.js';

const KEY = 'check-key';
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

test('remoteMatches follows the remote scope rules', () => {
  const ctx = vm.createContext({});
  vm.runInContext(readFileSync(new URL('../../shared.js', import.meta.url), 'utf8'), ctx);
  const m = (...a) => vm.runInContext(`remoteMatches(...${JSON.stringify(a)})`, ctx);
  assert.equal(m('worldwide', 'remote', 'France', ['France']), true);
  assert.equal(m('country-only: US', 'remote', 'France', ['France']), false);
  assert.equal(m('country-only: France', 'remote', 'France', ['France']), true);
  assert.equal(m('region: Europe', 'remote', 'France', ['France']), true);
  assert.equal(m('worldwide', 'onsite', 'France', ['France']), false);
  assert.equal(m('excluded', 'remote', 'France', ['France']), false);
  assert.equal(m('unknown', 'remote', 'France', ['France']), false);
});

test('checker returns the oldest new url with its countries, and a result marks it checked', async () => {
  const fr = await call('/collector/next');
  await call('/collector/results', { countryCode: fr.country.code, templateIndex: 0, engine: 'Bing', urls: ['https://a.com/jobs', 'https://b.com/jobs'] });
  const next = await call('/checker/next');
  assert.equal(next.url, 'https://a.com/jobs');
  assert.deepEqual(next.countries, [fr.country.name]);
  await call('/checker/result', { id: next.id, status: 'checked', kind: 'board', result: { careersUrl: 'https://a.com/jobs', openings: 'yes', jobTitle: 'Node Developer', jobUrl: 'https://a.com/jobs/1', workType: 'remote', remoteScope: 'worldwide', fit: 'good', stack: 'node', checkedBy: 'DeepSeek' } });
  assert.equal((await call('/checker/next')).url, 'https://b.com/jobs');
  await call('/checker/result', { id: (await call('/checker/next')).id, status: 'unreachable', kind: 'unknown' });
  assert.deepEqual(await call('/checker/next'), { done: true });
  const [[row]] = await pool.query('SELECT job_title, remote_scope FROM job_results WHERE url_id = ?', [next.id]);
  assert.deepEqual([row.job_title, row.remote_scope], ['Node Developer', 'worldwide']);
});

test('export returns one row per url and country with the job fields filled', async () => {
  const a = await call('/collector/next');
  await call('/collector/results', { countryCode: a.country.code, templateIndex: 0, engine: 'Bing', urls: ['https://a.com/jobs'] });
  await pool.query("UPDATE countries SET status='done' WHERE code=?", [a.country.code]);
  const b = await call('/collector/next');
  await call('/collector/results', { countryCode: b.country.code, templateIndex: 0, engine: 'Bing', urls: ['https://a.com/jobs'] });
  const next = await call('/checker/next');
  await call('/checker/result', { id: next.id, status: 'checked', kind: 'board', result: { careersUrl: 'https://a.com/jobs', openings: 'yes', jobTitle: 'Node Dev', jobUrl: 'https://a.com/jobs/1', workType: 'remote', remoteScope: 'worldwide', fit: 'good', stack: 'node', checkedBy: 'DeepSeek' } });
  const { rows } = await call('/export');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.jobTitle), ['Node Dev', 'Node Dev']);
  assert.deepEqual(rows.map((r) => r.country).sort(), [a.country.name, b.country.name].sort());
  assert.equal(rows[0].url, 'https://a.com/jobs');
});

test('manual links: added with a country, re-queued when already checked, and checked before searched links', async () => {
  const a = await call('/collector/next');
  await call('/collector/results', { countryCode: a.country.code, templateIndex: 0, engine: 'Bing', urls: ['https://searched.com/jobs'] });
  const r = await call('/links', { countryCode: a.country.code, urls: ['https://www.ycombinator.com/jobs/role/software-engineer?utm_x=1', 'not a url', 'https://www.indeed.com/q-node-jobs.html'] });
  assert.deepEqual([r.added, r.requeued, r.invalid], [2, 0, 1]);
  assert.equal((await call('/checker/next')).url, 'https://www.ycombinator.com/jobs/role/software-engineer'); // manual first
  const first = await call('/checker/next');
  await call('/checker/result', { id: first.id, status: 'checked', kind: 'board' });
  const again = await call('/links', { countryCode: a.country.code, urls: ['https://www.ycombinator.com/jobs/role/software-engineer'] });
  assert.deepEqual([again.added, again.requeued], [0, 1]); // an already-checked link is queued for another check
  assert.equal((await call('/checker/next')).url, 'https://www.ycombinator.com/jobs/role/software-engineer');
});

test('Anywhere is offered for manual links but is not counted as a country', async () => {
  const list = await call('/countries');
  assert.equal(list.countries[0].name, 'Anywhere');
  assert.equal(list.countries.length, 199);
  const stats = await call('/stats');
  assert.equal(stats.countriesTotal, 198);
  const r = await call('/links', { urls: ['https://remoteok.com/remote-node-jobs'] }); // no country means Anywhere
  assert.equal(r.added, 1);
  assert.deepEqual((await call('/checker/next')).countries, ['Anywhere']);
});

test('a list page can save several matching jobs, and a re-check replaces them', async () => {
  const a = await call('/collector/next');
  await call('/collector/results', { countryCode: a.country.code, templateIndex: 0, engine: 'Bing', urls: ['https://board.com/list'] });
  const next = await call('/checker/next');
  const job = (n) => ({ careersUrl: 'https://board.com/list', openings: 'yes', jobTitle: `Node Dev ${n}`, jobUrl: `https://board.com/job/${n}`, workType: 'remote', remoteScope: 'worldwide', fit: 'good', stack: 'node', checkedBy: 'DeepSeek' });
  await call('/checker/result', { id: next.id, status: 'checked', kind: 'board', results: [job(1), job(2), job(3)] });
  assert.equal((await call('/export')).rows.length, 3);
  assert.equal((await call('/stats')).matches, 3);
  await call('/checker/result', { id: next.id, status: 'checked', kind: 'board', results: [job(9)] });
  assert.deepEqual((await call('/export')).rows.map((r) => r.jobTitle), ['Node Dev 9']);
});

test('requeue puts checked links back in the queue', async () => {
  const a = await call('/collector/next');
  await call('/collector/results', { countryCode: a.country.code, templateIndex: 0, engine: 'Bing', urls: ['https://x.com/1', 'https://x.com/2', 'https://x.com/3'] });
  const one = await call('/checker/next');
  await call('/checker/result', { id: one.id, status: 'checked', kind: 'board' });
  const two = await call('/checker/next');
  await call('/checker/result', { id: two.id, status: 'unreachable', kind: 'unknown' });
  assert.deepEqual(await call('/checker/requeue', { which: 'unreachable' }), { requeued: 1 });
  assert.deepEqual(await call('/checker/requeue', { which: 'all' }), { requeued: 1 }); // the one still checked
  assert.equal((await call('/stats')).checked, 0);
});

