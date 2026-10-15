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
14. **`supabase-quotation-migration.sql` — required before deploying BOQ to Quotation; run after `supabase-boq-migration.sql` (it needs `boq_documents` and `set_updated_at()`). Adds `quotations`, `quotation_items`, the per-user per-financial-year `quotation_counters` table and the `finalize_quotation` RPC that assigns `SP/2026-27/0001` atomically. Idempotent; if the earlier price-list version of this file was already run, rerun this one to upgrade those tables in place (no data is dropped).**

15. `supabase-shared-access-migration.sql` — shared workspaces. Exposes `private.user_data_shares` to the backend through `resolve_data_owner` and `list_data_owners` (service role only). Idempotent; changes no data. Until it is run, every user keeps working in their own data only.

16. `supabase-campaign-delivery-migration.sql` — campaign delivery tracking, consent records and rate-limit cooldowns (run after step 13). Optional: without it campaigns still send, but delivered/read counts, opt-out dates/sources and the enforced wait after a WhatsApp rate limit are not stored; the backend logs `Database migration pending: run supabase-campaign-delivery-migration.sql …` until it is applied.

Run the startup guard's migration if it logs:
`Database migration pending: run supabase-campaign-reliability-migration.sql in the Supabase SQL Editor`
(or the same message naming `supabase-quotation-migration.sql`).

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

### Campaign sending safety

Campaigns go to opted-in contacts only, one message at a time, from a queue
stored in `campaign_contacts`. Nothing here hides automation from WhatsApp or
gets around a block; the goal is to send at a reasonable pace, stop as soon as
WhatsApp signals a problem, and never message the same person twice. No
setting can guarantee that WhatsApp will not restrict a number.

**Providers** (`backend/src/whatsapp/providerRegistry.js`):

- *WhatsApp Business Platform (Cloud API)*: the official route and the one to
  use for campaigns. Supports approved templates, delivery webhooks, quality
  rating and messaging-limit tiers.
- *WhatsApp Web (Baileys)*: an unofficial linked device. Kept for existing
  users, but WhatsApp can restrict or ban numbers that bulk-send through it,
  and it reports no quality or rate-limit signals. The campaign builder says
  so whenever the Business API is not connected.

**Pacing**: the configured delay between messages (varied between 0.7× and
1.4× so messages do not leave in a fixed rhythm), hourly
and daily caps (on the Business API also the number's WhatsApp tier, e.g.
1,000 recipients/day), your business hours, and the business hours in each
recipient's country (from the phone's country code; recipients whose hours
never overlap with yours are skipped with a reason). Optionally pause for N
minutes after every M messages. The dashboard shows why a running campaign is
waiting (limit, hours, pause, retries).

**Failures** (`backend/src/campaigns/sendPolicy.js`):

| WhatsApp says | What happens |
|---|---|
| Rate limit (429, 130429, 80007) | Campaign pauses; Resume is refused until `Retry-After`, at least 15 minutes |
| Spam/policy restriction (131048, 368, 131031), quality flag or downgrade | Campaign pauses (`account_restricted` / `quality_low`) |
| Auth, account or template problems (190, 131042, 131047, 132xxx) | Campaign pauses with the fix to make |
| Temporary error (5xx, 131000, 131016) | Recipient retried with exponential backoff: `retryDelay × 2^n`, max 1 hour, never sooner than `Retry-After` |
| Connection lost | Campaign pauses and resumes when WhatsApp reconnects |
| Pair rate limit (131056) | That recipient retried after at least 60 s |
| Permanent error (invalid number, 131026, 131049, …) | Recipient failed, never retried |
| Marketing opt-out (131050) | Contact recorded as opted out |

The campaign also pauses when 50% of the last 20 messages failed, or 40% were
numbers not on WhatsApp (thresholds configurable), and after 5 identical errors
in a row.

**No duplicates**: each recipient is claimed with a conditional update
(`pending → processing`) before sending, so a second worker or server instance
cannot send it too. WhatsApp Web messages get their message id before sending
and keep it across retries. Business API messages carry
`biz_opaque_callback_data = cc:<recipient id>`. A recipient left in
`processing` by a crash or restart is not resent: it is marked failed ("Sending
was interrupted …") and becomes sent automatically if a delivery receipt for
it arrives. Resuming a paused campaign continues with the pending recipients
only.

**Consent**: STOP-style replies opt a contact out (with date and source);
a bare START or SUBSCRIBE reply opts them back in. Turning marketing back on
by hand for someone who asked to stop needs an explicit confirmation
(`409 OPTED_OUT` otherwise). Re-adding an existing contact with the opt-in
box unchecked no longer opts them out.

**Delivery receipts**: in the Meta app's webhook settings subscribe to the
`messages` field (message statuses) and `phone_number_quality_update`. Sent →
delivered → read is shown per recipient and per campaign; a message WhatsApp
later reports as failed is counted as failed. WhatsApp Web receipts come from
the linked device's acks.

**Typing indicator**: WhatsApp supports one only when replying to a received
message, never for campaign messages. Set `WABA_TYPING_INDICATOR=true` to show
it while the AI drafts a reply on the Business API (this also marks the
customer's message as read). Off by default.

**Logs**: campaign events are JSON lines such as
`{"scope":"campaign","event":"send_failed","campaign":17,"phone":"***4567",…}`;
phone numbers are masked and message text and tokens are never logged.

### BOQ extraction checks

Extracted BOQ rows pass through `backend/src/documents/boqRowRepair.js`. On
scanned PDFs it drops page footers, signatures, stamps and blank rows, merges
descriptions wrapped onto extra rows, and keeps the BOQ's own S.No and Item
Code. Every row is checked against the BOQ itself: qty × rate = amount
(Rs 1 tolerance), the rate in words, and the printed total. Decimal points
read as spaces or commas ("45398 80", "78,00") are resolved by that check, a
missing quantity is recovered from amount ÷ rate, and unit superscripts
(m² vs m³) are repaired from the description. Nothing changes silently: each
row keeps the OCR values and a list of corrections (original, corrected,
reason), the raw OCR description is kept next to the cleaned text, and every
flagged row must be ticked **Reviewed** before the sheet can be confirmed
(`PUT /api/boq/:id` returns 409 otherwise). The RFQ export now carries the
BOQ S.No and Item Code. No migration is needed (rows are stored in the
existing `boq_documents.items` JSON).

### BOQ to Quotation

Tender BOQs are mostly civil works; only the pipe lines are ours. On a
**confirmed** BOQ in Document Intelligence, click **Create quotation**
(idempotent per BOQ: it reopens the existing quotation).

1. **Review pipe lines.** A rule-based detector
   (`backend/src/documents/pipeLineDetector.js`) classifies every BOQ line as
   *plastic pipe* (HDPE, PE80/PE100, PVC, uPVC, OPVC, DWC/SWC, SN/PN classes,
   IS 4984, IS 16098, IS 15778: section A), *other pipe* (stoneware, RCC/hume,
   DI/CI, GI, steel: section B, review) or *not a pipe* (manholes, signs on
   "pipe 65 NB", earth electrodes, trench excavation: stored but excluded).
   Each line shows confidence, reasons, spec chips and its BOQ page/row; any
   line can be included, excluded or moved between A and B. Composite items
   (weep holes with PVC pipe) are marked "composite item: quote pipe supply only".
2. **Enter rates.** Rates start **empty** and are typed by you. The BOQ
   rate/amount columns are the customer's installed contract rates: they are
   kept only as a reference (`ref_rate`), shown as a hint, warned about when
   your rate is higher, and **never** copied into the quotation rate. All
   totals (sub-total, discount, freight, taxable value, CGST + SGST or IGST,
   grand total, amount in words) are calculated by the server; empty rates
   count as 0 and are reported as unpriced lines.
3. **Finalize.** Allowed only when every included line has a rate above 0,
   the customer name is filled, the company address and GSTIN are in Settings,
   and no `[bracketed]` placeholder is left. The number
   `SP/<financial year>/0001` (April to March, by quotation date in IST) is
   assigned atomically in the database, and the quotation becomes read-only
   (use **Duplicate** to revise).

At creation the BOQ is checked but never corrected: each line's
qty x contract rate is compared with the printed amount (Rs 1 tolerance), and
the sum of all amounts with the printed total. Mismatches are flagged "qty or
rate may be misread: verify against the scan".

Exports: **Excel** reproduces the reference quotation workbook (yellow input
cells with blue text, live formulas for amounts, tax and totals, supply-type
drop-down, terms, signature, legend). **Excel + internal sheet**
(`?internal=1`) adds the "Internal - do not send" sheet with the BOQ contract
rates, the qty x rate check and our rate vs contract rate. **PDF** (pdfkit) is
the customer copy, with repeating table headers and page numbers; it never
contains contract rates. **Send via WhatsApp** sends one PDF to one number you
type and confirm, through your connected session, and marks the quotation
*sent*.

Company header details (name, address, state, GSTIN, phone, email, bank
details, optional logo) come from **Settings → Quotation company profile**.
No new environment variables or npm packages are needed (pdfkit and exceljs
were already dependencies). The earlier price-list import route is no longer
mounted; `backend/src/routes/priceList.js` is unused and can be deleted.

### Shared workspaces

One account can open another account's data without any `user_id` being
changed. The share list is `private.user_data_shares`
(`owner_user_id` → `shared_user_id`, one-way):

```sql
-- share User 1's data with User 2
insert into private.user_data_shares (owner_user_id, shared_user_id)
values ('<owner uuid>', '<colleague uuid>');
-- revoke (takes effect within 60 s; DATA_SHARE_CACHE_MS)
delete from private.user_data_shares
where owner_user_id = '<owner uuid>' and shared_user_id = '<colleague uuid>';
```

The browser never reads tables directly: every request goes through the
backend, which uses the service-role key (RLS does not apply) and scopes each
query to one `user_id`. RLS policies on the data tables therefore do not
grant or block anything inside the app. Instead, the browser sends the
workspace it wants in an `X-Data-Owner` header (and as `dataOwner` in the
Socket.IO auth). `requireAuth` asks `public.resolve_data_owner` whether the
signed-in user may use it and answers 403 otherwise. `req.user.id` is then the
workspace owner (so every existing query, insert and RPC works unchanged) and
`req.user.authId` is the person signed in.

- The sidebar shows a **Workspace** switcher when something is shared with
  you. On first sign-in the shared workspace opens; the choice is remembered
  per user in the browser.
- Records created in a shared workspace belong to its owner.
- Owner only, even in a shared workspace: saving Settings (AI and email keys,
  company profile), the email test, and everything under `/api/whatsapp`
  except `GET /status` (connect, QR code, logout, Business API credentials).
  QR-code socket events go to the owner's own room only. Campaigns and inbox
  replies in a shared workspace do send through the owner's connected
  WhatsApp.
- Sign-out always logs out the signed-in user's own WhatsApp session, never
  the owner's.
- Rate limits count per signed-in person.

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
