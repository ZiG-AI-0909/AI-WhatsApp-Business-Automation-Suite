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
// strip punctuation, keep words > 2 chars.
function tokenize(query) {
    return String(query || '')
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2);
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

    return chunks
        .map(chunk => {
            const text = String(chunk.content || '').toLowerCase();
            const score = queryWords.reduce((acc, w) => acc + (text.includes(w) ? 1 : 0), 0);
            return {
                content: chunk.content,
                docId: chunk.document_id,
                docName: docNameById.get(chunk.document_id) || 'Unknown',
                score,
            };
        })
        .filter(c => c.score > 0)
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
    return `You are an internal assistant for the sales team. Answer the team member's technical question using ONLY the company knowledge below. Never invent specifications, prices, or standards.\n\nRules:\n- When a fact comes from a source document, mention the document name in square brackets, e.g. [HDPE Specs].\n- If the knowledge base does not contain the answer, say so plainly and suggest which missing document or detail would help.\n- Keep the answer short and factual (2-6 sentences).\n\nCOMPANY KNOWLEDGE:\n${context || '(no matching documents)'}\n\nQUESTION: ${question}`;
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
            ? 'Your Knowledge Base is empty, so there is nothing to search yet. Add or upload a document (e.g. product specs, pricing) — a default company profile is seeded automatically on your first Knowledge Base load — then ask again.'
            : 'No matching documents were found in your Knowledge Base for this question. Add or check the relevant document (e.g. product specs, pricing) and try again.';
        return {
            id: null,
            answer,
            sources: [],
            stored: false,
        };
    }

    // Per-user AI credentials via the never-mix resolver (same guard as
    // the WhatsApp auto-reply path: a tenant-controlled base URL never
    // receives the server's own env key).
    const rows = await loadUserSettings(userId);
    const aiConfig = resolveAiConfig({
        storedKey: rows.AI_API_KEY,
        storedBaseURL: rows.AI_BASE_URL,
        envKey: process.env.AI_API_KEY,
        envBaseURL: process.env.AI_BASE_URL,
    });
    if (!aiConfig.apiKey) {
        throw new Error('AI is not configured. Set AI_API_KEY on the server or in Settings.');
    }
    const aiService = require('./aiService');
    const answer = await aiService._complete(
        [{ role: 'user', content: buildAnswerPrompt(trimmed, sources) }],
        {
            apiKey: aiConfig.apiKey,
            baseURL: aiConfig.baseURL,
            model: rows.AI_MODEL || process.env.AI_MODEL,
            temperature: 0.2,
            maxTokens: 600,
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
    listHistory,
    deleteHistory,
};
