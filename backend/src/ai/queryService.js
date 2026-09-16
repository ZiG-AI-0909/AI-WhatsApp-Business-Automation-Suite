// =============================================================
// Ask AI — internal Technical Query Resolver.
//
// Deliberately SEPARATE from the WhatsApp auto-reply flow
// (incomingMessageService.js): that one is customer-facing and
// persona-driven, this one is an internal tool that answers a team
// member's technical question from the Knowledge Base and reports
// exactly WHICH documents the answer drew from.
//
// Retrieval reuses the same user-scoped chunk-search approach as
// knowledgeBase.getRelevantContext(), but returns the matched chunks
// with their document names/ids so the UI can cite sources, and
// knowledge does not leak between tenants.
// =============================================================
const db = require('../database/db');
const { resolveAiConfig } = require('../utils/aiConfig');

// Ask AI can be the first authenticated page a user opens (it is reachable
// without loading the Knowledge Base view first), so the KB pre-flight
// (repair corrupted/chunk-less docs + seed the default profile) runs here
// rather than only on the Knowledge Base routes. Guarded to run at most
// once per user per server lifetime and never throws.

// Same tokenization as knowledgeBase.getRelevantContext: lowercase,
// strip punctuation, keep words > 2 chars. Common English function words
// are dropped: with the platform how-to guide now in every KB, a query
// like "what is the delivery time" would otherwise score 1 against ANY
// natural-language document purely via "the" — the lexical retriever
// can't tell relevance from stopword overlap, and the honest no-match
// fallback would never fire.
const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has',
    'was', 'are', 'were', 'will', 'would', 'can', 'could', 'should',
    'your', 'you', 'our', 'their', 'his', 'her', 'its', 'what', 'when',
    'where', 'which', 'who', 'whom', 'how', 'why', 'does', 'did', 'doing',
    'not', 'but', 'all', 'any', 'each', 'per', 'into', 'onto', 'about',
]);

function tokenize(query) {
    return String(query || '')
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Retrieve the most relevant active knowledge chunks for a query,
 * scoped to one user's documents. Mirrors the scoring in
 * knowledgeBase.getRelevantContext but keeps source attribution.
 * @returns {Promise<Array<{content, docName, docId, score}>>}
 */
async function retrieveSources(userId, query, maxChunks = 5) {
    const queryWords = tokenize(query);
    if (queryWords.length === 0) return [];

    // Only THIS user's active documents and chunks are searched —
    // same isolation contract as the auto-reply retrieval.
    const activeDocs = await db.select(
        'knowledge_documents',
        'id, name',
        'user_id = ? AND status = ?',
        [userId, 'active'],
        'id',
        1000,
        0
    );
    const docIds = activeDocs.map(d => d.id);
    if (docIds.length === 0) return [];
    const docNameById = new Map(activeDocs.map(d => [d.id, d.name]));

    const chunks = await db.select(
        'knowledge_chunks',
        'document_id, content',
        'document_id IN (?)',
        [docIds],
        'id',
        1000,
        0
    );

    // IDF-lite weighting: a word that appears in nearly every chunk of the
    // user's corpus (brand names like "sudarshan"/"pipes", generic "products")
    // carries almost no evidence, while a word unique to one or two chunks
    // (a model number, "launched", "MTPA") is decisive. Pure substring counting
    // let brand-word overlap make ANY document look relevant — which both
    // flooded the sources with weak matches and blocked the website fallback
    // for questions the knowledge base genuinely does not cover.
    const texts = chunks.map((c) => String(c.content || '').toLowerCase());
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
            return {
                content: chunk.content,
                docId: chunk.document_id,
                docName: docNameById.get(chunk.document_id) || 'Unknown',
                score,
            };
        })
        .filter(c => c.score > 0 && totalWeight > 0 && (c.score / totalWeight) >= MIN_COVERAGE)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxChunks);
}

/**
 * Build the grounded answer prompt. Strict rules: only use the provided
 * context, cite the [Document] names inline, and say clearly when the
 * knowledge base does not contain the answer — never invent specs.
 */
function buildAnswerPrompt(question, sources) {
    const context = sources
        .map(s => `[${s.docName}]\n${s.content}`)
        .join('\n\n---\n\n');
    return `You are an internal assistant for the sales team. Answer the team member's question using ONLY the company knowledge below — it may cover Sudarshan Pipes products OR how to use this platform. Never invent specifications, prices, or standards.\n\nRules:\n- When a fact comes from a source document, mention the document name in square brackets, e.g. [HDPE Specs].\n- If the knowledge base does not contain the answer, say so plainly and suggest which missing document or detail would help.\n- Keep the answer short and factual (2-6 sentences).\n\nCOMPANY KNOWLEDGE:\n${context || '(no matching documents)'}\n\nQUESTION: ${question}`;
}

// ─── Conversational chat ──────────────────────────────────────
// The chat endpoint wraps the same retrieval + grounding as ask() but
// keeps MULTI-TURN context: the client replays the recent conversation
// with every request, so the server stays stateless (no new tables) and
// the same per-user credential + citation rules apply to every turn.
const MAX_HISTORY_MESSAGES = 12;

/** Keep only the last few clean user/assistant turns from the client. */
function sanitizeHistory(history) {
    if (!Array.isArray(history)) return [];
    return history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-MAX_HISTORY_MESSAGES)
        .map((m) => ({ role: m.role, content: m.content.trim().slice(0, 2000) }))
        .filter((m) => m.content);
}

function buildChatPrompt(message, sources, history, websiteContext = '') {
    const context = sources
        .map(s => `[${s.docName}]\n${s.content}`)
        .join('\n\n---\n\n');
    const conversation = history.length
        ? history.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n') + '\n\n'
        : '';
    const websiteBlock = websiteContext
        ? `\nCOMPANY WEBSITE (sudarshanpipes.com) — current public information; use ONLY when the knowledge above does not answer the question, and attribute the answer to "the company website":\n${websiteContext}\n`
        : '';
    return `You are the built-in assistant inside the Sudarshan Pipes WhatsApp automation platform. You are chatting with a logged-in team member (never a customer) and help with THREE kinds of questions:\n1. Product and company questions — answer from the knowledge below.\n2. How-to questions about using THIS platform — point them to the right page or tool (WhatsApp Connection, Inbox, Campaigns, Contacts, Templates, Knowledge Base, Ask AI, Document Intelligence, Image Extractor, Analytics, Settings) using the platform guide content in the knowledge below.\n3. Company questions the knowledge does not cover — when COMPANY WEBSITE content is provided below, answer from it and attribute it to "the company website".\n\nRules:\n- Ground every fact in the knowledge or website text below; never invent specifications, prices, or features.\n- When a fact comes from a knowledge document, cite it in square brackets, e.g. [How to Use This Platform].\n- When COMPANY WEBSITE text is provided below and you use it, you MUST say the answer comes from the company website (write "the company website" in the answer).\n- If neither the knowledge nor the website text covers it, say so plainly instead of guessing, and suggest what to add or where to look.\n- Be conversational and brief (2-6 sentences); use short numbered steps when the user asks how to do something.\n- Continue the conversation naturally: "it", "that", or "also" refer to what came before.\n${websiteBlock}
CONVERSATION SO FAR:\n${conversation}KNOWLEDGE:\n${context || '(no matching documents)'}\n\nMESSAGE: ${message}`;
}

/**
 * Conversational variant of ask(): retrieval is run over the current
 * message PLUS the recent user turns (so "how about bulk sends?" still
 * finds the campaign guide), and the prompt carries the recent thread.
 * Each turn persists as one ai_queries row (same schema as ask()).
 */
async function chat(userId, message, rawHistory = [], { maxChunks = 5 } = {}) {
    const trimmed = String(message || '').trim();
    if (!trimmed) throw new Error('Type a message first.');
    if (trimmed.length > 2000) throw new Error('Message is too long (max 2000 characters).');
    const history = sanitizeHistory(rawHistory);

    try {
        await require('../knowledge/seedKnowledgeService').ensureReadyForAsk(userId);
    } catch { /* never block a chat turn on maintenance */ }

    // Retrieval query: the current message with recent user turns folded
    // in, so pronoun-heavy follow-ups still retrieve the right document.
    const priorUserText = history.filter((m) => m.role === 'user').slice(-2).map((m) => m.content).join(' ');
    const sources = await retrieveSources(userId, `${priorUserText} ${trimmed}`.trim(), maxChunks);

    // Grounding order: Knowledge Base first; when the KB has no match for
    // a COMPANY question, fall back to the company website (cached, capped)
    // instead of refusing — clearly labeled so the model can attribute the
    // answer to the website rather than fake-cite a document. Platform
    // how-to questions never touch the website.
    let websiteContext = '';
    if (sources.length === 0) {
        try {
            websiteContext = await require('./websiteContext').getWebsiteContext();
        } catch { /* never fail a chat turn on the website fetch */ }
        if (!websiteContext) {
            let docCount = 0;
            try {
                docCount = await db.count('knowledge_documents', 'user_id = ? AND status = ?', [userId, 'active']);
            } catch { /* fall through with generic message */ }
            const answer = docCount === 0
                ? 'Your Knowledge Base is empty, so there is nothing to search yet. Add or upload a document (e.g. product specs, pricing) — a default company profile and a platform how-to guide are seeded automatically on your first Knowledge Base load — then ask again.'
                : "I couldn't find anything in your Knowledge Base about that. Add or check the relevant document (e.g. product specs, pricing, or the platform how-to guide) and ask again — I'd rather say that than guess.";
            return { id: null, answer, sources: [], stored: false };
        }
    }

    // Same credential resolution as ask(): stored tenant key wins, then the
    // dedicated ASK_AI_* server pair, then the generic AI_* pair.
    const rows = await loadUserSettings(userId);
    const aiConfig = resolveAiConfig({
        storedKey: rows.AI_API_KEY,
        storedBaseURL: rows.AI_BASE_URL,
        envKey: (process.env.ASK_AI_API_KEY || '').trim() || process.env.AI_API_KEY,
        envBaseURL: process.env.AI_BASE_URL,
    });
    if (!aiConfig.apiKey) {
        throw new Error('AI is not configured. Set AI_API_KEY on the server or in Settings.');
    }
    const model = (rows.AI_MODEL || '').trim()
        || (process.env.ASK_AI_API_MODEL || '').trim()
        || (process.env.AI_MODEL || '').trim()
        || undefined;
    const aiService = require('./aiService');
    const answer = await aiService._complete(
        [{ role: 'user', content: buildChatPrompt(trimmed, sources, history, websiteContext) }],
        {
            apiKey: aiConfig.apiKey,
            baseURL: aiConfig.baseURL,
            model,
            temperature: 0.2,
            maxTokens: 600,
            reasoningEffort: 'none', // clean factual chat replies, no thinking leak
            logLabel: 'ask-ai chat',
        }
    );

    const docIds = [...new Set(sources.map((s) => s.docId))];
    // Deterministic attribution: when the answer was grounded on the
    // website fallback, tag the turn with a website pseudo-source so the
    // UI shows where it came from regardless of the model's phrasing.
    const usingWebsite = sources.length === 0 && !!websiteContext;
    const namedSources = usingWebsite
        ? [{ id: 'website', name: 'Company website (sudarshanpipes.com)' }]
        : sources.map((s) => ({ id: s.docId, name: s.docName, score: s.score }));
    const created = await db.insert('ai_queries', {
        question: trimmed,
        answer,
        source_doc_ids: JSON.stringify(usingWebsite ? ['website'] : docIds),
        source_doc_names: JSON.stringify(namedSources.map((s) => s.name)),
        user_id: userId,
    });

    return {
        id: created.id,
        answer,
        sources: namedSources,
        stored: true,
    };
}

/**
 * Ask a technical question: retrieve sources, generate an answer with the
 * user's own AI credentials, persist the query (answer + sources) so it
 * appears in history. Everything is scoped by userId.
 */
async function ask(userId, question, { maxChunks = 5 } = {}) {
    const trimmed = String(question || '').trim();
    if (!trimmed) throw new Error('Type a question first.');
    if (trimmed.length > 2000) throw new Error('Question is too long (max 2000 characters).');

    try {
        await require('../knowledge/seedKnowledgeService').ensureReadyForAsk(userId);
    } catch { /* never block a question on maintenance */ }

    const sources = await retrieveSources(userId, trimmed, maxChunks);
    if (sources.length === 0) {
        // Distinguish "KB is empty" from "KB has documents but none match"
        // so the user gets an actionable message.
        let docCount = 0;
        try {
            docCount = await db.count('knowledge_documents', 'user_id = ? AND status = ?', [userId, 'active']);
        } catch { /* fall through with generic message */ }
        const answer = docCount === 0
            ? 'Your Knowledge Base is empty, so there is nothing to search yet. Add or upload a document (e.g. product specs, pricing) — a default company profile and a platform how-to guide are seeded automatically on your first Knowledge Base load — then ask again.'
            : 'No matching documents were found in your Knowledge Base for this question. Add or check the relevant document (e.g. product specs, pricing, or the platform how-to guide) and try again.';
        return {
            id: null,
            answer,
            sources: [],
            stored: false,
        };
    }

    // Per-user AI credentials via the never-mix resolver (same guard as
    // the WhatsApp auto-reply path: a tenant-controlled base URL never
    // receives the server's own env key). Server-side feature override:
    // ASK_AI_API_KEY (optionally ASK_AI_API_MODEL) is a DEDICATED key for
    // this feature — it wins over the generic AI_* pair exactly like
    // DOCUMENT_INTELLIGENCE_NVIDIA_* does for BOQ extraction. A stored
    // user key still takes precedence (tenant BYO beats server defaults).
    const rows = await loadUserSettings(userId);
    const aiConfig = resolveAiConfig({
        storedKey: rows.AI_API_KEY,
        storedBaseURL: rows.AI_BASE_URL,
        envKey: (process.env.ASK_AI_API_KEY || '').trim() || process.env.AI_API_KEY,
        envBaseURL: process.env.AI_BASE_URL,
    });
    if (!aiConfig.apiKey) {
        throw new Error('AI is not configured. Set AI_API_KEY on the server or in Settings.');
    }
    const model = (rows.AI_MODEL || '').trim()
        || (process.env.ASK_AI_API_MODEL || '').trim()
        || (process.env.AI_MODEL || '').trim()
        || undefined;
    const aiService = require('./aiService');
    const answer = await aiService._complete(
        [{ role: 'user', content: buildAnswerPrompt(trimmed, sources) }],
        {
            apiKey: aiConfig.apiKey,
            baseURL: aiConfig.baseURL,
            model,
            temperature: 0.2,
            maxTokens: 600,
            // Short factual answers — no reasoning phase. Reasoning models
            // otherwise burn the token budget deliberating and can leak the
            // raw thinking process into the user-facing answer.
            reasoningEffort: 'none',
            logLabel: 'ask-ai', // per-attempt status/req-id logging for this feature
        }
    );

    // Persist so the user can revisit past questions. Sources are stored
    // as document ids + names, so history stays auditable.
    const docIds = [...new Set(sources.map(s => s.docId))];
    const created = await db.insert('ai_queries', {
        question: trimmed,
        answer,
        source_doc_ids: JSON.stringify(docIds),
        source_doc_names: JSON.stringify(sources.map(s => s.docName)),
        user_id: userId,
    });

    return {
        id: created.id,
        question: trimmed,
        answer,
        sources: sources.map(s => ({ id: s.docId, name: s.docName, score: s.score })),
        stored: true,
    };
}

async function loadUserSettings(userId) {
    const settings = {};
    try {
        const rows = await db.select('app_settings', 'key, value', 'user_id = ?', [userId], '', 100, 0);
        const { decryptSettingIfSecret } = require('../utils/encryption');
        for (const row of rows) settings[row.key] = decryptSettingIfSecret(row.key, row.value);
    } catch (error) {
        console.error('[askAi] failed to load settings:', error.message);
    }
    return settings;
}

async function listHistory(userId, limit = 30) {
    const rows = await db.select(
        'ai_queries',
        'id, question, answer, source_doc_names, created_at',
        'user_id = ?',
        [userId],
        'created_at',
        limit,
        0
    );
    // Newest first for display.
    return rows.reverse().map(row => ({
        ...row,
        source_doc_names: parseJsonArray(row.source_doc_names),
    }));
}

async function deleteHistory(id, userId) {
    const deleted = await db.del('ai_queries', 'id = ? AND user_id = ?', [id, userId]);
    if (!deleted || deleted.length === 0) throw new Error('Query not found.');
    return true;
}

function parseJsonArray(value) {
    if (Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

module.exports = {
    tokenize,
    retrieveSources,
    buildAnswerPrompt,
    ask,
    chat,
    sanitizeHistory,
    listHistory,
    deleteHistory,
};
