# Country-wise Remote Job Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Search 202 countries for remote Node/PHP/backend/full-stack jobs, store every URL in local MySQL, then visit the stored URLs and save fitting remote jobs.

**Architecture:** A localhost Express server owns MySQL. The existing MV3 extension gets two new background loops (collector, checker) that reuse `searchWeb`, `run`, `openPage`, `analyzeJobsPage` and `deepseekJson`, and talk to the server over `http://127.0.0.1:3917` with a shared-secret header. Progress lives in MySQL so runs resume after a restart.

**Tech Stack:** Node 22, Express, mysql2, `node:test`; Chrome MV3 extension (existing, plain JS); DeepSeek (existing `deepseek.js`).

**Spec:** `docs/2026-10-30-country-job-search-design.md`

## Global Constraints

- Search text per country is exactly `remote node js jobs in {country}`; extra queries use the same shape: `remote laravel php jobs in {country}`, `remote backend developer jobs in {country}`, `remote full stack developer jobs in {country}`.
- 202 countries, from a fixed ISO 3166 list. If the list does not reach 202, show the difference to the user; do not pad.
- Collector: 15-40 s random wait between searches, daily cap 150 searches, an engine that shows a captcha is blocked for the day, never bypassed.
- Server binds `127.0.0.1` only and rejects requests without the `x-lead-key` header (value from `server/.env`).
- MySQL database `job_leads`; credentials only in `server/.env`, never in the extension or chat.
- Only match a job when `remote_scope` is `worldwide`, or `region`/`country-only` that includes the searched country.
- The LinkedIn flow and the current Excel export keep working unchanged.
- Pages are read after rendering (single-page apps): wait for load, wait 3 s, scroll once, then read.
- The folder is not a git repository: where a step says "checkpoint", copy the changed files to `E:\linkedin-company-copier\.checkpoints\<task>\`.

## Review Focus

- Server not running or `.env` missing: the extension says "Start the local server" and changes nothing.
- The same URL found for several countries: one `urls` row, several `url_countries` rows.
- Service worker restart mid-run: the next wake continues from the server's saved position.
- A URL that redirects to a captcha, login wall or a 404 that returns status 200: stored as `status='unreachable'`, not as a job result.
- A job that says "US only" found while searching France: not saved as a match.

---

### Task 1: Server, schema, auth

**Files:**
- Create: `server/package.json`, `server/.env.example`, `server/schema.sql`, `server/db.js`, `server/app.js`, `server/index.js`, `server/start.bat`
- Test: `server/test/app.test.js`

**Interfaces:**
- Produces: `createApp(pool) -> express.Express`; `pool` is a `mysql2/promise` pool. `GET /health -> {ok:true}`. All routes except `/health` require header `x-lead-key`; otherwise 401.
- Tables: `countries(code PK, name, status ENUM('pending','running','done'), next_query INT, updated_at)`, `urls(id PK, url_hash CHAR(40) UNIQUE, url TEXT, host, kind ENUM('board','posting','company','unknown'), status ENUM('new','checked','unreachable'), engine, first_query, found_at)`, `url_countries(url_id, country_code, query_text, PRIMARY KEY(url_id, country_code, query_text))`, `job_results(url_id PK, careers_url, openings, job_title, job_url, work_type, remote_scope, fit, stack, checked_by, checked_at)`.

- [ ] **Step 1:** Test `app.test.js`: with a stub pool, `GET /health` is 200 without a key; `GET /stats` without the key is 401 and with the key is 200.
- [ ] **Step 2:** Run `node --test server/test` and confirm it fails (module missing).
- [ ] **Step 3:** Implement `createApp(pool)` with the key middleware, `schema.sql`, and `index.js` that reads `.env` (`MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE, LEAD_KEY, PORT`) and runs `schema.sql` on start.
- [ ] **Step 4:** Run `node --test server/test` and confirm it passes; run `node server/index.js` against the real `job_leads` database and confirm `GET /health` answers.
- [ ] **Step 5:** Checkpoint.

### Task 2: Countries and queries

**Files:**
- Create: `server/countries.js` (also copied to `extension/countries.js` at build, see Task 4), `server/test/countries.test.js`

**Interfaces:**
- Produces: `COUNTRIES: {code:string, name:string}[]`; `QUERY_TEMPLATES: string[]` (4 entries, `{country}` placeholder); `buildQuery(templateIndex:number, countryName:string) -> string`.

- [ ] **Step 1:** Tests: `COUNTRIES.length` equals 202 (if it does not, the test prints the count and the build stops for the user); codes are unique; `buildQuery(0,'France') === 'remote node js jobs in France'`.
- [ ] **Step 2:** Run `node --test server/test/countries.test.js`; expect FAIL.
- [ ] **Step 3:** Implement the module. Use the 193 UN members, plus the Holy See, Palestine, Kosovo, Taiwan, Hong Kong, Macau, Puerto Rico, Greenland and Bermuda, adjusted by the builder to reach 202 and reported to the user.
- [ ] **Step 4:** Run the tests; expect PASS.
- [ ] **Step 5:** Checkpoint.

### Task 3: Collector API

**Files:**
- Create: `server/routes/collector.js`; Modify: `server/app.js`
- Test: `server/test/collector.test.js` (uses a test database named by `MYSQL_TEST_DATABASE`)

**Interfaces:**
- Produces: `GET /collector/next -> {country:{code,name}, templateIndex:number, query:string} | {done:true}` (first country whose status is not `done`, resuming at its `next_query`); `POST /collector/results` body `{countryCode, templateIndex, engine, urls:string[]}` -> `{added:number, duplicates:number}` and advances `next_query` (marks the country `done` after the last template); `GET /stats -> {countriesDone, countriesTotal, urls, checked}`.
- URLs are normalized by `normalizeUrl(u) -> string` (lowercase host, drop `utm_*`, `gclid`, fragments, trailing slash); `url_hash` is the SHA-1 of the result.

- [ ] **Step 1:** Tests: posting the same URL twice for two countries gives one `urls` row and two `url_countries` rows; `normalizeUrl('https://A.com/x/?utm_source=a#b') === 'https://a.com/x'`; after posting template 3 for a country, `next` returns the next country.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement the routes and `normalizeUrl` in `server/normalize.js`; seed `countries` from `COUNTRIES` on startup when the table is empty.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Checkpoint.

### Task 4: Extension collector loop

**Files:**
- Create: `serverClient.js`, `collector.js`; Modify: `manifest.json` (host permission `http://127.0.0.1:3917/*`), `background.js` (`importScripts`, message handlers `startCollector`, `stopCollector`)
- Test: `server/test/e2e-collector.test.js` (puppeteer harness in the scratchpad pattern already used for this extension)

**Interfaces:**
- Consumes: `searchWeb(tabId, text, tried) -> {blocked, links, items, engine}` from `background.js`; `Task 3` routes.
- Produces: `serverFetch(path, opts) -> Promise<json>` (adds `x-lead-key` from `chrome.storage.local.leadKey`, throws `ServerDown` on connection failure); `collectLoop() -> Promise<void>`; storage key `collector = {running, message, blockedEngines:{[engine]:date}, dailyCount:{date,count}}`.

- [ ] **Step 1:** E2E test: with the server running against the test database and a stubbed `searchWeb` returning two fixed links, `collectLoop` posts them, `GET /stats` shows 2 urls, and stopping mid-run leaves the position saved.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement `collectLoop`: ask `/collector/next`, search, filter junk hosts (reuse `NOT_A_COMPANY_SITE` plus search engines), post, wait 15-40 s with the existing `pause`. Stop with a message on `ServerDown`, on the 150 daily cap, or when all engines are blocked.
- [ ] **Step 4:** Run; expect PASS. Then run one real country search in the test profile and confirm real URLs arrive in MySQL.
- [ ] **Step 5:** Checkpoint.

### Task 5: Popup section

**Files:**
- Modify: `popup.html`, `popup.css`, `popup.js`

**Interfaces:**
- Consumes: messages `startCollector`, `stopCollector`; storage `collector`; `serverFetch('/stats')`.

- [ ] **Step 1:** Add a "Country job search" block: server status line ("Server connected" / "Start the local server"), a field to save the shared key, **Start country search / Stop**, progress (`countriesDone of countriesTotal`, `urls`), and the last message. Progress shows inside the block, not only in the top status line.
- [ ] **Step 2:** Verify with the puppeteer harness: the block shows "Start the local server" with the server off and live counts with it on; the button is disabled during any other run.
- [ ] **Step 3:** Checkpoint.

### Task 6: Checker API and loop

**Files:**
- Create: `server/routes/checker.js`, `checker.js`; Modify: `server/app.js`, `background.js`, `popup.*`
- Test: `server/test/checker.test.js`

**Interfaces:**
- Produces: `GET /checker/next -> {id, url, countries:string[]} | {done:true}` (oldest `status='new'`); `POST /checker/result` body `{id, status:'checked'|'unreachable', kind, result?:{careersUrl, openings, jobTitle, jobUrl, workType, remoteScope, fit, stack, checkedBy}}`; extension `checkLoop() -> Promise<void>`; `remoteMatches(remoteScope, workType, countryName, countries:string[]) -> boolean` in `shared.js`.
- Consumes: `openPage`, `analyzeJobsPage`, `findCareerLinks`, `deepseekJson`, `getProfile` (existing).

- [ ] **Step 1:** Tests: `remoteMatches('worldwide','remote',...)` is true; `('country-only: US', 'remote', 'France', ['France'])` is false; `('region: Europe', 'remote', 'France', ['France'])` is true; server: `/checker/next` returns the oldest new url and a posted result flips it to `checked`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. The loop classifies the URL (DeepSeek, from page text and link list: board / posting / company), follows links DeepSeek picks (max depth 2), reads jobs with `analyzeJobsPage`, asks DeepSeek for `workType` and `remoteScope` per shortlisted job, and posts the best match that passes `remoteMatches`. Redirects to login or captcha pages, and soft-404 pages, are posted as `unreachable`.
- [ ] **Step 4:** Run; expect PASS. Then check 5 stored URLs for real in the test profile.
- [ ] **Step 5:** Checkpoint.

### Task 7: Export

**Files:**
- Create: `server/routes/export.js`; Modify: `popup.js`

**Interfaces:**
- Produces: `GET /export -> {rows: {country, url, kind, careersUrl, jobTitle, jobUrl, workType, remoteScope, fit, stack}[]}`; popup button **Export leads to Excel** reuses `buildXlsx` from `xlsx.js`.

- [ ] **Step 1:** Test: after Tasks 3 and 6 fixtures, `/export` returns one row per (url, country) with the job fields filled for matches.
- [ ] **Step 2:** Run; expect FAIL, then implement, then expect PASS.
- [ ] **Step 3:** Download the file from the popup in the test profile and open it with openpyxl to confirm headers and row count.
- [ ] **Step 4:** Checkpoint.

---

## Self-review notes

- Spec coverage: collection pass (Tasks 3-5), MySQL (1, 3, 6), checker with regex links + DeepSeek navigation and SPA waits (6), remote scope (6), export (7), pacing and captcha rules (4), failure handling (1, 4, 5, 6).
- Not planned on purpose: a dashboard website and applying to jobs (non-goals).
