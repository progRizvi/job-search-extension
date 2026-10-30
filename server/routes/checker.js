import { Router } from 'express';

const KINDS = ['board', 'posting', 'company', 'unknown'];
const cut = (v, n) => (v == null ? null : String(v).slice(0, n));

export function checkerRoutes(pool) {
  const r = Router();

  // The oldest url that has not been checked, with the countries whose searches found it.
  r.get('/checker/next', async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT id, url FROM urls WHERE status = 'new' ORDER BY id LIMIT 1");
      if (!rows.length) return res.json({ done: true });
      const [cs] = await pool.query(
        'SELECT DISTINCT c.name FROM url_countries uc JOIN countries c ON c.code = uc.country_code WHERE uc.url_id = ? ORDER BY c.name',
        [rows[0].id]
      );
      res.json({ id: rows[0].id, url: rows[0].url, countries: cs.map((c) => c.name) });
    } catch (e) { next(e); }
  });

  r.post('/checker/result', async (req, res, next) => {
    try {
      const { id, status, kind, result } = req.body || {};
      if (!Number.isInteger(id) || !['checked', 'unreachable'].includes(status)) {
        return res.status(400).json({ error: 'bad id or status' });
      }
      await pool.query('UPDATE urls SET status = ?, kind = ? WHERE id = ?', [status, KINDS.includes(kind) ? kind : 'unknown', id]);
      if (result) {
        await pool.query(
          `REPLACE INTO job_results (url_id, careers_url, openings, job_title, job_url, work_type, remote_scope, fit, stack, checked_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, result.careersUrl || null, cut(result.openings, 10), cut(result.jobTitle, 200), result.jobUrl || null,
            cut(result.workType, 10), cut(result.remoteScope, 120), cut(result.fit, 10), cut(result.stack, 200), cut(result.checkedBy, 20)]
        );
      }
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return r;
}
