import { Router } from 'express';
import { normalizeUrl, urlHash } from '../normalize.js';

// Manual links use this pseudo-country when no country is chosen. It is never handed out by the search
// (its status is always 'done') and is left out of the country totals.
export const ANYWHERE = { code: 'ZZ', name: 'Anywhere' };

export async function ensureAnywhere(pool) {
  await pool.query("INSERT IGNORE INTO countries (code, name, status) VALUES (?, ?, 'done')", [ANYWHERE.code, ANYWHERE.name]);
}

export function linksRoutes(pool) {
  const r = Router();

  r.get('/countries', async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT code, name FROM countries WHERE code <> ? ORDER BY name", [ANYWHERE.code]);
      res.json({ countries: [ANYWHERE, ...rows] });
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
