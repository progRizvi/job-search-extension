import { createHash } from 'node:crypto';

const TRACKING = /^(utm_|gclid$|fbclid$|mc_|ref$|ref_src$)/i;

// Lowercase host, no tracking parameters, no fragment, no trailing slash.
export function normalizeUrl(raw) {
  const u = new URL(raw);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  return u.toString().replace(/\/(\?|$)/, '$1'); // drop a trailing slash before the query or at the end
}

export const urlHash = (normalized) => createHash('sha1').update(normalized).digest('hex');
