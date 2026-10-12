// =============================================================
// Built-in knowledge for Ask AI.
//
// Ask AI is a SEPARATE internal assistant for employees. It does NOT
// read the Knowledge Base (knowledge_documents / knowledge_chunks):
// those tables exist to ground the customer-facing WhatsApp auto-reply
// only. Everything the internal assistant needs to answer platform
// how-to questions and company profile questions lives HERE, in code.
//
// Benefits of code-owned knowledge:
//   - A user editing or deleting their Knowledge Base can never break
//     or degrade the internal assistant.
//   - Ask AI is a hard no-op against the database on the happy path —
//     no seed/repair pre-flight runs on a chat turn, so a missing or
//     corrupted KB can never produce an HTTP 500 ("Something went
//     wrong") from this feature.
//   - The WhatsApp customer path and this path can evolve separately.
//
// The company profile text is intentionally DUPLICATED here (the
// Knowledge Base keeps its own seeded copy for customer auto-replies):
// one is grounded for customers via the KB, the other for staff via
// Ask AI, and neither depends on the other.
// =============================================================

const DOC_PLATFORM = 'Platform Guide (built-in)';
const DOC_COMPANY = 'Company Profile (built-in)';

// Platform how-to guide. Previously seeded INTO user Knowledge Bases as
// "How to Use This Platform"; it now lives only here where it belongs
// (staff audience), and never enters a customer-facing knowledge store.
const PLATFORM_HELP = `HOW TO USE THIS PLATFORM

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
Upload documents (product specs, pricing, policies, certificates) so the AI can answer customer questions accurately on WhatsApp. The WhatsApp auto-reply only answers using what's actually in your Knowledge Base — it won't make up information it doesn't have. The Knowledge Base feeds customer replies only; this assistant (Ask AI) does not read it.

ASK AI
Use the Ask AI page to ask any question about using this platform. You'll get an answer with the relevant guide section cited. The internal assistant uses its own built-in guides — it does not read your Knowledge Base.

DOCUMENT INTELLIGENCE
Upload a customer's BOQ or project requirement document (Excel, Word, PDF, or text) on the Document Intelligence page. The AI extracts sizes, quantities, and specifications into an editable requirement sheet, flags likely errors, and produces a ready-to-review RFQ you can export.

IMAGE EXTRACTOR
Upload photos of business cards or listings to automatically extract contact details as leads. There's also a Product Identification mode for identifying pipes/products from photos of visible markings.

ANALYTICS
View your dashboard for message trends, campaign performance, and overall activity stats.

SETTINGS
Configure your AI API key, business name, WhatsApp Business API credentials, email sending (Resend) settings, and default country code for phone numbers.`;

// Company profile (same facts the seeded Knowledge Base copy carries, so
// staff get consistent answers without touching the KB tables).
const COMPANY_PROFILE = `SUDARSHAN PIPES — COMPANY PROFILE
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

/**
 * Split text into retrieval-sized chunks (sentence-boundary aware, same
 * shape as knowledgeBase._chunkText). Pure function — no database.
 */
function chunkText(text, maxLen = 500) {
    const sentences = String(text || '').match(/[^.!?\n]+[.!?\n]+/g) || [String(text || '')];
    const chunks = [];
    let current = '';
    for (const sentence of sentences) {
        if (current.length + sentence.length > maxLen && current.length > 0) {
            chunks.push(current.trim());
            current = sentence;
        } else {
            current += sentence;
        }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.length ? chunks : [String(text || '')];
}

/** All built-in chunks with their source names — ready for scoring. */
function builtInChunks() {
    const chunks = [];
    for (const [docName, text] of [[DOC_PLATFORM, PLATFORM_HELP], [DOC_COMPANY, COMPANY_PROFILE]]) {
        for (const content of chunkText(text)) {
            chunks.push({ docName, content });
        }
    }
    return chunks;
}

// Same stopword list the KB-backed retrieval used: without it, function
// words like "the"/"how" made every natural-language chunk look relevant.
const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has',
    'was', 'are', 'were', 'will', 'would', 'can', 'could', 'should',
    'your', 'you', 'our', 'their', 'his', 'her', 'its', 'what', 'when',
    'where', 'which', 'who', 'whom', 'how', 'why', 'does', 'did', 'doing',
    'not', 'but', 'all', 'any', 'each', 'per', 'into', 'onto', 'about',
]);

/**
 * Retrieve the most relevant built-in chunks for a query, with the same
 * IDF-lite + coverage scoring as the previous KB-backed retrieval so
 * generic words ("products", "sudarshan") cannot drag in weak matches.
 * Synchronous and database-free — retrieval can never fail.
 */
function retrieveBuiltInSources(query, maxChunks = 5) {
    const queryWords = String(query || '')
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w));
    if (queryWords.length === 0) return [];

    const chunks = builtInChunks();
    const texts = chunks.map((c) => c.content.toLowerCase());
    const uniqueWords = [...new Set(queryWords)];
    const N = chunks.length;
    const idf = new Map(uniqueWords.map((w) => {
        const df = texts.filter((t) => t.includes(w)).length;
        return [w, Math.log(1 + N / (1 + df))];
    }));
    const totalWeight = uniqueWords.reduce((acc, w) => acc + idf.get(w), 0);
    // ≈ one third of the query's information must be present in the chunk.
    const MIN_COVERAGE = 0.34;

    return chunks
        .map((chunk, i) => {
            const text = texts[i];
            const score = uniqueWords.reduce((acc, w) => acc + (text.includes(w) ? idf.get(w) : 0), 0);
            return { ...chunk, score };
        })
        .filter((c) => c.score > 0 && totalWeight > 0 && (c.score / totalWeight) >= MIN_COVERAGE)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxChunks);
}

module.exports = {
    DOC_PLATFORM,
    DOC_COMPANY,
    PLATFORM_HELP,
    COMPANY_PROFILE,
    chunkText,
    builtInChunks,
    retrieveBuiltInSources,
};
