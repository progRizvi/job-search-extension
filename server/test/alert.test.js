import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function load(running = true, winState = 'normal') {
  const calls = { beep: 0, notify: 0, focus: 0, updates: [] };
  const store = { collector: { running } };
  const chrome = {
    storage: { local: {
      get: async (k) => (typeof k === 'string' ? { [k]: store[k] } : Object.fromEntries(k.map((x) => [x, store[x]]))),
      set: async (o) => Object.assign(store, o),
      remove: async (k) => { delete store[k]; },
    } },
    tabs: { get: async () => ({ windowId: 7 }) },
    windows: { get: async () => ({ state: winState }), update: async (id, o) => { calls.focus++; calls.updates.push(o); } },
    notifications: { create: () => { calls.notify++; } },
    offscreen: { hasDocument: async () => true },
    runtime: { sendMessage: async () => { calls.beep++; } },
  };
  const ctx = vm.createContext({ chrome, Date, Promise, setTimeout, sleep: () => new Promise((r) => setTimeout(r, 5)) });
  vm.runInContext(readFileSync(new URL('../../alert.js', import.meta.url), 'utf8'), ctx);
  return { ctx, calls, store };
}

test('waitForUser alerts, waits until the page is clear, then returns true', async () => {
  const { ctx, calls, store } = load();
  let n = 0;
  ctx.isClear = async () => ++n >= 3;
  const ok = await vm.runInContext('waitForUser(1, isClear, "Bing is asking for a check.")', ctx);
  assert.equal(ok, true);
  assert.deepEqual([calls.beep, calls.notify, calls.focus], [1, 1, 1]);
  assert.equal(store.waiting, undefined); // the waiting flag is cleared afterwards
});

test('waitForUser gives up when the run was stopped', async () => {
  const { ctx } = load(false);
  ctx.isClear = async () => false;
  assert.equal(await vm.runInContext('waitForUser(1, isClear, "x")', ctx), false);
});

test('waitForUser times out', async () => {
  const { ctx } = load();
  ctx.isClear = async () => false;
  assert.equal(await vm.runInContext('waitForUser(1, isClear, "x", 50)', ctx), false);
});

test('alertFinished announces Done and errors, but not the user pressing Stop', async () => {
  const { ctx, calls } = load();
  for (const m of ['Done: 5 found.', 'Stopped: the local server is not running.', 'Stopped by you. 2 found.', '']) {
    await vm.runInContext(`alertFinished(${JSON.stringify(m)})`, ctx);
  }
  assert.deepEqual([calls.beep, calls.notify], [2, 2]);
});

test('holdIfPaused waits while paused and carries on when resumed', async () => {
  const { ctx, store } = load();
  store.paused = true;
  setTimeout(() => { delete store.paused; }, 40);
  assert.equal(await vm.runInContext('holdIfPaused()', ctx), true);
});

test('holdIfPaused gives up and clears the flag when the run was stopped meanwhile', async () => {
  const { ctx, store } = load(false); // no run is active
  store.paused = true;
  assert.equal(await vm.runInContext('holdIfPaused()', ctx), false);
  assert.equal(store.paused, undefined);
});

test('a run that ends is no longer paused', async () => {
  const { ctx, store } = load();
  store.paused = true;
  await vm.runInContext('alertFinished("Stopped by you.")', ctx);
  assert.equal(store.paused, undefined);
});

test('a minimized window is brought forward for a captcha and put away again afterwards', async () => {
  const { ctx, calls } = load(true, 'minimized');
  let n = 0;
  ctx.isClear = async () => ++n >= 2;
  assert.equal(await vm.runInContext('waitForUser(1, isClear, "Bing is asking for a check.")', ctx), true);
  assert.equal(calls.updates[0].state, 'normal');           // shown so the user can solve it
  assert.equal(calls.updates.at(-1).state, 'minimized');    // and minimized again once solved
});

test('createWorkWindow opens without focus and minimizes by default, or stays normal when asked', async () => {
  const { ctx, calls } = load();
  const made = [];
  ctx.chrome.windows.create = async (o) => { made.push(o); return { id: 9, tabs: [{ id: 1 }] }; };
  await vm.runInContext('createWorkWindow("https://x.test")', ctx);
  assert.equal(made[0].focused, false);
  assert.equal(calls.updates.at(-1).state, 'minimized');
  const updatesBefore = calls.updates.length;
  ctx.chrome.storage.local.set({ workWindow: 'normal' });
  await vm.runInContext('createWorkWindow("https://x.test", 1000, 700)', ctx);
  assert.deepEqual([made[1].focused, made[1].width], [false, 1000]);
  assert.equal(calls.updates.length, updatesBefore); // left as a normal window
});
