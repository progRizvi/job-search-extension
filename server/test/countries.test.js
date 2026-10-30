import test from 'node:test';
import assert from 'node:assert/strict';
import { COUNTRIES, QUERY_TEMPLATES, buildQuery } from '../countries.js';

test('202 countries with unique codes', () => {
  assert.equal(COUNTRIES.length, 202, `got ${COUNTRIES.length}`);
  assert.equal(new Set(COUNTRIES.map((c) => c.code)).size, COUNTRIES.length);
});

test('four query templates and the exact first query', () => {
  assert.equal(QUERY_TEMPLATES.length, 4);
  assert.equal(buildQuery(0, 'France'), 'remote node js jobs in France');
});
