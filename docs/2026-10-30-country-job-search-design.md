# Country-wise remote job search: design

Status: draft for approval. Nothing in this document is built yet.

## Intent

The extension today finds companies on LinkedIn, then checks their sites for backend jobs. This adds a second source of leads that does not depend on LinkedIn: search the web country by country for **remote** jobs that a person living in that country can apply for, store every URL found in a local MySQL database, then visit those URLs and pick the jobs that fit the user's résumé (full-stack, ~3 years: PHP/Laravel, Node/Nest/Express, React/Next, TypeScript).

The reason for MySQL: the list will be huge (202 countries, several queries each, thousands of URLs). A Google Sheet is slow at that size and rate-limited, and cannot answer "what is still unchecked" or resume after a crash.

## What the user decided

- Search text per country is plain: `remote node js jobs in france`.
- The goal is remote jobs that hire from that country, not on-site jobs located there.
- Results can be job boards, single postings, or company sites. All are stored.
- All 202 countries are searched one by one first. Only after the whole list is collected does the job-checking pass start.
- Data goes to the user's local MySQL (already installed), not Google Sheets.
- Navigation inside sites uses regex to collect links, with DeepSeek deciding where to go next (as the current extension already does).
- The sites visited may be Vue/React single-page apps, so pages must be read after they render. The user offered console access if needed.

## Goals

1. Run 202 countries x a list of queries with human-like pacing, resumable across days and browser restarts.
2. Store every found URL once, with country, query, engine, and when it was found.
3. Visit stored URLs and extract job results with the same logic as the current "Find backend jobs", plus a check that the job is open to people in that country.
4. Export from MySQL to Excel at any time (the current Excel export stays).

## Non-goals

- Applying to jobs.
- Solving or bypassing captchas. When an engine shows one, the run stops for that engine.
- A dashboard website. (Possible later; the database makes it easy.)
- Replacing the LinkedIn flow. It keeps working unchanged.

## Anti-goals (failure even if it technically works)

- A run that gets the user's IP or Google account flagged by search engines.
- Saving jobs that are "US only" or "EU timezone only" as matches for another country.
- Losing progress when the browser or service worker restarts.

## Design

### Parts

1. **Local server** (Node + Express, `server/` folder, my call). Listens only on `127.0.0.1`. Talks to MySQL. The extension cannot open a database connection, so it sends batches over HTTP to this server. Needs a shared secret header so no web page can write to it.
2. **MySQL schema** (my call, adjustable):
   - `countries` (code, name, status, last_query_index, updated_at)
   - `queries` (country, query_text, engine, status, run_at)
   - `urls` (id, url, host, country, kind, source_query, engine, status, found_at); unique on normalized url
   - `job_results` (url_id, careers_url, openings, job_title, job_url, work_type, remote_scope, fit, stack, checked_by, checked_at)
3. **Extension: collector.** Same machinery as the website search (own unfocused window, Bing/DuckDuckGo/Google with captcha skip). For each country it runs each query, reads result links, drops obvious junk (social networks, search engines), posts the rest to the server. Progress is saved in MySQL, not only in extension storage.
4. **Extension: checker.** Takes unchecked URLs from the server. For each, classifies it as board, posting, or company site (DeepSeek, from page text and links), follows links DeepSeek picks, and reads jobs with the existing `analyzeJobsPage` logic. Pages are read after rendering: wait for the network and DOM to settle, scroll once, then read.
5. **Remote scope check.** DeepSeek is asked, for each shortlisted job, whether it is remote and whether it accepts candidates from the target country (values: `worldwide`, `region`, `country-only`, `excluded`, `unknown`). Only `worldwide`, or `region`/`country-only` that include the country, count as a match.

### Queries per country (my call)

`remote node js jobs in {country}`, plus `remote laravel php jobs in {country}`, `remote backend developer jobs in {country}`, `remote full stack developer jobs in {country}`. Four queries x 202 countries = 808 searches for the collection pass. The query list is editable.

### Pacing and limits (my call)

- Randomised 15-40 s between searches, one engine rotated at a time.
- Daily cap of 150 collector searches, so the collection pass takes about a week. Configurable.
- If an engine shows a captcha, mark it blocked for the day and use the others. If all are blocked, stop and say so.
- Checker visits capped per day and per host.

### Country list

A fixed list of 202 countries and territories (ISO 3166 names). The exact list is a builder decision; the user said 202, so the list is built to match that number, and any difference is shown to the user.

### Failure handling

- Server not running: the extension shows "Start the local server" and does nothing else.
- MySQL error: the batch is kept in extension storage and retried; nothing is dropped.
- Service worker restarts: state is read from the server on wake.

## Left to the builder

- Exact table indexes and column sizes.
- How the server is started (a `start.bat` is enough).
- URL normalization rules (strip tracking parameters, lowercase host).
- Popup layout for the new section (should match the current popup style).

## Calls I made that the user has not confirmed

1. Node/Express server with MySQL.
2. Four queries per country.
3. 150 searches per day, 15-40 s between searches.
4. Shared-secret header and localhost-only binding.
5. The country list is built from ISO 3166 to reach 202.
6. The LinkedIn flow and the current Excel export stay as they are.
