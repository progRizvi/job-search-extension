import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';

const stubPool = { query: async () => [[{ n: 0 }]] };
const listen = (app) => new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });

test('health is open, other routes need the key', async () => {
  const s = await listen(createApp(stubPool, { key: 'k' }));
  const base = `http://127.0.0.1:${s.address().port}`;
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/stats`)).status, 401);
  assert.equal((await fetch(`${base}/stats`, { headers: { 'x-lead-key': 'k' } })).status, 200);
  s.close();
});

test('refuses to start without a key', () => {
  assert.throws(() => createApp(stubPool, { key: '' }));
});
