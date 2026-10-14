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
13. **`supabase-campaign-reliability-migration.sql` — required before deploying the campaign reliability, queue, and duplicate-draft changes; includes campaign media metadata, queue columns/index, source campaign id, recipient-row data, and atomic per-user queue RPCs.**
14. **`supabase-quotation-migration.sql` — required before deploying BOQ-to-Quotation; run after `supabase-boq-migration.sql`. Adds per-user price lists, quotations, line items, audit history, and sequential numbering RPCs.**

Run the startup guard's migration if it logs:
`Database migration pending: run supabase-campaign-reliability-migration.sql in the Supabase SQL Editor`.

Campaign attachments use the `campaign-media` Supabase Storage bucket. At
startup, the backend creates it as private if it is missing and logs its
visibility. The service-role backend downloads attachments before a campaign
starts; images are limited to 5 MB (JPEG, PNG, WEBP) and PDF documents to 16 MB.
After applying updated campaign reliability SQL, use **Send test to my number**
to verify an attachment before starting a large campaign.
If this migration was already run, rerun the updated idempotent SQL file to add
`queue_position`, `queued_at`, `source_campaign_id`, `campaign_contacts.contact_data`,
and the queue RPC functions before deploying campaign queueing and duplicate
drafts.

### Campaign queue and draft copies

Use **Add to queue** to persist per-user campaign order; eligible completed
campaigns hand off to the next item automatically. Queue ordering and running
claims are serialized by migration RPCs. The Campaigns view also lets you
duplicate a finished campaign into an editable draft, including its attachment
reference; the shared media object is retained until no campaign references it.
Apply the migration before using these controls.

### BOQ to Quotation

After confirming a BOQ, open **BOQ to Quotation** in Document Intelligence.
Import your catalogue from Excel/CSV (or download its template), review the
suggested matches, and manually price every unmatched line before finalizing.
Quotation totals and GST are calculated by the backend; the company address,
state, GSTIN, phone, email, logo data URL, and bank details are read from
Settings. PDF and Excel exports are available, and a finalized draft can be
sent as a single WhatsApp document after confirming the customer number.
Run `supabase-quotation-migration.sql` after `supabase-boq-migration.sql`
before deploying this feature. No new Render environment variables are needed.

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
