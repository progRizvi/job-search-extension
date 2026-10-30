// Checks the links saved by the country search: reads the page, follows the links DeepSeek picks,
// and keeps the best job that is remote and open to someone in the searched country.
const CHECK_DAILY_LIMIT = 300;
const LIST_LOADS = 4; // times a list page is asked for more jobs
const MAX_LIST = 150; // job cards read per list
const MAX_LIST_SAVED = 50; // matching jobs kept from one list
const MAX_READ = 8; // job pages opened per link
const MAX_SAVED = 5; // matching jobs kept per link
const CHECK_FIT_RANK = { good: 2, maybe: 1, '': 0 };
const CAPTCHA_PAGE = /captcha|verify (that )?you.?re (a )?human|are you a robot|just a moment|checking your browser|humans only|prevent misuse|press (and|&) hold|security check/i;
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
  alertFinished(message);
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

// Keeps asking a list page for more jobs ("Show more jobs" / next page) and merges what it finds.
async function expandList(tabId, page) {
  const all = new Map(page.titles.map((t) => [t.url, t]));
  for (let i = 0; i < LIST_LOADS && all.size < MAX_LIST; i++) {
    if (!(await getChecker()).running) break;
    await setChecker({ message: `Loading more jobs (${all.size} so far)…` });
    let more;
    try { more = await run(tabId, loadMoreJobs); } catch { break; }
    if (more.next) {
      try { await openPage(tabId, more.next); } catch { break; }
    } else if (!more.clicked) break;
    let again;
    try { again = await run(tabId, analyzeJobsPage); } catch { break; }
    const before = all.size;
    again.titles.forEach((t) => { if (!all.has(t.url)) all.set(t.url, t); });
    if (all.size === before) break;
  }
  return { ...page, titles: [...all.values()].slice(0, MAX_LIST) };
}

// Judges every job card on a list from its title and card text, in batches. Returns the ones that could suit, best first.
async function judgeList(titles, country) {
  const out = [];
  for (let s = 0; s < titles.length; s += 40) {
    const chunk = titles.slice(s, s + 40);
    await setChecker({ message: `Judging ${Math.min(s + 40, titles.length)} of ${titles.length} jobs…` });
    const ai = await deepseekJson(
      `You screen job cards for a candidate. Candidate: ${await getProfile()} ${country === 'Anywhere' ? 'The candidate can work from any country' : `The candidate lives in ${country}`} and wants remote jobs. ` +
        'For each numbered card decide whether the role and stack could suit the candidate, and whether it is remote. ' +
        'Answer as {"matches": [{"i": card number, "fit": "good" | "maybe", "remote": "yes" | "no" | "unknown"}]}. ' +
        'List only cards that could suit. Leave out cards that are unsuitable or clearly on-site.',
      chunk.map((t, i) => `${i}. ${t.title} | ${t.text || ''}`).join('\n'),
      1500
    );
    for (const m of (ai && Array.isArray(ai.matches) ? ai.matches : [])) {
      const t = chunk[m.i];
      if (!t || m.remote === 'no') continue;
      out.push({ title: t.title, url: t.url, fit: m.fit === 'good' ? 'good' : 'maybe', remote: m.remote === 'yes' ? 'yes' : 'unknown' });
    }
  }
  return out.sort((x, y) => CHECK_FIT_RANK[y.fit] - CHECK_FIT_RANK[x.fit]);
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
  if (CAPTCHA_PAGE.test(r.text.slice(0, 600))) {
    // Wait for the user to solve it (up to 15 minutes), then read the page again.
    const solved = await waitForUser(tabId, async () => {
      const again = await run(tabId, analyzeJobsPage);
      if (!CAPTCHA_PAGE.test(again.text.slice(0, 600))) { r = again; return true; }
      return false;
    }, `${new URL(item.url).hostname} is asking for a check (captcha).`, 15 * 60 * 1000);
    if (!solved) return unreachable;
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
  if (!page.titles.length) return { status: 'checked', kind, results: [base] };

  const country = item.countries[0] || '';
  // A long list: read all of it and judge the cards, then open only the best few to confirm.
  const isList = page.titles.length > 5;
  let fromList = [];
  if (isList) {
    page = await expandList(tabId, page);
    fromList = await judgeList(page.titles, country);
  }

  // Shortlist titles, then read each job and judge it for the searched country.
  const short = isList ? null : await deepseekJson(
    `You match job openings to a candidate. Candidate: ${await getProfile()} From the numbered job titles choose up to ${MAX_READ} that best fit, best first. ` +
      'The candidate only wants remote roles. Use an empty list if none is a reasonable fit. Answer as {"indexes": [numbers]}.',
    page.titles.map((t, i) => `${i}. ${t.title}`).join('\n')
  );
  const picks = isList
    ? fromList.slice(0, MAX_READ).map((j) => ({ title: j.title, url: j.url }))
    : short && Array.isArray(short.indexes)
    ? short.indexes.filter((i) => Number.isInteger(i) && page.titles[i]).slice(0, MAX_READ).map((i) => page.titles[i])
    : page.backend.slice(0, MAX_READ);

  const strict = []; // remote and open to the country
  const unstated = []; // remote and a fit, but the posting never says who may apply
  for (const pick of picks) {
    let text = '';
    try {
      await openPage(tabId, pick.url);
      text = (await run(tabId, readJobPage)).text;
    } catch { continue; }
    const ai = await deepseekJson(
      `You judge one job for a candidate. Candidate: ${await getProfile()} ${country === 'Anywhere' ? 'The candidate can work from any country' : `The candidate lives in ${country}`} and wants a remote job. ` +
        'Answer as {"fit": "good" | "maybe" | "poor", "workType": "remote" | "hybrid" | "onsite" | "unknown", ' +
        '"remoteScope": "worldwide" | "region: <name>" | "country-only: <countries>" | "excluded" | "unknown" ' +
        `(who may apply: use "region: <name>" only when that region includes ${country === 'Anywhere' ? 'the candidate' : country}; use "excluded" when ${country === 'Anywhere' ? 'the candidate' : `people in ${country}`} cannot apply, ` +
        'for example a region or country list that does not include it; use "country-only" for named countries that include it), ' +
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
      if (open && fit) unstated.push({ fit, title: pick.title, url: pick.url, workType: ai.workType, remoteScope: 'unknown (not stated)', stack: ai.stack });
      continue;
    }
    strict.push({ fit, title: pick.title, url: pick.url, workType: ai.workType, remoteScope: ai.remoteScope, stack: ai.stack });
    if (strict.length >= MAX_SAVED) break;
  }
  // Best first: confirmed scope before unstated, then good fits before maybes.
  const rank = (l) => l.sort((x, y) => CHECK_FIT_RANK[y.fit] - CHECK_FIT_RANK[x.fit]);
  const verified = [...rank(strict), ...rank(unstated)].slice(0, MAX_SAVED);
  // The rest of the list: judged from the card only, not opened.
  const seen = new Set(verified.map((j) => j.url));
  const unopened = fromList.filter((j) => !seen.has(j.url)).map((j) => ({
    fit: j.fit, title: j.title, url: j.url, workType: j.remote === 'yes' ? 'remote' : 'unknown',
    remoteScope: j.remote === 'yes' ? 'remote (from list)' : 'unknown (from list)', stack: '',
  }));
  const kept = [...verified, ...unopened].slice(0, isList ? MAX_LIST_SAVED : MAX_SAVED);
  return {
    status: 'checked', kind,
    results: kept.length
      ? kept.map((j) => ({ ...base, jobTitle: j.title, jobUrl: j.url, workType: j.workType, remoteScope: j.remoteScope, fit: j.fit, stack: String(j.stack || '') }))
      : [base],
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
      if (next.done) {
        return finishChecker(
          done === 0
            ? 'Done: nothing to check. Every saved link was already checked. Add a link, or press "Check everything again" in the workspace.'
            : `Done: every saved link is checked. ${matches} matching jobs found.`,
          winId
        );
      }

      await setChecker({ message: `Checking ${new URL(next.url).hostname}…` });
      let out;
      try { out = await checkUrl(tabId, next); } catch { out = { status: 'unreachable', kind: 'unknown' }; }
      await serverFetch('/checker/result', { id: next.id, ...out });
      await chrome.storage.local.set({ checkerDaily: { date: today(), count: used + 1 } });
      const found = (out.results || []).filter((r) => r.jobUrl).length;
      matches += found;
      done++;
      await setChecker({ message: `${new URL(next.url).hostname}: ${out.status === 'unreachable' ? 'could not read the page' : found ? `${found} matching ${found === 1 ? 'job' : 'jobs'} found` : 'no matching job'}. ${done} checked, ${matches} matches.` });
      if (!(await checkerPause(Math.round(rnd(5, 12))))) return finishChecker(`Stopped by you. ${matches} matching jobs found.`, winId);
    }
  } catch (e) {
    await finishChecker(e instanceof ServerDown ? `Stopped: ${e.message} Start server/start.bat, then try again.` : `Stopped: ${e.message}`, winId);
  }
}
