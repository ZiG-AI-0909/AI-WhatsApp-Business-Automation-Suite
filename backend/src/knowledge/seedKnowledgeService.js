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
            if (marker) return; // already seeded or already had documents — exempt forever

            const docCount = await db.count('knowledge_documents', 'user_id = ?', [userId]);
            if (docCount > 0) {
                // Existing user with their own knowledge: mark exempt, touch nothing.
                await this._writeMarker(userId);
                return;
            }

            const knowledgeBase = require('../ai/knowledgeBase'); // lazy: avoids require cycle
            await knowledgeBase.addDocument(userId, SEED_DOC_NAME, SEED_CATEGORY, SEED_CONTENT);
            await this._writeMarker(userId);
            console.log(`[seed] default knowledge seeded for new user ${userId}`);
        } catch (error) {
            // Non-fatal by design; allow a retry on the next request.
            checked.delete(userId);
            console.error(`[seed] knowledge seeding failed for ${userId}:`, error.message);
        }
    }

    /** Upsert the marker (mirrors saveSetting's insert-then-update). */
    async _writeMarker(userId) {
        try {
            await db.insert('app_settings', { key: SEED_MARKER_KEY, value: 'true', user_id: userId, updated_at: new Date() });
        } catch {
            await db.update('app_settings', { value: 'true', updated_at: new Date() }, 'user_id = ? AND key = ?', [userId, SEED_MARKER_KEY]);
        }
    }

    /** Test hook: reset the in-process guard between test users. */
    _reset() { checked.clear(); }
}

module.exports = new SeedKnowledgeService();
module.exports.SEED_DOC_NAME = SEED_DOC_NAME;
module.exports.SEED_CATEGORY = SEED_CATEGORY;
module.exports.SEED_CONTENT = SEED_CONTENT;
