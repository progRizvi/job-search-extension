// Floating Start/Stop panel shown on LinkedIn search-results pages.
// Mirrors the popup: ten segments for the daily page budget, one main action.
(() => {
  const DAILY_LIMIT = 10;
  const INK = '#12212e', MUTED = '#5b6b77', LINE = '#d9dfda', HARBOR = '#0a5c7a', SIGNAL = '#f2a900', FLAG = '#b3261e';

  const box = document.createElement('div');
  box.style.cssText =
    `position:fixed;right:20px;bottom:20px;z-index:2147483647;width:248px;padding:12px;display:none;` +
    `font:13px/1.4 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;color:${INK};` +
    `background:#fff;border:1px solid ${LINE};border-radius:10px;box-shadow:0 4px 16px rgba(18,33,46,.18)`;

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:baseline;gap:6px;margin-bottom:8px';
  const num = document.createElement('span');
  num.style.cssText = 'font:650 26px/1 "Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;font-variant-numeric:tabular-nums';
  const of = document.createElement('span');
  of.style.cssText = `color:${MUTED};font-size:12px`;
  of.textContent = `of ${DAILY_LIMIT} pages today`;
  head.append(num, of);

  const segs = document.createElement('div');
  segs.style.cssText = 'display:grid;grid-template-columns:repeat(10,1fr);gap:3px;margin-bottom:10px';
  const segEls = Array.from({ length: DAILY_LIMIT }, () => {
    const s = document.createElement('span');
    s.style.cssText = 'height:8px;border-radius:2px';
    segs.appendChild(s);
    return s;
  });

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.style.cssText = 'width:100%;height:36px;border:0;border-radius:8px;color:#fff;font-weight:600;font-size:13px;font-family:inherit;cursor:pointer';

  const info = document.createElement('div');
  info.style.cssText = `margin-top:8px;color:${MUTED};font-size:12px;min-height:16px;white-space:pre-line`;

  box.append(head, segs, btn, info);
  document.documentElement.appendChild(box);

  let auto = {};
  let count = 0;
  let notice = '';

  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  async function refresh() {
    const s = await chrome.storage.local.get(['auto', 'daily']);
    auto = s.auto || {};
    count = s.daily && s.daily.date === today() ? s.daily.count : 0;
    notice = '';
    render();
  }

  function render() {
    box.style.display = location.pathname.startsWith('/search/results/') ? 'block' : 'none';
    num.textContent = count;
    segEls.forEach((el, i) => {
      const used = i < count;
      const now = auto.running && i === count;
      el.style.background = used ? INK : now ? SIGNAL : 'transparent';
      el.style.boxShadow = used || now ? 'none' : `inset 0 0 0 1.5px ${LINE}`;
      el.style.opacity = now && Math.floor(Date.now() / 700) % 2 ? '0.4' : '1';
    });

    const limitHit = count >= DAILY_LIMIT;
    btn.textContent = auto.running ? 'Stop copying' : 'Start copying';
    btn.style.background = auto.running ? FLAG : limitHit ? '#dfe5e0' : HARBOR;
    btn.style.color = !auto.running && limitHit ? MUTED : '#fff';
    btn.style.cursor = !auto.running && limitHit ? 'not-allowed' : 'pointer';

    let msg = notice || auto.message || (limitHit ? 'Daily limit reached. Start again after midnight.' : '');
    if (!notice && auto.running && auto.nextAt) {
      msg += ` Next page in ${Math.max(0, Math.round((auto.nextAt - Date.now()) / 1000))}s.`;
    }
    info.textContent = msg;
    info.style.color = !notice && !auto.running && /^Stopped:/.test(auto.message || '') ? FLAG : MUTED;
  }

  btn.addEventListener('click', async () => {
    if (auto.running) {
      await chrome.runtime.sendMessage({ type: 'stop' });
    } else if (count >= DAILY_LIMIT) {
      return;
    } else {
      const res = await chrome.runtime.sendMessage({ type: 'start', url: location.href });
      if (res && !res.ok) {
        notice = `Could not start: ${res.error}`;
        return render();
      }
    }
    refresh();
  });

  chrome.storage.onChanged.addListener(refresh);
  setInterval(render, 700); // countdown, segment pulse, and SPA route changes
  refresh();
})();
