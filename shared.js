// Shared by popup.js and background.js (classic scripts, global scope).
const DAILY_LIMIT = 10;
const COLUMNS = ['name', 'linkedinUrl', 'location', 'website', 'careersUrl', 'openings', 'backendJobTitle', 'backendJobUrl', 'checkedBy', 'jobFit', 'jobLocation', 'jobWorkType', 'jobExperience', 'jobStack'];

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Drop tracking params so the same results page always maps to the same key.
function normalizePageUrl(raw) {
  const u = new URL(raw);
  ['origin', 'sid', 'sessionId', 'lipi', 'trk', 'lici'].forEach((p) => u.searchParams.delete(p));
  u.searchParams.sort();
  return u.origin + u.pathname + (u.search || '');
}

async function load() {
  const { visited = {}, daily = {}, companies = {}, dataVersion = 1 } = await chrome.storage.local.get([
    'visited',
    'daily',
    'companies',
    'dataVersion',
  ]);
  if (dataVersion < 2) {
    // v1 assigned the first outside link on the page to every company; discard those.
    for (const c of Object.values(companies)) {
      c.website = '';
      delete c.siteChecked;
    }
    await chrome.storage.local.set({ companies, dataVersion: 2 });
  }
  if (dataVersion < 3) {
    // v3 widened the job-title matching; re-check companies scanned before.
    for (const c of Object.values(companies)) {
      if (!c.jobsChecked) continue;
      delete c.jobsChecked;
      c.careersUrl = c.openings = c.backendJobTitle = c.backendJobUrl = '';
    }
    await chrome.storage.local.set({ companies, dataVersion: 3 });
  }
  const count = daily.date === today() ? daily.count : 0;
  return { visited, count, companies };
}

// Stores one scraped page, marks its URL visited and bumps today's counter.
async function savePage(key, result) {
  const { visited, count, companies } = await load();
  let added = 0;
  for (const c of result) {
    const old = companies[c.linkedinUrl];
    if (!old) added++;
    companies[c.linkedinUrl] = { ...old, ...c };
    // A re-scrape must not wipe a website found earlier via Google.
    if (!c.website && old?.website) companies[c.linkedinUrl].website = old.website;
  }
  visited[key] = today();
  await chrome.storage.local.set({
    companies,
    visited,
    lastUrl: key,
    daily: { date: today(), count: count + 1 },
  });
  return { added, count: count + 1 };
}

function toRows(companies) {
  return Object.values(companies).map((c) => COLUMNS.map((k) => c[k] || ''));
}

function toTSV(companies) {
  const clean = (v) => String(v).replace(/[\t\r\n]+/g, ' ');
  return [COLUMNS, ...toRows(companies)].map((r) => r.map(clean).join('\t')).join('\n');
}

// ---- Functions below are injected into the LinkedIn page; each must be self-contained. ----

// Reads the search-result cards already on screen; never opens a company page.
function scrapePage() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const slugOf = (h) => (h.match(/linkedin\.com\/company\/([^/?#]+)/) || [])[1];
  const slugsIn = (el) =>
    new Set([...el.querySelectorAll('a[href*="/company/"]')].map((a) => slugOf(a.href)).filter(Boolean));

  const groups = new Map();
  document.querySelectorAll('a[href*="/company/"]').forEach((a) => {
    const slug = slugOf(a.href);
    if (!slug) return;
    if (!groups.has(slug)) groups.set(slug, []);
    groups.get(slug).push(a);
  });

  const out = [];
  groups.forEach((anchors, slug) => {
    // The card is the largest container that still holds exactly this one company.
    let card = anchors[0];
    while (card.parentElement && slugsIn(card.parentElement).size === 1) card = card.parentElement;

    // Card text reads: name, industry, location, Follow, description...
    const lines = (card.innerText || '').split('\n').map(clean).filter(Boolean);
    const name = lines[0];
    if (!name) return;
    const loc = lines[2] || '';
    const location =
      loc.length <= 60 && !/^(follow|following|message|visit website)$/i.test(loc) && !/follow|connection|visit/i.test(loc)
        ? loc
        : '';

    // Website only when this card itself carries a link out (e.g. "Visit website").
    let website = '';
    for (const a of card.querySelectorAll('a[href]')) {
      let h = a.href;
      if (/linkedin\.com\/redir\//.test(h)) {
        try { h = new URL(h).searchParams.get('url') || ''; } catch { h = ''; }
      }
      if (/^https?:/i.test(h) && !/linkedin\.com/i.test(h)) {
        try { website = new URL(h).origin; } catch { /* ignore */ }
        break;
      }
    }

    out.push({ name, linkedinUrl: `https://www.linkedin.com/company/${slug}/`, location, website });
  });
  return out;
}

// Scrolls down the way a reader would: uneven steps, pauses, the odd scroll back up.
async function humanScroll() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (a, b) => a + Math.random() * (b - a);
  await sleep(rnd(1500, 3500));
  let y = window.scrollY;
  while (y < document.documentElement.scrollHeight - window.innerHeight - 20) {
    y += rnd(250, 550);
    window.scrollTo({ top: y, behavior: 'instant' });
    await sleep(rnd(500, 1400));
    if (Math.random() < 0.15) {
      y -= rnd(80, 200);
      window.scrollTo({ top: y, behavior: 'instant' });
      await sleep(rnd(400, 900));
    }
  }
  await sleep(rnd(800, 2000));
}

// Resolves true once the document is complete and the company results have rendered
// and stopped changing (two identical readings 1.5s apart). False after 40s.
async function waitForResults() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const snapshot = () =>
    [...new Set([...document.querySelectorAll('a[href*="/company/"]')].map((a) => a.href))].join('|');
  let last = '';
  for (let i = 0; i < 40; i++) {
    const now = snapshot();
    if (document.readyState === 'complete' && now && now === last) return true;
    last = now;
    await sleep(1500);
  }
  return false;
}

// Injected into a Google results page: the outbound result links, or a block signal.
function readGoogleResults() {
  const t = (document.body?.innerText || '').slice(0, 4000);
  if (
    /unusual traffic|not a robot|captcha/i.test(t) ||
    location.pathname.startsWith('/sorry') ||
    location.hostname.startsWith('consent')
  ) {
    return { blocked: true, links: [] };
  }
  const links = [...document.querySelectorAll('#search a[href^="http"], #rso a[href^="http"]')]
    .map((a) => a.href)
    .filter((h) => !/(^|\.)google\./.test(new URL(h).hostname));

  // Title + snippet per result, so a model can judge which one is the official site.
  const items = [];
  const seen = new Set();
  document.querySelectorAll('#search a:has(h3), #rso a:has(h3)').forEach((a) => {
    let host;
    try { host = new URL(a.href).hostname; } catch { return; }
    if (/(^|\.)google\./.test(host) || seen.has(a.href)) return;
    seen.add(a.href);
    const box = a.closest('div[data-hveid]') || a.parentElement?.parentElement;
    items.push({
      url: a.href,
      title: a.querySelector('h3')?.innerText || '',
      snippet: (box?.innerText || '').replace(/\s+/g, ' ').slice(0, 220),
    });
  });
  // Some Google layouts hide the real address behind an opaque redirect (/goto?url=...). Then nothing is readable.
  return { blocked: false, unreadable: items.length === 0, links, items: items.slice(0, 8) };
}

// Injected into a company website: links that probably lead to its careers/jobs page.
async function findCareerLinks() {
  await new Promise((r) => setTimeout(r, 1500)); // let late-rendering menus appear
  const ATS = /(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|bamboohr\.com|recruitee\.com|breezy\.hr|myworkdayjobs\.com|jobvite\.com|icims\.com|teamtailor\.com|personio\.(de|com)|join\.com|rippling\.com|ycombinator\.com\/companies\/[^/]+\/jobs|workatastartup\.com|wellfound\.com\/company|angel\.co\/company|apply\.workable\.com|notion\.site)/i;
  const WORDS = /\b(careers?|jobs?|join (us|our team)|work (with|for) us|we.?re hiring|hiring|open (roles|positions)|openings|opportunities)\b/i;
  const seen = new Map();
  const every = new Map();
  for (const a of document.querySelectorAll('a[href]')) {
    let u;
    try { u = new URL(a.href); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    if (/linkedin\.com|indeed\.com|glassdoor\.com|facebook\.com|twitter\.com|instagram\.com|youtube\.com|tiktok\.com/i.test(u.hostname)) continue;
    const text = (a.innerText || a.getAttribute('aria-label') || a.title || '').replace(/\s+/g, ' ').trim();
    const link = u.href.split('#')[0];
    const sameSite = u.hostname.replace(/^www\./, '') === location.hostname.replace(/^www\./, '');
    if ((sameSite || ATS.test(u.hostname + u.pathname)) && !every.has(link) && u.pathname !== '/') every.set(link, { url: link, text: text.slice(0, 40) });
    const path = u.pathname.toLowerCase();
    let score = 0;
    if (/\/(careers?|jobs?|join-us|join|work-with-us|openings|opportunities)(\/|$)/.test(path)) score += 3;
    if (WORDS.test(text)) score += 2;
    if (ATS.test(u.hostname + u.pathname)) score += 2;
    const url = u.href.split('#')[0];
    // A "Join" link to patreon.com or similar is not this company's careers page.
    // A link that is plainly labelled "Careers" / "Jobs" counts even when it leads to another site
    // (many companies point it at their Y Combinator or Notion jobs page).
    const labelled = /^(careers?|jobs?|we.?re hiring|open (roles|positions)|join our team|work with us)$/i.test(text);
    if (score > 0 && (sameSite || labelled || ATS.test(u.hostname + u.pathname)) && !seen.has(url)) seen.set(url, { url, score: labelled && !sameSite ? score + 1 : score });
    if (labelled && !every.has(link)) every.set(link, { url: link, text: text.slice(0, 40) });
  }
  const iframes = [...document.querySelectorAll('iframe[src]')].map((f) => f.src).filter((x) => ATS.test(x));
  return { links: [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 4), iframes, all: [...every.values()].slice(0, 150) };
}

// Injected into a careers page: are there openings, and are any of them backend roles?
async function analyzeJobsPage() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(3000); // let single-page-app job lists render
  const text = document.body?.innerText || '';
  const noJobs = /(no|don.t have any|do not have any|aren.t any|there are no|currently no)( (current|open|available))? (job )?(openings|positions|vacancies|jobs|roles)|no jobs (available|found)|not (currently )?hiring|check back (soon|later)|0 (open )?(jobs|positions|roles)/i.test(text);
  // Roles to match, tuned to a ~3-year full-stack profile: Laravel/PHP, Node/Nest/Express, React/Next, TypeScript.
  const STRONG = /back[- ]?end|server[- ]?side|full[- ]?stack|\bnode(\.?js)?\b|\bphp\b|laravel|\bexpress(\.?js)?\b|\bnest(\.?js)?\b/i;
  const WEAK = /\b(java ?script|type ?script|js|react(\.?js)?|next(\.?js)?|software|web)\b.*\b(developer|engineer)\b|\b(developer|engineer)\b.*\b(java ?script|type ?script|js|react|node)\b/i;
  const SKIP = /\b(intern(ship)?|principal|staff|director|head of|vp|vice president|manager|architect|sales|support|recruit\w*|data scientist|machine learning|devops|sre|qa|test)\b/i;
  const SENIOR = /\b(senior|sr\.?|lead)\b/i;
  const BACKEND_TITLE = /(back[- ]?end|server[- ]?side|full[- ]?stack|node(\.?js)?|php|laravel|java ?script|js) (software )?(engineer|developer)/i;
  const NAV = /^(careers?|jobs?|apply|apply now|view all|see all|all jobs|open positions|learn more|benefits|culture|about|home|contact|life at.*|our team)$/i;
  const JOBLINK = /\/(jobs?|positions?|openings?|postings?|vacanc\w*|careers?|roles?)\/[^/]+|ycombinator\.com\/companies\/[^/]+\/jobs\/|workatastartup\.com\/jobs\/|greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|myworkdayjobs\.com|recruitee\.com|breezy\.hr|jobvite\.com|teamtailor\.com|personio/i;

  const jobs = new Map();
  for (const a of document.querySelectorAll('a[href]')) {
    // A job card often holds title, team and "Apply" on separate lines; the title is the first.
    const title = (a.innerText || '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find(Boolean) || '';
    if (title.length < 5 || title.length > 120 || NAV.test(title)) continue;
    let u;
    try { u = new URL(a.href); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || !JOBLINK.test(u.hostname + u.pathname)) continue;
    const url = u.href.split('#')[0];
    if (!jobs.has(url)) jobs.set(url, title);
  }
  const all = [...jobs].map(([url, title]) => ({ url, title }));

  // Landing pages ("Work with us") often hide the job list one click deeper: "View open jobs".
  const LIST = /\b(view|see|browse|explore|search|all)\b.{0,12}\b(open )?(jobs|positions|roles|openings|vacancies)\b|current (openings|vacancies|jobs)|open (positions|roles|jobs)/i;
  const ATS_HOST = /ycombinator\.com|workatastartup\.com|wellfound\.com|greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|bamboohr\.com|recruitee\.com|breezy\.hr|myworkdayjobs\.com|jobvite\.com|icims\.com|teamtailor\.com|personio|join\.com|rippling\.com/i;
  const listLinks = [];
  for (const a of document.querySelectorAll('a[href]')) {
    if (!LIST.test((a.innerText || '').replace(/\s+/g, ' ').trim())) continue;
    let u;
    try { u = new URL(a.href); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const link = u.href.split('#')[0];
    const sameSite = u.hostname.replace(/^www\./, '') === location.hostname.replace(/^www\./, '');
    if ((sameSite || ATS_HOST.test(u.hostname)) && link !== location.href.split('#')[0] && !listLinks.includes(link)) listLinks.push(link);
  }

  // Higher is better; senior/lead roles rank a little lower, unsuitable roles are dropped.
  const rank = (t) => (SKIP.test(t) ? 0 : (STRONG.test(t) ? 2 : WEAK.test(t) ? 1 : 0) - (SENIOR.test(t) ? 0.4 : 0));
  const backend = all
    .filter((j) => rank(j.title) > 0)
    .sort((x, y) => rank(y.title) - rank(x.title))
    .slice(0, 3);
  const textBackend = BACKEND_TITLE.test(text) ? (text.match(BACKEND_TITLE) || [''])[0] : '';
  return { notFound: /\b(404|page not found|not found|doesn.t exist)\b/i.test(text.slice(0, 400)), noJobs, jobCount: all.length, listLinks: listLinks.slice(0, 2), backend, titles: all.slice(0, 80), text: text.replace(/\s+/g, ' ').trim().slice(0, 6000), textBackend, pageUrl: location.href.split('#')[0] };
}

// Injected into a single job posting: its visible text, trimmed for the model.
async function readJobPage() {
  await new Promise((r) => setTimeout(r, 2500));
  return {
    title: document.title,
    text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 6000),
  };
}

// Injected into a Bing results page. Same shape as readGoogleResults.
function readBingResults() {
  const t = (document.body?.innerText || '').slice(0, 3000);
  if (/unusual traffic|verify (that )?you.?re (a )?human|captcha|are you a robot/i.test(t)) {
    return { blocked: true, links: [], items: [] };
  }
  // Bing sometimes wraps result links: bing.com/ck/a?...&u=a1<base64 of the real url>
  const real = (href) => {
    try {
      const u = new URL(href);
      if (/(^|\.)bing\.com$/.test(u.hostname) && u.pathname.startsWith('/ck/')) {
        const v = u.searchParams.get('u') || '';
        if (v.startsWith('a1')) return atob(v.slice(2).replace(/-/g, '+').replace(/_/g, '/'));
      }
      return href;
    } catch { return ''; }
  };
  const items = [];
  const seen = new Set();
  document.querySelectorAll('#b_results li.b_algo').forEach((li) => {
    const a = li.querySelector('h2 a');
    if (!a) return;
    const url = real(a.href);
    if (!/^https?:/.test(url) || seen.has(url)) return;
    seen.add(url);
    items.push({ url, title: a.innerText || '', snippet: (li.innerText || '').replace(/\s+/g, ' ').slice(0, 220) });
  });
  return { blocked: false, links: items.map((i) => i.url), items: items.slice(0, 8) };
}

// True when LinkedIn is asking for verification or warning about activity.
function isBlocked() {
  const t = (document.body?.innerText || '').slice(0, 5000);
  return /unusual activity|verify (that )?you.?re (a )?human|security verification|captcha|temporarily restricted/i.test(t);
}

async function clickNext() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btn = [...document.querySelectorAll('button')].find((b) =>
    /^next$/i.test((b.getAttribute('aria-label') || b.innerText || '').trim())
  );
  if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
  btn.scrollIntoView({ block: 'center', behavior: 'instant' });
  await sleep(800 + Math.random() * 1200);
  btn.click();
  return true;
}

// Rough check that a saved website could belong to the company. Used only to flag likely mistakes for review.
function looksUnrelated(name, website) {
  if (!website) return false;
  let host;
  try { host = new URL(website).hostname.toLowerCase().replace(/^www\./, ''); } catch { return true; }
  const labels = host.split('.');
  // "acme.co.uk" -> acme ; "ndl.ethernet.edu.et" -> ndl ethernet
  const core = labels.filter((l) => !['com', 'org', 'net', 'edu', 'gov', 'co', 'io', 'ai', 'app', 'dev', 'uk', 'et', 'in', 'us'].includes(l)).join('');
  const flat = core.replace(/[^a-z0-9]/g, '');
  const STOP = new Set(['inc', 'llc', 'ltd', 'corp', 'the', 'company', 'group', 'and', 'technologies', 'technology', 'tech', 'software', 'solutions', 'services', 'labs', 'systems', 'global']);
  const words = String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));
  const joined = words.join('');
  if (!flat || !joined) return false;
  if (flat.includes(joined) || joined.includes(flat)) return false;
  return !words.some((w) => w.length >= 3 && flat.includes(w));
}

// The text to search for a company. The LinkedIn address (e.g. /company/askloci) is a strong clue; the saved
// location is only used when it looks like a place, because older scrapes stored junk text there.
function companySearchText(c) {
  const slug = ((c.linkedinUrl || '').match(/\/company\/([^/?#]+)/) || [])[1] || '';
  let slugWords = slug;
  try { slugWords = decodeURIComponent(slug); } catch { /* keep as is */ }
  slugWords = slugWords.replace(/[-_.]+/g, ' ').replace(/\b\d+\b/g, '').replace(/\s+/g, ' ').trim();
  const nameKey = String(c.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const slugKey = slugWords.toLowerCase().replace(/[^a-z0-9]/g, '');
  const extra = slugKey && slugKey !== nameKey && !nameKey.includes(slugKey) ? slugWords : '';
  const loc = String(c.location || '').trim();
  const place = loc.length <= 40 && /^[A-Za-z .'\-]+(, ?[A-Za-z .'\-]+)*$/.test(loc) ? loc : '';
  return [c.name, extra, place, 'official website'].filter(Boolean).join(' ').replace(/\s+/g, ' ');
}

// Injected into a DuckDuckGo (html.duckduckgo.com) results page. Same shape as readGoogleResults.
function readDuckResults() {
  const t = (document.body?.innerText || '').slice(0, 3000);
  if (/bots use duckduckgo|select all squares|anomaly|unusual traffic/i.test(t)) {
    return { blocked: true, links: [], items: [] };
  }
  const real = (href) => {
    try {
      const u = new URL(href, location.href);
      return u.searchParams.get('uddg') || u.href; // results are wrapped: duckduckgo.com/l/?uddg=<real url>
    } catch { return ''; }
  };
  const items = [];
  const seen = new Set();
  document.querySelectorAll('.result:not(.result--ad)').forEach((r) => {
    const a = r.querySelector('a.result__a');
    if (!a) return;
    const url = real(a.getAttribute('href') || a.href);
    if (!/^https?:/.test(url) || seen.has(url)) return;
    seen.add(url);
    items.push({
      url,
      title: a.innerText || '',
      snippet: (r.querySelector('.result__snippet')?.innerText || r.innerText || '').replace(/\s+/g, ' ').slice(0, 220),
    });
  });
  return { blocked: false, unreadable: items.length === 0, links: items.map((i) => i.url), items: items.slice(0, 8) };
}

// Injected into a LinkedIn company "About" page: the website the company lists for itself.
function readLinkedInWebsite() {
  const t = (document.body?.innerText || '').slice(0, 2000);
  if (/\/(login|authwall|checkpoint)/.test(location.pathname) || /^\s*sign in|join linkedin/i.test(t.slice(0, 200))) {
    return { loggedOut: true, website: '' };
  }
  const external = (a) => {
    try {
      const u = new URL(a.href, location.href);
      if (/linkedin\.com$/.test(u.hostname)) {
        const inner = u.searchParams.get('url') || u.searchParams.get('target');
        return inner && /^https?:/.test(inner) ? inner : '';
      }
      return /^https?:/.test(u.protocol) ? u.href : '';
    } catch { return ''; }
  };
  // The About page lists "Website" as a label followed by a link.
  for (const dt of document.querySelectorAll('dt, h3, .org-page-details__definition-term')) {
    if (!/^\s*website\s*$/i.test(dt.innerText || '')) continue;
    const box = dt.nextElementSibling || dt.parentElement;
    const a = box && box.querySelector('a[href]');
    const url = a && external(a);
    if (url) return { website: url };
  }
  const a = document.querySelector('[data-test-id="about-us__website"] a[href], a[data-tracking-control-name*="website"]');
  const url = a && external(a);
  return { website: url || '' };
}

// Does a job qualify for someone living in countryName? Only remote jobs count, and only when the scope
// is worldwide, a region (assumed to include the country), or a country list that names it.
// remoteScope looks like "worldwide", "region: Europe", "country-only: France, Spain", "excluded" or "unknown".
function remoteMatches(remoteScope, workType, countryName, countries = []) {
  if (String(workType || '').toLowerCase() !== 'remote') return false;
  const s = String(remoteScope || '').toLowerCase().trim();
  if (/^(worldwide|anywhere|global)\b/.test(s)) return true;
  if (/^region\b/.test(s)) return true;
  if (/^country-only\b/.test(s)) {
    return [countryName, ...countries].map((x) => String(x || '').toLowerCase()).filter(Boolean).some((n) => s.includes(n));
  }
  return false;
}
