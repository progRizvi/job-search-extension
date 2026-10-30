// Checks the links saved by the country search: reads the page, follows the links DeepSeek picks,
// and keeps the best job that is remote and open to someone in the searched country.
const CHECK_DAILY_LIMIT = 300;
const CHECK_FIT_RANK = { good: 2, maybe: 1, '': 0 };
const PAGE_BLOCKED = /captcha|verify (that )?you.?re (a )?human|are you a robot|access denied|enable javascript and cookies|just a moment|sign in to continue|log in to continue/i;

async function getChecker() {
  return (await chrome.storage.local.get('checker')).checker || { running: false };
}

async function setChecker(patch) {
  const checker = { ...(await getChecker()), ...patch };
  await chrome.storage.local.set({ checker });
  chrome.action.setBadgeText({ text: checker.running ? 'CHK' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#0a5c7a' });
  return checker;
}

async function finishChecker(message, winId) {
  await setChecker({ running: false, message, nextAt: null });
  if (winId) chrome.windows.remove(winId).catch(() => {});
}

async function checkerPause(sec) {
  await setChecker({ nextAt: Date.now() + sec * 1000 });
  for (let i = 0; i < sec; i++) {
    await sleep(1000);
    if (!(await getChecker()).running) return false;
  }
  await setChecker({ nextAt: null });
  return true;
}

// Opens one saved link and returns what to store: {status, kind, result?}.
async function checkUrl(tabId, item) {
  const unreachable = { status: 'unreachable', kind: 'unknown' };
  let landed;
  let r;
  try {
    landed = await openPage(tabId, item.url);
    r = await run(tabId, analyzeJobsPage);
  } catch {
    return unreachable;
  }
  if (r.notFound || r.text.length < 80 || PAGE_BLOCKED.test(r.text.slice(0, 600))) return unreachable;

  // One DeepSeek call: what kind of page is this, and which links lead to the job list if it is not one itself.
  let links = [];
  try { links = (await run(tabId, findCareerLinks)).all; } catch { /* no links */ }
  const cls = await deepseekJson(
    'You look at a web page found by searching for remote developer jobs. Classify it and say where the job list is. ' +
      'Answer as {"kind": "board" (a job board or job list), "posting" (one job), "company" (a company site) or "unknown", ' +
      '"follow": [up to 2 numbers from the link list that most likely lead to the list of open jobs, or an empty list]}.',
    `URL: ${landed}\nPage text:\n${r.text.slice(0, 2500)}\n\nLinks:\n` + links.slice(0, 80).map((l, i) => `${i}. ${l.text} | ${l.url}`).join('\n')
  );
  const kind = cls && ['board', 'posting', 'company'].includes(cls.kind) ? cls.kind : 'unknown';

  let page = r;
  let listUrl = landed;
  if (!page.titles.length && cls && Array.isArray(cls.follow)) {
    for (const i of cls.follow.filter((n) => Number.isInteger(n) && links[n]).slice(0, 2)) {
      try {
        const u = await openPage(tabId, links[i].url);
        const deeper = await run(tabId, analyzeJobsPage);
        if (!deeper.notFound && deeper.titles.length) { page = deeper; listUrl = u.split('#')[0]; break; }
      } catch { /* try the next one */ }
    }
  }
  if (kind === 'posting' && !page.titles.length) page = { ...page, titles: [{ title: (await run(tabId, readJobPage)).title, url: landed }] };

  const base = { careersUrl: listUrl, openings: page.titles.length ? 'yes' : 'no', checkedBy: 'DeepSeek' };
  if (!page.titles.length) return { status: 'checked', kind, result: base };

  // Shortlist titles, then read each job and judge it for the searched country.
  const country = item.countries[0] || '';
  const short = await deepseekJson(
    `You match job openings to a candidate. Candidate: ${await getProfile()} From the numbered job titles choose up to 3 that best fit, best first. ` +
      'The candidate only wants remote roles. Use an empty list if none is a reasonable fit. Answer as {"indexes": [numbers]}.',
    page.titles.map((t, i) => `${i}. ${t.title}`).join('\n')
  );
  const picks = short && Array.isArray(short.indexes)
    ? short.indexes.filter((i) => Number.isInteger(i) && page.titles[i]).slice(0, 3).map((i) => page.titles[i])
    : page.backend.slice(0, 3);

  let best = null;
  let unstated = null; // remote and a good fit, but the posting never says who may apply
  for (const pick of picks) {
    let text = '';
    try {
      await openPage(tabId, pick.url);
      text = (await run(tabId, readJobPage)).text;
    } catch { continue; }
    const ai = await deepseekJson(
      `You judge one job for a candidate. Candidate: ${await getProfile()} The candidate lives in ${country} and wants a remote job. ` +
        'Answer as {"fit": "good" | "maybe" | "poor", "workType": "remote" | "hybrid" | "onsite" | "unknown", ' +
        '"remoteScope": "worldwide" | "region: <name>" | "country-only: <countries>" | "excluded" | "unknown" ' +
        `(who may apply: use "excluded" when people in ${country} cannot, "country-only" when it is limited to named countries), ` +
        '"experience": "years or unknown", "stack": "main technologies, max 8, comma separated"}.',
      text
    );
    // Keep the last few judgments so a missed job can be traced.
    const { checkerDebug = [] } = await chrome.storage.local.get('checkerDebug');
    checkerDebug.push({ url: item.url, job: pick.title, jobUrl: pick.url, country, ai });
    await chrome.storage.local.set({ checkerDebug: checkerDebug.slice(-20) });
    if (!ai) continue;
    const fit = ['good', 'maybe', 'poor'].includes(ai.fit) ? ai.fit : '';
    if (fit === 'poor') continue;
    if (!item.countries.some((c) => remoteMatches(ai.remoteScope, ai.workType, c, item.countries))) {
      const open = String(ai.workType).toLowerCase() === 'remote' && /^unknown/.test(String(ai.remoteScope || 'unknown').toLowerCase());
      if (open && fit && (!unstated || CHECK_FIT_RANK[fit] > CHECK_FIT_RANK[unstated.fit])) {
        unstated = { fit, title: pick.title, url: pick.url, workType: ai.workType, remoteScope: 'unknown (not stated)', stack: ai.stack };
      }
      continue;
    }
    if (!best || CHECK_FIT_RANK[fit] > CHECK_FIT_RANK[best.fit]) {
      best = { fit, title: pick.title, url: pick.url, workType: ai.workType, remoteScope: ai.remoteScope, stack: ai.stack };
    }
    if (fit === 'good') break;
  }
  best = best || unstated;
  return {
    status: 'checked', kind,
    result: best ? { ...base, jobTitle: best.title, jobUrl: best.url, workType: best.workType, remoteScope: best.remoteScope, fit: best.fit, stack: String(best.stack || '') } : base,
  };
}

async function checkLoop() {
  let winId;
  try {
    if (!(await chrome.storage.local.get('deepseekKey')).deepseekKey) {
      return finishChecker('Stopped: save a DeepSeek key first. It decides which jobs are remote and open to the country.');
    }
    const win = await chrome.windows.create({ url: 'about:blank', focused: false, type: 'normal', width: 1100, height: 800 });
    winId = win.id;
    const tabId = win.tabs[0].id;
    let matches = 0;
    let done = 0;
    for (;;) {
      if (!(await getChecker()).running) return finishChecker(`Stopped by you. ${matches} matching jobs found.`, winId);
      const d = (await chrome.storage.local.get('checkerDaily')).checkerDaily;
      const used = d && d.date === today() ? d.count : 0;
      if (used >= CHECK_DAILY_LIMIT) return finishChecker(`Done for today: ${CHECK_DAILY_LIMIT} links checked. ${matches} matching jobs found.`, winId);

      const next = await serverFetch('/checker/next');
      if (next.done) return finishChecker(`Done: every saved link is checked. ${matches} matching jobs found.`, winId);

      await setChecker({ message: `Checking ${new URL(next.url).hostname}…` });
      let out;
      try { out = await checkUrl(tabId, next); } catch { out = { status: 'unreachable', kind: 'unknown' }; }
      await serverFetch('/checker/result', { id: next.id, ...out });
      await chrome.storage.local.set({ checkerDaily: { date: today(), count: used + 1 } });
      if (out.result && out.result.jobUrl) matches++;
      done++;
      await setChecker({ message: `${new URL(next.url).hostname}: ${out.status === 'unreachable' ? 'could not read the page' : out.result && out.result.jobUrl ? 'matching job found' : 'no matching job'}. ${done} checked, ${matches} matches.` });
      if (!(await checkerPause(Math.round(rnd(5, 12))))) return finishChecker(`Stopped by you. ${matches} matching jobs found.`, winId);
    }
  } catch (e) {
    await finishChecker(e instanceof ServerDown ? `Stopped: ${e.message} Start server/start.bat, then try again.` : `Stopped: ${e.message}`, winId);
  }
}
