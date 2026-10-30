// Checks the links saved by the country search: reads the page, follows the links DeepSeek picks,
// and keeps the best job that is remote and open to someone in the searched country.
const CHECK_DAILY_LIMIT = 300;
const BREAK_EVERY = 10; // pages read from one site before it gets a rest
const BREAK_SEC = [60, 100]; // how long the rest lasts, in seconds (random in this range)
const MAX_JOBS_PER_LINK = 300; // jobs opened one by one on a single list page
const MAX_LOAD_MORE = 60; // times a list page is asked for more jobs, as a safety stop
const MAX_READ = 8; // job pages opened when a page is not a long list
const MAX_SAVED = 5; // matching jobs kept when a page is not a long list
const CHECK_FIT_RANK = { good: 2, maybe: 1, '': 0 };
// A link that is itself one job. Such a page also lists "more jobs like this one": those are not a list to walk.
const SINGLE_JOB_URL = /\/job-listing\/|\/viewjob|\/jobs\/view\/|ycombinator\.com\/companies\/[^/]+\/jobs\/|\/remote-jobs\/[^/]+-\d{5,}/i;
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
  const { currentId } = await getChecker();
  if (currentId) await serverFetch('/checker/release', { id: currentId }).catch(() => {}); // give the link back if the run ended early
  await setChecker({ running: false, message, nextAt: null, currentId: null });
  alertFinished(message);
  if (winId) chrome.windows.remove(winId).catch(() => {});
}

async function checkerPause(sec) {
  await setChecker({ nextAt: Date.now() + sec * 1000 });
  for (let i = 0; i < sec; i++) {
    await sleep(1000);
    if (!(await holdIfPaused())) return false;
    if (!(await getChecker()).running) return false;
  }
  await setChecker({ nextAt: null });
  return true;
}

// Pages read per site in this run. After every BREAK_EVERY of them the site gets a rest, so a long list does not
// hammer one server. (The numbers can be changed with the storage key checkerTuning: {breakEvery, breakSec: [min, max]}.)
const siteVisits = new Map();
const siteRested = new Map();

// Returns false when the run was stopped during the rest.
async function restIfNeeded(host) {
  const tune = (await chrome.storage.local.get('checkerTuning')).checkerTuning || {};
  const every = tune.breakEvery || BREAK_EVERY;
  const [lo, hi] = tune.breakSec || BREAK_SEC;
  const seen = siteVisits.get(host) || 0;
  if (seen > 0 && seen % every === 0 && siteRested.get(host) !== seen) {
    siteRested.set(host, seen);
    await setChecker({ message: `Resting ${host} for about a minute after ${seen} pages, to be gentle on the site.` });
    if (!(await checkerPause(Math.round(rnd(lo, hi))))) return false;
  }
  siteVisits.set(host, seen + 1);
  return true;
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

// Opens one job in a brand-new tab, reads it, and closes the tab, so nothing from the previous job can linger.
// Returns the job's text, or '' when it cannot be read. Waits for the user on a captcha.
async function readJobText(windowId, url) {
  let tab;
  if (!(await restIfNeeded(hostOf(url)))) return '';
  try {
    tab = await chrome.tabs.create({ windowId, url, active: false }); // never activate a tab: that can raise the window
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const t = await chrome.tabs.get(tab.id);
      if (t.status === 'complete' && /^https?:/.test(t.url || '')) break;
    }
    let page = await run(tab.id, readJobPage);
    let text = `${page.title}. ${page.text}`;
    if (CAPTCHA_PAGE.test(text.slice(0, 600))) {
      const solved = await waitForUser(tab.id, async () => {
        page = await run(tab.id, readJobPage);
        text = `${page.title}. ${page.text}`;
        return !CAPTCHA_PAGE.test(text.slice(0, 600));
      }, `${hostOf(url)} is asking for a check (captcha).`, 15 * 60 * 1000);
      if (!solved) return '';
    }
    return text;
  } catch {
    return '';
  } finally {
    if (tab) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// Judges one opened job for the searched country. Returns {strict, job} or null when it does not qualify.
async function judgeJob(item, country, text, pick) {
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
  if (!ai) return null;
  const fit = ['good', 'maybe', 'poor'].includes(ai.fit) ? ai.fit : '';
  if (fit === 'poor') return null;
  const job = { fit, title: pick.title, url: pick.url, workType: ai.workType, remoteScope: ai.remoteScope, stack: ai.stack };
  if (item.countries.some((c) => remoteMatches(ai.remoteScope, ai.workType, c, item.countries))) return { strict: true, job };
  const open = String(ai.workType).toLowerCase() === 'remote' && /^unknown/.test(String(ai.remoteScope || 'unknown').toLowerCase());
  return open && fit ? { strict: false, job: { ...job, remoteScope: 'unknown (not stated)' } } : null;
}

// The fixed rules found no next page. Show DeepSeek the page's links and buttons and let it pick the one that
// loads more jobs (or none). Returns {next: href} (the caller opens it), {clicked: true}, or {}.
async function aiNext(tabId) {
  let cand;
  try { cand = await run(tabId, listNextCandidates); } catch { return {}; }
  if (!cand || !cand.items.length) return {};
  const ai = await deepseekJson(
    'A program is reading a list of job postings page by page. From the numbered links and buttons, choose the one that loads the NEXT page ' +
      'or the next batch of jobs. Never choose a link to a single job, a filter, a sort option, a previous page, the page it is already on, or ' +
      'anything unrelated. If the list has no further page, answer null. Answer as {"index": number or null}.',
    `Page: ${cand.url}\n${cand.hint ? `Pagination text: ${cand.hint}\n` : ''}Controls:\n` +
      cand.items.map((x) => `${x.i}. [${x.tag}]${x.inPag ? ' [in pagination]' : ''} ${x.label} | ${x.href || '(button)'}`).join('\n')
  );
  const pick = ai && Number.isInteger(ai.index) ? cand.items.find((x) => x.i === ai.index) : null;
  if (!pick) return {};
  if (pick.href) {
    // Stay on the same site and never "advance" to the page we are already on.
    let ok = false;
    try { ok = new URL(pick.href).origin === new URL(cand.url).origin && pick.href !== cand.url; } catch { /* not a URL */ }
    return ok ? { next: pick.href } : {};
  }
  try { return await run(tabId, clickCandidate, [pick.i]); } catch { return {}; }
}

// A long job list: open every job one by one, each in its own tab that is closed afterwards (the list tab keeps
// what it has loaded), and when every job on screen is done, press "Show more jobs" and carry on with the new ones.
async function walkList(listTab, page, item, country) {
  const host = hostOf(item.url);
  const { windowId } = await chrome.tabs.get(listTab);
  const strict = [];
  const unstated = [];
  const seen = new Set();
  const keyOf = (t) => t.key || t.url; // one entry per job, however many addresses it has
  const known = new Set(page.titles.map(keyOf));
  let cards = page.titles;
  let opened = 0;
  let loads = 0;
  for (;;) {
    for (const card of cards) {
      if (seen.has(keyOf(card))) continue;
      if (!(await holdIfPaused())) return { strict, unstated, opened };
      if (opened >= MAX_JOBS_PER_LINK || !(await getChecker()).running) return { strict, unstated, opened };
      seen.add(keyOf(card));
      opened++;
      await setChecker({ message: `${host}: reading job ${opened} of ${known.size}: ${String(card.title).slice(0, 60)}` });
      const text = await readJobText(windowId, card.url);
      if (text) {
        const j = await judgeJob(item, country, text, card);
        if (j) (j.strict ? strict : unstated).push(j.job);
      }
      await sleep(rnd(600, 1500));
    }
    if (loads >= MAX_LOAD_MORE) break;
    await setChecker({ message: `${host}: ${opened} jobs read, loading more…` });
    let more;
    try { more = await run(listTab, loadMoreJobs); } catch { break; }
    if (!more.next && !more.clicked) more = await aiNext(listTab); // the rules found nothing: ask the AI
    loads++;
    if (more.next) {
      try { await openPage(listTab, more.next); } catch { break; }
    } else if (!more.clicked) break;
    let again;
    try { again = await run(listTab, analyzeJobsPage); } catch { break; }
    cards = again.titles.filter((t) => !seen.has(keyOf(t)));
    again.titles.forEach((t) => known.add(keyOf(t)));
    if (!cards.length) break;
  }
  return { strict, unstated, opened };
}

// Opens one saved link and returns what to store: {status, kind, results}.
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
  // The saved link is one job: judge that job only, not the similar jobs listed on its page.
  if (SINGLE_JOB_URL.test(landed)) page = { ...page, titles: [] };
  if ((kind === 'posting' || SINGLE_JOB_URL.test(landed)) && !page.titles.length) page = { ...page, titles: [{ title: (await run(tabId, readJobPage)).title, url: landed }] };

  const base = { careersUrl: listUrl, openings: page.titles.length ? 'yes' : 'no', checkedBy: 'DeepSeek' };
  if (!page.titles.length) return { status: 'checked', kind, results: [base] };

  const country = item.countries[0] || '';
  const isList = page.titles.length > 5;
  let strict = [];
  let unstated = [];

  if (isList) {
    ({ strict, unstated } = await walkList(tabId, page, item, country));
  } else {
    const { windowId } = await chrome.tabs.get(tabId);
    // A short page: have DeepSeek shortlist titles, then read each job and judge it.
    const short = await deepseekJson(
      `You match job openings to a candidate. Candidate: ${await getProfile()} From the numbered job titles choose up to ${MAX_READ} that best fit, best first. ` +
        'The candidate only wants remote roles. Use an empty list if none is a reasonable fit. Answer as {"indexes": [numbers]}.',
      page.titles.map((t, i) => `${i}. ${t.title}`).join('\n')
    );
    const picks = short && Array.isArray(short.indexes)
      ? short.indexes.filter((i) => Number.isInteger(i) && page.titles[i]).slice(0, MAX_READ).map((i) => page.titles[i])
      : page.backend.slice(0, MAX_READ);
    for (const pick of picks) {
      await setChecker({ message: `${hostOf(item.url)}: reading ${String(pick.title).slice(0, 60)}` });
      const text = await readJobText(windowId, pick.url);
      if (!text) continue;
      const j = await judgeJob(item, country, text, pick);
      if (j) (j.strict ? strict : unstated).push(j.job);
      if (strict.length >= MAX_SAVED) break;
    }
  }

  // Best first: confirmed scope before unstated, then good fits before maybes.
  const rank = (l) => l.sort((x, y) => CHECK_FIT_RANK[y.fit] - CHECK_FIT_RANK[x.fit]);
  const kept = [...rank(strict), ...rank(unstated)].slice(0, isList ? MAX_JOBS_PER_LINK : MAX_SAVED);
  return {
    status: 'checked', kind,
    results: kept.length
      ? kept.map((j) => ({ ...base, jobTitle: j.title, jobUrl: j.url, workType: j.workType, remoteScope: j.remoteScope, fit: j.fit, stack: String(j.stack || '') }))
      : [base],
  };
}

// onlyId: check just that one link (the "Check now" button) instead of working through the queue.
async function checkLoop(onlyId = null) {
  let winId;
  try {
    if (!(await chrome.storage.local.get('deepseekKey')).deepseekKey) {
      return finishChecker('Stopped: save a DeepSeek key first. It decides which jobs are remote and open to the country.');
    }
    const win = await createWorkWindow('about:blank', 1100, 800);
    winId = win.id;
    const tabId = win.tabs[0].id;
    let matches = 0;
    let done = 0;
    siteVisits.clear();
    siteRested.clear();
    for (;;) {
      if (!(await getChecker()).running) return finishChecker(`Stopped by you. ${matches} matching jobs found.`, winId);
      if (!(await holdIfPaused())) return finishChecker(`Stopped by you. ${matches} matching jobs found.`, winId);
      const d = (await chrome.storage.local.get('checkerDaily')).checkerDaily;
      const used = d && d.date === today() ? d.count : 0;
      if (used >= CHECK_DAILY_LIMIT) return finishChecker(`Done for today: ${CHECK_DAILY_LIMIT} links checked. ${matches} matching jobs found.`, winId);

      const next = await serverFetch(onlyId ? `/checker/item?id=${onlyId}` : '/checker/next');
      if (next.done && onlyId) return finishChecker('Done: that link no longer exists.', winId);
      if (next.done) {
        return finishChecker(
          done === 0
            ? 'Done: nothing to check. Every saved link was already checked. Add a link, or press "Check everything again" in the workspace.'
            : `Done: every saved link is checked. ${matches} matching jobs found.`,
          winId
        );
      }

      await setChecker({ message: `Checking ${new URL(next.url).hostname}…`, currentId: next.id });
      let out;
      // Tell the server this link is still being worked on, so another browser does not take it.
      const beat = setInterval(() => serverFetch('/checker/heartbeat', { id: next.id }).catch(() => {}), 60000);
      try { out = await checkUrl(tabId, next); } catch { out = { status: 'unreachable', kind: 'unknown' }; } finally { clearInterval(beat); }
      await serverFetch('/checker/result', { id: next.id, url: next.url, ...out }); // url lets the server drop a result for a link edited meanwhile
      await chrome.storage.local.set({ checkerDaily: { date: today(), count: used + 1 } });
      const found = (out.results || []).filter((r) => r.jobUrl).length;
      matches += found;
      done++;
      await setChecker({ message: `${new URL(next.url).hostname}: ${out.status === 'unreachable' ? 'could not read the page' : found ? `${found} matching ${found === 1 ? 'job' : 'jobs'} found` : 'no matching job'}. ${done} checked, ${matches} matches.`, currentId: null });
      if (onlyId) return finishChecker(`Done: ${hostOf(next.url)} checked. ${matches} matching ${matches === 1 ? 'job' : 'jobs'} found.`, winId);
      if (!(await checkerPause(Math.round(rnd(5, 12))))) return finishChecker(`Stopped by you. ${matches} matching jobs found.`, winId);
    }
  } catch (e) {
    await finishChecker(e instanceof ServerDown ? `Stopped: ${e.message} Start server/start.bat, then try again.` : `Stopped: ${e.message}`, winId);
  }
}
