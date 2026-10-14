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

### Database migrations

Run the `supabase-*.sql` migrations in Supabase before first deploy. The
campaign reliability migration (`supabase-campaign-reliability-migration.sql`)
adds pause/error tracking and the atomic counter recount function. The
schedule-estimate cache requires `supabase-schedule-estimate-migration.sql`.
These migrations are idempotent and safe to re-run.

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
