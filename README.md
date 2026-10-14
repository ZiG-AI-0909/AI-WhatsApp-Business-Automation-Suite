# AI WhatsApp Business Automation Suite

Multi-tenant WhatsApp bulk messaging + AI assistant. React 19 + Vite frontend,
Node/Express backend (Supabase, Baileys, WhatsApp Business Cloud API).

## Deployment (Render)

The backend deploys from `render.yaml` as a Node web service
(`rootDir: backend`, `startCommand: node src/server.js`).

> **⚠️ Scheduled campaigns need an always-on plan.**
> The service is configured with `plan: free` in `render.yaml`. **On the
> Free plan Render spins the service down after ~15 minutes of inactivity,
> and scheduled campaigns will NOT fire while the service is asleep** —
> the in-process scheduler (`schedulerService.startPolling`) only runs
> while the service is awake; there is no external cron. Missed schedules
> fire on the next poll after wake-up (or when traffic "wakes" the
> service), which may be much later than their `run_at`. For reliable
> scheduled sends, upgrade the Render service to a paid always-on plan
> (or run the worker on an always-on host and point the dashboard at it).

### Required environment (Render dashboard)

- `ENCRYPTION_KEY` — 64 hex chars (generate with
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
- `SUPABASE_URL`, `SUPABASE_SECRET_KEY` — service-role key
- Optional: `APP_TIMEZONE` (IANA name, default `Asia/Kolkata`) — drives
  business-hours checks and schedule estimates

### Required SQL migrations

Run the SQL files below in the Supabase SQL Editor in this order. The
application/schema migrations are idempotent where marked in their SQL.
Feature migrations that depend on the multi-tenant schema must follow steps
1–3. Run the campaign reliability migration before deploying the campaign
queue changes; the backend checks for it at startup and once per minute.

1. `supabase-migration.sql` — auth/profile foundation.
2. `supabase-data-migration.sql` — application tables.
3. `supabase-multitenant-migration.sql` — tenant ownership and isolation.
4. `supabase-whatsapp-sessions-migration.sql` — per-user WhatsApp sessions.
5. `supabase-ask-ai-migration.sql` — Ask AI history.
6. `supabase-knowledge-internal-only-migration.sql` — requires step 5.
7. `supabase-boq-migration.sql` — document/BOQ storage.
8. `supabase-product-identification-migration.sql` — product identification.
9. `supabase-email-migration.sql` — requires the data and multi-tenant migrations.
10. `supabase-analytics-dashboard-migration.sql` — analytics aggregation.
11. `supabase-unread-increment-migration.sql` — atomic unread counter RPC.
12. `supabase-schedule-estimate-migration.sql` — schedule estimate cache.
13. **`supabase-campaign-reliability-migration.sql` — required before deploying the campaign reliability changes.**

Run the startup guard's migration if it logs:
`Database migration pending: run supabase-campaign-reliability-migration.sql in the Supabase SQL Editor`.

### API smoke check

After deploying the backend, set `API_BASE_URL` to the service URL and
`TEST_JWT` to a valid Supabase access token for a test account, then run:

```powershell
$env:API_BASE_URL = "https://your-service.onrender.com"
$env:TEST_JWT = "your-test-user-access-token"
cd backend
npm run smoke:api
```

Use `npm run smoke:api -- --list-only` to print discovered mounted routes
without making API requests.

The command discovers mounted routes, performs safe GET checks, and validates
the Excel upload route using an in-memory `test.xlsx`. Mutating routes are
listed as skipped unless explicitly enabled with `npm run smoke:api -- --write`.
Use a non-production test account when enabling writes; any data created by
those requests should be cleaned up manually. Routes that can send WhatsApp
messages or stop/restart a campaign or schedule are always skipped to avoid
accidental live actions.
