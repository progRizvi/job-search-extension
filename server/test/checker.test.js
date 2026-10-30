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
