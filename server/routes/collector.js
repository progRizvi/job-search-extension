import { Router } from 'express';
import { COUNTRIES, QUERY_TEMPLATES, buildQuery } from '../countries.js';
import { normalizeUrl, urlHash } from '../normalize.js';

export async function seedCountries(pool) {
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM countries');
  if (n > 0) return;
  await pool.query('INSERT INTO countries (code, name) VALUES ?', [COUNTRIES.map((c) => [c.code, c.name])]);
}

export function collectorRoutes(pool) {
  const r = Router();

  r.get('/collector/next', async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT code, name, next_query FROM countries WHERE status <> 'done' ORDER BY name LIMIT 1");
      if (!rows.length) return res.json({ done: true });
      const c = rows[0];
      res.json({ country: { code: c.code, name: c.name }, templateIndex: c.next_query, query: buildQuery(c.next_query, c.name) });
    } catch (e) { next(e); }
  });

  r.post('/collector/results', async (req, res, next) => {
    try {
      const { countryCode, templateIndex, engine, urls = [] } = req.body || {};
      const [crow] = await pool.query('SELECT name FROM countries WHERE code = ?', [countryCode]);
      if (!crow.length || !Number.isInteger(templateIndex) || !QUERY_TEMPLATES[templateIndex]) {
        return res.status(400).json({ error: 'bad countryCode or templateIndex' });
      }
      const query = buildQuery(templateIndex, crow[0].name);
      const items = new Map();
      for (const raw of urls) {
        try {
          const n = normalizeUrl(raw);
          if (/^https?:/.test(n)) items.set(urlHash(n), { url: n, host: new URL(n).hostname });
        } catch { /* skip malformed */ }
      }
      let added = 0;
      if (items.size) {
        const rows = [...items].map(([h, v]) => [h, v.url, v.host.slice(0, 255), engine || null, query]);
        const [ins] = await pool.query('INSERT IGNORE INTO urls (url_hash, url, host, engine, first_query) VALUES ?', [rows]);
        added = ins.affectedRows;
        const [ids] = await pool.query('SELECT id FROM urls WHERE url_hash IN (?)', [[...items.keys()]]);
        await pool.query('INSERT IGNORE INTO url_countries (url_id, country_code, query_text) VALUES ?', [ids.map((i) => [i.id, countryCode, query])]);
      }
      // Advance only forward, so a repeated post cannot move the position back.
      await pool.query(
        "UPDATE countries SET next_query = GREATEST(next_query, ?), status = IF(GREATEST(next_query, ?) >= ?, 'done', 'running') WHERE code = ?",
        [templateIndex + 1, templateIndex + 1, QUERY_TEMPLATES.length, countryCode]
      );
      res.json({ added, duplicates: items.size - added });
    } catch (e) { next(e); }
  });

  return r;
}
