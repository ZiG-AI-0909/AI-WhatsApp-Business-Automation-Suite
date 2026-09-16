// =============================================================
// Default knowledge-base seeding for new tenants.
//
// Every NEW signup starts with one pre-populated, fully editable
// knowledge document (Sudarshan Pipes company profile) so the AI has
// real grounding immediately, without the user uploading anything.
//
// DESIGN: check-and-seed-if-empty, triggered lazily from the user's
// first authenticated data loads (Knowledge Base view + Dashboard).
//
// Why this over a Supabase DB trigger on auth.users:
//  - The whole multi-tenant design enforces ownership at the
//    APPLICATION layer with the service-role key (RLS is only a
//    safety net — see supabase-multitenant-migration.sql). Seeding
//    belongs in that same layer, next to knowledgeBase.addDocument().
//  - A DB trigger would need a SECURITY DEFINER function writing
//    through RLS at auth time — more moving parts (definer scope,
//    migration ordering, silent trigger failures invisible to the
//    app), and it could not reuse _chunkText() for the retrieval
//    chunks without duplicating that logic in SQL.
//  - This is idempotent, per-user, and failure-tolerant: a seed
//    error logs and degrades to "no default document" instead of
//    breaking the page load. Data guard: seeding only runs when the
//    user has ZERO knowledge documents, so existing users (and new
//    users who deleted or replaced the seed) are never overwritten.
// =============================================================
const db = require('../database/db');

const SEED_DOC_NAME = 'Sudarshan Pipes — Company Profile';
const SEED_CATEGORY = 'Company Profile';

// Second seed document: in-app how-to content so Ask AI answers BOTH
// product questions and "how do I use this platform" questions from the
// same retrieval. Distinct category so it stands out in the Knowledge
// Base list next to the company profile. A completely normal document —
// editable/deletable through the usual UI, nothing protected.
// AUDIENCE: seeded internal_only = true — it teaches STAFF how to use
// the platform, so it powers Ask AI but must never leak into a real
// customer's WhatsApp auto-reply. The company profile stays visible to
// both audiences on purpose (customers SHOULD get accurate product info).
const PLATFORM_DOC_NAME = 'How to Use This Platform';
const PLATFORM_CATEGORY = 'Platform Help';
const PLATFORM_MARKER_KEY = 'KB_PLATFORM_SEEDED';

const PLATFORM_CONTENT = `HOW TO USE THIS PLATFORM

CONNECTING WHATSAPP
Go to WhatsApp Connection. Choose WhatsApp Web (scan a QR code from your phone's Linked Devices menu) or WhatsApp Business API (enter your Meta Phone Number ID, Access Token, and Webhook Verify Token). Each user has their own separate WhatsApp connection — no two accounts share a number. Signing out fully disconnects your WhatsApp session for security; you'll need to scan the QR code again next time you sign in.

INBOX AND AI AUTO-REPLY
The Inbox shows all your WhatsApp conversations. Each conversation has an AI toggle — when on, the AI automatically replies to that customer using your Knowledge Base content. Turn it off any time to take over a conversation personally.

CREATING CAMPAIGNS
Go to Campaigns to send bulk messages. Upload an Excel file of contacts, write your message or select a template, optionally attach media. Choose a country code for phone numbers without one (set a default in Settings, or override it per upload). You can send immediately or schedule for later, including recurring campaigns — scheduled campaigns run automatically in the background even if you close your browser.

MANAGING CONTACTS
Add contacts manually or via Excel import on the Contacts page. Tag contacts, add notes, and track opt-in/opt-out status.

MESSAGE TEMPLATES
Save reusable message templates on the Templates page so you don't have to retype common messages.

KNOWLEDGE BASE
Upload documents (product specs, pricing, policies, certificates) so the AI can answer customer questions and internal questions accurately. The AI only answers using what's actually in your Knowledge Base — it won't make up information it doesn't have.

ASK AI
Use the Ask AI page to ask any question — about Sudarshan Pipes products, or about how to use this platform itself. You'll get an answer with the source document cited. If nothing in the Knowledge Base has the answer, Ask AI will tell you honestly rather than guessing.

DOCUMENT INTELLIGENCE
Upload a customer's BOQ or project requirement document (Excel, Word, PDF, or text) on the Document Intelligence page. The AI extracts sizes, quantities, and specifications into an editable requirement sheet, flags likely errors, and produces a ready-to-review RFQ you can export.

IMAGE EXTRACTOR
Upload photos of business cards or listings to automatically extract contact details as leads. There's also a Product Identification mode for identifying pipes/products from photos of visible markings.

ANALYTICS
View your dashboard for message trends, campaign performance, and overall activity stats.

SETTINGS
Configure your AI API key, business name, WhatsApp Business API credentials, email sending (Resend) settings, and default country code for phone numbers.`;

// Company-reported/marketing figures are kept with their framing so the
// AI never presents them as independently audited facts.
const SEED_CONTENT = `SUDARSHAN PIPES — COMPANY PROFILE
Industry: Polymer / Plastic Pipe & Fittings Manufacturing
Main operations: Bengaluru, Karnataka, India
Business origin: Sudarshan Extrusions founded 2003; broader business history traces to an earlier 1993 operation (Shiva Polytubes Pvt. Ltd., Patna).
Main divisions: PVC Division and PE/HDPE Division
Business model: B2B manufacturing, distributors/dealers, infrastructure projects and exports.

CORPORATE STRUCTURE
- Sudarshan Extrusions Pvt. Ltd. — PVC-focused, incorporated 2003, Bengaluru.
- Sudarshan Pipes Extrusions Pvt. Ltd. — PE/HDPE-focused, incorporated 2017, Bengaluru.
Both operate under the Sudarshan Pipes brand.

PRODUCT PORTFOLIO
PVC: uPVC Column Pipes, casing and filter products, agricultural pipes, UGD pipes, Foam Core UGD, Solid Wall UGD, OPVC pipes and fittings.
PE/HDPE: HDPE/PE100 pipes, MDPE pipes, compression fittings, electrofusion fittings, PLB ducts, DWC/SWC ducts, gas distribution pipes, irrigation products.
Applications: drinking water, borewell, irrigation, drainage, telecom, power, gas, plumbing, industrial infrastructure.

MANUFACTURING CAPACITY
- PVC: approximately 18,000 MTPA
- PE: approximately 48,000 MTPA
- Combined: approximately 66,000 MTPA (future stated capacity ~78,000 MTPA after expansion)
- PE facility (Dabaspet/Sompura industrial area): 12 HDPE extrusion lines, 2 drip lines, 2 SWC lines, 2 DWC lines, 11 injection moulding machines, 11 CNC machines.

CUSTOMERS & TARGET MARKETS
Primary B2B targets: government departments, water authorities, EPC contractors, infrastructure companies, civil contractors, municipalities, railways, industrial companies, agriculture/irrigation contractors, telecom and power companies. Reference projects include Karnataka infrastructure/water organizations, Indian Railways, Kerala Water Authority, Maharashtra Jeevan Pradhikaran, Madhya Pradesh Jal Nigam, Tamil Nadu Water Supply & Drainage Board.

INTERNATIONAL BUSINESS
Column-pipe exports expanded into Africa and the Middle East during 2010–2016. Company-reported figures (should be treated as marketing figures, not audited): 15+ countries, 400 distributors, 6,000 dealers.

STANDARDS & QUALITY
Products manufactured according to BIS and relevant international standards, including IS 4984:2016 for HDPE water pipes, and standards associated with UGD, column pipe, drainage, ducting, gas and irrigation products.

CONTACT INFORMATION
Website: sudarshanpipes.com
PVC enquiries: sales@sudarshanpipes.com | +91 93411 39695 / +91 97311 00553
PE/HDPE enquiries: hdpe@sudarshanpipes.com | +91 77488 99949 / +91 96066 76865
International/export enquiries: exports@sudarshanpipes.com | +91 97423 50063`;

// In-process guard: one user's seeding check runs at most once per
// server lifetime, so the "am I empty?" query doesn't repeat on every
// page load. The DB-side checks below remain the source of truth.
const checked = new Set();

// app_settings marker written the first time a user is either seeded or
// seen with their own documents. Guarantees seeding happens AT MOST ONCE
// per account: a user who deletes the seed document is never re-seeded,
// and a user who emptied their own KB is not surprised with it either.
const SEED_MARKER_KEY = 'KB_DEFAULT_SEEDED';

// Retrieval can never match this text, so a document made of only such
// chunks is unusable. "[object Blob]" is the corruption signature this
// codebase produced: knowledge uploads used to call .toString('utf8') on
// supabase-js's Web Blob download result, whose toString() is
// Object.prototype.toString → the literal string "[object Blob]". Kept
// generic ("[object ...]") so any future stringified-object bug is
// caught the same way.
function isCorruptChunkText(text) {
    const s = String(text || '').trim();
    return s.length === 0 || /^\[object .+\]$/.test(s);
}

/**
 * Best-effort recovery of a document's real text.
 *  1. The doc row itself holds usable text (content is fine but the
 *     chunk insert failed) → just re-chunk from it.
 *  2. The original upload is still in Storage → re-extract it with the
 *     FIXED download path (Buffer conversion + per-type text extraction).
 * Returns null when nothing usable exists.
 */
async function recoverDocumentContent(doc) {
    const content = typeof doc.content === 'string' ? doc.content : '';
    if (content.trim() && !isCorruptChunkText(content)) return content;

    if (doc.file_path && String(doc.file_path).startsWith('https://')) {
        try {
            const { downloadFromStorage, getBucketForPath } = require('../middleware/upload');
            const buffer = await downloadFromStorage(getBucketForPath(doc.file_path, 'knowledge'), doc.file_path);
            // The stored object name keeps the original upload's extension;
            // the display name may not (e.g. "Sudarshan pipes").
            let storageName = doc.file_path;
            try { storageName = decodeURIComponent(new URL(doc.file_path).pathname.split('/').pop() || ''); } catch { /* keep raw */ }
            const ext = require('path').extname(storageName).toLowerCase()
                || require('path').extname(String(doc.name || '')).toLowerCase();
            let text;
            try {
                text = require('../documents/boqExtractor').extractText(buffer, ext);
            } catch {
                text = buffer.toString('utf8'); // plain-text files and unknown extensions
            }
            if (String(text || '').trim()) return text;
        } catch (error) {
            console.warn(`[seed] could not recover doc "${doc.name}" (#${doc.id}) from storage: ${error.message}`);
        }
    }
    return null;
}

class SeedKnowledgeService {
    /**
     * Seed THIS user's knowledge base if they have no documents yet AND
     * have never been seeded/seen before (persistent marker). Safe to
     * call on every request: in-process guard + DB checks make it a
     * no-op after the first check. Failures never propagate — a page
     * load must not break because seeding failed.
     */
    async seedIfEmpty(userId) {
        if (!userId || checked.has(userId) || !db.isAvailable()) return;
        checked.add(userId);
        try {
            const marker = await db.getOne('app_settings', 'key', SEED_MARKER_KEY, userId);
            if (marker) {
                // Already exempt from profile seeding. The platform-help doc
                // is NEWER than the marker system, so existing accounts are
                // backfilled exactly once here (its own marker guards it).
                await this._seedPlatformDoc(userId);
                return; // already seeded or already had documents — exempt forever
            }

            const docCount = await db.count('knowledge_documents', 'user_id = ?', [userId]);
            if (docCount > 0) {
                // Existing user with their own knowledge: mark exempt, touch
                // nothing (except the one-time platform-help backfill below).
                await this._writeMarker(userId);
                await this._seedPlatformDoc(userId);
                return;
            }

            const knowledgeBase = require('../ai/knowledgeBase'); // lazy: avoids require cycle
            await knowledgeBase.addDocument(userId, SEED_DOC_NAME, SEED_CATEGORY, SEED_CONTENT);
            await this._writeMarker(userId);
            console.log(`[seed] default knowledge seeded for new user ${userId}`);
            await this._seedPlatformDoc(userId);
        } catch (error) {
            // Non-fatal by design; allow a retry on the next request.
            checked.delete(userId);
            console.error(`[seed] knowledge seeding failed for ${userId}:`, error.message);
        }
    }

    /**
     * Backfill/seed the "How to Use This Platform" document. Idempotent
     * via its own marker (a user who deletes it afterwards is never
     * re-surprised with it), and never added to a knowledge base the user
     * has deliberately EMPTIED (zero documents) — same respect-the-user
     * rule as the company profile. Runs for new users AND, once, for
     * existing accounts (the backfill), through the same lazy trigger.
     */
    async _seedPlatformDoc(userId) {
        try {
            const marker = await db.getOne('app_settings', 'key', PLATFORM_MARKER_KEY, userId);
            if (marker) return;
            const docCount = await db.count('knowledge_documents', 'user_id = ?', [userId]);
            if (docCount === 0) return; // user emptied their KB — respect it
            const knowledgeBase = require('../ai/knowledgeBase'); // lazy: avoids require cycle
            await knowledgeBase.addDocument(userId, PLATFORM_DOC_NAME, PLATFORM_CATEGORY, PLATFORM_CONTENT, null, { internalOnly: true });
            await this._writeMarker(userId, PLATFORM_MARKER_KEY);
            console.log(`[seed] platform help document seeded for user ${userId} (internal_only)`);
        } catch (error) {
            // Same failure tolerance as profile seeding — never break a page load.
            console.error(`[seed] platform help seeding failed for ${userId}:`, error.message);
        }
    }

    /** Upsert a marker row (mirrors saveSetting's insert-then-update). */
    async _writeMarker(userId, key = SEED_MARKER_KEY) {
        try {
            await db.insert('app_settings', { key, value: 'true', user_id: userId, updated_at: new Date() });
        } catch {
            await db.update('app_settings', { value: 'true', updated_at: new Date() }, 'user_id = ? AND key = ?', [userId, key]);
        }
    }

    /**
     * Repair THIS user's UNUSABLE knowledge documents. A document is
     * unusable when retrieval can never match it:
     *   - it has no chunks (doc insert succeeded but the chunk insert
     *     failed — seedIfEmpty's marker logic would otherwise exempt
     *     this user from repair forever), or
     *   - every chunk is garbage — the "[object Blob]" corruption the
     *     upload path used to store (fixed at the source in
     *     middleware/upload.js; this ladder cleans existing rows).
     * Unrecoverable garbage docs are deleted so the user sees an
     * honest empty KB instead of a document that can never answer.
     */
    async repairUnusableDocuments(userId) {
        if (!userId || !db.isAvailable()) return;
        const docs = await db.select(
            'knowledge_documents',
            'id, name, content, file_path',
            'user_id = ?',
            [userId],
            'id',
            1000,
            0
        );
        for (const doc of docs) {
            const chunks = await db.select(
                'knowledge_chunks',
                'content',
                'document_id = ?',
                [doc.id],
                'chunk_index',
                1000,
                0
            );
            const unusable = chunks.length === 0 || chunks.every(c => isCorruptChunkText(c.content));
            if (!unusable) continue;

            const recovered = await recoverDocumentContent(doc);
            if (!recovered) {
                console.warn(`[seed] doc "${doc.name}" (#${doc.id}) is unusable with no recovery source; deleting it`);
                await db.del('knowledge_documents', 'id = ? AND user_id = ?', [doc.id, userId]);
                // The user never truly had usable knowledge, so re-allow
                // seeding: seedIfEmpty's marker would otherwise exempt them
                // forever (the exact production trap — the corrupt upload
                // existed when the marker check ran, so the marker was
                // written without the user ever getting the default
                // profile). If the user still has healthy documents, the
                // next seedIfEmpty just re-marks them without seeding.
                // Both seed markers are cleared so both seeds re-run.
                await db.del('app_settings', "user_id = ? AND key IN ('KB_DEFAULT_SEEDED', 'KB_PLATFORM_SEEDED')", [userId]);
                continue;
            }
            const knowledgeBase = require('../ai/knowledgeBase'); // lazy: avoids require cycle
            await knowledgeBase.updateDocument(doc.id, userId, { content: recovered });
            console.log(`[seed] repaired unusable knowledge doc #${doc.id} "${doc.name}" for user ${userId}`);
        }
    }

    /**
     * One-call pre-flight for the Ask AI route: repair broken docs,
     * then seed the default profile for a first-time user. Ask AI can
     * be the FIRST authenticated page a user opens (it is reachable
     * without loading the Knowledge Base view), so without this a new
     * account asked questions against an empty KB. The once-per-user
     * guard keeps steady-state queries at zero extra queries. Never
     * throws — an Ask AI query must not fail because maintenance did.
     */
    async ensureReadyForAsk(userId) {
        const guardKey = `ready:${userId}`;
        if (!userId || checked.has(guardKey) || !db.isAvailable()) return;
        checked.add(guardKey);
        try {
            await this.repairUnusableDocuments(userId);
            await this.seedIfEmpty(userId);
        } catch (error) {
            checked.delete(guardKey); // allow a retry on the next query
            console.error(`[seed] ensureReadyForAsk failed for ${userId}:`, error.message);
        }
    }

    /** Test hook: reset the in-process guard between test users. */
    _reset() { checked.clear(); }
}

module.exports = new SeedKnowledgeService();
module.exports.SEED_DOC_NAME = SEED_DOC_NAME;
module.exports.SEED_CATEGORY = SEED_CATEGORY;
module.exports.SEED_CONTENT = SEED_CONTENT;
module.exports.PLATFORM_DOC_NAME = PLATFORM_DOC_NAME;
module.exports.PLATFORM_CATEGORY = PLATFORM_CATEGORY;
module.exports.PLATFORM_CONTENT = PLATFORM_CONTENT;
