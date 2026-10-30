import express from 'express';
import { collectorRoutes } from './routes/collector.js';
import { checkerRoutes } from './routes/checker.js';
import { exportRoutes } from './routes/export.js';

// pool is a mysql2/promise pool. Every route except /health needs the x-lead-key header.
export function createApp(pool, { key } = {}) {
  if (!key) throw new Error('LEAD_KEY is not set');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use((req, res, next) => (req.get('x-lead-key') === key ? next() : res.status(401).json({ error: 'bad key' })));
  app.use(collectorRoutes(pool));
  app.use(checkerRoutes(pool));
  app.use(exportRoutes(pool));
  app.get('/stats', async (req, res, next) => {
    try {
      const [[c]] = await pool.query("SELECT COUNT(*) AS n, SUM(status='done') AS done FROM countries");
      const [[u]] = await pool.query("SELECT COUNT(*) AS n, SUM(status='checked') AS checked FROM urls");
      res.json({ countriesTotal: Number(c?.n || 0), countriesDone: Number(c?.done || 0), urls: Number(u?.n || 0), checked: Number(u?.checked || 0) });
    } catch (e) { next(e); }
  });
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return app;
}
