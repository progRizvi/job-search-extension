import { Router } from 'express';
import { createHash } from 'node:crypto';

// A link being checked is claimed, so a second browser (or a second copy of the extension) never takes it too.
// The owner renews the claim with a heartbeat; a claim not renewed for this long is treated as abandoned.
const CLAIM_MINUTES = 10;
const KINDS = ['board', 'posting', 'company', 'unknown'];
const cut = (v, n) => (v == null ? null : String(v).slice(0, n));

export function checkerRoutes(pool) {
  const r = Router();

  // The oldest url that has not been checked, with the countries whose searches found it.
  const shapeItem = async (row) => {
    const [cs] = await pool.query(
      'SELECT DISTINCT c.name FROM url_countries uc JOIN countries c ON c.code = uc.country_code WHERE uc.url_id = ? ORDER BY c.name',
      [row.id]
    );
    return { id: row.id, url: row.url, countries: cs.map((c) => c.name) };
  };

  // The oldest link still to check. Without ?peek=1 it is claimed for the caller.
  r.get('/checker/next', async (req, res, next) => {
    try {
      const free = "status = 'new' AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL ? MINUTE)";
      for (let attempt = 0; attempt < 5; attempt++) {
        const [rows] = await pool.query(`SELECT id, url FROM urls WHERE ${free} ORDER BY (first_query = 'manual') DESC, id LIMIT 1`, [CLAIM_MINUTES]);
        if (!rows.length) return res.json({ done: true });
        if (req.query.peek) return res.json(await shapeItem(rows[0]));
        // Claim it only if nobody else got there first; otherwise look again.
        const [got] = await pool.query(`UPDATE urls SET claimed_at = NOW() WHERE id = ? AND ${free}`, [rows[0].id, CLAIM_MINUTES]);
        if (got.affectedRows === 1) return res.json(await shapeItem(rows[0]));
      }
      res.json({ done: true });
    } catch (e) { next(e); }
  });

  r.post('/checker/heartbeat', async (req, res, next) => {
    try {
      await pool.query('UPDATE urls SET claimed_at = NOW() WHERE id = ?', [Number((req.body || {}).id) || 0]);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.post('/checker/release', async (req, res, next) => {
    try {
      await pool.query('UPDATE urls SET claimed_at = NULL WHERE id = ?', [Number((req.body || {}).id) || 0]);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // One chosen link, whatever its status: for the "Check now" button.
  r.get('/checker/item', async (req, res, next) => {
    try {
      const id = Number(req.query.id) || 0;
      const [rows] = await pool.query('SELECT id, url FROM urls WHERE id = ?', [id]);
      if (rows.length) await pool.query('UPDATE urls SET claimed_at = NOW() WHERE id = ?', [id]); // the user asked for this one
      res.json(rows.length ? await shapeItem(rows[0]) : { done: true });
    } catch (e) { next(e); }
  });

  r.post('/checker/result', async (req, res, next) => {
    try {
      const { id, status, kind, result, results, url } = req.body || {};
      if (!Number.isInteger(id) || !['checked', 'unreachable'].includes(status)) {
        return res.status(400).json({ error: 'bad id or status' });
      }
      // The link may have been removed or edited while it was being visited: then this result is stale.
      const [cur] = await pool.query('SELECT url FROM urls WHERE id = ?', [id]);
      if (!cur.length || (url && cur[0].url !== url)) return res.json({ ok: true, ignored: true });
      await pool.query('UPDATE urls SET status = ?, kind = ?, claimed_at = NULL WHERE id = ?', [status, KINDS.includes(kind) ? kind : 'unknown', id]);
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
      const { which, ids } = req.body || {};
      if (Array.isArray(ids) && ids.length) {
        const [one] = await pool.query("UPDATE urls SET status = 'new', claimed_at = NULL WHERE id IN (?) AND status <> 'new'", [ids]);
        return res.json({ requeued: one.affectedRows });
      }
      const [out] = await pool.query(
        which === 'unreachable' ? "UPDATE urls SET status = 'new', claimed_at = NULL WHERE status = 'unreachable'" : "UPDATE urls SET status = 'new', claimed_at = NULL WHERE status <> 'new'"
      );
      res.json({ requeued: out.affectedRows });
    } catch (e) { next(e); }
  });

  return r;
}
