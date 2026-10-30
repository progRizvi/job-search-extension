// Country search: one query at a time ("remote node js jobs in France"), every result URL goes to the server.
const COLLECT_DAILY_LIMIT = 150;
const COLLECT_JUNK = /(^|\.)(google|bing|duckduckgo|yahoo|facebook|instagram|twitter|x|youtube|tiktok|pinterest|wikipedia|linkedin)\.[a-z.]+$/i;

async function getCollector() {
  return (await chrome.storage.local.get('collector')).collector || { running: false };
}

async function setCollector(patch) {
  const collector = { ...(await getCollector()), ...patch };
  await chrome.storage.local.set({ collector });
  chrome.action.setBadgeText({ text: collector.running ? 'GEO' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#0a5c7a' });
  return collector;
}

async function finishCollector(message, winId) {
  await setCollector({ running: false, message, nextAt: null });
  alertFinished(message);
  if (winId) chrome.windows.remove(winId).catch(() => {});
}

// Waits in 1 s slices so Stop works quickly. Returns false when stopped.
async function collectorPause(sec) {
  await setCollector({ nextAt: Date.now() + sec * 1000 });
  for (let i = 0; i < sec; i++) {
    await sleep(1000);
    if (!(await holdIfPaused())) return false;
    if (!(await getCollector()).running) return false;
  }
  await setCollector({ nextAt: null });
  return true;
}

const isLeadUrl = (u) => {
  try { return !COLLECT_JUNK.test(new URL(u).hostname); } catch { return false; }
};

async function collectLoop() {
  let winId;
  googleBlocked = false;
  try {
    const win = await chrome.windows.create({ url: 'https://www.bing.com/', focused: false, type: 'normal', width: 1000, height: 760 });
    winId = win.id;
    const tabId = win.tabs[0].id;
    for (;;) {
      if (!(await getCollector()).running) return finishCollector('Stopped by you.', winId);
      if (!(await holdIfPaused())) return finishCollector('Stopped by you.', winId);

      const d = (await chrome.storage.local.get('collectorDaily')).collectorDaily;
      const used = d && d.date === today() ? d.count : 0;
      if (used >= COLLECT_DAILY_LIMIT) {
        return finishCollector(`Done for today: ${COLLECT_DAILY_LIMIT} searches used. Start again tomorrow.`, winId);
      }

      const next = await serverFetch('/collector/next');
      if (next.done) return finishCollector('Done: every country has been searched.', winId);

      await setCollector({ message: `Searching "${next.query}"…`, country: next.country.name });
      const res = await searchWeb(tabId, next.query);
      if (res.blocked) {
        return finishCollector('Stopped: the search engines are asking for a check (captcha). Open one yourself, solve it, then start again.', winId);
      }
      // Even if Stop was pressed during the search, keep what it found; the pause below then stops the run.
      const urls = (res.links || []).filter(isLeadUrl);
      await serverFetch('/collector/results', { countryCode: next.country.code, templateIndex: next.templateIndex, engine: res.engine, urls });
      await chrome.storage.local.set({ collectorDaily: { date: today(), count: used + 1 } });

      if (!(await collectorPause(Math.round(rnd(15, 40))))) return finishCollector('Stopped by you.', winId);
    }
  } catch (e) {
    await finishCollector(e instanceof ServerDown ? `Stopped: ${e.message} Start server/start.bat, then try again.` : `Stopped: ${e.message}`, winId);
  }
}
