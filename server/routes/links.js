import { Router } from 'express';
import { normalizeUrl, urlHash } from '../normalize.js';

// Manual links use this pseudo-country when no country is chosen. It is never handed out by the search
// (its status is always 'done') and is left out of the country totals.
export const ANYWHERE = { code: 'ZZ', name: 'Anywhere' };

export async function ensureAnywhere(pool) {
  await pool.query("INSERT IGNORE INTO countries (code, name, status) VALUES (?, ?, 'done')", [ANYWHERE.code, ANYWHERE.name]);
}

const LINK_SELECT = `SELECT u.id, u.url, u.status, u.kind, u.first_query, u.engine, u.found_at,
       (SELECT GROUP_CONCAT(DISTINCT c.name ORDER BY c.name SEPARATOR ', ') FROM url_countries uc JOIN countries c ON c.code = uc.country_code WHERE uc.url_id = u.id) AS countries,
       (SELECT COUNT(*) FROM job_results j WHERE j.url_id = u.id AND j.job_url IS NOT NULL) AS jobs
  FROM urls u`;

export function linksRoutes(pool) {
  const r = Router();

  r.get('/countries', async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT code, name FROM countries WHERE code <> ? ORDER BY name", [ANYWHERE.code]);
      res.json({ countries: [ANYWHERE, ...rows] });
    } catch (e) { next(e); }
  });

  // Every saved link, newest first, with the countries it was found for and how many jobs it has.
  r.get('/links', async (req, res, next) => {
    try {
      const { status = '', q = '' } = req.query;
      const limit = Math.min(Number(req.query.limit) || 200, 500);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const where = [];
      const args = [];
      if (status === 'manual') where.push("u.first_query = 'manual'");
      else if (['new', 'checked', 'unreachable'].includes(status)) { where.push('u.status = ?'); args.push(status); }
      if (q) { where.push('u.url LIKE ?'); args.push(`%${q}%`); }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM urls u ${w}`, args);
      const [rows] = await pool.query(`${LINK_SELECT} ${w} ORDER BY u.id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
      const shape = (x, pinned = false) => ({ id: x.id, url: x.url, status: x.status, kind: x.kind, source: x.first_query === 'manual' ? 'manual' : x.first_query || '', engine: x.engine || '', foundAt: x.found_at, countries: x.countries || '', jobs: Number(x.jobs), pinned });
      const out = rows.map((x) => shape(x));
      // The link being checked is always shown at the top, even when a filter or the page size would hide it.
      const pin = Number(req.query.pin);
      if (pin && !out.some((x) => x.id === pin)) {
        const [one] = await pool.query(`${LINK_SELECT} WHERE u.id = ?`, [pin]);
        if (one.length) out.unshift(shape(one[0], true));
      }
      res.json({ total, rows: out });
    } catch (e) { next(e); }
  });

  // Changes a link's address. It goes back to waiting and its old jobs are dropped.
  r.post('/links/update', async (req, res, next) => {
    try {
      const { id, url } = req.body || {};
      let n;
      try {
        n = normalizeUrl(String(url || '').trim());
        if (!/^https?:/.test(n) || !Number.isInteger(id)) throw new Error('bad');
      } catch { return res.status(400).json({ error: 'That is not a web link.' }); }
      const hash = urlHash(n);
      const [dup] = await pool.query('SELECT id FROM urls WHERE url_hash = ? AND id <> ?', [hash, id]);
      if (dup.length) return res.status(409).json({ error: 'That link is already in the list.' });
      const [out] = await pool.query("UPDATE urls SET url = ?, url_hash = ?, host = ?, status = 'new', kind = 'unknown' WHERE id = ?", [n, hash, new URL(n).hostname.slice(0, 255), id]);
      await pool.query('DELETE FROM job_results WHERE url_id = ?', [id]);
      res.json({ updated: out.affectedRows });
    } catch (e) { next(e); }
  });

  r.post('/links/remove', async (req, res, next) => {
    try {
      const { id } = req.body || {};
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
      await pool.query('DELETE FROM job_results WHERE url_id = ?', [id]);
      await pool.query('DELETE FROM url_countries WHERE url_id = ?', [id]);
      const [out] = await pool.query('DELETE FROM urls WHERE id = ?', [id]);
      res.json({ removed: out.affectedRows });
    } catch (e) { next(e); }
  });

  // Links the user pastes by hand: checked before the searched ones, and re-checked if they were checked already.
  r.post('/links', async (req, res, next) => {
    try {
      const { countryCode = ANYWHERE.code, urls = [] } = req.body || {};
      const [crow] = await pool.query('SELECT name FROM countries WHERE code = ?', [countryCode]);
      if (!crow.length) return res.status(400).json({ error: 'unknown country' });
      const items = new Map();
      let invalid = 0;
      for (const raw of urls) {
        try {
          const n = normalizeUrl(String(raw).trim());
          if (!/^https?:/.test(n)) throw new Error('not http');
          items.set(urlHash(n), { url: n, host: new URL(n).hostname });
        } catch { invalid++; }
      }
      let added = 0;
      let requeued = 0;
      if (items.size) {
        const hashes = [...items.keys()];
        const [existing] = await pool.query('SELECT url_hash FROM urls WHERE url_hash IN (?)', [hashes]);
        const have = new Set(existing.map((x) => x.url_hash));
        const fresh = [...items].filter(([h]) => !have.has(h));
        if (fresh.length) {
          await pool.query('INSERT INTO urls (url_hash, url, host, engine, first_query) VALUES ?', [fresh.map(([h, v]) => [h, v.url, v.host.slice(0, 255), 'manual', 'manual'])]);
          added = fresh.length;
        }
        const old = hashes.filter((h) => have.has(h));
        if (old.length) {
          const [done] = await pool.query("UPDATE urls SET status = 'new', first_query = 'manual' WHERE url_hash IN (?) AND status <> 'new'", [old]);
          requeued = done.affectedRows;
        }
        const [ids] = await pool.query('SELECT id FROM urls WHERE url_hash IN (?)', [hashes]);
        await pool.query('INSERT IGNORE INTO url_countries (url_id, country_code, query_text) VALUES ?', [ids.map((i) => [i.id, countryCode, 'manual'])]);
      }
      res.json({ added, requeued, invalid });
    } catch (e) { next(e); }
  });

  return r;
}
