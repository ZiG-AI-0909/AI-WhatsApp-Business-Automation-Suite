# Migration Summary: SQLite → Supabase for Render Free Tier

This document summarizes the migration from local SQLite/database files to Supabase Postgres and Storage, required for deployment on Render's free tier (ephemeral filesystem).

---

## 1. Supabase Tables Created

Run `supabase-data-migration.sql` in your Supabase dashboard SQL editor to create these tables:

### Core Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `contacts` | Phone contacts | id, phone, name, company, city, marketing_opt_in, tags (JSON), notes, is_lid, jid, last_message_at |
| `conversations` | WhatsApp conversations | id, contact_id (FK), status, ai_enabled, last_message_at, unread_count |
| `messages` | Individual messages | id, conversation_id (FK), direction, body, status, wa_message_id, provider, sender, timestamp |
| `templates` | Message templates | id, name, content, created_at, updated_at |

### Campaign Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `campaigns` | Bulk messaging campaigns | id, name, status, template_message, total_contacts, processed, sent, failed, replies, opt_outs, settings (JSON), buttons (JSON), media_path, media_type, media_filename, media_mimetype, provider |
| `campaign_contacts` | Contacts in campaigns | id, campaign_id (FK), contact_id (FK), rendered_message, status, attempts, last_error, sent_at, provider_message_id, retry_at |

### Knowledge Base Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `knowledge_documents` | Knowledge base docs | id, name, category, content, file_path, status, created_at |
| `knowledge_chunks` | Text chunks for retrieval | id, document_id (FK), content, chunk_index |

### Scheduling Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `campaign_schedules` | Scheduled campaigns | id, name, template_message, file_path, media_path, media_type, media_filename, media_mimetype, buttons (JSON), settings (JSON), allow_missing_fields, schedule_type, run_at, recurrence_cron, status, last_run_at, next_run_at, last_campaign_id, last_error |

### Image Extractor Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `image_leads` | Leads from image extraction | id, source_image, extraction_group_id, business_name, phone_numbers (JSON), emails (JSON), website, address, city, state, country, postal_code, business_category, contact_person, social_links (JSON), raw_text, duplicate_status, review_status, confidence, processing_status |

### Settings Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `app_settings` | Key-value settings storage | key (PK), value, updated_at |

---

## 2. Supabase Storage Buckets

Create these buckets in your Supabase dashboard (Storage → New Bucket):

| Bucket Name | Purpose | Public | File Types |
|-------------|---------|--------|------------|
| `campaign-excel-uploads` | Excel files for campaigns | No | .xlsx |
| `knowledge-documents` | Knowledge base document files | No | .txt, .md, .pdf, .docx |
| `campaign-media` | Campaign media (images, documents) | No | .jpg, .jpeg, .png, .webp, .pdf, .doc, .docx, .xls, .xlsx |

**Note:** If the JS client cannot create buckets (requires service role), create them manually in the Supabase dashboard. Set appropriate bucket policies (private by default, signed URLs if needed).

---

## 3. Environment Variables for Render Dashboard

Set these in your Render service's environment variables:

### Required (Supabase)
- `SUPABASE_URL` — Your Supabase project URL
- `SUPABASE_SECRET_KEY` — Service role key (for server-side database operations)
- `SUPABASE_ANON_KEY` — Anon key (for storage operations)

### Required (WhatsApp)
- `AI_API_KEY` — Your AI provider API key (NVIDIA, etc.)
- `AI_BASE_URL` — AI API base URL
- `AI_MODEL` — Model name (default: deepseek-ai/deepseek-v4-flash-0731)
- `BUSINESS_NAME` — Your business name
- `BUSINESS_TAGLINE` — Your business tagline (optional)

### Optional
- `PORT` — Server port (default: 3000)
- `NODE_ENV` — Set to "production"
- `AUTH_DISABLED` — Set to "true" only for local dev (not production)

---

## 4. WhatsApp QR Code Re-scan Question (Point 3)

### Answer: YES, you will need to re-scan the WhatsApp QR code after each Render free tier restart/sleep-wake cycle.

**Why:** Baileys uses a local file-based auth state stored in `.baileys_auth/` folder. On Render's free tier:
- The filesystem is ephemeral
- Every restart/sleep-wake wipes local files
- The `.baileys_auth/` folder is lost on each restart
- Baileys cannot restore the session without the auth files

**Tradeoff:** This is a fundamental limitation of the Render free tier with Baileys. The WhatsApp connection will drop when Render sleeps the service, and you'll need to:
1. Visit your frontend
2. Scan the QR code again
3. Re-authenticate WhatsApp

**Why not fix it:** Rewriting Baileys to use a custom Postgres-backed auth state would be a large, complex change involving:
- Serializing the entire auth state (cryptographic keys, session data)
- Storing/retrieving from Postgres
- Handling session recovery edge cases
- Potential security implications

This is beyond a "small, safe change" and would require significant testing. For a free tier deployment, accepting the QR re-scan requirement is the pragmatic tradeoff.

**Workaround ideas (not implemented):**
- Use a WhatsApp Business API provider that supports cloud-based auth (e.g., Meta's Cloud API)
- Use a Render paid tier with persistent disk
- Use a separate persistent storage service for the auth files

---

## 5. Files Changed

### Database Layer
- `backend/src/database/db.js` — Complete rewrite: SQLite → Supabase client wrapper
- `backend/src/database/supabaseClient.js` — New: Supabase client singleton

### Services Updated
- `backend/src/contacts/contactService.js` — SQLite → Supabase
- `backend/src/conversations/conversationService.js` — SQLite → Supabase
- `backend/src/conversations/incomingMessageService.js` — Added await for async DB calls
- `backend/src/templates/templateService.js` — SQLite → Supabase
- `backend/src/campaigns/campaignService.js` — SQLite → Supabase
- `backend/src/campaigns/schedulerService.js` — SQLite → Supabase
- `backend/src/campaigns/messageQueue.js` — SQLite → Supabase
- `backend/src/ai/knowledgeBase.js` — SQLite → Supabase
- `backend/src/analytics/analyticsService.js` — SQLite → Supabase

### Routes Updated
- `backend/src/routes/settings.js` — settings.json → Supabase app_settings table
- `backend/src/routes/campaigns.js` — Updated for remote file paths
- `backend/src/routes/schedules.js` — Updated for remote file paths
- `backend/src/routes/knowledge.js` — Updated for remote file download
- `backend/src/routes/imageExtractor.js` — Complete rewrite for Supabase

### Middleware Updated
- `backend/src/middleware/upload.js` — Local disk → Supabase Storage

### Configuration
- `render.yaml` — New: Render deployment configuration
- `railway.json` — Left in place (can be deleted if not needed)

### Other Files (read but no structural changes needed)
- `backend/src/server.js` — No changes (CORS setup preserved as requested)
- `backend/src/whatsapp/whatsappService.js` — Removed settings.json reference
- `backend/src/ai/aiService.js` — Removed settings.json reference

---

## 6. Remaining Local Disk Writes (Non-Persistent Data)

After this migration, the following still write to local disk and will NOT survive Render restarts:

### 1. WhatsApp Auth State (`.baileys_auth/`)
- **Location:** `.baileys_auth/` folder at project root
- **What:** Baileys session data (cryptographic keys, credentials)
- **Impact:** WhatsApp connection lost on every restart; must re-scan QR code
- **Mitigation:** Not feasible without major Baileys rewrite (see Point 3 above)

### 2. Temporary Upload Buffers
- **Location:** Memory (multer.memoryStorage())
- **What:** In-flight file uploads before they're stored in Supabase
- **Impact:** Minimal — files are uploaded to Supabase quickly, then buffers are garbage collected

### 3. Node.js Runtime Files
- **Location:** Various (package cache, etc.)
- **What:** npm modules, runtime artifacts
- **Impact:** Re-created on each restart during `npm install`

---

## 7. Migration Steps

### Step 1: Create Supabase Tables
1. Go to Supabase Dashboard → SQL Editor
2. Open `supabase-data-migration.sql`
3. Run the entire file
4. Verify tables were created: `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;`

### Step 2: Create Storage Buckets
1. Go to Supabase Dashboard → Storage
2. Create buckets: `campaign-excel-uploads`, `knowledge-documents`, `campaign-media`
3. Set bucket policies (private by default recommended)

### Step 3: Update Environment Variables
1. Go to Render Dashboard → Your Service → Environment
2. Add all variables from Section 3 above
3. Restart the service

### Step 4: Deploy
1. Push changes to your repo
2. Render will auto-deploy
3. Connect WhatsApp by scanning the QR code in your frontend

### Step 5: Verify
1. Check health: `GET /api/health`
2. Test contacts: `GET /api/contacts`
3. Test WhatsApp connection
4. Verify file uploads work

---

## 8. Important Notes

### Data Types
- SQLite uses `TEXT` for everything; Postgres uses proper types
- Boolean-like fields (`marketing_opt_in`, `is_lid`, `ai_enabled`) are stored as `BIGINT` (0/1) for compatibility
- JSON fields are stored as `TEXT` with `JSON.stringify`/`JSON.parse`
- Timestamps are `timestamptz` (UTC)

### ID Types
- All tables use `BIGSERIAL` for auto-incrementing integer IDs
- This matches the frontend's expectation of integer IDs
- If you need UUIDs in the future, that's a separate migration

### Row Level Security
- All tables have RLS enabled
- The service role key bypasses RLS
- For production, review and add appropriate RLS policies if needed

### Transaction Limitations
- Supabase JS client does not support native transactions
- Critical operations use sequential calls (no atomicity guarantee)
- For true transactions, use Postgres functions via `rpc()`

### Performance Considerations
- Client-side filtering for complex queries (e.g., knowledge base scoring)
- Some analytics queries may be slower than SQLite for small datasets
- Consider adding database indexes for frequently queried columns

---

## 9. Rollback Plan

If you need to roll back:
1. Revert all file changes (git checkout)
2. Keep using SQLite locally
3. Deploy to a platform with persistent disk (not Render free tier)
4. Or use Railway/Render paid tier with persistent storage

---

## 10. Future Improvements (Not Implemented)

- [ ] Custom Baileys auth state storage in Postgres (complex, not implemented)
- [ ] Postgres functions for complex queries (transactions, aggregations)
- [ ] RLS policies for production security
- [ ] Database connection pooling optimization
- [ ] Migration of existing SQLite data to Supabase (manual export/import)
