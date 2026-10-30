importScripts('shared.js', 'xlsx.js', 'deepseek.js', 'serverClient.js', 'collector.js', 'checker.js', 'alert.js');

const MAX_SKIPS = 3; // already-visited pages we will click through before giving up
const rnd = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let busy = false;

async function getAuto() {
  return (await chrome.storage.local.get('auto')).auto || { running: false };
}

async function setAuto(patch) {
  const auto = { ...(await getAuto()), ...patch };
  await chrome.storage.local.set({ auto });
  chrome.action.setBadgeText({ text: auto.running ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#0a66c2' });
  return auto;
}

async function stop(message) {
  await setAuto({ running: false, message, nextAt: null });
  alertFinished(message);
  if (/^Done/.test(message)) await downloadExcel();
}

// Hands the collected list to the user as an Excel file when a run completes.
async function downloadExcel() {
  const { companies } = await load();
  if (!Object.keys(companies).length) return;
  const b64 = xlsxBase64(companiesToXlsx(companies));
  await chrome.downloads.download({
    url: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${b64}`,
    filename: `linkedin-companies-${today()}.xlsx`,
  });
}

const run = async (tabId, func, args) =>
  (await chrome.scripting.executeScript({ target: { tabId }, func, ...(args ? { args } : {}) }))[0].result;

// Waits in 1s slices so Stop takes effect quickly; the storage read every 10s
// keeps the service worker from being put to sleep mid-wait.
async function pause(sec, alive = async () => (await getAuto()).running) {
  await setAuto({ nextAt: Date.now() + sec * 1000 });
  for (let i = 0; i < sec; i++) {
    await sleep(1000);
    if (i % 10 === 9) await getAuto();
    if (!(await holdIfPaused())) return false;
    if (!(await alive())) return false;
  }
  await setAuto({ nextAt: null });
  return true;
}

// Full load: tab status complete, then results rendered and stable in the page.
async function waitForLoad(tabId) {
  for (let i = 0; i < 60; i++) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') break;
    await sleep(1000);
  }
  return run(tabId, waitForResults);
}

// After clicking Next (an in-page navigation) wait for the URL to actually change.
async function waitForUrlChange(tabId, oldUrl) {
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if ((await chrome.tabs.get(tabId)).url !== oldUrl) return true;
  }
  return false;
}

async function loop() {
  if (busy) return;
  busy = true;
  try {
    let skips = 0;
    while ((await getAuto()).running) {
      const { tabId } = await getAuto();
      let tab;
      try {
        // A freshly opened tab has no URL yet; wait for it to load before checking.
        for (let i = 0; i < 60; i++) {
          tab = await chrome.tabs.get(tabId);
          if (tab.status === 'complete' && tab.url) break;
          await sleep(1000);
        }
      } catch {
        return stop('Stopped: the tab was closed.');
      }
      if (!/^https:\/\/www\.linkedin\.com\/search\/results\//.test(tab.url || '')) {
        return stop('Stopped: left the search results (login or checkpoint page?).');
      }

      await setAuto({ message: 'Waiting for the page to finish loading…' });
      if (!(await waitForLoad(tabId))) return stop('Stopped: results never finished loading.');
      if (!(await getAuto()).running) return;
      if (await run(tabId, isBlocked)) {
        return stop('Stopped: LinkedIn is showing a verification/warning. Check the tab yourself.');
      }

      tab = await chrome.tabs.get(tabId);
      const key = normalizePageUrl(tab.url);
      const { visited, count } = await load();

      if (visited[key]) {
        if (++skips > MAX_SKIPS) {
          return stop('Stopped: several pages in a row were already collected. Start from a newer page.');
        }
      } else {
        if (count >= DAILY_LIMIT) return stop(`Done: daily limit of ${DAILY_LIMIT} pages reached.`);
        skips = 0;
        await setAuto({ message: 'Page loaded. Collecting…' });
        await run(tabId, humanScroll);
        const result = await run(tabId, scrapePage);
        if (!result || !result.length) return stop('Stopped: no companies found on this page.');
        const saved = await savePage(key, result);
        await setAuto({
          message: `Collected ${result.length} companies (${saved.added} new). ${saved.count}/${DAILY_LIMIT} pages today.`,
        });
        if (saved.count >= DAILY_LIMIT) return stop(`Done: daily limit of ${DAILY_LIMIT} pages reached.`);
      }

      // Pause 10-30s after collecting, then go to the next page.
      if (!(await pause(Math.round(rnd(10, 30))))) return;

      const oldUrl = tab.url;
      if (!(await run(tabId, clickNext))) return stop('Done: reached the last results page.');
      if (!(await waitForUrlChange(tabId, oldUrl))) return stop('Stopped: the next page did not open.');
      // Remember the page we are about to collect, so a later run can resume here.
      await chrome.storage.local.set({ lastUrl: (await chrome.tabs.get(tabId)).url });
    }
  } catch (e) {
    await stop(`Stopped: ${e.message}`);
  } finally {
    busy = false;
  }
}


// ---- Find company websites through Google ----
const SITES_DAILY_LIMIT = 300;
const LINKEDIN_PROFILE_LIMIT = 40; // LinkedIn About pages opened per day, kept low on purpose
// Directories and social networks are never the company's own site.
const NOT_A_COMPANY_SITE = [
  'linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'youtube.com', 'tiktok.com',
  'crunchbase.com', 'wikipedia.org', 'glassdoor.com', 'indeed.com', 'zoominfo.com', 'bloomberg.com',
  'pitchbook.com', 'yelp.com', 'reddit.com', 'medium.com', 'apollo.io', 'rocketreach.co', 'dnb.com',
  'opencorporates.com', 'clutch.co', 'g2.com', 'trustpilot.com', 'mapquest.com', 'yellowpages.com',
  'bbb.org', 'builtin.com', 'wellfound.com', 'angel.co', 'owler.com', 'cbinsights.com', 'tracxn.com',
  'lusha.com', 'signalhire.com', 'craft.co', 'growjo.com', 'leadiq.com', 'manta.com', 'chamberofcommerce.com',
];

function pickCompanySite(links) {
  for (const link of links) {
    let u;
    try { u = new URL(link); } catch { continue; }
    const host = u.hostname.replace(/^www\./, '');
    if (NOT_A_COMPANY_SITE.some((d) => host === d || host.endsWith('.' + d))) continue;
    return u.origin;
  }
  return '';
}

async function getSites() {
  return (await chrome.storage.local.get('sites')).sites || { running: false };
}

async function setSites(patch) {
  const sites = { ...(await getSites()), ...patch };
  await chrome.storage.local.set({ sites });
  chrome.action.setBadgeText({ text: sites.running ? 'WEB' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#0a5c7a' });
  return sites;
}

async function updateCompany(url, patch) {
  const { companies = {} } = await chrome.storage.local.get('companies');
  if (companies[url]) companies[url] = { ...companies[url], ...patch };
  await chrome.storage.local.set({ companies });
}

async function finishSites(message, winId) {
  await setSites({ running: false });
  await setAuto({ message, nextAt: null });
  alertFinished(message);
  if (winId) chrome.windows.remove(winId).catch(() => {});
}

// Searches the web for a query. Tries Google, then Bing, then DuckDuckGo, skipping any engine that asked
// for a check (captcha) or whose results cannot be read, and any engine listed in `tried`.
let googleBlocked = false;
async function searchWeb(tabId, text, tried = []) {
  const q = encodeURIComponent(text);
  const engines = [];
  if (!googleBlocked) engines.push({ name: 'Google', url: `https://www.google.com/search?q=${q}&hl=en&gl=us`, read: readGoogleResults });
  engines.push({ name: 'Bing', url: `https://www.bing.com/search?q=${q}&setlang=en&cc=US&mkt=en-US`, read: readBingResults });
  engines.push({ name: 'DuckDuckGo', url: `https://html.duckduckgo.com/html/?q=${q}&kl=us-en`, read: readDuckResults });
  for (const e of engines.filter((x) => !tried.includes(x.name))) {
    await chrome.tabs.update(tabId, { url: e.url });
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      if ((await chrome.tabs.get(tabId)).status === 'complete') break;
    }
    await sleep(rnd(1500, 3500));
    let res = await run(tabId, e.read);
    if (res.blocked) {
      // A captcha: alert the user and wait for them to solve it in this window, then carry on.
      const cleared = await waitForUser(tabId, async () => {
        const again = await run(tabId, e.read);
        if (!again.blocked && (again.links || []).length) { res = again; return true; }
        return false;
      }, `${e.name} is asking for a check (captcha).`);
      if (!cleared) return { blocked: true, links: [], items: [] };
    }
    if (!res.blocked && !res.unreadable && (res.links || []).length) return { ...res, engine: e.name }; // no links at all = not loaded or unreadable
    if (e.name === 'Google') googleBlocked = true; // blocked or unreadable: skip it for the rest of this run
  }
  return { blocked: true, links: [], items: [] };
}

const originOf = (u) => {
  try { return new URL(u).origin; } catch { return ''; }
};

const JOB_RESET = {
  jobsChecked: false, careersUrl: '', openings: '', backendJobTitle: '', backendJobUrl: '',
  checkedBy: '', jobFit: '', jobLocation: '', jobWorkType: '', jobExperience: '', jobStack: '',
};

// recheck = false: find websites for companies that have none.
// recheck = true: have DeepSeek verify (and if needed replace) websites that were not chosen by DeepSeek.
async function findSitesLoop(recheck = false, ids = null) {
  let winId;
  googleBlocked = false;
  try {
    const todo = Object.values((await load()).companies).filter((c) =>
      ids ? ids.includes(c.linkedinUrl) : recheck ? c.website && c.websiteBy !== 'DeepSeek' && c.websiteBy !== 'LinkedIn' : !c.website && !c.siteChecked
    );
    if (!todo.length) {
      return finishSites(recheck ? 'Done: every saved website was already checked by DeepSeek.' : 'Done: every saved company already has a website.');
    }
    let confirmed = 0;
    let replaced = 0;
    let cleared = 0;
    let unanswered = 0;

    const win = await createWorkWindow('https://www.google.com/', 1000, 760);
    winId = win.id;
    const tabId = win.tabs[0].id;
    const stillRunning = async () => (await getSites()).running;
    let found = 0;
    let done = 0;

    for (const c of todo) {
      if (!(await stillRunning())) return finishSites(`Stopped by you. Found ${found} websites.`, winId);

      const d = (await chrome.storage.local.get('sitesDaily')).sitesDaily;
      const used = d && d.date === today() ? d.count : 0;
      if (used >= SITES_DAILY_LIMIT) {
        return finishSites(`Done: daily limit of ${SITES_DAILY_LIMIT} web searches reached. Found ${found} websites.`, winId);
      }

      const hasKey = !!(await chrome.storage.local.get('deepseekKey')).deepseekKey;
      const text = companySearchText(c);
      const tried = [];
      let site = '';
      let answered = false; // did DeepSeek give an answer at least once?
      for (let attempt = 0; attempt < 2 && !site; attempt++) {
        await setAuto({ message: `Searching the web for ${c.name} (${done + 1} of ${todo.length})…`, nextAt: null });
        // First try the name with LinkedIn clues; if nothing official turns up, retry on another engine with a plainer query.
        const qText = attempt === 0 ? text : `${c.name} company`;
        const res = await searchWeb(tabId, qText, tried);
        if (res.blocked) {
          if (attempt === 0) {
            return finishSites('Stopped: Google, Bing and DuckDuckGo are all asking for a check (captcha). Open one yourself, solve it, then try again.', winId);
          }
          break;
        }
        tried.push(res.engine);

        let found_ = pickCompanySite(res.links); // built-in rule
        let ai = null;
        if (hasKey && res.items && res.items.length) {
          await setAuto({ message: `DeepSeek is choosing the website for ${c.name}…` });
          ai = await deepseekJson(
            "You identify a company's official website from web search results. Pick the result that is the company's own site, " +
              'not a directory, social network, news article or job board. Use null if none of them is the official site. ' +
              'The LinkedIn page address is a strong clue to the company. Answer as {"index": number or null}.',
            `Company: ${c.name}\nLinkedIn page: ${c.linkedinUrl}\n` +
              (recheck && c.website ? `Website saved earlier (may be wrong): ${c.website}\n` : '') +
              'Results:\n' +
              res.items.map((it, i) => `${i}. ${it.title} | ${it.url} | ${it.snippet}`).join('\n')
          );
          if (ai && 'index' in ai) {
            answered = true;
            // Accept 2 or "2"; trust the model, but never accept a directory or social site.
            const idx = ai.index === null || ai.index === '' ? NaN : Number(ai.index);
            found_ = Number.isInteger(idx) && res.items[idx] ? pickCompanySite([res.items[idx].url]) : '';
          }
        }
        site = found_;

        // Keep the last few decisions so a wrong answer can be traced.
        const { siteDebug = [] } = await chrome.storage.local.get('siteDebug');
        siteDebug.push({
          name: c.name, query: qText, engine: res.engine, answer: ai ? JSON.stringify(ai).slice(0, 80) : 'no answer',
          chose: site, results: (res.items || []).map((it) => `${it.title.slice(0, 40)} | ${it.url.slice(0, 70)}`),
        });
        await chrome.storage.local.set({ siteDebug: siteDebug.slice(-12) });
      }
      // Nothing found, or DeepSeek could not tell: the company's own LinkedIn About page lists its website.
      let viaLinkedIn = false;
      if (!site && /linkedin\.com\/company\//.test(c.linkedinUrl || '')) {
        const ld = (await chrome.storage.local.get('liDaily')).liDaily;
        const liUsed = ld && ld.date === today() ? ld.count : 0;
        if (liUsed < LINKEDIN_PROFILE_LIMIT) {
          await setAuto({ message: `Checking ${c.name}'s LinkedIn page for its website…` });
          try {
            await chrome.tabs.update(tabId, { url: c.linkedinUrl.replace(/\/?(about\/?)?$/, '/about/') });
            for (let i = 0; i < 30; i++) {
              await sleep(1000);
              if ((await chrome.tabs.get(tabId)).status === 'complete') break;
            }
            await sleep(rnd(2500, 5000));
            let li = await run(tabId, readLinkedInWebsite);
            await chrome.storage.local.set({ liDaily: { date: today(), count: liUsed + 1 } });
            if (li.loggedOut) {
              const back = await waitForUser(tabId, async () => !(await run(tabId, readLinkedInWebsite)).loggedOut, 'LinkedIn is asking you to sign in.');
              if (!back) return finishSites('Stopped: LinkedIn is asking you to sign in. Sign in in Chrome, then try again.', winId);
              li = await run(tabId, readLinkedInWebsite);
            }
            const fromLi = li.website ? pickCompanySite([li.website]) : '';
            if (fromLi) { site = fromLi; viaLinkedIn = true; }
          } catch (e) {
            if (!(await stillRunning())) return finishSites(`Stopped by you. Found ${found} websites.`, winId);
          }
        }
      }
      const by = viaLinkedIn ? 'LinkedIn' : answered ? 'DeepSeek' : 'Rules';
      if (recheck) {
        if (by !== 'DeepSeek' && by !== 'LinkedIn') {
          unanswered++; // DeepSeek did not answer; leave the saved website alone.
        } else if (site && originOf(site) === originOf(c.website)) {
          confirmed++;
          await updateCompany(c.linkedinUrl, { websiteBy: by });
        } else {
          // A different site (or none): the earlier website was wrong, so earlier job results are too.
          site ? replaced++ : cleared++;
          await updateCompany(c.linkedinUrl, { ...JOB_RESET, website: site, websiteBy: by === 'LinkedIn' ? 'LinkedIn' : 'DeepSeek', siteChecked: !site });
        }
      } else {
        await updateCompany(c.linkedinUrl, site ? { website: site, websiteBy: by } : { siteChecked: true });
      }
      if (site) found++;
      done++;
      await chrome.storage.local.set({ sitesDaily: { date: today(), count: used + 1 } });

      if (done < todo.length && !(await pause(Math.round(rnd(8, 20)), stillRunning))) {
        return finishSites(`Stopped by you. Found ${found} websites.`, winId);
      }
    }
    await finishSites(
      recheck
        ? `Done: ${confirmed} confirmed, ${replaced} replaced, ${cleared} had no official site.` +
          (unanswered ? ` ${unanswered} unchanged because DeepSeek did not answer.` : '')
        : `Done: found ${found} of ${todo.length} websites.`,
      winId
    );
  } catch (e) {
    await finishSites(`Stopped: ${e.message}`, winId);
  }
}

// ---- Visit company sites: careers page -> openings -> backend roles ----
async function getJobs() {
  return (await chrome.storage.local.get('jobs')).jobs || { running: false };
}

async function setJobs(patch) {
  const jobs = { ...(await getJobs()), ...patch };
  await chrome.storage.local.set({ jobs });
  chrome.action.setBadgeText({ text: jobs.running ? 'JOBS' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#0a5c7a' });
  return jobs;
}

async function finishJobs(message, winId) {
  await setJobs({ running: false });
  await setAuto({ message, nextAt: null });
  alertFinished(message);
  if (winId) chrome.windows.remove(winId).catch(() => {});
}

async function openPage(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if ((await chrome.tabs.get(tabId)).status === 'complete') break;
  }
  await sleep(rnd(1200, 2500));
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:/.test(tab.url || '')) throw new Error('page did not open');
  return tab.url;
}

const NO_JOBS_RESULT = {
  jobsChecked: true, careersUrl: '', openings: 'unknown',
  backendJobTitle: '', backendJobUrl: '', checkedBy: 'Rules', jobFit: '', jobLocation: '', jobWorkType: '', jobExperience: '', jobStack: '',
};
const FIT_RANK = { good: 3, maybe: 2, '': 1, poor: 0 };

// Returns the fields to save for one company.
async function checkCompanyJobs(tabId, site, name) {
  const hasKey = !!(await chrome.storage.local.get('deepseekKey')).deepseekKey;
  await openPage(tabId, site);
  const home = await run(tabId, findCareerLinks);
  const origin = new URL(site).origin;

  // Where might the careers page be? DeepSeek's pick from the homepage links, the keyword rules, then common paths.
  let aiLinks = [];
  if (hasKey && home.all.length) {
    await setAuto({ message: `${name}: DeepSeek is looking for the careers page…` });
    const ai = await deepseekJson(
      'You are given numbered links found on a company website. Choose up to 3 that most likely lead to the careers / jobs / hiring page, ' +
        'including external job boards such as Greenhouse, Lever or Workable. Use an empty list if none looks right. Answer as {"indexes": [numbers]}.',
      home.all.map((l, i) => `${i}. ${l.text || '(no text)'} | ${l.url}`).join('\n')
    );
    if (ai && Array.isArray(ai.indexes)) {
      aiLinks = ai.indexes.filter((i) => Number.isInteger(i) && home.all[i]).slice(0, 3).map((i) => home.all[i].url);
    }
  }
  const guesses = ['/careers', '/jobs', '/career', '/join-us', '/company/careers', '/about/careers', '/work-with-us'].map((p) => origin + p);
  const candidates = [...aiLinks, ...home.links.map((l) => l.url), ...home.iframes.slice(0, 1), ...guesses]
    .filter((u, i, arr) => arr.indexOf(u) === i)
    .slice(0, 6);

  let careersSeen = ''; // a page that clearly is a careers page, even if we could not read its jobs

  // Opens one candidate. Returns {r, careersUrl[, ai]} when it is a usable jobs page, else null.
  const tryUrl = async (url, depth = 0) => {
    let landed;
    let r;
    try {
      landed = await openPage(tabId, url);
      r = await run(tabId, analyzeJobsPage);
    } catch {
      return null;
    }
    if (r.notFound) return null;
    const careersUrl = landed.split('#')[0];
    const lu = new URL(landed);
    if (!careersSeen && /career|jobs?|join|hiring|work-with-us|opportunit/i.test(lu.hostname + lu.pathname) && r.text.length > 150) {
      careersSeen = careersUrl;
    }
    const has = r.jobCount > 0 || !!r.textBackend;
    if (has || r.noJobs) return { r, careersUrl };

    // A landing page with a "View open jobs" button: follow it one level to the real list.
    if (depth === 0 && r.listLinks && r.listLinks.length) {
      const deeper = await tryUrl(r.listLinks[0], 1);
      if (deeper) return deeper;
    }
    if (!hasKey || !r.text) return null;

    // The keyword rules could not tell. Let DeepSeek read the page text itself.
    await setAuto({ message: `${name}: DeepSeek is reading the careers page…` });
    const ai = await deepseekJson(
      `You read a company web page and judge it for a job seeker. Candidate: ${await getProfile()} ` +
        'Answer as {"isJobsPage": true or false (is this a careers/jobs page?), "hasOpenings": true or false, ' +
        '"bestTitle": "the best-fitting open role title for the candidate, or null", "fit": "good" | "maybe" | "poor", ' +
        '"location": "e.g. Remote, or city, or unknown", "workType": "remote" | "hybrid" | "onsite" | "unknown", ' +
        '"experience": "years required, or unknown", "stack": "main technologies, max 8, comma separated"}. ' +
        'The candidate only wants remote roles, so mark "fit" as "poor" for a role that must be done on-site.',
      r.text
    );
    return ai && ai.isJobsPage ? { r, careersUrl, ai } : null;
  };

  let best = null;
  for (const url of candidates) {
    best = await tryUrl(url);
    if (best) break;
  }

  // Last resort: ask Google for the site's careers page.
  if (!best && !careersSeen) {
    try {
      const host = new URL(site).hostname.replace(/^www\./, '');
      await setAuto({ message: `${name}: searching Google for the careers page…` });
      const g = await searchWeb(tabId, `site:${host} careers OR jobs OR "join our team"`);
      if (!g.blocked) {
        const urls = (g.items || [])
          .map((it) => it.url)
          .filter((u) => { try { return new URL(u).hostname.replace(/^www\./, '').endsWith(host); } catch { return false; } })
          .filter((u) => !candidates.includes(u))
          .slice(0, 2);
        for (const u of urls) {
          best = await tryUrl(u);
          if (best) break;
        }
      }
    } catch {
      /* ignore and fall through */
    }
  }

  if (!best && careersSeen) {
    // We found the careers page but could not read any jobs from it; still save where it is.
    return { ...NO_JOBS_RESULT, careersUrl: careersSeen, checkedBy: hasKey ? 'DeepSeek' : 'Rules' };
  }
  if (!best) return NO_JOBS_RESULT;

  const { r, careersUrl } = best;

  if (best.ai) {
    const ai = best.ai;
    const fit = ['good', 'maybe', 'poor'].includes(ai.fit) ? ai.fit : '';
    const usable = ai.hasOpenings && ai.bestTitle && fit !== 'poor' && ai.workType !== 'onsite';
    return {
      jobsChecked: true,
      careersUrl,
      openings: ai.hasOpenings ? 'yes' : 'no',
      backendJobTitle: usable ? String(ai.bestTitle).slice(0, 100) : '',
      backendJobUrl: usable ? r.pageUrl : '',
      checkedBy: 'DeepSeek',
      jobFit: usable ? fit : '',
      jobLocation: usable ? String(ai.location || '').slice(0, 60) : '',
      jobWorkType: usable ? String(ai.workType || '').slice(0, 10) : '',
      jobExperience: usable ? String(ai.experience || '').slice(0, 40) : '',
      jobStack: usable ? String(ai.stack || '').slice(0, 100) : '',
    };
  }

  // 1. Shortlist up to 3 titles: DeepSeek if available, otherwise the keyword rules.
  let picks = r.backend.slice(0, 3);
  let aiDecided = false;
  if (r.titles && r.titles.length) {
    if (hasKey) await setAuto({ message: `${name}: DeepSeek is shortlisting ${r.titles.length} jobs…` });
    const ai = await deepseekJson(
      `You match job openings to a candidate. Candidate: ${await getProfile()} ` +
        'From the numbered job titles, choose up to 3 that best fit the candidate, best first. The candidate only wants remote roles, so skip any title that is clearly on-site. Use an empty list if none is a reasonable fit. ' +
        'Answer as {"indexes": [numbers]}.',
      r.titles.map((t, i) => `${i}. ${t.title}`).join('\n')
    );
    if (ai && Array.isArray(ai.indexes)) {
      aiDecided = true;
      picks = ai.indexes.filter((i) => Number.isInteger(i) && r.titles[i]).slice(0, 3).map((i) => r.titles[i]);
    }
  }

  // Never keep a title that says on-site, whichever way it was shortlisted.
  picks = picks.filter((p) => !/\bon[- ]?site\b/i.test(p.title));

  // 2. Open each shortlisted job and let DeepSeek judge the real posting.
  const deepseekKey = hasKey;
  let best_ = null;
  for (const pick of picks) {
    let eval_ = { jobFit: '', jobLocation: '', jobWorkType: '', jobExperience: '', jobStack: '' };
    if (deepseekKey) {
      try {
        await setAuto({ message: `${name}: DeepSeek is reading the job "${pick.title.slice(0, 50)}"…` });
        await openPage(tabId, pick.url);
        const page = await run(tabId, readJobPage);
        const ai = await deepseekJson(
          `You judge a job posting for a candidate. Candidate: ${await getProfile()} ` +
            'Answer as {"fit": "good" | "maybe" | "poor", "location": "e.g. Remote, or city", "workType": "remote" | "hybrid" | "onsite" | "unknown", ' +
            '"experience": "years required, or unknown", "stack": "main technologies, max 8, comma separated"}. ' +
            '"poor" means clearly a mismatch (wrong stack, wrong seniority, not hiring in practice, or a role that must be done on-site).',
          `${page.title}\n\n${page.text}`
        );
        if (ai) {
          eval_ = {
            jobFit: ['good', 'maybe', 'poor'].includes(ai.fit) ? ai.fit : '',
            jobLocation: String(ai.location || '').slice(0, 60),
            jobWorkType: ['remote', 'hybrid', 'onsite', 'unknown'].includes(ai.workType) ? ai.workType : '',
            jobExperience: String(ai.experience || '').slice(0, 40),
            jobStack: String(ai.stack || '').slice(0, 100),
          };
        }
      } catch {
        /* keep the unjudged result */
      }
      await sleep(rnd(1500, 3500));
    }
    if (eval_.jobFit === 'poor' || eval_.jobWorkType === 'onsite') continue; // the candidate wants remote only
    if (!best_ || FIT_RANK[eval_.jobFit] > FIT_RANK[best_.eval_.jobFit]) best_ = { pick, eval_ };
    if (eval_.jobFit === 'good') break;
  }

  const hit = best_ ? best_.pick : undefined;
  const allRejected = hasKey && picks.length > 0; // matching jobs existed but were judged poor or on-site
  const fallbackText = !hit && r.textBackend && !allRejected ? r.textBackend : '';
  return {
    jobsChecked: true,
    careersUrl,
    openings: r.jobCount > 0 || r.textBackend ? 'yes' : 'no',
    backendJobTitle: hit ? hit.title : fallbackText,
    backendJobUrl: hit ? hit.url : fallbackText ? r.pageUrl : '',
    checkedBy: aiDecided || (best_ && best_.eval_.jobFit) ? 'DeepSeek' : 'Rules',
    jobFit: best_ ? best_.eval_.jobFit : '',
    jobLocation: best_ ? best_.eval_.jobLocation : '',
    jobWorkType: best_ ? best_.eval_.jobWorkType : '',
    jobExperience: best_ ? best_.eval_.jobExperience : '',
    jobStack: best_ ? best_.eval_.jobStack : '',
  };
}

async function findJobsLoop() {
  let winId;
  googleBlocked = false;
  try {
    const todo = Object.values((await load()).companies).filter((c) => c.website && !c.jobsChecked);
    if (!todo.length) return finishJobs('Done: no companies with a website left to check.');

    const win = await createWorkWindow(todo[0].website, 1100, 800);
    winId = win.id;
    const tabId = win.tabs[0].id;
    const stillRunning = async () => (await getJobs()).running;
    let withBackend = 0;
    let done = 0;

    for (const c of todo) {
      if (!(await stillRunning())) return finishJobs(`Stopped by you. ${withBackend} backend jobs found.`, winId);
      await setAuto({ message: `Checking ${c.name} (${done + 1} of ${todo.length})…`, nextAt: null });
      let patch;
      try {
        patch = await checkCompanyJobs(tabId, c.website, c.name);
      } catch {
        patch = NO_JOBS_RESULT;
      }
      await updateCompany(c.linkedinUrl, patch);
      if (patch.backendJobUrl) withBackend++;
      const outcome = !patch.careersUrl
        ? 'no careers page found'
        : patch.backendJobUrl
          ? `matching job found (${patch.checkedBy})`
          : patch.openings === 'yes'
            ? `hiring, but no fitting job (${patch.checkedBy})`
            : `careers page found, no openings (${patch.checkedBy})`;
      await setAuto({ message: `${c.name}: ${outcome}.` });
      done++;
      if (done < todo.length && !(await pause(Math.round(rnd(5, 12)), stillRunning))) {
        return finishJobs(`Stopped by you. ${withBackend} backend jobs found.`, winId);
      }
    }
    await finishJobs(`Done: checked ${todo.length} companies, ${withBackend} have a backend job.`, winId);
  } catch (e) {
    await finishJobs(`Stopped: ${e.message}`, winId);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'start') {
    chrome.storage.local.remove('paused');
    // Run in a dedicated, unfocused window: Chrome throttles scrolling and lazy
    // loading in background tabs, but a visible tab in its own window works normally.
    chrome.windows
      .create({ url: msg.url, focused: false, type: 'normal', width: 1100, height: 800 })
      .then((win) =>
        setAuto({ running: true, tabId: win.tabs[0].id, windowId: win.id, message: 'Started in a separate window.', nextAt: null })
      )
      .then(() => {
        loop();
        sendResponse({ ok: true });
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'findSites') {
    Promise.all([getAuto(), getSites(), getJobs(), getCollector(), getChecker()]).then(async ([a, st, j, c, k]) => {
      if (a.running || st.running || j.running || c.running || k.running) return sendResponse({ ok: false, error: 'Another run is already active.' });
      if ((msg.recheck || msg.ids) && !(await chrome.storage.local.get('deepseekKey')).deepseekKey) {
        return sendResponse({ ok: false, error: 'Save a DeepSeek key first.' });
      }
      await chrome.storage.local.remove('paused');
      await setSites({ running: true });
      findSitesLoop(!!msg.recheck, Array.isArray(msg.ids) ? msg.ids : null);
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === 'startCollector') {
    Promise.all([getAuto(), getSites(), getJobs(), getCollector(), getChecker()]).then(async ([a, st, j, c, k]) => {
      if (a.running || st.running || j.running || c.running || k.running) return sendResponse({ ok: false, error: 'Another run is already active.' });
      await chrome.storage.local.remove('paused');
      await setCollector({ running: true, message: 'Starting…' });
      collectLoop();
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === 'startChecker') {
    Promise.all([getAuto(), getSites(), getJobs(), getCollector(), getChecker()]).then(async ([a, st, j, c, k]) => {
      if (a.running || st.running || j.running || c.running || k.running) return sendResponse({ ok: false, error: 'Another run is already active.' });
      await chrome.storage.local.remove('paused');
      await setChecker({ running: true, message: 'Starting…' });
      checkLoop(Number.isInteger(msg.id) ? msg.id : null);
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === 'stopChecker') {
    setChecker({ running: false }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'stopCollector') {
    setCollector({ running: false }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'findJobs') {
    Promise.all([getAuto(), getSites(), getJobs(), getCollector(), getChecker()]).then(async ([a, st, j, c, k]) => {
      if (a.running || st.running || j.running || c.running || k.running) return sendResponse({ ok: false, error: 'Another run is already active.' });
      await chrome.storage.local.remove('paused');
      await setJobs({ running: true });
      findJobsLoop();
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === 'stopJobs') {
    setJobs({ running: false }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'testDeepseek') {
    deepseekJson('Reply with {"ok": true}.', 'ping').then((ai) => sendResponse({ ok: !!ai }));
    return true;
  }
  if (msg.type === 'stopSites') {
    setSites({ running: false }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'stop') {
    stop('Stopped by you.').then(() => sendResponse({ ok: true }));
    return true;
  }
});

// A pause must not survive a browser restart.
chrome.runtime.onStartup.addListener(() => chrome.storage.local.remove('paused'));
chrome.runtime.onInstalled.addListener(() => chrome.storage.local.remove('paused'));
