# Railway Deployment — Backend

## Service setup (in Railway dashboard)

1. **Add a new service** from your GitHub repo.
2. **Root directory:** set to `backend/` (this is what makes `node src/server.js` resolve correctly).
3. Railway should auto-detect the `startCommand` from `backend/package.json` (`"start": "node src/server.js"`). If it doesn't, set it manually to `node src/server.js`.
4. **Build command:** leave default (Railway runs `npm install` automatically).

## Persistent volume (REQUIRED)

Railway filesystems are **ephemeral by default** — without a mounted volume, every deploy and restart wipes the disk. The backend writes to several folders that must survive:

| Folder | Contents | Why it must persist |
|---|---|---|
| `data/` | Local SQLite DB + settings (legacy; Supabase is now the source of truth) | Campaigns, contacts, knowledge base, schedules, and the persisted settings from the Settings UI |
| `.baileys_auth/` | WhatsApp Web (Baileys) session/auth state | Without this, WhatsApp re-asks for QR login on every restart |
| `uploads/` | Uploaded campaign Excel files | Campaign creation reads these files from disk |
| `campaign-media/` | Uploaded campaign media (images, PDFs, docs) | Campaigns reference media by path on disk |
| `knowledge/` | Uploaded knowledge-base text files | Knowledge documents loaded from disk |

**To add the volume in Railway:**
- Go to your backend service → **Volumes** → **New Volume**.
- Set the mount path to the **repo root** (e.g. `/` relative to the service root `backend/` — or mount at the parent path that contains `data/`, `.baileys_auth/`, `uploads/`, `campaign-media/`, `knowledge/`).
- Size: start with something like 5–10 GB; SQLite and text files are small, but uploaded media/images add up.

If Railway's volume mount is relative to the service root (`backend/`), mount the volume at `/` so that `data/`, `.baileys_auth/`, `uploads/`, `campaign-media/`, `knowledge/` all sit at the top of the mounted volume.

## Environment variables (set in Railway dashboard → Variables)

Set these in the Railway dashboard. **Do not commit a `.env` file** — it's in `.gitignore` for a reason, and the secrets (API keys, Supabase service role key, WhatsApp tokens) must not be in the repo.

| Variable | Notes |
|---|---|
| `AI_API_KEY` | NVIDIA/OpenAI-compatible API key |
| `AI_BASE_URL` | e.g. `https://integrate.api.nvidia.com/v1` |
| `AI_MODEL` | e.g. `deepseek-ai/deepseek-v4-flash-0731` |
| `NVIDIA_API_KEY` | Same key unless you use a separate one (falls back to `AI_API_KEY` if unset) |
| `NVIDIA_BASE_URL` | Falls back to `AI_BASE_URL` if unset |
| `NVIDIA_STRUCTURED_MODEL` | e.g. `meta/llama-3.2-11b-vision-instruct` (for image lead extraction) |
| `WHATSAPP_PROVIDER` | `web` (Baileys) or `business` (Meta Cloud API) |
| `DEFAULT_COUNTRY_CODE` | e.g. `91` |
| `WABA_PHONE_NUMBER_ID` | Only if `WHATSAPP_PROVIDER=business` |
| `WABA_ACCESS_TOKEN` | Only if `WHATSAPP_PROVIDER=business` |
| `WABA_WEBHOOK_VERIFY_TOKEN` | Only if `WHATSAPP_PROVIDER=business` — register this with Meta's webhook config |
| `WABA_API_VERSION` | Only if `WHATSAPP_PROVIDER=business`; default is `v23.0` |
| `BUSINESS_NAME` | Your business name |
| `BUSINESS_TAGLINE` | Your business tagline |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SECRET_KEY` | **Service role key** — server-side only, never expose to the browser |
| `AUTH_DISABLED` | Leave unset (or `false`). Only set to `true` for local dev without auth. |

Do **not** set `PORT`. Railway injects its own `PORT` and the app already reads `process.env.PORT || 3000`.

## First deploy

1. Push the repo to GitHub (if not already).
2. Create the Railway service from the repo.
3. Set root directory to `backend/`, start command to `node src/server.js`.
4. Add the persistent volume (see above).
5. Add all environment variables from the table above.
6. Deploy.

After deploy, check the **Deploy logs** for:
- `✅ Database schema initialized`
- `🚀 Sudarshan Pipes AI Assistant API started on http://...`
- Any errors about missing env vars.

## WhatsApp login after deploy

- **If `WHATSAPP_PROVIDER=web`:** go to the WhatsApp Connection page in the frontend, get the QR code from `GET /api/whatsapp/qr`, and scan it. The session is saved to `.baileys_auth/` on the persistent volume, so it survives restarts.
- **If `WHATSAPP_PROVIDER=business`:** connect via the settings UI with your WABA credentials. No QR needed; the webhook URL is `https://<your-railway-url>/api/webhooks/whatsapp` — register that with Meta.

## Settings UI behavior after deploy

The Settings UI (`PUT /api/settings`) now writes to `data/settings.json` on the persistent volume instead of `.env`. On a fresh deploy with no `settings.json` yet, the app reads from the Railway dashboard environment variables — so your initial values come from the dashboard, and any later in-app changes are persisted to `settings.json` and survive restarts.

## Health check

`GET /api/health` returns `{ status, timestamp, whatsapp }`. You can use this as a Railway health check endpoint if desired.

