import { Router } from 'express';

export function exportRoutes(pool) {
  const r = Router();
  // One row per (link, country). Unchecked links have empty job fields.
  r.get('/export', async (req, res, next) => {
    try {
      const [rows] = await pool.query(
        `SELECT c.name AS country, u.url, u.kind, u.status, j.careers_url, j.openings, j.job_title, j.job_url,
                j.work_type, j.remote_scope, j.fit, j.stack
           FROM url_countries uc
           JOIN urls u ON u.id = uc.url_id
           JOIN countries c ON c.code = uc.country_code
           LEFT JOIN job_results j ON j.url_id = u.id
          GROUP BY u.id, uc.country_code
          ORDER BY c.name, u.id`
      );
      res.json({
        rows: rows.map((x) => ({
          country: x.country, url: x.url, kind: x.kind, status: x.status, careersUrl: x.careers_url || '', openings: x.openings || '',
          jobTitle: x.job_title || '', jobUrl: x.job_url || '', workType: x.work_type || '', remoteScope: x.remote_scope || '',
          fit: x.fit || '', stack: x.stack || '',
        })),
      });
    } catch (e) { next(e); }
  });
  return r;
}
