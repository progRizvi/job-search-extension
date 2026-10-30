const $ = (id) => document.getElementById(id);
const PAGES = ['overview', 'companies', 'country', 'settings'];
const KEYS = ['auto', 'sites', 'jobs', 'collector', 'checker', 'waiting', 'paused', 'leadKey', 'deepseekKey', 'deepseekError', 'dsStats', 'lastUrl', 'visited', 'collectorDaily', 'checkerDaily'];

let S = {}; // everything read from storage on the last refresh
let server = { ok: false, error: 'Checking…', stats: null, matches: [] };
const picked = new Set();
let onlyUnrelated = false;

const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  kids.flat().forEach((c) => n.append(c));
  return n;
};

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

async function send(type, extra = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...extra });
  if (res && res.ok === false) toast(`Could not start: ${res.error}`);
  refresh();
  return res;
}

// Two-click guard instead of a confirm dialog.
function armed(btn, label, action) {
  let timer = null;
  const original = btn.textContent;
  btn.addEventListener('click', async () => {
    if (!timer) {
      btn.textContent = label;
      timer = setTimeout(() => { timer = null; btn.textContent = original; }, 4000);
      return;
    }
    clearTimeout(timer);
    timer = null;
    btn.textContent = original;
    await action();
  });
}

// ---------- data ----------
// Older scrapes stored page text in the location field; only show something that looks like a place.
const cleanPlace = (s) => (s && s.length <= 40 && /^[\p{L} .,'-]+$/u.test(s) ? s : '');
const shortUrl = (u) => { try { const x = new URL(u); return host(u) + x.pathname.replace(/\/$/, '').slice(0, 28); } catch { return u; } };
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u || ''; } };

function figures(companies) {
  const list = Object.values(companies);
  const withSite = list.filter((c) => c.website);
  return {
    n: list.length,
    withSite: withSite.length,
    missing: list.filter((c) => !c.website && !c.siteChecked).length,
    unverified: withSite.filter((c) => c.websiteBy !== 'DeepSeek' && c.websiteBy !== 'LinkedIn').length,
    toCheck: withSite.filter((c) => !c.jobsChecked).length,
    checked: withSite.filter((c) => c.jobsChecked).length,
    matches: list.filter((c) => c.backendJobUrl).length,
  };
}

async function refresh() {
  S = await chrome.storage.local.get(KEYS);
  const data = await load();
  S.companies = data.companies;
  S.count = data.count;
  S.f = figures(S.companies);
  renderNow();
  renderOverview();
  renderCountry();
  renderSettings();
  renderCompaniesIfChanged();
  $('navCount').textContent = S.f.n || '';
}

// ---------- the Now strip ----------
function activeRun() {
  const { auto = {}, sites = {}, jobs = {}, collector = {}, checker = {} } = S;
  if (auto.running) return { title: 'Copying LinkedIn pages', rec: auto, stop: 'stop' };
  if (sites.running) return { title: 'Finding websites', rec: auto, stop: 'stopSites' };
  if (jobs.running) return { title: 'Finding backend jobs', rec: auto, stop: 'stopJobs' };
  if (collector.running) return { title: 'Searching countries', rec: collector, stop: 'stopCollector' };
  if (checker.running) return { title: 'Checking saved links', rec: checker, stop: 'stopChecker' };
  return null;
}

const countdown = (rec) => (rec.nextAt ? ` Next in ${Math.max(0, Math.round((rec.nextAt - Date.now()) / 1000))}s.` : '');

function renderNow() {
  const run = activeRun();
  const now = $('now');
  const stop = $('nowStop');
  const pauseBtn = $('nowPause');
  pauseBtn.hidden = !run;
  pauseBtn.textContent = S.paused ? 'Resume' : 'Pause';
  pauseBtn.onclick = () => chrome.storage.local.set({ paused: !S.paused });
  if (S.paused && run && !S.waiting) {
    now.dataset.s = 'waiting';
    $('nowTitle').textContent = 'Paused';
    $('nowMsg').textContent = `${run.title} will hold at the next safe point. Press Resume to continue.`;
    stop.hidden = false;
    stop.onclick = () => send(run.stop);
    return;
  }
  if (S.waiting) {
    now.dataset.s = 'waiting';
    $('nowTitle').textContent = 'Waiting for you';
    $('nowMsg').textContent = `${S.waiting.what} Solve it in the separate window and the run continues.`;
    stop.hidden = !run;
    stop.onclick = () => run && send(run.stop);
    return;
  }
  if (run) {
    now.dataset.s = 'running';
    $('nowTitle').textContent = run.title;
    $('nowMsg').textContent = (run.rec.message || '') + countdown(run.rec);
    stop.hidden = false;
    stop.onclick = () => send(run.stop);
    return;
  }
  stop.hidden = true;
  const last = [S.auto, S.collector, S.checker].map((r) => r && r.message).filter(Boolean).pop() || '';
  now.dataset.s = /^Stopped:/.test(last) ? 'error' : 'idle';
  const waiting = server.stats ? server.stats.waiting : 0;
  $('nowTitle').textContent = 'Idle';
  // Keep the last result visible, and add what is still queued. A summary that says everything is checked would be wrong then.
  const summary = waiting && /^Done: (every saved link|nothing to check)/.test(last) ? '' : last;
  $('nowMsg').textContent = waiting
    ? `${summary} ${waiting} ${waiting === 1 ? 'link is' : 'links are'} queued. Nothing is running. Press Check saved links.`.trim()
    : last;
}

// ---------- overview: two routes ----------
function stop(opts) {
  const { title, stat, sub, state, done, action } = opts;
  return el('li', { class: 'stop', 'data-state': state === 'idle' && done ? 'done' : state, 'data-done': done ? '1' : '0' },
    el('span', { class: 'dot' }),
    el('span', { class: 'title' }, title),
    el('span', { class: 'stat' }, stat),
    el('span', { class: 'sub' }, sub || ''),
    action ? el('button', { class: 'btn act', type: 'button', onclick: action.run, disabled: action.disabled }, action.label) : '');
}

const stateOf = (running) => (running ? (S.waiting ? 'waiting' : 'running') : 'idle');
let routeSig = '';

function renderOverview() {
  const f = S.f;
  const { auto = {}, sites = {}, jobs = {}, collector = {}, checker = {}, leadKey } = S;
  const anyRun = !!(auto.running || sites.running || jobs.running || collector.running || checker.running);
  const lastUrl = S.lastUrl || Object.keys(S.visited || {}).pop() || '';
  const st = server.stats;

  const linkedin = [
    stop({
      title: 'Collect companies', stat: `${f.n}`, sub: `${S.count} of ${DAILY_LIMIT} pages today`,
      state: stateOf(auto.running), done: f.n > 0 && !auto.running,
      action: auto.running
        ? { label: 'Stop', run: () => send('stop') }
        : lastUrl
          ? { label: 'Resume last page', run: () => send('start', { url: lastUrl }), disabled: anyRun || S.count >= DAILY_LIMIT }
          : { label: 'Open LinkedIn search', run: () => chrome.tabs.create({ url: 'https://www.linkedin.com/search/results/companies/' }) },
    }),
    stop({
      title: 'Find websites', stat: `${f.withSite} of ${f.n}`, sub: f.unverified ? `${f.unverified} not yet verified by AI` : f.n ? 'All verified' : '',
      state: stateOf(sites.running), done: f.n > 0 && f.missing === 0 && !sites.running,
      action: sites.running
        ? { label: 'Stop', run: () => send('stopSites') }
        : f.missing
          ? { label: `Find ${f.missing} missing`, run: () => send('findSites'), disabled: anyRun }
          : f.unverified && S.deepseekKey
            ? { label: `Re-check ${f.unverified} with AI`, run: () => send('findSites', { recheck: true }), disabled: anyRun }
            : null,
    }),
    stop({
      title: 'Find backend jobs', stat: `${f.checked} of ${f.withSite}`, sub: `${f.matches} fitting ${f.matches === 1 ? 'job' : 'jobs'}`,
      state: stateOf(jobs.running), done: f.withSite > 0 && f.toCheck === 0 && !jobs.running,
      action: jobs.running
        ? { label: 'Stop', run: () => send('stopJobs') }
        : f.toCheck ? { label: `Check ${f.toCheck} sites`, run: () => send('findJobs'), disabled: anyRun } : null,
    }),
    stop({
      title: 'Export', stat: 'Excel', sub: 'All saved companies and job results', state: 'idle', done: false,
      action: { label: 'Export Excel', run: exportCompanies, disabled: !f.n },
    }),
  ];

  const country = [
    stop({
      title: 'Search countries', stat: st ? `${st.countriesDone} of ${st.countriesTotal}` : '–', sub: st ? `${st.urls} links saved` : server.error,
      state: stateOf(collector.running), done: !!st && st.countriesTotal > 0 && st.countriesDone === st.countriesTotal,
      action: collector.running
        ? { label: 'Stop', run: () => send('stopCollector') }
        : { label: 'Start search', run: () => send('startCollector'), disabled: anyRun || !leadKey || !server.ok },
    }),
    stop({
      title: 'Check links', stat: st ? `${st.checked} of ${st.urls}` : '–', sub: st ? `${st.matches} matching jobs` : '',
      state: stateOf(checker.running), done: !!st && st.urls > 0 && st.checked === st.urls,
      action: checker.running
        ? { label: 'Stop', run: () => send('stopChecker') }
        : { label: 'Check saved links', run: () => send('startChecker'), disabled: anyRun || !leadKey || !server.ok || !S.deepseekKey },
    }),
    stop({
      title: 'Export', stat: 'Excel', sub: 'Every link with its country and job', state: 'idle', done: false,
      action: { label: 'Export Excel', run: exportLeads, disabled: !server.ok },
    }),
  ];

  // Only rebuild when something visible changed, so buttons keep focus and hover.
  const sig = JSON.stringify([f, S.count, st, auto.running, sites.running, jobs.running, collector.running, checker.running, !!S.waiting, !!leadKey, !!S.deepseekKey, server.ok, lastUrl]);
  if (sig === routeSig) return;
  routeSig = sig;
  const mk = (id, title, stops) => {
    const box = $(id);
    box.textContent = '';
    box.append(el('h2', {}, title), el('ol', { class: 'stops', style: `--n:${stops.length}` }, stops));
  };
  mk('routeLinkedin', 'LinkedIn companies', linkedin);
  mk('routeCountry', 'Country search', country);
}

// ---------- companies ----------
let companiesSig = '';

function renderCompaniesIfChanged() {
  if ($('page-companies').hidden) return;
  const sig = JSON.stringify([S.companies, [...picked], $('filter').value, onlyUnrelated, !!S.deepseekKey, activeRun() && 1]);
  if (sig === companiesSig) return;
  companiesSig = sig;
  renderCompanies();
}

function renderCompanies() {
  const q = $('filter').value.trim().toLowerCase();
  const all = Object.values(S.companies).map((c) => ({ c, bad: looksUnrelated(c.name, c.website) }));
  const rows = all
    .filter(({ c, bad }) => (!onlyUnrelated || bad) && (!q || `${c.name} ${c.website}`.toLowerCase().includes(q)))
    .sort((a, b) => Number(b.bad) - Number(a.bad) || a.c.name.localeCompare(b.c.name));
  const shown = rows.slice(0, 400);
  const tbody = $('rows');
  const scroller = tbody.closest('.tableWrap');
  const top = scroller.scrollTop;
  tbody.textContent = '';
  for (const { c, bad } of shown) {
    const box = el('input', { type: 'checkbox', 'aria-label': `Select ${c.name}` });
    box.checked = picked.has(c.linkedinUrl);
    box.addEventListener('change', () => { box.checked ? picked.add(c.linkedinUrl) : picked.delete(c.linkedinUrl); renderPicked(); });
    const job = c.backendJobUrl
      ? [el('a', { href: c.backendJobUrl, target: '_blank', rel: 'noreferrer' }, c.backendJobTitle || 'Open job'),
        el('small', {}, [c.jobFit, c.jobWorkType, c.jobLocation].filter(Boolean).join(' · '))]
      : c.jobsChecked ? [el('small', {}, c.openings === 'yes' ? 'Hiring, no fitting job' : 'No openings')] : [el('small', {}, 'Not checked yet')];
    tbody.append(el('tr', {},
      el('td', { class: 'chk' }, box),
      el('td', {}, el('a', { href: c.linkedinUrl, target: '_blank', rel: 'noreferrer' }, c.name), el('small', {}, cleanPlace(c.location))),
      el('td', {}, c.website ? el('a', { href: c.website, target: '_blank', rel: 'noreferrer' }, host(c.website)) : el('small', {}, '–'), bad ? el('small', { class: 'flag' }, 'looks unrelated') : ''),
      el('td', {}, c.careersUrl ? el('a', { href: c.careersUrl, target: '_blank', rel: 'noreferrer' }, shortUrl(c.careersUrl)) : el('small', {}, '–')),
      el('td', {}, job),
      el('td', {}, c.checkedBy || c.websiteBy || '–')));
  }
  scroller.scrollTop = top;
  $('empty').hidden = all.length > 0;
  $('table').hidden = all.length === 0;
  $('tableNote').textContent = rows.length > shown.length ? `Showing the first ${shown.length} of ${rows.length}. Use the filter to narrow the list.` : all.length ? `${rows.length} ${rows.length === 1 ? 'company' : 'companies'}.` : '';
  $('allBox').checked = shown.length > 0 && shown.every(({ c }) => picked.has(c.linkedinUrl));
  $('allBox').onchange = (e) => { shown.forEach(({ c }) => (e.target.checked ? picked.add(c.linkedinUrl) : picked.delete(c.linkedinUrl))); renderPicked(); renderCompanies(); };
  renderPicked(shown);
}

function renderPicked() {
  const busy = !!activeRun();
  $('picked').hidden = picked.size === 0;
  $('pickedCount').textContent = `${picked.size} selected`;
  $('research').disabled = !S.deepseekKey || busy;
  $('pickedNote').textContent = !S.deepseekKey ? 'Save a DeepSeek key in Settings first.' : busy ? 'Another run is active.' : '';
}

$('filter').addEventListener('input', () => { companiesSig = ''; renderCompaniesIfChanged(); });
$('onlyUnrelated').addEventListener('click', (e) => {
  onlyUnrelated = !onlyUnrelated;
  e.currentTarget.setAttribute('aria-pressed', String(onlyUnrelated));
  companiesSig = '';
  renderCompaniesIfChanged();
});
$('selUnrelated').addEventListener('click', () => {
  Object.values(S.companies).forEach((c) => { if (looksUnrelated(c.name, c.website)) picked.add(c.linkedinUrl); });
  renderPicked();
  renderCompaniesIfChanged();
});
$('clearPick').addEventListener('click', () => { picked.clear(); renderPicked(); renderCompaniesIfChanged(); });
$('research').addEventListener('click', async () => {
  const res = await send('findSites', { recheck: true, ids: [...picked] });
  if (res && res.ok) { picked.clear(); renderPicked(); }
});
$('copyAll').addEventListener('click', async () => {
  if (!S.f.n) return toast('Nothing saved yet.');
  await navigator.clipboard.writeText(toTSV(S.companies));
  toast(`Copied ${S.f.n} companies.`);
});

function download(bytes, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportCompanies() {
  if (!S.f.n) return toast('Nothing saved yet.');
  download(companiesToXlsx(S.companies), `linkedin-companies-${today()}.xlsx`);
  toast('Excel file saved to your Downloads folder.');
}
$('xlsx').addEventListener('click', exportCompanies);

armed($('resetJobs'), 'Click again to erase all job results', async () => {
  const { companies = {} } = await chrome.storage.local.get('companies');
  for (const c of Object.values(companies)) {
    Object.assign(c, { jobsChecked: false, careersUrl: '', openings: '', backendJobTitle: '', backendJobUrl: '', checkedBy: '', jobFit: '', jobLocation: '', jobWorkType: '', jobExperience: '', jobStack: '' });
  }
  await chrome.storage.local.set({ companies });
  toast('Job results erased. Websites are kept.');
  refresh();
});
armed($('clear'), 'Click again to delete all saved companies', async () => {
  await chrome.storage.local.set({ companies: {} });
  picked.clear();
  toast("Saved companies cleared. Today's page count is unchanged.");
  refresh();
});

// ---------- country search ----------
async function refreshServer() {
  try {
    const stats = await serverFetch('/stats');
    const { rows } = await serverFetch('/export');
    server = { ok: true, error: '', stats, matches: rows.filter((r) => r.jobUrl) };
  } catch (e) {
    server = { ok: false, error: e instanceof ServerDown ? e.message : e.message, stats: null, matches: [] };
  }
  routeSig = '';
  loadCountries();
  loadLinks();
  renderCountry();
  renderOverview();
}

function renderCountry() {
  const st = server.stats;
  const { collector = {}, checker = {}, leadKey } = S;
  const busy = !!activeRun();
  $('serverState').textContent = server.ok ? 'Local server connected.' : `${server.error} Start server/start.bat.`;
  $('serverState').className = `serverState${server.ok ? '' : ' err'}`;
  $('mCountries').textContent = st ? `${st.countriesDone} of ${st.countriesTotal}` : '–';
  $('mChecked').textContent = st ? `${st.checked} of ${st.urls}` : '–';
  $('barCountries').style.width = st && st.countriesTotal ? `${(100 * st.countriesDone) / st.countriesTotal}%` : '0';
  $('barChecked').style.width = st && st.urls ? `${(100 * st.checked) / st.urls}%` : '0';
  $('geoStart').textContent = collector.running ? 'Stop country search' : 'Start country search';
  $('geoStart').disabled = !leadKey || !server.ok || (!collector.running && busy);
  $('chkStart').textContent = checker.running ? 'Stop checking' : 'Check saved links';
  $('chkStart').classList.toggle('primary', !!(st && st.waiting) && !checker.running);
  $('chkStart').disabled = !leadKey || !server.ok || (!checker.running && (busy || !S.deepseekKey));
  $('geoExport').disabled = !server.ok;
  $('chkRetry').disabled = $('chkAgain').disabled = !server.ok || !!checker.running;
  syncLinks();
  $('geoNote').textContent = !leadKey ? 'Save the server key in Settings.' : !S.deepseekKey ? 'Checking links needs a DeepSeek key.' : '';
  const day = (d) => (d && d.date === today() ? d.count : 0);
  $('limits').textContent = `Today: ${day(S.collectorDaily)} of 150 searches, ${day(S.checkerDaily)} of 300 link checks. Bangladesh, India, Pakistan and Afghanistan are skipped.`;

  const body = $('matchRows');
  const sig = JSON.stringify(server.matches.map((m) => m.jobUrl + m.country));
  if (body.dataset.sig !== sig) {
    body.dataset.sig = sig;
    body.textContent = '';
    for (const m of server.matches.slice(0, 200)) {
      body.append(el('tr', {},
        el('td', {}, m.country),
        el('td', {}, el('a', { href: m.jobUrl, target: '_blank', rel: 'noreferrer' }, m.jobTitle || 'Open job'), el('small', {}, host(m.url))),
        el('td', {}, m.remoteScope || '–'), el('td', {}, m.fit || '–'), el('td', {}, m.stack || '–')));
    }
    $('matchEmpty').hidden = server.matches.length > 0;
  }
}

$('geoStart').addEventListener('click', () => send(S.collector?.running ? 'stopCollector' : 'startCollector'));
$('chkStart').addEventListener('click', () => send(S.checker?.running ? 'stopChecker' : 'startChecker'));

async function exportLeads() {
  try {
    const { rows } = await serverFetch('/export');
    if (!rows.length) return toast('Nothing to export yet. Run the country search first.');
    const header = ['Country', 'URL', 'Kind', 'Status', 'Careers/List Page', 'Openings', 'Job Title', 'Job URL', 'Work Type', 'Remote Scope', 'Fit', 'Stack'];
    download(buildXlsx([header, ...rows.map((r) => [r.country, r.url, r.kind, r.status, r.careersUrl, r.openings, r.jobTitle, r.jobUrl, r.workType, r.remoteScope, r.fit, r.stack])]), `country-job-leads-${today()}.xlsx`);
    toast(`Saved ${rows.length} rows to your Downloads folder.`);
  } catch (e) { toast(e.message); }
}
$('geoExport').addEventListener('click', exportLeads);

async function requeue(which) {
  try {
    const r = await serverFetch('/checker/requeue', { which });
    toast(r.requeued ? `${r.requeued} links will be checked again. Press Check saved links.` : 'Nothing to re-check.');
    refreshServer();
  } catch (e) { toast(e.message); }
}
$('chkRetry').addEventListener('click', () => requeue('unreachable'));
armed($('chkAgain'), 'Click again to re-check every link', () => requeue('all'));

async function loadCountries() {
  try {
    const { countries } = await serverFetch('/countries');
    const sel = $('manualCountry');
    if (sel.options.length === countries.length) return;
    sel.textContent = '';
    countries.forEach((c) => sel.append(el('option', { value: c.code }, c.name)));
  } catch { /* the server is off; the list fills in when it is back */ }
}

$('manualAdd').addEventListener('click', async () => {
  // One link per line. Never split on commas: Glassdoor and Indeed links contain them (…SRCH_KO0,24.htm).
  const urls = $('manualUrls').value.split(/\r?\n/).flatMap((line) => {
    const t = line.trim();
    const parts = t.split(/\s+/);
    return parts.length > 1 && parts.every((p) => /^https?:\/\//i.test(p)) ? parts : [t]; // several links on one line, separated by spaces
  }).filter(Boolean);
  const note = $('manualNote');
  note.className = 'note';
  if (!urls.length) { note.textContent = 'Paste at least one link.'; return; }
  try {
    const r = await serverFetch('/links', { countryCode: $('manualCountry').value, urls });
    const parts = [`${r.added} added`];
    if (r.requeued) parts.push(`${r.requeued} will be checked again`);
    if (r.invalid) parts.push(`${r.invalid} skipped (not a web link)`);
    note.textContent = `${parts.join(', ')}.`;
    $('manualUrls').value = '';
    refreshServer();
  } catch (e) {
    note.className = 'note err';
    note.textContent = e instanceof ServerDown ? `${e.message} Start server/start.bat.` : e.message;
  }
});

// ---------- saved links ----------
const links = { status: '', q: '', rows: [], total: 0, editing: null, scrolledTo: null, activeSeen: null };
const STATUS_LABEL = { new: 'Not checked yet', checked: 'Checked', unreachable: 'Unreadable' };
const activeId = () => (S.checker && S.checker.running && S.checker.currentId) || null;

async function loadLinks(more = false) {
  if ($('page-country').hidden || !server.ok) return;
  if (links.editing !== null && !more) return; // never redraw under an open edit box
  try {
    const shown = links.rows.filter((r) => !r.pinned).length;
    const limit = more ? 100 : Math.max(100, shown);
    const pin = !more && activeId() ? `&pin=${activeId()}` : '';
    const res = await serverFetch(`/links?status=${links.status}&q=${encodeURIComponent(links.q)}&limit=${limit}&offset=${more ? shown : 0}${pin}`);
    links.total = res.total;
    links.rows = more ? [...links.rows, ...res.rows] : res.rows;
    renderLinks();
  } catch { /* the server is off; the table keeps what it had */ }
}

// Called on every refresh: when the checker moves to another link, reload so that link is pinned and highlighted.
function syncLinks() {
  const now = activeId();
  if (now !== links.activeSeen) {
    links.activeSeen = now;
    loadLinks();
  }
  renderLinks();
}

async function saveEdit(l, input, msg) {
  try {
    await serverFetch('/links/update', { id: l.id, url: input.value.trim() });
    links.editing = null;
    toast('Saved. This link will be checked again.');
    await loadLinks();
    refreshServer();
  } catch (e) {
    msg.textContent = e.message;
  }
}

function renderLinks() {
  const active = activeId();
  const sig = JSON.stringify([links.rows, links.total, active, links.editing, !!activeRun(), !!S.deepseekKey]);
  const body = $('linkRows');
  $('linksTotal').textContent = links.total ? `(${links.total})` : '';
  $('linksMore').hidden = links.rows.filter((r) => !r.pinned).length >= links.total;
  $('linksEmpty').hidden = links.rows.length > 0;
  if (body.dataset.sig === sig) return;
  body.dataset.sig = sig;
  body.textContent = '';
  let activeRow = null;
  for (const l of links.rows) {
    const isActive = l.id === active;
    let linkCell;
    if (links.editing === l.id) {
      const input = el('input', { type: 'text', value: l.url, 'aria-label': 'Link address', class: 'editUrl', spellcheck: 'false' });
      const msg = el('small', { class: 'err' });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveEdit(l, input, msg);
        if (e.key === 'Escape') { links.editing = null; renderLinks(); }
      });
      linkCell = el('td', {}, input,
        el('div', { class: 'editBtns' },
          el('button', { class: 'btn primary mini', type: 'button', onclick: () => saveEdit(l, input, msg) }, 'Save'),
          el('button', { class: 'btn quiet mini', type: 'button', onclick: () => { links.editing = null; renderLinks(); } }, 'Cancel'), msg));
      setTimeout(() => input.focus(), 0);
    } else {
      linkCell = el('td', {}, el('a', { href: l.url, target: '_blank', rel: 'noreferrer', title: l.url }, shortUrl(l.url)));
    }
    const remove = el('button', { class: 'btn quiet mini danger', type: 'button' }, 'Remove');
    armed(remove, 'Sure?', async () => {
      try { await serverFetch('/links/remove', { id: l.id }); toast('Link removed.'); loadLinks(); refreshServer(); } catch (e) { toast(e.message); }
    });
    const row = el('tr', { class: isActive ? 'active' : '', 'aria-current': isActive ? 'true' : false },
      linkCell,
      el('td', { title: l.countries }, l.countries.length > 48 ? `${l.countries.slice(0, 46)}…` : l.countries || '–'),
      el('td', {}, l.source === 'manual' ? 'Added by me' : l.source.replace(/^remote /, '') || '–'),
      el('td', { class: 'status', 'data-s': isActive ? 'active' : l.status }, isActive ? 'Checking now' : l.status === 'new' && l.jobs ? 'Queued to re-check' : STATUS_LABEL[l.status] || l.status),
      el('td', { title: l.status === 'new' && l.jobs ? 'From the last check. They are replaced when the re-check finishes. Press Check saved links to run it.' : '' }, l.jobs ? String(l.jobs) : '–'),
      el('td', { class: 'acts' },
        el('button', { class: 'btn quiet mini', type: 'button', onclick: () => { links.editing = l.id; renderLinks(); } }, 'Edit'),
        isActive
          ? ''
          : el('button', { class: 'btn quiet mini', type: 'button', disabled: !!activeRun() || !S.deepseekKey, title: S.deepseekKey ? 'Check only this link now' : 'Save a DeepSeek key in Settings first', onclick: () => send('startChecker', { id: l.id }) }, 'Check now'),
        remove));
    if (isActive) activeRow = row;
    body.append(row);
  }
  // Bring the link being checked into view once, when it changes.
  if (activeRow && links.scrolledTo !== active) {
    links.scrolledTo = active;
    activeRow.scrollIntoView({ block: 'nearest' });
  }
}

let linkTimer;
$('linkFilter').addEventListener('input', (e) => {
  clearTimeout(linkTimer);
  linkTimer = setTimeout(() => { links.q = e.target.value.trim(); links.rows = []; links.editing = null; loadLinks(); }, 300);
});
document.querySelectorAll('.chips .chip').forEach((chip) => chip.addEventListener('click', () => {
  document.querySelectorAll('.chips .chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
  links.status = chip.dataset.status;
  links.rows = [];
  links.editing = null;
  loadLinks();
}));
$('linksMore').addEventListener('click', () => loadLinks(true));

// ---------- settings ----------
let dsNotice = '';
function renderSettings() {
  const t = new Date();
  const day = `${t.getFullYear()}-${t.getMonth() + 1}-${t.getDate()}`;
  const used = S.dsStats && S.dsStats.day === day ? S.dsStats.count : 0;
  const ds = $('dsStatus');
  ds.className = `note${S.deepseekError ? ' err' : ''}`;
  ds.textContent = dsNotice || S.deepseekError || (S.deepseekKey ? `Key saved. DeepSeek is on. ${used} ${used === 1 ? 'request' : 'requests'} today.` : 'Off. The built-in matching is used.');
  $('dsKey').placeholder = S.deepseekKey ? 'Key saved. Paste a new one to replace it.' : 'Paste your API key';
  $('leadKey').placeholder = S.leadKey ? 'Key saved. Paste a new one to replace it.' : 'Paste the server key';
  $('leadStatus').textContent = server.ok ? 'Server connected.' : S.leadKey ? `${server.error} Start server/start.bat.` : 'No key saved yet.';
  $('leadStatus').className = `note${!server.ok && S.leadKey ? ' err' : ''}`;
}

$('dsSave').addEventListener('click', async () => {
  const key = $('dsKey').value.trim();
  if (!key) return;
  await chrome.storage.local.set({ deepseekKey: key });
  await chrome.storage.local.remove('deepseekError');
  $('dsKey').value = '';
  refresh();
});
$('dsTest').addEventListener('click', async () => {
  $('dsStatus').textContent = 'Testing…';
  const res = await chrome.runtime.sendMessage({ type: 'testDeepseek' });
  if (res && res.ok) {
    dsNotice = 'The key works. DeepSeek answered.';
    setTimeout(() => { dsNotice = ''; refresh(); }, 5000);
  } else {
    dsNotice = !S.deepseekKey ? 'Save a key first.' : 'No answer from DeepSeek. Check the key and your connection.';
    setTimeout(() => { dsNotice = ''; refresh(); }, 6000);
  }
  refresh();
});
$('dsRemove').addEventListener('click', async () => { await chrome.storage.local.remove(['deepseekKey', 'deepseekError']); refresh(); });
$('leadSave').addEventListener('click', async () => {
  const key = $('leadKey').value.trim();
  if (!key) return;
  await chrome.storage.local.set({ leadKey: key });
  $('leadKey').value = '';
  await refresh();
  refreshServer();
});

// ---------- navigation ----------
function showPage() {
  const page = PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  PAGES.forEach((p) => { $(`page-${p}`).hidden = p !== page; });
  document.querySelectorAll('.rail a').forEach((a) => {
    if (a.dataset.page === page) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  companiesSig = '';
  renderCompaniesIfChanged();
  if (page === 'country' || page === 'overview') refreshServer();
}
window.addEventListener('hashchange', showPage);

chrome.storage.onChanged.addListener(refresh);
setInterval(renderNow, 1000); // the countdown
setInterval(refreshServer, 8000);
refresh().then(() => { showPage(); refreshServer(); });
