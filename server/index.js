import { createApp } from './app.js';
import { makePool, migrate } from './db.js';

const pool = makePool();
await migrate(pool);
createApp(pool, { key: process.env.LEAD_KEY }).listen(Number(process.env.PORT || 3917), '127.0.0.1', () =>
  console.log(`Job leads server on http://127.0.0.1:${process.env.PORT || 3917}`));
