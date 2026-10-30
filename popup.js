const $ = (id) => document.getElementById(id);

const isSearch = (url) => /^https:\/\/www\.linkedin\.com\/search\/results\//.test(url || '');

function setStatus(msg, isErr) {
  $('status').textContent = msg;
  $('status').className = isErr ? 'err' : '';
}

// Ten segments, one per allowed page: used, the one being collected, or free.
function buildSegments() {
  const segs = $('segs');
  for (let i = 0; i < DAILY_LIMIT; i++) segs.appendChild(document.createElement('span'));
}

async function render() {
  const { count, companies } = await load();
  const { auto = {} } = await chrome.storage.local.get('auto');
  const running = !!auto.running;
  const { sites = {} } = await chrome.storage.local.get('sites');
  const sitesRunning = !!sites.running;
  const { jobs = {} } = await chrome.storage.local.get('jobs');
  const jobsRunning = !!jobs.running;
  const limitHit = count >= DAILY_LIMIT;

  $('count').textContent = count;
  $('segs').setAttribute('aria-label', `${count} of ${DAILY_LIMIT} pages used today`);
  [...$('segs').children].forEach((el, i) => {
    el.className = i < count ? 'used' : running && i === count ? 'now' : '';
  });
  const n = Object.keys(companies).length;
  $('saved').textContent = `${n} ${n === 1 ? 'company' : 'companies'} saved`;

  const main = $('main');
  main.dataset.mode = running ? 'stop' : 'start';
  main.textContent = running ? 'Stop copying' : 'Start copying';
  main.disabled = !running && limitHit;

  const lastUrl = await getLastUrl();
  $('resume').hidden = !lastUrl || running || limitHit;
  $('viewUrl').style.marginLeft = 'auto';
  $('urlOpen').disabled = $('urlCopy').disabled = !lastUrl;
  $('urlText').textContent = lastUrl || 'No page saved yet. Collect a page and it will appear here.';

  main.disabled = main.disabled || sitesRunning || jobsRunning;

  const missing = Object.values(companies).filter((c) => !c.website && !c.siteChecked).length;
  const sitesBtn = $('sites');
  sitesBtn.textContent = sitesRunning
    ? 'Stop finding websites'
    : missing
      ? `Find websites on Google (${missing} missing)`
      : 'Find websites on Google';
  sitesBtn.disabled = running || jobsRunning || (!sitesRunning && !missing);

  const { deepseekKey: dsKey } = await chrome.storage.local.get('deepseekKey');
  const unverified = Object.values(companies).filter((c) => c.website && c.websiteBy !== 'DeepSeek' && c.websiteBy !== 'LinkedIn').length;
  const recheckBtn = $('recheck');
  recheckBtn.hidden = !dsKey || !unverified;
  recheckBtn.textContent = `Re-check websites with DeepSeek (${unverified})`;
  recheckBtn.disabled = running || sitesRunning || jobsRunning;

  const resetBtn = $('resetJobs');
  const hasJobs = Object.values(companies).some((c) => c.jobsChecked || c.careersUrl || c.backendJobUrl);
  resetBtn.hidden = !hasJobs;
  resetBtn.disabled = running || sitesRunning || jobsRunning;
  if (!resetTimer) resetBtn.textContent = 'Reset job results';

  const toCheck = Object.values(companies).filter((c) => c.website && !c.jobsChecked).length;
  const jobsBtn = $('jobs');
  jobsBtn.textContent = jobsRunning
    ? 'Stop checking jobs'
    : toCheck
      ? `Find backend jobs (${toCheck} sites)`
      : 'Find backend jobs';
  jobsBtn.disabled = running || sitesRunning || (!jobsRunning && !toCheck);

  const busy = running || sitesRunning || jobsRunning;
  const state = $('state');
  state.dataset.s = busy ? 'running' : limitHit ? 'done' : 'ready';
  state.textContent = running ? 'Running' : sitesRunning ? 'Finding sites' : jobsRunning ? 'Checking jobs' : limitHit ? 'Done for today' : 'Ready';

  // Live message from the background run, with a countdown to the next page.
  if (busy || auto.message) {
    let msg = auto.message || '';
    if (busy && auto.nextAt) {
      msg += ` Next page in ${Math.max(0, Math.round((auto.nextAt - Date.now()) / 1000))}s.`;
    }
    setStatus(msg, !busy && /^Stopped:/.test(auto.message || ''));
  } else if (limitHit) {
    setStatus('Daily limit reached. You can start again after midnight.');
  }
}

// The saved resume pointer, or, for data collected before it existed, the newest visited page.
async function getLastUrl() {
  const { lastUrl, visited = {} } = await chrome.storage.local.get(['lastUrl', 'visited']);
  return lastUrl || Object.keys(visited).pop() || '';
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

$('main').addEventListener('click', async () => {
  const { auto = {} } = await chrome.storage.local.get('auto');
  if (auto.running) {
    await chrome.runtime.sendMessage({ type: 'stop' });
    return render();
  }
  const tab = await activeTab();
  if (!isSearch(tab?.url)) {
    return setStatus('Open a LinkedIn company search (Search → Companies), then start.', true);
  }
  setStatus('Opening a separate window…');
  const res = await chrome.runtime.sendMessage({ type: 'start', url: tab.url });
  if (res && !res.ok) setStatus(`Could not start: ${res.error}`, true);
  render();
});

$('resume').addEventListener('click', async () => {
  const lastUrl = await getLastUrl();
  if (!lastUrl) return;
  setStatus('Opening your last page in a separate window…');
  const res = await chrome.runtime.sendMessage({ type: 'start', url: lastUrl });
  if (res && !res.ok) setStatus(`Could not start: ${res.error}`, true);
  render();
});

$('viewUrl').addEventListener('click', () => {
  const box = $('urlBox');
  box.hidden = !box.hidden;
  $('viewUrl').setAttribute('aria-expanded', String(!box.hidden));
  $('viewUrl').textContent = box.hidden ? 'View URL' : 'Hide URL';
});

$('urlOpen').addEventListener('click', async () => {
  const lastUrl = await getLastUrl();
  if (lastUrl) chrome.tabs.create({ url: lastUrl });
});

$('urlCopy').addEventListener('click', async () => {
  const lastUrl = await getLastUrl();
  if (!lastUrl) return;
  await navigator.clipboard.writeText(lastUrl);
  setStatus('Last page link copied.');
});

$('sites').addEventListener('click', async () => {
  const { sites = {} } = await chrome.storage.local.get('sites');
  if (sites.running) {
    await chrome.runtime.sendMessage({ type: 'stopSites' });
    return render();
  }
  setStatus('Opening Google in a separate window…');
  const res = await chrome.runtime.sendMessage({ type: 'findSites' });
  if (res && !res.ok) setStatus(`Could not start: ${res.error}`, true);
  render();
});

$('recheck').addEventListener('click', async () => {
  setStatus('Opening Google in a separate window…');
  const res = await chrome.runtime.sendMessage({ type: 'findSites', recheck: true });
  if (res && !res.ok) setStatus(`Could not start: ${res.error}`, true);
  render();
});

let resetTimer = null;
$('resetJobs').addEventListener('click', async () => {
  if (!resetTimer) {
    $('resetJobs').textContent = 'Click again to erase all job results';
    resetTimer = setTimeout(() => { resetTimer = null; render(); }, 4000);
    return;
  }
  clearTimeout(resetTimer);
  resetTimer = null;
  const { companies = {} } = await chrome.storage.local.get('companies');
  for (const c of Object.values(companies)) {
    Object.assign(c, {
      jobsChecked: false, careersUrl: '', openings: '', backendJobTitle: '', backendJobUrl: '',
      checkedBy: '', jobFit: '', jobLocation: '', jobWorkType: '', jobExperience: '', jobStack: '',
    });
  }
  await chrome.storage.local.set({ companies });
  setStatus('Job results erased. Websites are kept. Run Find backend jobs again.');
  render();
});
$('jobs').addEventListener('click', async () => {
  const { jobs = {} } = await chrome.storage.local.get('jobs');
  if (jobs.running) {
    await chrome.runtime.sendMessage({ type: 'stopJobs' });
    return render();
  }
  setStatus('Opening company sites in a separate window…');
  const res = await chrome.runtime.sendMessage({ type: 'findJobs' });
  if (res && !res.ok) setStatus(`Could not start: ${res.error}`, true);
  render();
});

$('scrape').addEventListener('click', async () => {
  try {
    const tab = await activeTab();
    if (!isSearch(tab?.url)) {
      return setStatus('Open a LinkedIn company search (Search → Companies), then copy.', true);
    }
    const key = normalizePageUrl(tab.url);
    const { visited, count } = await load();

    if (visited[key]) return setStatus(`You already copied this page on ${visited[key]}.`, true);
    if (count >= DAILY_LIMIT) return setStatus('Daily limit reached. Try again after midnight.', true);

    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapePage });
    if (!result || !result.length) {
      return setStatus('No companies found. Scroll down so results load, then try again.', true);
    }

    const { added } = await savePage(key, result);
    await navigator.clipboard.writeText(toTSV(Object.fromEntries(result.map((c) => [c.linkedinUrl, c]))));
    setStatus(`Copied ${result.length} companies (${added} new). Paste into Excel or Sheets.`);
  } catch (e) {
    setStatus(`Could not copy: ${e.message}`, true);
  }
  render();
});

$('copyAll').addEventListener('click', async () => {
  const { companies } = await load();
  const n = Object.keys(companies).length;
  if (!n) return setStatus('Nothing saved yet. Copy a page first.', true);
  await navigator.clipboard.writeText(toTSV(companies));
  setStatus(`Copied ${n} companies.`);
});

$('xlsx').addEventListener('click', async () => {
  const { companies } = await load();
  if (!Object.keys(companies).length) return setStatus('Nothing saved yet. Copy a page first.', true);
  const blob = new Blob([companiesToXlsx(companies)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `linkedin-companies-${today()}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus('Excel file saved to your Downloads folder.');
});

// Two-step clear instead of a confirm dialog.
let clearTimer = null;
function disarmClear() {
  clearTimeout(clearTimer);
  clearTimer = null;
  $('clear').textContent = 'Clear saved companies';
}
$('clear').addEventListener('click', async () => {
  if (!clearTimer) {
    $('clear').textContent = 'Click again to delete all saved companies';
    clearTimer = setTimeout(disarmClear, 4000);
    return;
  }
  disarmClear();
  await chrome.storage.local.set({ companies: {} });
  setStatus("Saved companies cleared. Today's page count is unchanged.");
  render();
});

let dsNotice = '';

async function renderDeepseek() {
  const { deepseekKey, deepseekError, dsStats } = await chrome.storage.local.get(['deepseekKey', 'deepseekError', 'dsStats']);
  const t = new Date();
  const day = `${t.getFullYear()}-${t.getMonth() + 1}-${t.getDate()}`;
  const used = dsStats && dsStats.day === day ? dsStats.count : 0;
  const el = $('dsStatus');
  el.className = deepseekError ? 'err' : '';
  el.textContent = dsNotice
    ? dsNotice
    : deepseekError
    ? deepseekError
    : deepseekKey
      ? `Key saved. DeepSeek is on. ${used} ${used === 1 ? 'request' : 'requests'} today.`
      : 'Off. Using the built-in matching.';
  $('dsKey').placeholder = deepseekKey ? 'Key saved (paste a new one to replace)' : 'Paste your API key';
}

$('dsSave').addEventListener('click', async () => {
  const key = $('dsKey').value.trim();
  if (!key) return;
  await chrome.storage.local.set({ deepseekKey: key });
  await chrome.storage.local.remove('deepseekError');
  $('dsKey').value = '';
  renderDeepseek();
});

$('dsTest').addEventListener('click', async () => {
  const el = $('dsStatus');
  el.className = '';
  el.textContent = 'Testing…';
  const res = await chrome.runtime.sendMessage({ type: 'testDeepseek' });
  if (res && res.ok) {
    dsNotice = 'The key works. DeepSeek answered.';
    setTimeout(() => { dsNotice = ''; renderDeepseek(); }, 5000);
    renderDeepseek();
  } else {
    const { deepseekKey, deepseekError } = await chrome.storage.local.get(['deepseekKey', 'deepseekError']);
    el.className = 'err';
    el.textContent = !deepseekKey ? 'Save a key first.' : deepseekError || 'No answer from DeepSeek. Check your connection.';
  }
});

$('dsRemove').addEventListener('click', async () => {
  await chrome.storage.local.remove(['deepseekKey', 'deepseekError']);
  renderDeepseek();
});

// ---- Review websites: pick companies whose saved domain looks wrong and re-search them with DeepSeek ----
const picked = new Set();

async function renderReview() {
  if (!$('review').open) return;
  const { companies = {} } = await load();
  const { deepseekKey } = await chrome.storage.local.get('deepseekKey');
  const q = $('reviewFilter').value.trim().toLowerCase();
  const list = $('reviewList');
  const scroll = list.scrollTop;
  list.textContent = '';
  const rows = Object.values(companies)
    .map((c) => ({ c, bad: looksUnrelated(c.name, c.website) }))
    .filter(({ c }) => !q || `${c.name} ${c.website}`.toLowerCase().includes(q))
    .sort((a, b) => Number(b.bad) - Number(a.bad) || a.c.name.localeCompare(b.c.name))
    .slice(0, 300);
  for (const { c, bad } of rows) {
    const row = document.createElement('label');
    row.className = 'reviewRow';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = picked.has(c.linkedinUrl);
    box.addEventListener('change', () => {
      box.checked ? picked.add(c.linkedinUrl) : picked.delete(c.linkedinUrl);
      syncResearchButton();
    });
    const text = document.createElement('span');
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = c.name;
    const dm = document.createElement('div');
    dm.className = 'dm';
    let host = 'no website';
    try { if (c.website) host = new URL(c.website).hostname.replace(/^www\./, ''); } catch { host = c.website; }
    dm.textContent = host;
    if (bad) {
      const f = document.createElement('span');
      f.className = 'flag';
      f.textContent = '  looks unrelated';
      dm.appendChild(f);
    }
    text.append(nm, dm);
    row.append(box, text);
    list.appendChild(row);
  }
  if (!rows.length) list.textContent = 'No saved companies match.';
  list.scrollTop = scroll;
  syncResearchButton();
}

async function syncResearchButton() {
  const { deepseekKey, auto = {}, sites = {}, jobs = {} } = await chrome.storage.local.get(['deepseekKey', 'auto', 'sites', 'jobs']);
  const busy = !!(auto.running || sites.running || jobs.running);
  const btn = $('researchSel');
  btn.disabled = !deepseekKey || picked.size === 0 || busy;
  btn.textContent = sites.running
    ? 'Stop re-searching'
    : picked.size ? `Re-search ${picked.size} selected with DeepSeek` : 'Re-search selected with DeepSeek';
  if (sites.running) btn.disabled = false; // lets the user stop it from here
  $('reviewNote').className = 'hint';
  // Progress shows here, next to the button: the main status line is off-screen when this list is scrolled.
  $('reviewNote').textContent = !deepseekKey
    ? 'Save a DeepSeek key below to use this.'
    : sites.running
      ? auto.message || 'Searching…'
      : busy
        ? 'Another run is active. Stop it or wait for it to finish, then re-search.'
      : auto.message && /^(Stopped|Done)/.test(auto.message)
        ? `Last run: ${auto.message}`
        : picked.size === 0
          ? 'Tick at least one company.'
          : '';
  if (!sites.running && /^Stopped/.test(auto.message || '')) $('reviewNote').className = 'hint err';
}

$('review').addEventListener('toggle', renderReview);
$('reviewFilter').addEventListener('input', renderReview);
$('selNone').addEventListener('click', () => { picked.clear(); renderReview(); });
$('selUnrelated').addEventListener('click', async () => {
  const { companies = {} } = await load();
  Object.values(companies).forEach((c) => { if (looksUnrelated(c.name, c.website)) picked.add(c.linkedinUrl); });
  renderReview();
});
$('researchSel').addEventListener('click', async () => {
  const { sites = {} } = await chrome.storage.local.get('sites');
  if (sites.running) {
    await chrome.runtime.sendMessage({ type: 'stopSites' });
    return syncResearchButton();
  }
  const ids = [...picked];
  $('reviewNote').textContent = 'Starting… a separate window will open.';
  setStatus(`Re-searching ${ids.length} websites…`);
  const res = await chrome.runtime.sendMessage({ type: 'findSites', recheck: true, ids });
  if (res && !res.ok) {
    $('reviewNote').textContent = `Could not start: ${res.error}`;
    $('reviewNote').className = 'hint err';
    return;
  }
  picked.clear();
  renderReview();
  render();
});

buildSegments();
renderDeepseek();
chrome.storage.onChanged.addListener((changes) => {
  render();
  renderDeepseek();
  if ($('review').open) (changes.companies ? renderReview() : syncResearchButton());
});
setInterval(render, 1000); // countdown while a run is active
render();
