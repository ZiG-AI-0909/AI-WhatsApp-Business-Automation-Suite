# Project Report — AI WhatsApp Business Automation Suite

_Last updated: October 12, 2026 (post code-review fixes)_

---

## 1. Project Overview

Multi-tenant WhatsApp bulk-messaging platform:

- **Frontend:** React 19 + Vite (`frontend/`), Tailwind CSS 4, socket.io-client, Supabase JS
- **Backend:** Node.js + Express (`backend/src/server.js`) with Baileys (WhatsApp Web sessions),
  WhatsApp Business Cloud API, Supabase (PostgREST) datastore
- **Key modules:** `campaigns/` (excelParser, campaignService, messageQueue, rateLimiter,
  schedulerService, fieldRenderer), `whatsapp/` (sessionManager, businessApiProvider,
  authStateStore), plus contacts, documents (BOQ), ai, knowledge, security, copilot
- **Testing:** 27 registered backend smoke-test files (125 passing assertions), oxlint both
  halves, `lint:undef` (ESLint no-undef), Vite production build

---

## 2. Scheduled Campaigns Run Without the Browser — Confirmed

**YES.** `schedulerService.startPolling()` polls every 30s inside the backend process;
fires via `campaignService.start()` → `messageQueue` in-process; auto-revives a dropped
WhatsApp session from stored Supabase auth state; records a visible wait reason when
revival fails. Only the backend server must be running.

⚠️ On **Render Free plan the service can sleep** — scheduled campaigns will NOT fire
while it is asleep. See the Deployment warning in the new root `README.md`.

---

## 3. Time Calculator for Scheduled Campaigns

- `schedulerService.estimateRun(id, userId)` → `{ contacts, durationMs, durationLabel,
  startAt, endAt, computedAt }`, modeled on the real send loop
- Durations are **cached** (Task 3): `estimate_json` / `estimate_computed_at` /
  `estimate_source_hash` columns (migration `supabase-schedule-estimate-migration.sql`);
  reuse while file + settings unchanged; recompute otherwise; anchors re-derived per read
- **API:** `GET /api/schedules/:id/estimate`, batched `GET /api/schedules/estimates`,
  and estimates embedded in `GET /api/schedules` (single request replaces N parallel)
- Frontend: "Est. one campaign run" column (~duration, contacts, ends approx. …)

---

## 4. Code-Review Fixes (Tasks 1–7) — all verified

| # | Task | Status | Files / functions |
|---|---|---|---|
| 1.1 | Business hours in explicit IANA timezone (`settings.timezone` → `APP_TIMEZONE` → `Asia/Kolkata`), via `Intl.DateTimeFormat`, shared helper `zonedParts`/`zonedWithinBusinessHours` | **DONE** | `backend/src/campaigns/rateLimiter.js` (isWithinBusinessHours, msUntilBusinessHours) |
| 1.2 | estimateRun uses the SAME timezone logic (shared helper, no duplication) | **DONE** | `schedulerService._computeDurationMs` imports from rateLimiter |
| 1.3 | `APP_TIMEZONE` documented | **DONE** | `backend/.env.example` |
| 1.4 | Tests: 10:00 IST inside 09:30–18:30 at TZ=UTC; 20:00 IST outside; IST-Sunday excluded (weekday diverges from UTC); msUntil correct across midnight (13.5h = 48 600 000ms), incl. Sunday | **DONE, fails on old code** | `schedule-estimate-smoke.test.js` T1 |
| 2.1 | Estimator jitter: `wait()` jitters uniformly over [0.7, 1.4]; expected value (0.7+1.4)/2 = **1.05** exported as `JITTER_EXPECTED`; estimator uses it (no hardcoded 0.85) | **DONE** | rateLimiter.js export + `schedulerService._computeDurationMs` |
| 2.2 | Test: 100 contacts × 10 000ms delay × 1.05 → 1 050 000ms ±1% (old 0.85 would give 850 000 — fails) | **DONE, fails on old code** | T2 |
| 3.1 | Idempotent migration adding `estimate_json jsonb`, `estimate_computed_at timestamptz`, `estimate_source_hash text` | **DONE (run in Supabase!)** | `supabase-schedule-estimate-migration.sql` |
| 3.2 | estimateRun reuses stored estimate while file(+size/mtime)/settings hash unchanged; only startAt/endAt recomputed | **DONE** | `_estimateSourceHash`, `estimateRun`, `_computeAndStoreEstimate` |
| 3.3 | Estimate computed at create (and refreshable) — fire-and-forget, error-logged, never blocks | **DONE** | `schedulerService.create` → `refreshEstimate` |
| 3.4 | Frontend stopped firing N parallel per-schedule requests: estimates embedded in `GET /api/schedules` + batched `GET /api/schedules/estimates`; `GET /:id/estimate` still works, registered before `/:id` | **DONE** | `list`, `estimates`, `routes/schedules.js`, `App.jsx loadSchedules` |
| 3.5 | Tests: second call does not re-parse (spy: countCalls stays 1); settings change invalidates (recompute exactly once); user B gets null for user A (tenant scope) | **DONE, fails on old code** | T3 |
| 4.1 | `resumeInterrupted` returns `{ok:false}` on DB failure; `server.js` retries with backoff 5s → ×2 → cap 60s, stop on success; HTTP + scheduler boot normally during retry; every attempt logged | **DONE** | `messageQueue.resumeInterrupted`, `server.js startResumeRetries` |
| 4.2 | Idempotent: second call while a worker is loaded returns `{ok:true, alreadyRunning:true}` and never starts a second `_process()` | **DONE** | same |
| 4.3 | Tests: outage → ok:false then success once DB "recovers"; empty table ok:true; repeated calls no duplicate worker; backoff schedule 5/10/20/40/60-capped asserted | **DONE, fails on old code** | `resume-retry-smoke.test.js` T1–T4 |
| 5.1 | Owner-queue-busy (`"A campaign is already running"`): schedule stays **pending**, `last_error='Waiting for the running campaign to finish'`, retried each poll; 24h past `next_run_at` → `status='skipped'` with clear reason | **DONE** | `schedulerService._fireDueSchedules` |
| 5.2 | No duplicate campaigns: created-but-unstarted campaign parked on `pending_campaign_id` and **reused** next attempt (chosen over delete-and-recreate because re-parsing Excel every poll is expensive and reuse also preserves the already-validated contact queue); reference cleared on fire/skip/pause/retry | **DONE** | same |
| 5.3 | Tests: 3 busy polls → 1 campaign total, still pending; fires exactly once after owner frees; 24h cap → skipped | **DONE, fails on old code** | `busy-owner-schedule-smoke.test.js` T1–T3 |
| 6.1 | `lint:undef` script (ESLint + globals devDeps; oxlint untouched); findings fixed: `setActiveView` undefined in ContactsView/AnalyticsView (real runtime crash — components now take `onNavigate` and App passes `setActiveView`); `API`/`authHeaders` unimported in ImageExtractorView (real crash on export); stale `react-hooks/exhaustive-deps` disable comment removed | **DONE** | `frontend/package.json`, `eslint.undef.config.js`, `App.jsx`, `ImageExtractorView.jsx` |
| 7.1 | Test-script audit: found **27** `*.test.js` under `backend/src`; **22** were registered; added the **5** missing (3 new from this review + pre-existing `analytics-dashboard-smoke` and `conversations-list-smoke`). Final: **27 files, 125 assertions, exit 0** | **DONE** | `backend/package.json` |
| 7.2 | Hosting report: `render.yaml` → Render **Free plan** web service; **it can sleep** → scheduled campaigns **will not fire while asleep**; warning added to the **Deployment** section of the new root `README.md` (no README existed before) | **DONE (report + README)** | `render.yaml` (no change), `README.md` (new) |

**New tests failing on old code — confirmation method:** git stash/restore of the old file
(`git checkout -- <file>` + `git diff` patch re-apply); each suite exited 1 on the old code
and 0 after restore. Restorations verified with `node --check` and a green rerun.

**Extra bug found & fixed during the work:** `_parseSchedule` in
`backend/src/campaigns/schedulerService.js` was not idempotent — double-parsing an
already-parsed jsonb object (`JSON.parse(object)`) turned `settings`/`buttons` into `{}`
(poisoning the estimate cache and hash). Now parses strings, keeps objects.

---

## 5. Final Verification (all run)

| Check | Result |
|---|---|
| `backend npm test` | ✅ exit 0 — 27 files, 125 assertions |
| `frontend npm run build` | ✅ exit 0 |
| `frontend npm run lint` (oxlint) | ✅ 0 errors (33 pre-existing warnings) |
| `frontend npm run lint:undef` | ✅ exit 0 — 0 problems |
| `git diff --check` (whitespace/conflict markers) | ✅ clean |
| Server boot w/o DB | ✅ listens on :3000; resume retries 5s/10s…; scheduler polls retry |

## 6. Changed Files

**Backend:** `src/campaigns/rateLimiter.js`, `src/campaigns/schedulerService.js`,
`src/campaigns/messageQueue.js`, `src/routes/schedules.js`, `src/server.js`,
`package.json`, `.env.example`

**New backend tests:** `src/campaigns/__tests__/schedule-estimate-smoke.test.js`,
`src/campaigns/__tests__/resume-retry-smoke.test.js`,
`src/campaigns/__tests__/busy-owner-schedule-smoke.test.js`

**Frontend:** `src/App.jsx`, `src/ImageExtractorView.jsx`, `package.json`,
`eslint.undef.config.js` (new)

**Root:** `supabase-schedule-estimate-migration.sql` (new), `README.md` (new),
`reports.md`, `render.yaml` **unchanged** (report only)

## 7. Manual Steps & Notes

1. **Run `supabase-schedule-estimate-migration.sql` in Supabase** — estimates fall back
   to compute-per-read (and console errors) until the 3 columns exist.
2. Set `APP_TIMEZONE` if your business hours are not IST (default `Asia/Kolkata`).
3. ESLint devDeps added to `frontend/package.json` (`eslint`, `globals`) — `npm install`.
4. **Render Free plan**: scheduled sends stop during spin-down; upgrade for reliability.
5. Lint warnings (~137, unchanged) remain pre-existing test-mock noise.
6. `estimateRun` accuracy on real Supabase data was validated through mocked-DB smoke
   tests, not a live instance — no credentials in this environment.
