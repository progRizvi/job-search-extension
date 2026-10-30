const $ = (id) => document.getElementById(id);
const isSearch = (url) => /^https:\/\/www\.linkedin\.com\/search\/results\//.test(url || '');

function hint(msg, isErr) {
  $('hint').textContent = msg;
  $('hint').className = isErr ? 'hint err' : 'hint';
}

for (let i = 0; i < DAILY_LIMIT; i++) $('segs').appendChild(document.createElement('span'));

async function getLastUrl() {
  const { lastUrl, visited = {} } = await chrome.storage.local.get(['lastUrl', 'visited']);
  return lastUrl || Object.keys(visited).pop() || '';
}

const RUNS = [
  ['auto', 'Copying LinkedIn pages'], ['sites', 'Finding websites'], ['jobs', 'Finding backend jobs'],
  ['collector', 'Searching countries'], ['checker', 'Checking saved links'],
];

async function render() {
  const { count, companies } = await load();
  const st = await chrome.storage.local.get(['auto', 'sites', 'jobs', 'collector', 'checker', 'waiting', 'paused']);
  const auto = st.auto || {};
  const active = RUNS.find(([k]) => st[k] && st[k].running);
  const limitHit = count >= DAILY_LIMIT;

  $('count').textContent = count;
  $('segs').setAttribute('aria-label', `${count} of ${DAILY_LIMIT} pages used today`);
  [...$('segs').children].forEach((el, i) => { el.className = i < count ? 'used' : auto.running && i === count ? 'now' : ''; });
  const n = Object.keys(companies).length;
  $('saved').textContent = `${n} ${n === 1 ? 'company' : 'companies'} saved`;

  // Same wording as the workspace's Now strip.
  const now = $('now');
  if (st.paused && active && !st.waiting) {
    now.dataset.s = 'waiting';
    $('nowTitle').textContent = 'Paused';
    $('nowMsg').textContent = 'Press Resume to continue.';
  } else if (st.waiting) {
    now.dataset.s = 'waiting';
    $('nowTitle').textContent = 'Waiting for you';
    $('nowMsg').textContent = `${st.waiting.what} Solve it in the separate window and the run continues.`;
  } else if (active) {
    const [key, title] = active;
    const rec = key === 'sites' || key === 'jobs' ? auto : st[key];
    now.dataset.s = 'running';
    $('nowTitle').textContent = title;
    $('nowMsg').textContent = (rec.message || '') + (rec.nextAt ? ` Next in ${Math.max(0, Math.round((rec.nextAt - Date.now()) / 1000))}s.` : '');
  } else {
    const last = [auto.message, st.collector?.message, st.checker?.message].filter(Boolean).pop() || '';
    now.dataset.s = /^Stopped:/.test(last) ? 'error' : 'idle';
    $('nowTitle').textContent = limitHit ? 'Done for today' : 'Ready';
    $('nowMsg').textContent = last;
  }

  // A pause flag with nothing running would only get in the way of the next run: clear it.
  if (st.paused && !active) chrome.storage.local.remove('paused');
  const pauseBtn = $('pause');
  pauseBtn.hidden = !active;
  pauseBtn.textContent = st.paused ? 'Resume' : 'Pause';
  pauseBtn.dataset.paused = st.paused ? '1' : '';

  const main = $('main');
  main.dataset.mode = auto.running ? 'stop' : 'start';
  main.textContent = auto.running ? 'Stop copying' : 'Start copying';
  main.disabled = !auto.running && (limitHit || !!active);

  const lastUrl = await getLastUrl();
  $('resume').disabled = !lastUrl || !!active || limitHit;
  $('scrape').disabled = !!active;
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
  if (!isSearch(tab?.url)) return hint('Open a LinkedIn company search (Search, then Companies), then start.', true);
  hint('Opening a separate window…');
  const res = await chrome.runtime.sendMessage({ type: 'start', url: tab.url });
  if (res && !res.ok) hint(`Could not start: ${res.error}`, true);
  render();
});

$('resume').addEventListener('click', async () => {
  const lastUrl = await getLastUrl();
  if (!lastUrl) return;
  hint('Opening your last page in a separate window…');
  const res = await chrome.runtime.sendMessage({ type: 'start', url: lastUrl });
  if (res && !res.ok) hint(`Could not start: ${res.error}`, true);
  render();
});

$('scrape').addEventListener('click', async () => {
  try {
    const tab = await activeTab();
    if (!isSearch(tab?.url)) return hint('Open a LinkedIn company search, then copy.', true);
    const key = normalizePageUrl(tab.url);
    const { visited, count } = await load();
    if (visited[key]) return hint(`You already copied this page on ${visited[key]}.`, true);
    if (count >= DAILY_LIMIT) return hint('Daily limit reached. Try again after midnight.', true);
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapePage });
    if (!result || !result.length) return hint('No companies found. Scroll down so results load, then try again.', true);
    const { added } = await savePage(key, result);
    await navigator.clipboard.writeText(toTSV(Object.fromEntries(result.map((c) => [c.linkedinUrl, c]))));
    hint(`Copied ${result.length} companies (${added} new). Paste into Excel or Sheets.`);
  } catch (e) {
    hint(`Could not copy: ${e.message}`, true);
  }
  render();
});

$('pause').addEventListener('click', () => chrome.storage.local.set({ paused: !$('pause').dataset.paused }));

$('open').addEventListener('click', async () => {
  const url = chrome.runtime.getURL('app.html');
  const [existing] = await chrome.tabs.query({ url });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
  window.close();
});

chrome.storage.onChanged.addListener(render);
setInterval(render, 1000);
render();
