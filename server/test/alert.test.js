import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function load(running = true) {
  const calls = { beep: 0, notify: 0, focus: 0 };
  const store = { collector: { running } };
  const chrome = {
    storage: { local: {
      get: async (k) => (typeof k === 'string' ? { [k]: store[k] } : Object.fromEntries(k.map((x) => [x, store[x]]))),
      set: async (o) => Object.assign(store, o),
      remove: async (k) => { delete store[k]; },
    } },
    tabs: { get: async () => ({ windowId: 7 }) },
    windows: { update: async () => { calls.focus++; } },
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
