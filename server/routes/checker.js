import { Router } from 'express';
import { createHash } from 'node:crypto';

const KINDS = ['board', 'posting', 'company', 'unknown'];
const cut = (v, n) => (v == null ? null : String(v).slice(0, n));

export function checkerRoutes(pool) {
  const r = Router();

  // The oldest url that has not been checked, with the countries whose searches found it.
  r.get('/checker/next', async (req, res, next) => {
    try {
      const [rows] = await pool.query("SELECT id, url FROM urls WHERE status = 'new' ORDER BY (first_query = 'manual') DESC, id LIMIT 1");
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
      const { id, status, kind, result, results } = req.body || {};
      if (!Number.isInteger(id) || !['checked', 'unreachable'].includes(status)) {
        return res.status(400).json({ error: 'bad id or status' });
      }
      await pool.query('UPDATE urls SET status = ?, kind = ? WHERE id = ?', [status, KINDS.includes(kind) ? kind : 'unknown', id]);
      // A list page can have several matching jobs; a re-check replaces the earlier ones.
      const list = Array.isArray(results) ? results : result ? [result] : [];
      if (list.length) await pool.query('DELETE FROM job_results WHERE url_id = ?', [id]);
      for (const x of list) {
        await pool.query(
          `REPLACE INTO job_results (url_id, job_hash, careers_url, openings, job_title, job_url, work_type, remote_scope, fit, stack, checked_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, x.jobUrl ? createHash('sha1').update(String(x.jobUrl)).digest('hex') : '', x.careersUrl || null, cut(x.openings, 10), cut(x.jobTitle, 200), x.jobUrl || null,
            cut(x.workType, 10), cut(x.remoteScope, 120), cut(x.fit, 10), cut(x.stack, 200), cut(x.checkedBy, 20)]
        );
      }
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Puts links back in the queue: only the ones that could not be read, or every checked link.
  r.post('/checker/requeue', async (req, res, next) => {
    try {
      const which = (req.body || {}).which;
      const [out] = await pool.query(
        which === 'unreachable' ? "UPDATE urls SET status = 'new' WHERE status = 'unreachable'" : "UPDATE urls SET status = 'new' WHERE status <> 'new'"
      );
      res.json({ requeued: out.affectedRows });
    } catch (e) { next(e); }
  });

  return r;
}
