// When a page needs the user (captcha, sign-in), the run stops, makes a noise, and waits until it is solved.
const WAIT_LIMIT_MS = 30 * 60 * 1000;
const REALERT_MS = 30 * 1000;

async function anyRunActive() {
  const s = await chrome.storage.local.get(['auto', 'sites', 'jobs', 'collector', 'checker']);
  return !!(s.auto?.running || s.sites?.running || s.jobs?.running || s.collector?.running || s.checker?.running);
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK'], justification: 'Play a sound when a captcha needs solving',
  });
}

async function alertUser(title, message, windowId) {
  try { await ensureOffscreen(); await chrome.runtime.sendMessage({ type: 'beep' }); } catch { /* sound is a bonus */ }
  try { chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 2 }); } catch { /* ignore */ }
  if (windowId) chrome.windows.update(windowId, { focused: true, drawAttention: true }).catch(() => {});
}

// Waits until isClear() returns true. Returns true when solved, false when the run was stopped or the wait timed out.
async function waitForUser(tabId, isClear, what, limitMs = WAIT_LIMIT_MS) {
  const { windowId } = await chrome.tabs.get(tabId);
  const t0 = Date.now();
  let lastAlert = 0;
  await chrome.storage.local.set({ waiting: { what, since: t0 } });
  try {
    while (Date.now() - t0 < limitMs) {
      if (!(await anyRunActive())) return false;
      if (Date.now() - lastAlert > REALERT_MS) {
        lastAlert = Date.now();
        await alertUser('Action needed', `${what} Solve it in the window that just opened. The run continues by itself.`, windowId);
      }
      await sleep(3000);
      try { if (await isClear()) return true; } catch { /* page is changing; try again */ }
    }
    return false;
  } finally {
    await chrome.storage.local.remove('waiting');
  }
}

// Pause: a run holds still at its next safe point until the user resumes it. Returns false when the run was
// stopped while it waited, so the caller can stop too.
async function holdIfPaused() {
  while ((await chrome.storage.local.get('paused')).paused) {
    if (!(await anyRunActive())) {
      await chrome.storage.local.remove('paused');
      return false;
    }
    await sleep(1000);
  }
  return true;
}

// Tells the user a run ended: finished, or stopped by an error. Their own Stop press is not announced.
async function alertFinished(message) {
  await chrome.storage.local.remove('paused'); // a run that ended is no longer paused
  if (!message || /^Stopped by you/.test(message)) return;
  const done = /^Done/.test(message);
  await alertUser(done ? 'Task complete' : 'Run stopped', message);
}
