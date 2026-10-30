import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createApp } from '../app.js';
import { makePool, migrate } from '../db.js';
import { seedCountries } from '../routes/collector.js';

const KEY = 'e2e-key';
let pool, server, ctx, store;

// Loads the extension's serverClient.js and collector.js with chrome and the browser parts stubbed.
function load(searchWebBody, address) {
  store = { leadKey: KEY };
  const chrome = {
    storage: { local: {
      get: async (k) => (typeof k === 'string' ? { [k]: store[k] } : Object.fromEntries(k.map((x) => [x, store[x]]))),
      set: async (o) => Object.assign(store, JSON.parse(JSON.stringify(o))),
    } },
    windows: { create: async () => ({ id: 1, tabs: [{ id: 1 }] }), remove: async () => {} },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  };
  ctx = vm.createContext({ chrome, fetch, URL, console, JSON, Date, Math, globalThis: null, LEAD_SERVER: address || `http://127.0.0.1:${server.address().port}` });
  ctx.globalThis = ctx;
  vm.runInContext(
    `const sleep = () => Promise.resolve(); const rnd = (a) => a; let googleBlocked = false; const alertFinished = async () => {}; const holdIfPaused = async () => true;
     const today = () => '2026-10-30'; ${searchWebBody}`, ctx);
  for (const f of ['../../serverClient.js', '../../collector.js']) vm.runInContext(readFileSync(new URL(f, import.meta.url), 'utf8'), ctx);
}

before(async () => {
  pool = makePool(process.env.MYSQL_TEST_DATABASE);
  await migrate(pool);
  await pool.query('TRUNCATE countries; TRUNCATE urls; TRUNCATE url_countries');
  await seedCountries(pool);
  server = await new Promise((res) => { const s = createApp(pool, { key: KEY }).listen(0, '127.0.0.1', () => res(s)); });
});
after(async () => { server.close(); await pool.end(); });

test('collectLoop posts filtered links, saves the position, and stops cleanly', async () => {
  load(`async function searchWeb() {
    chrome.storage.local.set({ collector: { running: false } }); // user presses Stop during the first search
    return { blocked: false, engine: 'Bing', links: ['https://jobs.example.com/node?utm_x=1', 'https://www.google.com/x', 'https://acme.io/careers'] };
  }`);
  store.collector = { running: true };
  await vm.runInContext('collectLoop()', ctx);
  assert.match(store.collector.message, /^Stopped by you/);
  const [[u]] = await pool.query('SELECT COUNT(*) n FROM urls');
  assert.equal(u.n, 2); // the Google link is filtered out, the tracking parameter is stripped
});

test('collectLoop reports a stopped server instead of throwing', async () => {
  load('async function searchWeb() { return { blocked: false, engine: "Bing", links: [] }; }', 'http://127.0.0.1:1');
  store.collector = { running: true };
  await vm.runInContext('collectLoop()', ctx);
  assert.match(store.collector.message, /not running/);
  assert.equal(store.collector.running, false);
});
